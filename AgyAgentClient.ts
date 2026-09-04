import { ChildProcess, spawn, execFile, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import type {
  RpcResponse,
  RpcEvent,
  PiModel,
  PiAgentState,
  AvailableModelsResult,
  SetModelResult,
  ForkMessagesResult,
  SessionEntriesResult,
} from "./PiAgentClient";
import { calculateAgyCost } from "./AgyPricing";
import { AgyUsageStore } from "./AgyUsageStore";

export interface AgyAgentClientOptions {
  agyPath?: string;
  modelId?: string;
  effort?: string;
  cwd?: string;
  /** Obsidian Vault root that AGY should explicitly register as a workspace. */
  workspacePath?: string;
  conversationId?: string;
  dangerouslySkipPermissions?: boolean;
  /** Disable Pimate's usage journal for internal helper conversations. */
  trackUsage?: boolean;
}

export interface AgyConversationSummary {
  conversationId: string;
  title: string;
  preview: string;
  mtime: number;
  stepCount: number;
  workspaceUris: string[];
}

export type AgyConversationWorkspaceStatus =
  | "current"
  | "foreign"
  | "unassigned"
  | "missing";

export interface AgyQuotaBucket {
  id: string;
  name: string;
  window: string;
  remainingFraction: number;
  resetTime?: string;
}

export interface AgyQuotaGroup {
  name: string;
  description?: string;
  buckets: AgyQuotaBucket[];
}

export interface AgyQuotaStatus {
  groups: AgyQuotaGroup[];
  fetchedAt: number;
}

type AgyHistoryBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "toolCall";
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };

type AgyHistoryMessage =
  | {
      role: "user" | "assistant";
      content: AgyHistoryBlock[];
    }
  | {
      role: "toolResult";
      toolName: string;
      toolCallId: string;
      content: string;
      isError?: boolean;
      details?: Record<string, unknown>;
    };

type AgyPromptOptions = {
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: string; data: string; mimeType: string }>;
};

interface PendingAgyPrompt {
  message: string;
  options?: AgyPromptOptions;
  kind: "steering" | "followUp";
}

type AgyFailureCategory =
  | "cancelled"
  | "network"
  | "timeout"
  | "authentication"
  | "quota"
  | "permission"
  | "process"
  | "unknown";

interface ActiveAgyPrompt {
  message: string;
  options?: AgyPromptOptions;
  retryAttempt: number;
  receivedModelOutput: boolean;
  hadToolActivity: boolean;
}

interface RetryableAgyPrompt {
  message: string;
  options?: AgyPromptOptions;
  retryAttempt: number;
}

interface AgyFailureInfo {
  category: AgyFailureCategory;
  retryable: boolean;
  diagnostic?: string;
}

// Transcript files can grow very large. Pimate only renders the recent
// history on first paint, so avoid synchronously parsing an entire AGY
// transcript before the user can see a restored conversation.
const DEFAULT_AGY_HISTORY_MESSAGES = 100;
const AGY_HISTORY_TAIL_BYTES = 2 * 1024 * 1024;
// Give AGY enough time to turn SIGINT into a turn-level cancellation before
// falling back to a hard process stop. This keeps the normal Stop action close
// to the interactive CLI's Esc behavior without allowing a stuck agent to run
// indefinitely in the background.
const AGY_ABORT_GRACE_MS = 2_000;
const AGY_ABORT_CLOSE_GRACE_MS = 250;
// AGY's stream-json transport runs through print mode, whose default wait is
// only five minutes. Long tool chains can legitimately exceed that window;
// keep the process alive until the user stops it or this generous guardrail is
// reached.
const AGY_PRINT_TIMEOUT = "15m";
const AGY_PROMPT_WAIT_TIMEOUT_MS = 15 * 60 * 1_000;

/**
 * Resolve the agy executable path on Windows and POSIX.
 */
export function resolveAgySpawn(
  userAgyPath?: string
): { cmd: string; scriptArgs: string[] } {
  const p = userAgyPath?.trim() || "agy";

  if (process.platform === "win32") {
    if (fs.existsSync(p)) return { cmd: p, scriptArgs: [] };
    const winCandidates = [
      p,
      p + ".exe",
      p + ".cmd",
      path.join(process.env.LOCALAPPDATA || "", "Programs", "agy", "agy.exe"),
      path.join(process.env.USERPROFILE || "", ".local", "bin", "agy.exe"),
    ];
    for (const c of winCandidates) {
      if (c && fs.existsSync(c)) return { cmd: c, scriptArgs: [] };
    }
    return { cmd: p, scriptArgs: [] };
  }

  // POSIX (macOS, Linux)
  let resolvedPosix = p;
  if (resolvedPosix.startsWith("~/") && process.env.HOME) {
    resolvedPosix = path.join(process.env.HOME, resolvedPosix.slice(2));
  }
  if (path.isAbsolute(resolvedPosix)) {
    if (fs.existsSync(resolvedPosix)) return { cmd: resolvedPosix, scriptArgs: [] };
  }

  const searchDirs = [
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    ...(process.env.PATH || "").split(path.delimiter),
    "/usr/bin",
    "/bin",
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, resolvedPosix);
    if (fs.existsSync(candidate)) {
      return { cmd: candidate, scriptArgs: [] };
    }
  }

  return { cmd: resolvedPosix, scriptArgs: [] };
}

/**
 * AgyAgentClient manages an `agy` CLI sub-process communicating via
 * `--input-format stream-json --output-format stream-json`.
 *
 * It adapts the official stream-json events into Pimate's standard RpcEvent stream,
 * allowing seamless reuse of the Pimate chat UI, markdown rendering, tool call views,
 * and session state management.
 */
export class AgyAgentClient extends EventEmitter {
  readonly engine = "antigravity" as const;

  private static quotaCache: {
    path: string;
    expiresAt: number;
    data: AgyQuotaStatus;
  } | null = null;
  private static quotaRequest: {
    path: string;
    promise: Promise<RpcResponse<AgyQuotaStatus>>;
  } | null = null;

  private process: ChildProcess | null = null;
  private abortingProcess: ChildProcess | null = null;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private destroyed = false;
  private processGeneration = 0;
  private startPromise: Promise<void> | null = null;
  // AGY can be called by startup, tab switching, model changes, and history
  // restore at nearly the same time. Serialize lifecycle mutations so a
  // queued destroy cannot invalidate a start that a restore is waiting for.
  private lifecycleTail: Promise<void> = Promise.resolve();

  private options: AgyAgentClientOptions;
  private conversationId: string | null = null;
  private currentModelId: string;
  private currentEffort: string;
  private availableTools: string[] = [];
  private pendingPrompts: PendingAgyPrompt[] = [];
  private activePrompt: ActiveAgyPrompt | null = null;
  private retryablePrompt: RetryableAgyPrompt | null = null;
  private recentTurnStderr = "";
  // AGY writes detailed transport errors to its rotating log. Keep per-process
  // byte offsets so a failed turn only reads diagnostics appended by this
  // invocation and never reuses stale errors from an older process.
  private agyLogOffsets = new Map<string, number>();
  private historyLoadedConversationId: string | null = null;
  private historyLoadedLimit: number | null = null;
  private historyIsPartial = false;
  private toolCallStates = new Map<string, "active" | "done">();

  private lastAssistantText = "";
  private lastAssistantThinking = "";
  private isTurnStreaming = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private thinkingTokens = 0;
  private cacheReadTokens = 0;
  private totalTokens = 0;
  private usageKnown = false;
  private usageObservedAt = 0;
  private usageModelId: string | null = null;
  private usageLoadPromise: Promise<void> = Promise.resolve();
  private usageStateRevision = 0;
  private readonly trackUsage: boolean;

  private historyMessages: AgyHistoryMessage[] = [];

  private initResolve: ((value?: unknown) => void) | null = null;
  private initReject: ((reason?: unknown) => void) | null = null;

