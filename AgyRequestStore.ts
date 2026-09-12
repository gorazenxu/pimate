import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

/**
 * A request accepted by Pimate's AGY adapter.
 *
 * This is deliberately separate from AGY's usage snapshots. A snapshot is a
 * cumulative accounting observation, while this record represents one prompt
 * submitted through Pimate. No prompt text is persisted.
 */
export interface AgyRequestRecord {
  conversationId: string;
  model: string;
  observedAt: number;
  /** Stable within the Pimate process; prevents same-millisecond prompts collapsing. */
  requestId?: string;
}

const STORE_VERSION = 1;
const FLUSH_DELAY_MS = 400;

function getHomeDir(): string {
  return process.env.HOME || os.homedir();
}

export function getAgyRequestStorePath(): string {
  return path.join(getHomeDir(), ".pimate", "agy-requests.jsonl");
}

function positiveNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function normalizeRecord(value: unknown): AgyRequestRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AgyRequestRecord>;
  const conversationId =
    typeof raw.conversationId === "string" ? raw.conversationId.trim() : "";
  if (!conversationId) return null;
  const observedAt = positiveNumber(raw.observedAt);
  if (!observedAt) return null;
  return {
    conversationId,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : "unknown",
    observedAt,
    requestId: typeof raw.requestId === "string" && raw.requestId.trim()
      ? raw.requestId.trim()
      : undefined,
  };
}

function recordKey(record: AgyRequestRecord): string {
  return record.requestId || [record.conversationId, record.observedAt, record.model].join(":");
}

/** Pimate-owned append-only ledger for AGY requests created after this feature. */
export class AgyRequestStore {
  private static records: AgyRequestRecord[] | null = null;
  private static loadPromise: Promise<void> | null = null;
  private static writeTail: Promise<void> = Promise.resolve();
  private static pending = new Map<string, AgyRequestRecord>();
  private static flushTimer: ReturnType<typeof setTimeout> | null = null;
  private static nextRequestId = 0;

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
    const records: AgyRequestRecord[] = [];
    const seen = new Set<string>();
    try {
      const raw = await fs.readFile(getAgyRequestStorePath(), "utf8");
      for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed?.version !== STORE_VERSION) continue;
          const record = normalizeRecord(parsed.record);
          if (!record) continue;
          const key = recordKey(record);
          if (seen.has(key)) continue;
          seen.add(key);
          records.push(record);
        } catch {
          // Ignore a truncated final line or a record from a future version.
        }
      }
    } catch {
      // The request ledger is optional and must never affect the chat path.
    }
    this.records = records;
  }

  static readAll(): Promise<AgyRequestRecord[]> {
    return this.ensureLoaded().then(() => {
      const merged = new Map<string, AgyRequestRecord>();
      for (const record of this.records || []) merged.set(recordKey(record), record);
      for (const record of this.pending.values()) merged.set(recordKey(record), record);
      return [...merged.values()];
    });
  }

  static record(record: AgyRequestRecord): void {
    const normalized = normalizeRecord(record);
    if (!normalized) return;
    const withId = normalized.requestId
      ? normalized
      : {
          ...normalized,
          requestId: `${normalized.observedAt}-${this.nextRequestId++}`,
        };
    const key = recordKey(withId);
    this.pending.set(key, withId);
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
      const existingKeys = new Set((this.records || []).map(recordKey));
      const fresh = [...pending.values()].filter((record) => !existingKeys.has(recordKey(record)));
      if (fresh.length === 0) return;

      const storePath = getAgyRequestStorePath();
      await fs.mkdir(path.dirname(storePath), { recursive: true });
      const payload = fresh
        .map((record) => JSON.stringify({ version: STORE_VERSION, record }))
        .join("\n") + "\n";
      await fs.appendFile(storePath, payload, "utf8");
      this.records = [...(this.records || []), ...fresh];
    }).catch((err) => {
      // A request ledger failure must never delay or fail a prompt.
      console.warn("[agy] Could not persist request record:", err);
    });
    await this.writeTail;
  }
}
