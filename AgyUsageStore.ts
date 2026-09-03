import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

export interface AgyUsageTotals {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  total: number;
}

export interface AgyUsageSnapshot {
  conversationId: string;
  cwd: string;
  model: string;
  observedAt: number;
  numTurns?: number;
  cumulative: AgyUsageTotals;
}

const STORE_VERSION = 1;
const FLUSH_DELAY_MS = 400;

function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

export function getAgyUsageStorePath(): string {
  return path.join(getHomeDir(), ".pimate", "agy-usage.jsonl");
}

function nonNegativeNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeTotals(value: Partial<AgyUsageTotals> | undefined): AgyUsageTotals {
  return {
    input: nonNegativeNumber(value?.input),
    output: nonNegativeNumber(value?.output),
    thinking: nonNegativeNumber(value?.thinking),
    cacheRead: nonNegativeNumber(value?.cacheRead),
    total: nonNegativeNumber(value?.total),
  };
}

function normalizeSnapshot(value: unknown): AgyUsageSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AgyUsageSnapshot> & { version?: number };
  const conversationId = typeof raw.conversationId === "string" ? raw.conversationId.trim() : "";
  if (!conversationId) return null;
  const observedAt = nonNegativeNumber(raw.observedAt);
  if (!observedAt) return null;
  return {
    conversationId,
    cwd: typeof raw.cwd === "string" ? raw.cwd : "",
    model: typeof raw.model === "string" ? raw.model : "unknown",
    observedAt,
    numTurns:
      typeof raw.numTurns === "number" && Number.isFinite(raw.numTurns)
        ? raw.numTurns
        : undefined,
    cumulative: normalizeTotals(raw.cumulative),
  };
}

function snapshotKey(snapshot: AgyUsageSnapshot): string {
  const totals = snapshot.cumulative;
  return [
    snapshot.conversationId,
    snapshot.numTurns ?? "",
    totals.input,
    totals.output,
    totals.thinking,
    totals.cacheRead,
    totals.total,
  ].join(":");
}

/**
 * Pimate-owned, append-only AGY usage journal.
 *
 * AGY's conversation database is an internal SQLite/Protobuf store and does
 * not expose a stable historical usage API. We therefore persist the usage
 * snapshots AGY already emits in stream-json. Writes are batched and never
 * happen on the token-delta path.
 */
export class AgyUsageStore {
  private static records: AgyUsageSnapshot[] | null = null;
  private static loadPromise: Promise<void> | null = null;
  private static writeTail: Promise<void> = Promise.resolve();
  private static pending = new Map<string, AgyUsageSnapshot>();
  private static flushTimer: ReturnType<typeof setTimeout> | null = null;

  private static async ensureLoaded(): Promise<void> {
    if (this.records) return;
    if (!this.loadPromise) {
      this.loadPromise = this.loadFromDisk().finally(() => {
        this.loadPromise = null;
      });
    }
    await this.loadPromise;
  }

  private static async loadFromDisk(): Promise<void> {
    const records: AgyUsageSnapshot[] = [];
    const seen = new Set<string>();
    try {
      const raw = await fs.readFile(getAgyUsageStorePath(), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.version !== STORE_VERSION) continue;
          const snapshot = normalizeSnapshot(parsed.snapshot);
          if (!snapshot) continue;
          const key = snapshotKey(snapshot);
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(snapshot);
        } catch {
          // Ignore a truncated final line or a record from a future version.
        }
      }
    } catch {
      // The journal is optional. A missing or unreadable file must not affect
      // the chat client.
    }
    this.records = records;
  }

  static getLatest(conversationId: string): Promise<AgyUsageSnapshot | null> {
    const id = conversationId.trim();
    if (!id) return Promise.resolve(null);
    return this.ensureLoaded().then(() => {
      const matches = [...(this.records || []), ...this.pending.values()].filter(
        (record) => record.conversationId === id
      );
      matches.sort((a, b) => {
        const aTurn = a.numTurns ?? -1;
        const bTurn = b.numTurns ?? -1;
        return bTurn - aTurn || b.observedAt - a.observedAt;
      });
      return matches[0] || null;
    });
  }

  static readAll(): Promise<AgyUsageSnapshot[]> {
    return this.ensureLoaded().then(() => [
      ...(this.records || []),
      ...this.pending.values(),
    ]);
  }

  static record(snapshot: AgyUsageSnapshot): void {
    const normalized = normalizeSnapshot(snapshot);
    if (!normalized) return;
    const key = snapshotKey(normalized);
    this.pending.set(key, normalized);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        void this.flush();
      }, FLUSH_DELAY_MS);
    }
  }

  static async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pending.size === 0) {
      await this.writeTail;
      return;
    }

    const pending = new Map(this.pending);
    this.pending.clear();
    this.writeTail = this.writeTail.then(async () => {
      await this.ensureLoaded();
      const existingKeys = new Set((this.records || []).map(snapshotKey));
      const fresh = [...pending.values()].filter((snapshot) => !existingKeys.has(snapshotKey(snapshot)));
      if (fresh.length === 0) return;

      const storePath = getAgyUsageStorePath();
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const payload = fresh
        .map((snapshot) => JSON.stringify({ version: STORE_VERSION, snapshot }))
        .join("\n") + "\n";
      await fs.appendFile(storePath, payload, "utf8");
      this.records = [...(this.records || []), ...fresh];
    }).catch((err) => {
      // Usage persistence is best effort. Keep the chat path independent from
      // permissions, transient disk errors, or a locked home directory.
      console.warn("[agy] Could not persist usage snapshot:", err);
    });
    await this.writeTail;
  }
}
