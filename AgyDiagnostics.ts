import { promises as fs } from "fs";
import * as path from "path";
import * as os from "os";
import { createHash } from "crypto";

export type AgyFailureCategory =
  | "cancelled" | "interrupted" | "network" | "timeout"
  | "authentication" | "quota" | "permission" | "process" | "unknown";

/** A remote cancellation does not establish that the local user pressed Stop. */
export function classifyAgyFailure(reason: string, stopRequested: boolean, status = ""): AgyFailureCategory {
  if (stopRequested) return "cancelled";
  const text = `${status}\n${reason}`;
  if (/(quota|rate limit|resource exhausted|too many requests|\b429\b)/i.test(text)) return "quota";
  if (/(unauthenticated|authentication|sign[ -]?in|not logged in|login|credential|\b401\b|\b403\b)/i.test(text)) return "authentication";
  if (/(permission|access denied|not allowed)/i.test(text)) return "permission";
  if (/(timeout|timed out|deadline exceeded)/i.test(text)) return "timeout";
  if (/(broken pipe|connection (?:reset|refused|closed)|network|\beof\b|stream (?:was )?interrupted|temporarily unavailable)/i.test(text)) return "network";
  if (/(process exited|agy exited|child process|exit code|signal)/i.test(text)) return "process";
  if (/(cancel|abort|interrupt)/i.test(text)) return "interrupted";
  return "unknown";
}

/** Apply before truncation so a cut-off email/token cannot escape redaction. */
export function sanitizeAgyDiagnostic(value: string): string {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|authorization|cookie|password|secret)(?:["']?)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "$1[redacted]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/https?:\/\/[^\s<>"']+/gi, (url) => {
      try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}/[path]`; }
      catch { return "[url]"; }
    })
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\r\n"'<>]*/gi, "[local path]")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .slice(0, 1600);
}

export interface AgyTerminalDiagnostic {
  at: string;
  conversationId: string | null;
  source: "result" | "transport";
  status: string;
  error: string;
  category?: AgyFailureCategory;
  stopRequested: boolean;
  receivedModelOutput: boolean;
  hadToolActivity: boolean;
  responseChars: number;
}

/** Small asynchronous journal, partitioned by workspace without storing its path. */
export class AgyDiagnosticStore {
  private static tail: Promise<void> = Promise.resolve();

  static record(entry: AgyTerminalDiagnostic, workspace: string): void {
    const key = createHash("sha256").update(path.resolve(workspace)).digest("hex").slice(0, 16);
    const file = path.join(process.env.HOME || os.homedir(), ".pimate", "agy-diagnostics", `${key}.jsonl`);
    // Whitelist fields: never serialize the AGY result object or conversation text.
    const line = JSON.stringify({
      version: 1, at: entry.at,
      conversationId: /^[a-f0-9-]{36}$/i.test(entry.conversationId || "") ? entry.conversationId : null,
      source: entry.source, status: sanitizeAgyDiagnostic(entry.status).slice(0, 100),
      error: sanitizeAgyDiagnostic(entry.error), category: entry.category,
      stopRequested: entry.stopRequested, receivedModelOutput: entry.receivedModelOutput,
      hadToolActivity: entry.hadToolActivity, responseChars: entry.responseChars,
    }) + "\n";
    this.tail = this.tail.then(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      let size = 0;
      try { size = (await fs.stat(file)).size; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (size + Buffer.byteLength(line) > 256 * 1024) await fs.rename(file, `${file}.previous`);
      await fs.appendFile(file, line, { mode: 0o600 });
    }).catch(() => {
      // Diagnostics must never delay/fail a prompt or leak raw filesystem errors.
      console.warn("[agy] Could not save terminal diagnostic");
    });
  }
}