  private enqueueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = run.then(() => undefined, () => undefined);
    return run;
  }

  constructor(options: AgyAgentClientOptions) {
    super();
    this.options = { ...options };
    this.conversationId = options.conversationId || null;
    this.currentModelId = options.modelId || "gemini-3.8-flash-high";
    this.currentEffort = options.effort || "high";
    this.trackUsage = options.trackUsage !== false;
    this.usageLoadPromise = this.trackUsage
      ? this.restorePersistedUsage(this.conversationId)
      : Promise.resolve();
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private readTranscriptForHistory(transcriptPath: string, maxMessages: number): string {
    const useTail = maxMessages > 0;
    try {
      const size = fs.statSync(transcriptPath).size;
      if (!useTail || size <= AGY_HISTORY_TAIL_BYTES) {
        return fs.readFileSync(transcriptPath, "utf-8");
      }

      const length = Math.min(size, AGY_HISTORY_TAIL_BYTES);
      const offset = Math.max(0, size - length);
      const buffer = Buffer.alloc(length);
      const fd = fs.openSync(transcriptPath, "r");
      try {
        const bytesRead = fs.readSync(fd, buffer, 0, length, offset);
        let raw = buffer.subarray(0, bytesRead).toString("utf-8");
        // The first record is normally cut in half when reading a tail. Drop
        // it so every remaining line remains valid JSONL.
        if (offset > 0) {
          const firstNewline = raw.indexOf("\n");
          raw = firstNewline >= 0 ? raw.slice(firstNewline + 1) : "";
        }
        return raw;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return "";
    }
  }

  private loadTranscriptHistory(maxMessages = DEFAULT_AGY_HISTORY_MESSAGES): AgyHistoryMessage[] {
    if (!this.conversationId) return [];
    try {
      const transcriptPath = path.join(
        this.getAgyDataDir(),
        "brain",
        this.conversationId,
        ".system_generated",
        "logs",
        "transcript.jsonl"
      );
      if (!fs.existsSync(transcriptPath)) return [];
      const raw = this.readTranscriptForHistory(transcriptPath, maxMessages);
      const lines = raw.split("\n").filter(Boolean);
      const messages: AgyHistoryMessage[] = [];
      const pendingToolCalls: Array<{
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }> = [];
      const parseToolArguments = (raw: unknown): Record<string, unknown> => {
        if (raw && typeof raw === "object" && !Array.isArray(raw)) {
          return raw as Record<string, unknown>;
        }
        if (typeof raw === "string") {
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Keep an opaque string argument readable in the restored tool row.
          }
          return { command: raw };
        }
        return {};
      };

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "USER_INPUT" && entry.content) {
            pendingToolCalls.length = 0;
            let text = String(entry.content);
            const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (reqMatch) text = reqMatch[1].trim();
            messages.push({
              role: "user",
              content: [{ type: "text", text }],
            });
          } else if (entry.type === "PLANNER_RESPONSE") {
            // A planner response can contain assistant text, thinking, tool
            // calls, or a combination. Keep all of those in restored history.
            pendingToolCalls.length = 0;
            const blocks: AgyHistoryBlock[] = [];
            if (typeof entry.thinking === "string" && entry.thinking.trim()) {
              blocks.push({ type: "thinking", thinking: entry.thinking });
            }
            if (typeof entry.content === "string" && entry.content.trim()) {
              blocks.push({ type: "text", text: entry.content });
            }
            if (Array.isArray(entry.tool_calls)) {
              for (const [index, toolCall] of entry.tool_calls.entries()) {
                const name = String(toolCall?.name || toolCall?.tool_name || "tool");
                const id = `agy-history-tool-${entry.step_index ?? messages.length}-${index}`;
                const argumentsValue = parseToolArguments(toolCall?.args ?? toolCall?.arguments);
                blocks.push({
                  type: "toolCall",
                  id,
                  name,
                  arguments: argumentsValue,
                });
                pendingToolCalls.push({ id, name, arguments: argumentsValue });
              }
            }
            if (blocks.length > 0) {
              messages.push({ role: "assistant", content: blocks });
            }
          } else if (
            entry.type === "GENERIC" &&
            typeof entry.content === "string" &&
            pendingToolCalls.length > 0
          ) {
            const toolCall = pendingToolCalls.shift();
            if (toolCall) {
              messages.push({
                role: "toolResult",
                toolName: toolCall.name,
                toolCallId: toolCall.id,
                content: entry.content,
                isError: entry.status === "ERROR",
                details: toolCall.arguments,
              });
            }
          }
        } catch {}
      }
      return maxMessages > 0 ? messages.slice(-maxMessages) : messages;
    } catch {
      return [];
    }
  }

  private ensureHistoryLoaded(maxMessages = DEFAULT_AGY_HISTORY_MESSAGES): void {
    const requestedLimit = Math.max(0, Math.floor(maxMessages));
    const alreadyLoaded =
      this.historyLoadedConversationId === this.conversationId &&
      this.historyLoadedLimit !== null &&
      (this.historyLoadedLimit === 0 || this.historyLoadedLimit >= requestedLimit);
    if (!this.conversationId || alreadyLoaded) {
      return;
    }
    this.historyMessages = this.loadTranscriptHistory(requestedLimit);
    this.historyLoadedConversationId = this.conversationId;
    this.historyLoadedLimit = requestedLimit;
    this.historyIsPartial = requestedLimit > 0;
  }

  private emitQueueUpdate(): void {
    this.emit("event", {
      type: "queue_update",
      steering: this.pendingPrompts
        .filter((prompt) => prompt.kind === "steering")
        .map((prompt) => prompt.message),
      followUp: this.pendingPrompts
        .filter((prompt) => prompt.kind === "followUp")
        .map((prompt) => prompt.message),
    });
  }

  private invalidateProcess(child: ChildProcess): void {
    if (this.process !== child) return;
    this.process = null;
    this.processGeneration++;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.isTurnStreaming = false;
    this.toolCallStates.clear();
  }

  private async terminateChild(
    child: ChildProcess,
    signal: NodeJS.Signals = "SIGTERM"
  ): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(forceKillTimer);
        child.removeListener("close", finish);
        resolve();
      };
      const forceKillTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        } catch {
          // The process may have exited between the status check and kill.
        }
        finish();
      }, 1_000);

      child.once("close", finish);
      try {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill(signal);
        } else {
          finish();
        }
      } catch {
        finish();
      }
    });
  }

  private async resolveLaunchSelection(): Promise<{
    modelId: string;
    effortArg?: string;
    effectiveEffort: string;
  }> {
    const modelId = this.currentModelId;
    const effort = this.currentEffort;
    const suffixMatch = modelId.match(/-(low|medium|high)$/);

    // Models without an effort suffix accept --effort directly.
    if (!suffixMatch) {
      return { modelId, effortArg: effort, effectiveEffort: effort };
    }

    const encodedEffort = suffixMatch[1];
    if (!effort || effort === encodedEffort) {
      return { modelId, effectiveEffort: encodedEffort };
    }

    // AGY rejects a model ID carrying one effort together with a different
    // --effort flag. Prefer the matching sibling when the installed CLI
    // exposes it (for example gemini-3.8-flash-low). Some model families do
    // not publish every effort, so fall back to the encoded model instead of
    // launching a command that the CLI will reject.
    const candidateModelId = `${modelId.slice(0, -encodedEffort.length)}${effort}`;
    const availableModels = await AgyAgentClient.getAvailableModels(this.options.agyPath);
    if (availableModels.some((model) => model.id === candidateModelId)) {
      return { modelId: candidateModelId, effectiveEffort: effort };
    }

    console.warn(
      `[agy] Model ${candidateModelId} is not available; using ${modelId} (${encodedEffort} effort)`
    );
    return { modelId, effectiveEffort: encodedEffort };
  }

  private getAgyDataDir(): string {
    return AgyAgentClient.getAgyDataDir();
  }

  private resetHistoryCache(): void {
    this.historyMessages = [];
    this.historyLoadedConversationId = null;
    this.historyLoadedLimit = null;
    this.historyIsPartial = false;
  }

  private resetUsageState(): void {
    this.usageStateRevision++;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.thinkingTokens = 0;
    this.cacheReadTokens = 0;
    this.totalTokens = 0;
    this.usageKnown = false;
    this.usageObservedAt = 0;
    this.usageModelId = null;
  }

  private async restorePersistedUsage(conversationId: string | null): Promise<void> {
    if (!this.trackUsage) return;
    this.resetUsageState();
    if (!conversationId) return;
    const loadRevision = this.usageStateRevision;
    try {
      const snapshot = await AgyUsageStore.getLatest(conversationId);
      if (
        !snapshot ||
        this.conversationId !== conversationId ||
        this.usageStateRevision !== loadRevision
      ) return;
      this.inputTokens = snapshot.cumulative.input;
      this.outputTokens = snapshot.cumulative.output;
      this.thinkingTokens = snapshot.cumulative.thinking;
      this.cacheReadTokens = snapshot.cumulative.cacheRead;
      this.totalTokens = snapshot.cumulative.total;
      this.usageKnown = true;
      this.usageObservedAt = snapshot.observedAt;
      this.usageModelId = snapshot.model || null;
      this.usageStateRevision++;
    } catch {
      // Usage history is optional and must never prevent a conversation from
      // starting or being restored.
    }
  }

  private persistUsageSnapshot(numTurns: unknown): void {
    if (!this.trackUsage || !this.conversationId || !this.usageKnown) return;
    AgyUsageStore.record({
      conversationId: this.conversationId,
      cwd: this.options.cwd || process.cwd(),
      model: this.currentModelId || "unknown",
      observedAt: Date.now(),
      numTurns:
        typeof numTurns === "number" && Number.isFinite(numTurns)
          ? numTurns
          : undefined,
      cumulative: {
        input: this.inputTokens,
        output: this.outputTokens,
        thinking: this.thinkingTokens,
        cacheRead: this.cacheReadTokens,
        total: this.totalTokens,
      },
    });
  }

  /**
   * Launch `agy` process in stream-json mode and wait for the "init" event.
   */
  async start(): Promise<void> {
    return this.enqueueLifecycle(() => this.startInternal());
  }

  private async startInternal(): Promise<void> {
    if (this.destroyed) throw new Error("Client destroyed");
    if (this.isRunning()) return;

    if (this.startPromise) return this.startPromise;

    const startPromise = this.startProcess();
    this.startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.startPromise === startPromise) this.startPromise = null;
    }
  }

  private async startProcess(): Promise<void> {
    if (this.destroyed) throw new Error("Client destroyed");
    if (this.isRunning()) return;

    const launchSelection = await this.resolveLaunchSelection();
    if (this.destroyed) throw new Error("Client destroyed");
    this.currentModelId = launchSelection.modelId;
    this.currentEffort = launchSelection.effectiveEffort;

    const resolved = resolveAgySpawn(this.options.agyPath);
    const args: string[] = [
      ...resolved.scriptArgs,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--print-timeout", AGY_PRINT_TIMEOUT,
    ];

    // `cwd` controls the child process directory, but AGY's workspace and
    // permission context is established separately. Register the active
    // Obsidian Vault explicitly so AGY resolves files/searches against the
    // same workspace that Pimate is displaying.
    const workspacePath = this.options.workspacePath?.trim();
    if (workspacePath) {
      const resolvedWorkspacePath = path.resolve(workspacePath);
      try {
        if (fs.statSync(resolvedWorkspacePath).isDirectory()) {
          args.push("--add-dir", resolvedWorkspacePath);
        }
      } catch {
        // A non-filesystem Obsidian adapter may not expose a local directory.
        // Keep the existing cwd behavior and let AGY report any real error.
      }
    }

    if (this.options.dangerouslySkipPermissions === true) {
      args.push("--dangerously-skip-permissions");
    }

    // A suffix such as `-high` is part of the model ID. When present, the
    // matching effort is encoded in that ID and must not be passed again.
    if (this.currentModelId) {
      args.push("--model", this.currentModelId);
    }
    if (launchSelection.effortArg) {
      args.push("--effort", launchSelection.effortArg);
    }
    if (this.conversationId) {
      args.push("--conversation", this.conversationId);
    }

    this.destroyed = false;

    const homeDir = process.env.HOME || "";
    const customPath = [
      path.join(homeDir, ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      process.env.PATH || "",
    ].filter(Boolean).join(path.delimiter);

    const spawnOptions: SpawnOptions = {
      cwd: this.options.cwd || process.cwd(),
      env: {
        ...process.env,
        PATH: customPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      let initTimeout: ReturnType<typeof setTimeout> | null = null;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (initTimeout) {
          clearTimeout(initTimeout);
          initTimeout = null;
        }
        if (err) reject(err);
        else resolve();
      };

      try {
        this.snapshotAgyLogFiles();
        const child = spawn(resolved.cmd, args, spawnOptions);
        this.process = child;
        const generation = ++this.processGeneration;
        this.buffer = "";
        this.decoder = new StringDecoder("utf8");

        // Wait up to 20s for the init event
        initTimeout = setTimeout(() => {
          if (!settled) {
            settle(new Error("Timeout waiting for agy init event"));
            this.invalidateProcess(child);
            void this.terminateChild(child);
          }
        }, 20_000);

        this.initResolve = () => {
          settle();
        };
        this.initReject = (err: unknown) => {
          settle(err instanceof Error ? err : new Error(String(err)));
        };

        child.stdout!.on("data", (chunk: Buffer) => {
          if (this.process !== child || this.processGeneration !== generation) return;
          this.handleData(chunk);
        });

        child.stderr!.on("data", (chunk: Buffer) => {
          if (this.process !== child || this.processGeneration !== generation) return;
          const stderr = chunk.toString();
          this.recordTurnStderr(stderr);
          console.warn("[agy stderr]", stderr);
        });

        child.stdin!.on("error", (err) => {
          if (this.process !== child || this.processGeneration !== generation) return;
          console.error("[agy] Input stream error:", err);
          if (!settled) {
            settle(err);
            return;
          }
          // SIGINT/destroy can legitimately close stdin. Do not turn that
          // expected shutdown into a second user-visible failure.
          if (this.abortingProcess === child || this.destroyed) return;
          if (this.isTurnStreaming) {
            this.finishActiveTurnWithError(`AGY input stream error: ${err.message}`);
          } else {
            this.emit("error", err);
          }
        });

        child.on("error", (err) => {
          if (this.process !== child || this.processGeneration !== generation) return;
          console.error("[agy] Process error:", err);
          if (!settled) settle(err);
          else this.emit("error", err);
        });

        child.on("close", (code) => {
          if (this.process !== child || this.processGeneration !== generation) return;
          console.log(`[agy] Process closed with code ${code}`);
          const wasRunningTurn = this.isTurnStreaming;
          const wasExpectedAbort = this.abortingProcess === child;
          if (wasExpectedAbort) this.abortingProcess = null;
          this.process = null;

          if (!settled) {
            this.isTurnStreaming = false;
            this.pendingPrompts = [];
            this.toolCallStates.clear();
            this.emitQueueUpdate();
            settle(new Error(`agy exited with code ${code} before initialization`));
          } else {
            if (wasRunningTurn) {
              this.finishActiveTurnWithError(
                wasExpectedAbort
                  ? "Operation aborted by user"
                  : `Process exited with code ${code}`
              );
            } else {
              this.isTurnStreaming = false;
              this.pendingPrompts = [];
              this.toolCallStates.clear();
              this.emitQueueUpdate();
            }
            // An unexpected close is surfaced. The view restores this same
            // conversation lazily when the user sends the next message.
            if (!wasExpectedAbort) this.emit("close");
          }
        });
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Parse NDJSON lines from agy stdout.
   */
  private handleData(chunk: Buffer): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      line = line.trim();
      if (!line) continue;

      try {
        const parsed = JSON.parse(line);
        this.handleAgyEvent(parsed);
      } catch {
        // Non-JSON diagnostic line from agy, ignore or log
        console.debug("[agy stdout raw]", line);
      }
    }
  }

  /**
   * Adapt official agy stream-json events to Pimate RpcEvents.
   */
  private handleAgyEvent(data: any): void {
    if (!data || typeof data !== "object") return;

    const eventName = data.event;

    // 1. Session Init
    if (eventName === "init") {
      this.conversationId = data.conversation_id || this.conversationId;
      if (typeof data.init?.model === "string" && data.init.model.trim()) {
        this.currentModelId = data.init.model.trim();
      }
      this.availableTools = data.init?.tools || [];
      if (this.initResolve) {
        this.initResolve();
        this.initResolve = null;
        this.initReject = null;
      }
      return;
    }

    // 2. Step Update
    if (eventName === "step_update") {
      const step = data.step_update;
      if (!step) return;

      // User input echo
      if (step.step_type === "user_input") {
        return;
      }

      // Tool call execution
      if (step.step_type === "tool") {
        // Never offer a replay after AGY has started a tool. A disconnected
        // stream cannot prove whether that tool completed remotely.
        if (this.activePrompt) this.activePrompt.hadToolActivity = true;
        const toolCallId = `agy-tool-${step.step_index ?? Date.now()}`;
        const toolName = step.tool_name || step.tool_info?.name || "tool";
        const args = { ...(step.tool_info?.parameters || {}) };

        // Normalize argument keys to help Pimate UI features
        if (args.AbsolutePath && !args.path) args.path = args.AbsolutePath;
        if (args.TargetFile && !args.path) args.path = args.TargetFile;
        if (args.DirectoryPath && !args.path) args.path = args.DirectoryPath;
        if (args.CommandLine && !args.command) args.command = args.CommandLine;

        let outputText = "";
        if (typeof step.tool_info?.output === "string") {
          outputText = step.tool_info.output;
        } else if (step.tool_info?.output !== undefined) {
          outputText = JSON.stringify(step.tool_info.output, null, 2);
        }

        // A tool step can be reported as ACTIVE and then DONE. Render the
        // execution only once, and surface errors carried in tool_info.
        const isError = step.state === "ERROR" || !!step.tool_info?.error;
        const toolState = this.toolCallStates.get(toolCallId);
        if (toolState === "done") return;
        if (step.state === "ACTIVE") {
          if (toolState) return;
          this.toolCallStates.set(toolCallId, "active");
          this.emit("event", {
            type: "tool_execution_start",
            toolCallId,
            toolName,
            args,
          });
          return;
        }

        // Some CLI versions only emit the terminal tool event. Starting it
        // here keeps those versions renderable; ACTIVE/DONE versions get a
        // single start from the ACTIVE branch above.
        if (toolState !== "active") {
          this.emit("event", {
            type: "tool_execution_start",
            toolCallId,
            toolName,
            args,
          });
        }
        this.toolCallStates.set(toolCallId, "done");

        // Emit tool execution end
        this.emit("event", {
          type: "tool_execution_end",
          toolCallId,
          toolName,
          isError,
          result: {
            toolCallId,
            toolName,
            content: [{ type: "text", text: outputText }],
            isError,
            details: args,
          },
        });
        return;
      }

      // Model assistant streaming
      if (step.step_type === "agent_response") {
        if ((step.thinking_delta || step.text_delta) && this.activePrompt) {
          this.activePrompt.receivedModelOutput = true;
        }
        if (step.thinking_delta) {
          this.lastAssistantThinking += step.thinking_delta;
          this.emit("event", {
            type: "message_update",
            assistantMessageEvent: {
              type: "thinking_delta",
              delta: step.thinking_delta,
            },
          });
        }

        if (step.text_delta) {
          this.lastAssistantText += step.text_delta;
          this.emit("event", {
            type: "message_update",
            assistantMessageEvent: {
              type: "text_delta",
              delta: step.text_delta,
            },
          });
        }

        if (step.usage) {
          this.updateUsage(step.usage);
        }
        return;
      }
    }

    // 3. Turn Result
    if (eventName === "result") {
      const result = data.result;
      if (!this.isTurnStreaming) {
        // A CLI validation/authentication failure can be reported as a result
        // before init (for example an invalid model/effort combination).
        // Reject startup immediately so the UI receives the useful AGY error
        // instead of waiting for the generic init timeout.
        if (result?.status !== "SUCCESS" && this.initReject) {
          const rejectInit = this.initReject;
          this.initResolve = null;
          this.initReject = null;
          rejectInit(new Error(result?.error || "Antigravity initialization failed"));
        }
        return;
      }
      if (result?.usage) {
        this.updateUsage(result.usage);
        if (result.status === "SUCCESS") {
          this.persistUsageSnapshot(result.num_turns);
        }
      }

      if (result?.status === "SUCCESS") {
        this.activePrompt = null;
        this.retryablePrompt = null;
        const responseText = result.response || this.lastAssistantText;
        const blocks: AgyHistoryBlock[] = [];
        if (this.lastAssistantThinking) {
          blocks.push({ type: "thinking", thinking: this.lastAssistantThinking });
        }
        blocks.push({ type: "text", text: responseText });
        this.historyMessages.push({
          role: "assistant",
          content: blocks,
        });

        this.emit("event", {
          type: "message_update",
          assistantMessageEvent: {
            type: "done",
          },
        });
        this.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: blocks,
          },
        });
      } else {
        const resultError =
          typeof result?.error === "string" ? result.error : "";
        const resultStatus = String(result?.status || "");
        const wasCancelled = /(cancel|abort|interrupt)/i.test(
          `${resultStatus} ${resultError}`
        );
        const errorMsg = wasCancelled
          ? "Operation aborted by user"
          : resultError || "Agent execution failed";
        // Some AGY versions provide a final response only on the result
        // frame. Treat it as output too, so it can never qualify for replay.
        if ((this.lastAssistantText || result?.response) && this.activePrompt) {
          this.activePrompt.receivedModelOutput = true;
        }
        const failure = this.prepareFailure(
          errorMsg,
          this.pendingPrompts.length === 0
        );
        this.emit("event", {
          type: "message_update",
          assistantMessageEvent: {
            type: "error",
            reason: errorMsg,
            errorCategory: failure.category,
            retryable: failure.retryable,
            diagnostic: failure.diagnostic,
          },
        });
        this.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: this.lastAssistantText,
          },
        });
      }

      this.emit("event", { type: "agent_end" });
      this.emit("event", { type: "turn_end" });

      const nextPrompt = this.pendingPrompts.shift();
      this.emitQueueUpdate();
      if (nextPrompt) {
        try {
          this.beginPrompt(nextPrompt.message, nextPrompt.options);
        } catch (err) {
          this.finishActiveTurnWithError(`Failed to send queued prompt: ${(err as Error).message}`);
        }
      } else {
        this.isTurnStreaming = false;
        this.emit("event", { type: "agent_settled" });
      }
      return;
    }
  }

  private finishActiveTurnWithError(reason: string): void {
    const partialText = this.lastAssistantText;
    const failure = this.prepareFailure(reason, this.pendingPrompts.length === 0);
    this.pendingPrompts = [];
    this.toolCallStates.clear();
    this.emitQueueUpdate();
    this.isTurnStreaming = false;
    this.emit("event", {
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason,
        errorCategory: failure.category,
        retryable: failure.retryable,
        diagnostic: failure.diagnostic,
      },
    });
    this.emit("event", {
      type: "message_end",
      message: { role: "assistant", content: partialText },
    });
    this.emit("event", { type: "agent_end" });
    this.emit("event", { type: "turn_end" });
    this.emit("event", { type: "agent_settled" });
  }

  /**
   * Retain only enough diagnostics to explain a failed turn. AGY normally
   * writes its detailed Go log to disk, but some builds also write useful
   * transport errors to stderr.
   */
  private recordTurnStderr(stderr: string): void {
    if (!this.isTurnStreaming || !stderr) return;
    this.recentTurnStderr = `${this.recentTurnStderr}${stderr}`.slice(-8_000);
  }

  private snapshotAgyLogFiles(): void {
    this.agyLogOffsets.clear();
    const logDir = path.join(AgyAgentClient.getAgyDataDir(), "log");
    let names: string[];
    try {
      names = fs.readdirSync(logDir);
    } catch {
      return;
    }

    for (const name of names) {
      if (name !== "cli.log" && !/^cli-.*\.log$/i.test(name)) continue;
      const filePath = path.join(logDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) this.agyLogOffsets.set(filePath, stat.size);
      } catch {
        // The CLI can rotate a log between readdir and stat.
      }
    }
  }

  private readNewAgyLogDiagnostics(): string | undefined {
    const logDir = path.join(AgyAgentClient.getAgyDataDir(), "log");
    let names: string[];
    try {
      names = fs.readdirSync(logDir);
    } catch {
      return undefined;
    }

    const relevant: string[] = [];
    for (const name of names) {
      if (name !== "cli.log" && !/^cli-.*\.log$/i.test(name)) continue;
      const filePath = path.join(logDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        let previousOffset = this.agyLogOffsets.get(filePath) || 0;
        if (stat.size < previousOffset) {
          previousOffset = 0;
        }
        if (stat.size <= previousOffset) continue;

        const contents = fs.readFileSync(filePath);
        const start = Math.min(previousOffset, contents.length);
        this.agyLogOffsets.set(filePath, contents.length);
        for (const rawLine of contents.subarray(start).toString("utf8").split(/\r?\n/)) {
          const line = rawLine
            .trim()
            .replace(/^ERROR: logging before google\.Init:\s*/, "");
          if (!line) continue;
          if (
            /agent executor error|calling model: request failed|broken pipe|connection (?:reset|refused|closed)|timeout|timed out|failed to install playwright|browser context|not logged in|unauthenticated|quota|permission denied|access denied/i.test(
              line
            )
          ) {
            relevant.push(line);
          }
        }
      } catch {
        // Log rotation or an in-progress write must not break the turn UI.
      }
    }

    return relevant.slice(-3).join(" · ").slice(-1_200) || undefined;
  }

  private classifyFailure(reason: string): AgyFailureCategory {
    const normalized = reason.toLowerCase();
    if (/(cancel|abort|interrupt|context canceled)/i.test(normalized)) {
      return "cancelled";
    }
    if (/(quota|rate limit|resource exhausted|too many requests|\b429\b)/i.test(normalized)) {
      return "quota";
    }
    if (/(auth|sign[ -]?in|login|credential|unauthenticated|\b401\b|\b403\b)/i.test(normalized)) {
      return "authentication";
    }
    if (/(permission|access denied|not allowed)/i.test(normalized)) {
      return "permission";
    }
    if (/(timeout|timed out|deadline exceeded)/i.test(normalized)) {
      return "timeout";
    }
    if (/(broken pipe|connection (?:reset|refused|closed)|network|i\/o timeout|timed out|\beof\b|stream (?:was )?interrupted|temporarily unavailable)/i.test(normalized)) {
      return "network";
    }
    if (/(process exited|agy exited|child process|exit code|signal)/i.test(normalized)) {
      return "process";
    }
    return "unknown";
  }

  private getTurnDiagnostic(): string | undefined {
    const stderrRelevant = this.recentTurnStderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /error|fail|broken pipe|timeout|reset|denied|quota/i.test(line));
    const logDetail = this.readNewAgyLogDiagnostics();
    const detail = [...stderrRelevant.slice(-2), ...(logDetail ? [logDetail] : [])]
      .join(" · ")
      .slice(-1_000);
    return detail || undefined;
  }

  /**
   * A retry is intentionally opt-in and offered once only. It is eligible
   * solely when this adapter received neither model output nor a tool event,
   * and when there are no queued prompts that would change turn ordering.
   */
  private prepareFailure(reason: string, noQueuedPrompts: boolean): AgyFailureInfo {
    const diagnostic = this.getTurnDiagnostic();
    const category = this.classifyFailure(`${reason}\n${diagnostic || ""}`);
    const activePrompt = this.activePrompt;
    const retryable =
      category !== "cancelled" &&
      category !== "authentication" &&
      category !== "quota" &&
      category !== "permission" &&
      noQueuedPrompts &&
      !!activePrompt &&
      activePrompt.retryAttempt === 0 &&
      !activePrompt.receivedModelOutput &&
      !activePrompt.hadToolActivity;

    if (retryable && activePrompt) {
      this.retryablePrompt = {
        message: activePrompt.message,
        options: activePrompt.options,
        retryAttempt: activePrompt.retryAttempt,
      };
    } else {
      this.retryablePrompt = null;
    }
    this.activePrompt = null;

    return {
      category,
      retryable,
      diagnostic,
    };
  }

  private beginPrompt(
    message: string,
    options?: AgyPromptOptions,
    retryAttempt = 0
  ): void {
    this.ensureHistoryLoaded();
    this.lastAssistantText = "";
    this.lastAssistantThinking = "";
    this.isTurnStreaming = true;
    this.toolCallStates.clear();
    this.retryablePrompt = null;
    this.recentTurnStderr = "";
    this.activePrompt = {
      message,
      options,
      retryAttempt,
      receivedModelOutput: false,
      hadToolActivity: false,
    };

    this.historyMessages.push({
      role: "user",
      content: [{ type: "text", text: message }],
    });

    // Emit initial stream lifecycle events for UI
    this.emit("event", { type: "turn_start" });
    this.emit("event", { type: "agent_start" });
    this.emit("event", {
      type: "message_start",
      message: { role: "user", content: message, retry: retryAttempt > 0 },
    });
    this.emit("event", {
      type: "message_start",
      message: { role: "assistant" },
    });

    const payload = JSON.stringify({
      event: "user",
      message: { content: message },
    }) + "\n";

    const input = this.process?.stdin;
    if (!input || input.destroyed || input.writableEnded) {
      throw new Error("AGY input stream is not writable");
    }
    input.write(payload);
  }

  private updateUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  }): void {
    let updated = false;
    if (typeof usage.input_tokens === "number") {
      this.inputTokens = usage.input_tokens;
      updated = true;
    }
    if (typeof usage.output_tokens === "number") {
      this.outputTokens = usage.output_tokens;
      updated = true;
    }
    if (typeof usage.thinking_tokens === "number") {
      this.thinkingTokens = usage.thinking_tokens;
      updated = true;
    }
    if (typeof usage.cache_read_tokens === "number") {
      this.cacheReadTokens = usage.cache_read_tokens;
      updated = true;
    }
    if (typeof usage.total_tokens === "number") {
      this.totalTokens = usage.total_tokens;
      updated = true;
    }
    if (updated) {
      this.usageStateRevision++;
      this.usageKnown = true;
      this.usageObservedAt = Date.now();
      this.usageModelId = this.currentModelId;
    }
  }

  /**
   * Send a prompt to Antigravity CLI over stdin stream.
   */
  async prompt(
    message: string,
    options?: AgyPromptOptions
  ): Promise<RpcResponse> {
    if (this.destroyed) throw new Error("Client destroyed");
    if (options?.images?.length) {
      return {
        type: "response",
        command: "prompt",
        success: false,
        error: "Antigravity CLI image attachments are not supported by this adapter yet",
      };
    }
    if (!this.isRunning()) {
      await this.start();
    }

    try {
      if (this.isTurnStreaming) {
        this.pendingPrompts.push({
          message,
          options,
          kind: options?.streamingBehavior === "steer" ? "steering" : "followUp",
        });
        this.emitQueueUpdate();
      } else {
        try {
          this.beginPrompt(message, options);
        } catch (err) {
          this.historyMessages.pop();
          this.finishActiveTurnWithError(`Failed to send prompt: ${(err as Error).message}`);
          throw err;
        }
      }
      return {
        type: "response",
        command: "prompt",
        success: true,
      };
    } catch (err) {
      this.isTurnStreaming = false;
      throw err;
    }
  }

  /**
   * Retry the immediately preceding failed turn once, only after
   * `prepareFailure` established that no model output or tool event reached
   * this adapter. This is deliberately user-invoked; Pimate never retries a
   * potentially side-effecting turn on its own.
   */
  async retryLastFailedPrompt(): Promise<RpcResponse> {
    if (this.destroyed) {
      return {
        type: "response",
        command: "retry_last_failed_prompt",
        success: false,
        error: "Antigravity client is no longer available",
      };
    }
    if (this.isTurnStreaming) {
      return {
        type: "response",
        command: "retry_last_failed_prompt",
        success: false,
        error: "Wait for the current Antigravity turn to finish before retrying",
      };
    }
    const retry = this.retryablePrompt;
    if (!retry) {
      return {
        type: "response",
        command: "retry_last_failed_prompt",
        success: false,
        error: "This Antigravity turn is not safe to retry automatically",
      };
    }

    this.retryablePrompt = null;
    if (!this.isRunning()) {
      await this.start();
    }
    try {
      this.beginPrompt(retry.message, retry.options, retry.retryAttempt + 1);
      return {
        type: "response",
        command: "retry_last_failed_prompt",
        success: true,
      };
    } catch (err) {
      this.historyMessages.pop();
      this.finishActiveTurnWithError(`Failed to retry prompt: ${(err as Error).message}`);
      throw err;
    }
  }

  /**
   * Queue steer message (equivalent to prompt for AGY).
   */
  async steer(
    message: string,
    options?: { images?: Array<{ type: string; data: string; mimeType: string }> }
  ): Promise<RpcResponse> {
    return this.prompt(message, { ...options, streamingBehavior: "steer" });
  }

  /**
   * Queue follow-up message (equivalent to prompt for AGY).
   */
  async followUp(
    message: string,
    options?: { images?: Array<{ type: string; data: string; mimeType: string }> }
  ): Promise<RpcResponse> {
    return this.prompt(message, { ...options, streamingBehavior: "followUp" });
  }

  /**
   * Abort the active turn.
   */
  async abort(): Promise<RpcResponse> {
    const hadActiveTurn = this.isTurnStreaming;
    const partialText = this.lastAssistantText;
    const child = this.process;
    this.retryablePrompt = null;
    this.pendingPrompts = [];
    this.emitQueueUpdate();

    if (!child || child.exitCode !== null || child.signalCode !== null) {
      if (hadActiveTurn) {
        this.lastAssistantText = partialText;
        this.finishActiveTurnWithError("Operation aborted by user");
      }
      return { type: "response", command: "abort", success: true };
    }

    // Interactive AGY maps its interrupt key to a turn-level cancellation.
    // Headless mode does not document a separate cancel frame, so first send
    // SIGINT and keep routing events while AGY has a chance to emit its normal
    // terminal result. Only a non-responsive child is force-terminated below.
    this.abortingProcess = child;
    const outcomePromise = this.waitForAbortOutcome(child, AGY_ABORT_GRACE_MS);
    try {
      child.kill("SIGINT");
    } catch {
      // The close/timeout path below still provides a safe fallback.
    }

    const outcome = await outcomePromise;
    if (outcome === "settled" || outcome === "closed") {
      if (outcome === "settled" && this.process === child) {
        // A headless AGY build may emit its cancellation result immediately
        // and close the process on the following event-loop turn. Keep the
        // expected-abort marker alive long enough to cover that race.
        await this.waitForProcessClose(child, AGY_ABORT_CLOSE_GRACE_MS);
      }
      if (this.abortingProcess === child) {
        this.abortingProcess = null;
      }
      return { type: "response", command: "abort", success: true };
    }

    // A stuck headless process must not continue running tools after the user
    // presses Stop. Invalidate it before the hard kill so late output cannot
    // be routed into a later prompt.
    if (this.process === child) {
      this.invalidateProcess(child);
      if (this.abortingProcess === child) this.abortingProcess = null;
      await this.terminateChild(child, "SIGKILL");
      if (hadActiveTurn) {
        this.lastAssistantText = partialText;
        this.finishActiveTurnWithError("Operation aborted by user");
      }
    }

    return { type: "response", command: "abort", success: true };
  }

  /**
   * Authoritative state getter.
   */
  async getState(): Promise<RpcResponse<PiAgentState>> {
    return {
      type: "response",
      command: "get_state",
      success: true,
      data: {
        isStreaming: this.isTurnStreaming,
        pendingMessageCount: this.pendingPrompts.length,
        model: {
          id: this.currentModelId,
          provider: "antigravity",
          name: this.currentModelId,
          reasoning: true,
          thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
        },
        thinkingLevel: this.currentEffort,
        sessionId: this.conversationId || undefined,
        sessionName: "Antigravity Session",
      },
    };
  }

  /**
   * Set model. If the process is currently running, restarts with the new model.
   */
  async setModel(
    provider: string,
    modelId: string
  ): Promise<RpcResponse<SetModelResult>> {
    if (this.currentModelId === modelId && this.isRunning()) {
      return {
        type: "response",
        command: "set_model",
        success: true,
        data: {
          id: modelId,
          provider: "antigravity",
          name: modelId,
          reasoning: true,
          thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
        },
      };
    }
    if (this.isTurnStreaming) {
      return {
        type: "response",
        command: "set_model",
        success: false,
        error: "Wait for the current Antigravity turn to finish before changing models",
      };
    }
    this.currentModelId = modelId;
    if (this.isRunning() && !this.isTurnStreaming) {
      await this.restart();
    }
    return {
      type: "response",
      command: "set_model",
      success: true,
      data: {
        id: modelId,
        provider: "antigravity",
        name: modelId,
        reasoning: true,
        thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
      },
    };
  }

  /**
   * Set thinking effort level.
   */
  async setThinkingLevel(level: string): Promise<RpcResponse> {
    if (this.currentEffort === level && this.isRunning()) {
      return {
        type: "response",
        command: "set_thinking_level",
        success: true,
      };
    }
    if (this.isTurnStreaming) {
      return {
        type: "response",
        command: "set_thinking_level",
        success: false,
        error: "Wait for the current Antigravity turn to finish before changing effort",
      };
    }
    this.currentEffort = level;
    if (this.isRunning() && !this.isTurnStreaming) {
      await this.restart();
    }
    return {
      type: "response",
      command: "set_thinking_level",
      success: true,
    };
  }

  /**
   * Fetch available models using `agy models`.
   */
  async getAvailableModels(): Promise<RpcResponse<AvailableModelsResult>> {
    const models = await AgyAgentClient.getAvailableModels(this.options.agyPath);
    if (models.length === 0) {
      return {
        type: "response",
        command: "get_available_models",
        success: false,
        error: "Unable to query available Antigravity models",
      };
    }
    return {
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models },
    };
  }

  async getMessages(options: { limit?: number } = {}): Promise<RpcResponse> {
    const limit = options.limit;
    this.ensureHistoryLoaded(
      typeof limit === "number" && Number.isFinite(limit)
        ? limit
        : DEFAULT_AGY_HISTORY_MESSAGES
    );
    return {
      type: "response",
      command: "get_messages",
      success: true,
      data: {
        messages: this.historyMessages,
        totalMessages: this.historyMessages.length,
        partialHistory: this.historyIsPartial,
      },
    };
  }

  async getCommands(): Promise<RpcResponse> {
    return {
      type: "response",
      command: "get_commands",
      success: true,
      data: { commands: [] },
    };
  }

  async getSessionStats(options: { includeHistory?: boolean } = {}): Promise<RpcResponse> {
    await this.usageLoadPromise;
    const includeHistory = options.includeHistory !== false;
    if (includeHistory) this.ensureHistoryLoaded();
    const cost = this.usageKnown
      ? calculateAgyCost(this.usageModelId || this.currentModelId, {
        input: this.inputTokens,
        output: this.outputTokens,
        thinking: this.thinkingTokens,
        cacheRead: this.cacheReadTokens,
        total: this.totalTokens,
      }, this.usageObservedAt || Date.now())
      : null;
    return {
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        totalMessages: includeHistory ? this.historyMessages.length : undefined,
        tokens: {
          total: this.totalTokens,
          input: this.inputTokens,
          output: this.outputTokens,
          thinking: this.thinkingTokens,
          cacheRead: this.cacheReadTokens,
        },
        cost: cost ?? 0,
        costKnown: cost !== null,
        costEstimated: cost !== null,
        contextUsage: undefined,
        totalTokens: this.totalTokens,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        thinkingTokens: this.thinkingTokens,
        cacheReadTokens: this.cacheReadTokens,
        usageKnown: this.usageKnown,
        usageObservedAt: this.usageObservedAt || undefined,
        partialHistory: includeHistory ? this.historyIsPartial : undefined,
      },
    };
  }

  /**
   * Switch or resume a previous conversation by ID.
   */
  async switchSession(conversationId: string): Promise<RpcResponse> {
    const nextConversationId = conversationId.trim();
    const workspacePath = this.options.workspacePath || this.options.cwd;
    const workspaceStatus = AgyAgentClient.getConversationWorkspaceStatus(
      nextConversationId,
      workspacePath
    );
    if (workspaceStatus === "missing") {
      return {
        type: "response",
        command: "switch_session",
        success: false,
        error: "Antigravity conversation was not found",
      };
    }
    if (workspacePath && workspaceStatus === "foreign") {
      return {
        type: "response",
        command: "switch_session",
        success: false,
        error: "Antigravity conversation belongs to another workspace",
      };
    }

    return this.enqueueLifecycle(() => this.switchSessionInternal(nextConversationId));
  }

  private async switchSessionInternal(conversationId: string): Promise<RpcResponse> {
    if (this.isTurnStreaming) {
      return {
        type: "response",
        command: "switch_session",
        success: false,
        error: "Wait for the current Antigravity turn to finish before switching conversations",
      };
    }

    const previousConversationId = this.conversationId;
    this.conversationId = conversationId;
    this.resetHistoryCache();
    this.usageLoadPromise = this.restorePersistedUsage(conversationId);
    await this.usageLoadPromise;

    try {
      await this.destroyInternal();
      this.destroyed = false;
      await this.startInternal();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);

      // A failed restore must not leave the tab holding a destroyed client.
      // Reconnect the previous conversation so the user can retry without
      // restarting Obsidian.
      this.conversationId = previousConversationId;
      this.resetHistoryCache();
      this.usageLoadPromise = this.restorePersistedUsage(previousConversationId);
      await this.usageLoadPromise;
      this.destroyed = false;
      await this.startInternal().catch(() => undefined);
      return {
        type: "response",
        command: "switch_session",
        success: false,
        error: `Failed to restore Antigravity conversation: ${reason}`,
      };
    }

    if (this.conversationId !== conversationId) {
      const actualConversationId = this.conversationId;
      await this.destroyInternal();
      this.conversationId = previousConversationId;
      this.resetHistoryCache();
      this.usageLoadPromise = this.restorePersistedUsage(previousConversationId);
      await this.usageLoadPromise;
      this.destroyed = false;
      await this.startInternal().catch(() => undefined);
      return {
        type: "response",
        command: "switch_session",
        success: false,
        error: `Antigravity did not restore the requested conversation (opened ${actualConversationId || "a new conversation"})`,
      };
    }

    return {
      type: "response",
      command: "switch_session",
      success: true,
    };
  }

  async fork(entryId: string): Promise<RpcResponse> {
    return {
      type: "response",
      command: "fork",
      success: false,
      error: "Branching/forking is not supported by Antigravity CLI",
    };
  }

  async getForkMessages(): Promise<RpcResponse<ForkMessagesResult>> {
    return {
      type: "response",
      command: "get_fork_messages",
      success: false,
      error: "Branching/forking is not supported by Antigravity CLI",
    };
  }

  async getEntries(): Promise<RpcResponse<SessionEntriesResult>> {
    return {
      type: "response",
      command: "get_entries",
      success: false,
      error: "Session entry trees are not exposed by Antigravity CLI",
    };
  }

  async clone(): Promise<RpcResponse> {
    return {
      type: "response",
      command: "clone",
      success: false,
      error: "Session cloning is not supported by Antigravity CLI",
    };
  }

  async exportHtml(): Promise<RpcResponse> {
    return {
      type: "response",
      command: "export_html",
      success: false,
      error: "HTML export is not supported by Antigravity CLI",
    };
  }

  async compact(): Promise<RpcResponse> {
    return {
      type: "response",
      command: "compact",
      success: false,
      error: "Context compaction is not exposed by Antigravity CLI",
    };
  }

  async bash(command: string): Promise<RpcResponse> {
    return {
      type: "response",
      command: "bash",
      success: false,
      error: "Direct Bash mode is only supported by the Pi engine; ask Antigravity in a normal prompt to run a command",
    };
  }

  async getLastAssistantText(): Promise<RpcResponse> {
    let text = this.lastAssistantText;
    if (!text) {
      this.ensureHistoryLoaded();
      for (let i = this.historyMessages.length - 1; i >= 0; i--) {
        const m = this.historyMessages[i];
        if (m.role === "assistant") {
          const textBlock = m.content.find((b) => b.type === "text");
          if (textBlock?.text) {
            text = textBlock.text;
            break;
          }
        }
      }
    }
    return {
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: { text },
    };
  }

  async promptAndWait(message: string): Promise<RpcResponse> {
    await this.prompt(message);
    await this.waitForAgentSettled();
    return this.getLastAssistantText();
  }

  private waitForAgentSettled(timeoutMs = AGY_PROMPT_WAIT_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off("event", onEvent);
        reject(new Error("Timed out waiting for agy response"));
      }, timeoutMs);

      const onEvent = (event: RpcEvent) => {
        if (event.type === "agent_settled") {
          clearTimeout(timeout);
          this.off("event", onEvent);
          resolve();
        }
      };
      this.on("event", onEvent);
    });
  }

  private waitForAbortOutcome(
    child: ChildProcess,
    timeoutMs: number
  ): Promise<"settled" | "closed" | "timeout"> {
    return new Promise((resolve) => {
      let finished = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: "settled" | "closed" | "timeout") => {
        if (finished) return;
        finished = true;
        if (timeout) clearTimeout(timeout);
        this.off("event", onEvent);
        child.off("close", onClose);
        resolve(outcome);
      };
      const onEvent = (event: RpcEvent) => {
        if (event.type === "agent_settled") finish("settled");
      };
      const onClose = () => finish("closed");

      timeout = setTimeout(() => finish("timeout"), timeoutMs);
      this.on("event", onEvent);
      child.once("close", onClose);
    });
  }

  private waitForProcessClose(
    child: ChildProcess,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let finished = false;
      const finish = (closed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        child.off("close", onClose);
        resolve(closed);
      };
      const onClose = () => finish(true);
      const timeout = setTimeout(() => finish(false), timeoutMs);

      child.once("close", onClose);
    });
  }

  sendUIResponse(id: string, response: Record<string, unknown>): void {
    // AGY runs headlessly without the Pi extension UI protocol.
  }

  async reloadExtensionsViaBridge(bridgePath: string): Promise<any> {
    return {
      success: false,
      fallbackToRestart: false,
      error: "Extension reload is not supported by Antigravity CLI",
    };
  }

  async restart(): Promise<void> {
    return this.enqueueLifecycle(() => this.restartInternal());
  }

  private async restartInternal(): Promise<void> {
    await this.destroyInternal();
    this.destroyed = false;
    await this.startInternal();
  }

  async destroy(): Promise<void> {
    return this.enqueueLifecycle(() => this.destroyInternal());
  }

  private async destroyInternal(): Promise<void> {
    if (this.destroyed && !this.process && !this.startPromise) return;
    this.destroyed = true;
    this.pendingPrompts = [];
    this.activePrompt = null;
    this.retryablePrompt = null;
    this.recentTurnStderr = "";
    this.emitQueueUpdate();
    this.isTurnStreaming = false;
    this.toolCallStates.clear();
    this.processGeneration++;

    if (this.initReject) {
      this.initReject(new Error("Client destroyed"));
      this.initResolve = null;
      this.initReject = null;
    }

    if (this.process) {
      const p = this.process;
      this.process = null;
      if (this.abortingProcess === p) this.abortingProcess = null;

      await this.terminateChild(p);
    }

    // A model/effort reconciliation may still be probing `agy models` before
    // spawning. Wait for that startup attempt to observe `destroyed` and
    // finish before a restart can begin a second process.
    const pendingStart = this.startPromise;
    if (pendingStart) await pendingStart.catch(() => undefined);
    await AgyUsageStore.flush();
  }

  // ─── Static Helpers ────────────────────────────────────────────────────────

  private static getAgyDataDir(): string {
    const home = process.env.HOME || os.homedir();
    return path.join(home, ".gemini", "antigravity-cli");
  }

  static conversationExists(conversationId: string): boolean {
    const id = conversationId.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
      return false;
    }
    const dataDir = AgyAgentClient.getAgyDataDir();
    return (
      fs.existsSync(path.join(dataDir, "conversations", `${id}.db`)) ||
      fs.existsSync(path.join(dataDir, "brain", id))
    );
  }

  static getConversationSummary(conversationId: string): AgyConversationSummary | undefined {
    const key = conversationId.trim().toLowerCase();
    if (!key) return undefined;
    return AgyAgentClient.listConversations().find(
      (summary) => summary.conversationId.toLowerCase() === key
    );
  }

  /** Normalize an AGY workspace URI/path into the same form as process.cwd(). */
  static normalizeWorkspacePath(workspace?: string): string {
    const raw = workspace?.trim() || "";
    if (!raw) return "";
    try {
      const filePath = raw.startsWith("file://")
        ? raw.slice("file://".length)
        : raw;
      return path.resolve(decodeURIComponent(filePath)).replace(/\\/g, "/");
    } catch {
      return raw.replace(/\\/g, "/");
    }
  }

  static belongsToWorkspace(summary: AgyConversationSummary, workspace?: string): boolean {
    const target = AgyAgentClient.normalizeWorkspacePath(workspace);
    return !!target && summary.workspaceUris.some(
      (uri) => AgyAgentClient.normalizeWorkspacePath(uri) === target
    );
  }

  static getConversationWorkspaceStatus(
    conversationId: string,
    workspace?: string
  ): AgyConversationWorkspaceStatus {
    const id = conversationId.trim();
    if (!id || !AgyAgentClient.conversationExists(id)) return "missing";

    const target = AgyAgentClient.normalizeWorkspacePath(workspace);
    if (!target) return "unassigned";

    const summary = AgyAgentClient.getConversationSummary(id);
    if (!summary || summary.workspaceUris.length === 0) return "unassigned";
    return AgyAgentClient.belongsToWorkspace(summary, target) ? "current" : "foreign";
  }

  /**
   * Read AGY's persistent conversation metadata cache. The cache is the same
   * source used by the native `/resume` picker; the actual `.db` file check
   * keeps stale cache records out of Pimate's list.
   */
  static listConversations(cwd?: string): AgyConversationSummary[] {
    const dataDir = AgyAgentClient.getAgyDataDir();
    const metadataPath = path.join(dataDir, "cache", "conversation_metadata.json");
    const conversationsDir = path.join(dataDir, "conversations");

    let metadata: Record<string, any> = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
      if (parsed?.conversations && typeof parsed.conversations === "object") {
        metadata = parsed.conversations;
      }
    } catch {
      // AGY may be updating the cache, or an older version may not have it.
    }

    const conversationMtimes = new Map<string, number>();
    try {
      for (const name of fs.readdirSync(conversationsDir)) {
        const match = name.match(
          /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.db$/i
        );
        if (!match) continue;
        try {
          const stat = fs.statSync(path.join(conversationsDir, name));
          if (stat.isFile()) conversationMtimes.set(match[1].toLowerCase(), stat.mtimeMs);
        } catch {
          // A conversation can be removed while the directory is scanned.
        }
      }
    } catch {
      // The brain directory below may still contain recoverable sessions.
    }
    try {
      const brainDir = path.join(dataDir, "brain");
      for (const name of fs.readdirSync(brainDir)) {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(name)) {
          continue;
        }
        const key = name.toLowerCase();
        if (conversationMtimes.has(key)) continue;
        try {
          const stat = fs.statSync(path.join(brainDir, name));
          if (stat.isDirectory()) conversationMtimes.set(key, stat.mtimeMs);
        } catch {
          // A conversation can be removed while the directory is scanned.
        }
      }
    } catch {
      // Return records backed by the conversations directory when brain is unavailable.
    }

    const summaries: AgyConversationSummary[] = [];
    for (const [key, record] of Object.entries(metadata)) {
      const summary = record?.summary;
      if (!summary || typeof summary !== "object") continue;

      const conversationId =
        typeof summary.ID === "string" && summary.ID.trim() ? summary.ID.trim() : key;
      const conversationKey = conversationId.toLowerCase();
      if (!conversationMtimes.has(conversationKey)) continue;

      const stepCount = Number(summary.NumSteps) || 0;
      // Match AGY's native picker behavior: empty startup shells are not
      // recoverable conversations and should not clutter the list.
      if (stepCount <= 0) continue;

      const workspaceUris = Array.isArray(summary.WorkspaceURIs)
        ? summary.WorkspaceURIs.filter((uri: unknown): uri is string => typeof uri === "string")
        : [];
      const updatedAt = Date.parse(
        typeof record.last_modified_time === "string"
          ? record.last_modified_time
          : typeof summary.UpdatedAt === "string"
            ? summary.UpdatedAt
            : ""
      );
      summaries.push({
        conversationId,
        title: typeof summary.Title === "string" ? summary.Title.trim() : "",
        preview: typeof summary.Preview === "string" ? summary.Preview.trim() : "",
        mtime: Number.isFinite(updatedAt) ? updatedAt : conversationMtimes.get(conversationKey) || 0,
        stepCount,
        workspaceUris,
      });
    }

    let filtered = summaries;
    if (cwd) {
      // Do not treat AGY's unscoped print-mode records as belonging to the
      // current vault. Pimate has its own ownership index for records it
      // created or the user explicitly imports; this low-level method only
      // trusts an explicit AGY workspace URI.
      filtered = summaries.filter((summary) =>
        AgyAgentClient.belongsToWorkspace(summary, cwd)
      );
    }

    return filtered.sort((a, b) => b.mtime - a.mtime);
  }

  /**
   * Query available models from `agy models`.
   */
  static async getAvailableModels(userAgyPath?: string): Promise<PiModel[]> {
    const resolved = resolveAgySpawn(userAgyPath);

    return new Promise((resolve) => {
      execFile(
        resolved.cmd,
        [...resolved.scriptArgs, "models"],
        { timeout: 15000, env: process.env },
        (err, stdout) => {
          if (err || !stdout) {
            return resolve([]);
          }

          const lines = stdout.split("\n");
          const models: PiModel[] = [];

          for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.startsWith("Fetching")) continue;

            const parts = line.split(/\t+/);
            if (parts.length >= 2) {
              const id = parts[0].trim();
              const name = parts[1].trim();
              models.push({
                id,
                provider: "antigravity",
                name,
                reasoning: true,
                thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
              });
            } else {
              const spaceParts = line.split(/\s{2,}/);
              if (spaceParts.length >= 2) {
                const id = spaceParts[0].trim();
                const name = spaceParts[1].trim();
                models.push({
                  id,
                  provider: "antigravity",
                  name,
                  reasoning: true,
                  thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
                });
              }
            }
          }

          resolve(models);
        }
      );
    });
  }

  /**
   * Check whether agy is installed and whether Google OAuth is authenticated.
   */
  static async checkAuthStatus(
    userAgyPath?: string
  ): Promise<{ installed: boolean; authenticated: boolean | null; version?: string; error?: string }> {
    const resolved = resolveAgySpawn(userAgyPath);

    // 1. Check version
    const versionRes = await new Promise<{ ok: boolean; version?: string; error?: string }>((res) => {
      execFile(
        resolved.cmd,
        [...resolved.scriptArgs, "--version"],
        { timeout: 5000, env: process.env },
        (err, stdout, stderr) => {
          if (err) {
            return res({ ok: false, error: err.message || stderr });
          }
          res({ ok: true, version: stdout.trim() });
        }
      );
    });

    if (!versionRes.ok) {
      return {
        installed: false,
        authenticated: false,
        error: versionRes.error,
      };
    }

    // 2. Check auth by querying models
    const authRes = await new Promise<{ status: boolean | null; error?: string }>((res) => {
      execFile(
        resolved.cmd,
        [...resolved.scriptArgs, "models"],
        { timeout: 15000, env: process.env },
        (err, stdout, stderr) => {
          const diagnostic = [stderr?.trim(), err?.message].filter(Boolean).join(" ");
          if (err || !stdout) {
            // `agy models` is a network/service probe, not a reliable local
            // OAuth check. Treat transient failures as unknown instead of
            // telling the user that their cached credentials are invalid.
            if (/auth|login|credential|unauthor/i.test(diagnostic)) {
              return res({ status: false, error: diagnostic });
            }
            return res({ status: null, error: diagnostic || "Could not query available models" });
          }
          // If models list contains known model names or has at least 1 model
          if (stdout.includes("gemini") || stdout.includes("claude") || stdout.includes("gpt")) {
            return res({ status: true });
          }
          res({ status: null, error: "agy returned no recognizable model list" });
        }
      );
    });

    return {
      installed: true,
      authenticated: authRes.status,
      version: versionRes.version,
      error: authRes.error,
    };
  }

  /**
   * Query AGY's read-only `/usage` command in print mode. AGY 1.1.x returns a
   * structured quota payload here without starting an agent turn, consuming
   * quota, or creating a conversation record.
   */
  static getQuotaStatus(
    userAgyPath?: string,
    options: { force?: boolean } = {}
  ): Promise<RpcResponse<AgyQuotaStatus>> {
    const resolved = resolveAgySpawn(userAgyPath);
    const cacheKey = [resolved.cmd, ...resolved.scriptArgs].join("\u0000");
    const now = Date.now();
    if (
      !options.force &&
      this.quotaCache &&
      this.quotaCache.path === cacheKey &&
      this.quotaCache.expiresAt > now
    ) {
      return Promise.resolve({
        type: "response",
        command: "usage",
        success: true,
        data: this.quotaCache.data,
      });
    }
    if (!options.force && this.quotaRequest?.path === cacheKey) {
      return this.quotaRequest.promise;
    }

    const promise = new Promise<RpcResponse<AgyQuotaStatus>>((resolve) => {
      execFile(
        resolved.cmd,
        [...resolved.scriptArgs, "-p", "/usage", "--output-format", "json"],
        { timeout: 30_000, env: process.env, maxBuffer: 2 * 1024 * 1024 },
        (err, stdout, stderr) => {
          const diagnostic = [stderr?.trim(), err?.message].filter(Boolean).join(" ");
          if (err && !stdout?.trim()) {
            resolve({
              type: "response",
              command: "usage",
              success: false,
              error: diagnostic || "Could not query AGY quota",
            });
            return;
          }

          try {
            const payload = JSON.parse(stdout.trim());
            if (payload?.status !== "SUCCESS") {
              throw new Error(payload?.error || diagnostic || "AGY quota query failed");
            }
            const rawGroups = payload?.command?.data?.groups;
            if (!Array.isArray(rawGroups)) {
              throw new Error("AGY returned no quota groups");
            }
            const groups: AgyQuotaGroup[] = rawGroups
              .filter((group: any) => group && typeof group.name === "string")
              .map((group: any) => ({
                name: group.name.trim(),
                description:
                  typeof group.description === "string" ? group.description.trim() : undefined,
                buckets: Array.isArray(group.buckets)
                  ? group.buckets
                      .filter((bucket: any) => bucket && typeof bucket.name === "string")
                      .map((bucket: any) => ({
                        id: typeof bucket.id === "string" ? bucket.id : bucket.name,
                        name: bucket.name.trim(),
                        window: typeof bucket.window === "string" ? bucket.window : "",
                        remainingFraction: Math.max(
                          0,
                          Math.min(1, Number(bucket.remaining_fraction) || 0)
                        ),
                        resetTime:
                          typeof bucket.reset_time === "string" ? bucket.reset_time : undefined,
                      }))
                  : [],
              }))
              .filter((group: AgyQuotaGroup) => group.buckets.length > 0);
            if (groups.length === 0) throw new Error("AGY returned no quota buckets");

            const data: AgyQuotaStatus = { groups, fetchedAt: Date.now() };
            this.quotaCache = {
              path: cacheKey,
              expiresAt: Date.now() + 30_000,
              data,
            };
            resolve({ type: "response", command: "usage", success: true, data });
          } catch (parseError) {
            resolve({
              type: "response",
              command: "usage",
              success: false,
              error:
                parseError instanceof Error
                  ? parseError.message
                  : diagnostic || "Invalid AGY quota response",
            });
          }
        }
      );
    });

    this.quotaRequest = { path: cacheKey, promise };
    void promise.then(
      () => {
        if (this.quotaRequest?.promise === promise) this.quotaRequest = null;
      },
      () => {
        if (this.quotaRequest?.promise === promise) this.quotaRequest = null;
      }
    );
    return promise;
  }
}
