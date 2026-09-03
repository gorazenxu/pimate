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
  conversationId?: string;
  dangerouslySkipPermissions?: boolean;
}

export interface AgyConversationSummary {
  conversationId: string;
  title: string;
  preview: string;
  mtime: number;
  stepCount: number;
  workspaceUris: string[];
}

type AgyPromptOptions = {
  streamingBehavior?: "steer" | "followUp";
  images?: Array<{ type: string; data: string; mimeType: string }>;
};

interface PendingAgyPrompt {
  message: string;
  options?: AgyPromptOptions;
  kind: "steering" | "followUp";
}

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

  private process: ChildProcess | null = null;
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
  private historyLoadedConversationId: string | null = null;
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

  private historyMessages: Array<{
    role: "user" | "assistant";
    content: Array<{ type: "text" | "thinking"; text?: string; thinking?: string }>;
  }> = [];

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
    this.usageLoadPromise = this.restorePersistedUsage(this.conversationId);
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  private loadTranscriptHistory(): Array<{
    role: "user" | "assistant";
    content: Array<{ type: "text" | "thinking"; text?: string; thinking?: string }>;
  }> {
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
      const raw = fs.readFileSync(transcriptPath, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const messages: Array<{
        role: "user" | "assistant";
        content: Array<{ type: "text" | "thinking"; text?: string; thinking?: string }>;
      }> = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === "USER_INPUT" && entry.content) {
            let text = String(entry.content);
            const reqMatch = text.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (reqMatch) text = reqMatch[1].trim();
            messages.push({
              role: "user",
              content: [{ type: "text", text }],
            });
          } else if (entry.type === "PLANNER_RESPONSE" && entry.content) {
            const blocks: Array<{ type: "text" | "thinking"; text?: string; thinking?: string }> = [];
            if (entry.thinking) {
              blocks.push({ type: "thinking", thinking: String(entry.thinking) });
            }
            blocks.push({ type: "text", text: String(entry.content) });
            messages.push({
              role: "assistant",
              content: blocks,
            });
          }
        } catch {}
      }
      return messages;
    } catch {
      return [];
    }
  }

  private ensureHistoryLoaded(): void {
    if (!this.conversationId || this.historyLoadedConversationId === this.conversationId) {
      return;
    }
    this.historyMessages = this.loadTranscriptHistory();
    this.historyLoadedConversationId = this.conversationId;
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
    if (!this.conversationId || !this.usageKnown) return;
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
      // `--print` consumes the next argv item as its prompt. An empty
      // assignment selects print mode without stealing `--input-format`.
      "--print=",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ];

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
          console.warn("[agy stderr]", chunk.toString());
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
          this.process = null;

          if (!settled) {
            this.isTurnStreaming = false;
            this.pendingPrompts = [];
            this.toolCallStates.clear();
            this.emitQueueUpdate();
            settle(new Error(`agy exited with code ${code} before initialization`));
          } else {
            if (wasRunningTurn) {
              this.finishActiveTurnWithError(`Process exited with code ${code}`);
            } else {
              this.isTurnStreaming = false;
              this.pendingPrompts = [];
              this.toolCallStates.clear();
              this.emitQueueUpdate();
            }
            this.emit("close");
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
        const responseText = result.response || this.lastAssistantText;
        const blocks: Array<{ type: "text" | "thinking"; text?: string; thinking?: string }> = [];
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
        const errorMsg = result?.error || "Agent execution failed";
        this.emit("event", {
          type: "message_update",
          assistantMessageEvent: {
            type: "error",
            reason: errorMsg,
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
    this.pendingPrompts = [];
    this.toolCallStates.clear();
    this.emitQueueUpdate();
    this.isTurnStreaming = false;
    this.emit("event", {
      type: "message_update",
      assistantMessageEvent: { type: "error", reason },
    });
    this.emit("event", {
      type: "message_end",
      message: { role: "assistant", content: partialText },
    });
    this.emit("event", { type: "agent_end" });
    this.emit("event", { type: "turn_end" });
    this.emit("event", { type: "agent_settled" });
  }

  private beginPrompt(message: string, options?: AgyPromptOptions): void {
    this.ensureHistoryLoaded();
    this.lastAssistantText = "";
    this.lastAssistantThinking = "";
    this.isTurnStreaming = true;
    this.toolCallStates.clear();

    this.historyMessages.push({
      role: "user",
      content: [{ type: "text", text: message }],
    });

    // Emit initial stream lifecycle events for UI
    this.emit("event", { type: "turn_start" });
    this.emit("event", { type: "agent_start" });
    this.emit("event", {
      type: "message_start",
      message: { role: "user", content: message },
    });
    this.emit("event", {
      type: "message_start",
      message: { role: "assistant" },
    });

    const payload = JSON.stringify({
      event: "user",
      message: { content: message },
    }) + "\n";

    this.process!.stdin!.write(payload);
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
    this.pendingPrompts = [];
    this.emitQueueUpdate();

    if (!child || child.killed) {
      if (hadActiveTurn) {
        this.lastAssistantText = partialText;
        this.finishActiveTurnWithError("Operation aborted by user");
      }
      return { type: "response", command: "abort", success: true };
    }

    // AGY print mode does not expose a turn-level abort protocol. Terminate
    // this child and resume the same conversation on the next prompt. The
    // generation guard prevents a late result from the old child being routed
    // into the replacement turn.
    this.invalidateProcess(child);
    this.isTurnStreaming = false;
    await this.terminateChild(child, "SIGINT");

    if (hadActiveTurn) {
      this.lastAssistantText = partialText;
      this.finishActiveTurnWithError("Operation aborted by user");
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

  async getMessages(): Promise<RpcResponse> {
    this.ensureHistoryLoaded();
    return {
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: this.historyMessages },
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

  async getSessionStats(): Promise<RpcResponse> {
    await this.usageLoadPromise;
    this.ensureHistoryLoaded();
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
        totalMessages: this.historyMessages.length,
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
      },
    };
  }

  /**
   * Switch or resume a previous conversation by ID.
   */
  async switchSession(conversationId: string): Promise<RpcResponse> {
    const nextConversationId = conversationId.trim();
    if (!AgyAgentClient.conversationExists(nextConversationId)) {
      return {
        type: "response",
        command: "switch_session",
        success: false,
        error: "Antigravity conversation was not found",
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

  private waitForAgentSettled(timeoutMs = 120_000): Promise<void> {
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

  /**
   * Read AGY's persistent conversation metadata cache. The cache is the same
   * source used by the native `/resume` picker; the actual `.db` file check
   * keeps stale cache records out of Pimate's list.
   */
  static listConversations(cwd?: string): AgyConversationSummary[] {
    const dataDir = AgyAgentClient.getAgyDataDir();
    const metadataPath = path.join(dataDir, "cache", "conversation_metadata.json");
    const lastConversationsPath = path.join(dataDir, "cache", "last_conversations.json");
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

    let lastConversationId = "";
    try {
      const parsed = JSON.parse(fs.readFileSync(lastConversationsPath, "utf8"));
      if (parsed && typeof parsed === "object") {
        const target = cwd ? path.resolve(cwd) : "";
        const match = Object.entries(parsed).find(([workspace]) => {
          if (!target) return false;
          return path.resolve(workspace) === target;
        });
        if (typeof match?.[1] === "string") lastConversationId = match[1];
      }
    } catch {
      // The metadata list below is still useful without the last-session map.
    }

    const dbMtimes = new Map<string, number>();
    try {
      for (const name of fs.readdirSync(conversationsDir)) {
        const match = name.match(
          /^([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.db$/i
        );
        if (!match) continue;
        try {
          const stat = fs.statSync(path.join(conversationsDir, name));
          if (stat.isFile()) dbMtimes.set(match[1], stat.mtimeMs);
        } catch {
          // A conversation can be removed while the directory is scanned.
        }
      }
    } catch {
      // Return an empty list if AGY's local store is not available.
    }

    const summaries: AgyConversationSummary[] = [];
    for (const [key, record] of Object.entries(metadata)) {
      const summary = record?.summary;
      if (!summary || typeof summary !== "object") continue;

      const conversationId =
        typeof summary.ID === "string" && summary.ID.trim() ? summary.ID.trim() : key;
      if (!dbMtimes.has(conversationId)) continue;

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
        mtime: Number.isFinite(updatedAt) ? updatedAt : dbMtimes.get(conversationId) || 0,
        stepCount,
        workspaceUris,
      });
    }

    const normalizedCwd = cwd ? path.resolve(cwd) : "";
    const workspaceFromUri = (uri: string): string => {
      try {
        const filePath = uri.startsWith("file://")
          ? uri.slice("file://".length)
          : uri;
        return path.resolve(decodeURIComponent(filePath));
      } catch {
        return uri;
      }
    };
    const belongsToWorkspace = (summary: AgyConversationSummary): boolean =>
      !!normalizedCwd && summary.workspaceUris.some(
        (uri) => workspaceFromUri(uri) === normalizedCwd
      );

    let filtered = summaries;
    if (normalizedCwd) {
      const explicitMatches = summaries.filter(belongsToWorkspace);
      if (explicitMatches.length > 0) {
        filtered = summaries.filter(
          (summary) => belongsToWorkspace(summary) || summary.conversationId === lastConversationId
        );
      } else {
        // AGY 1.1.x sometimes leaves WorkspaceURIs empty for print-mode
        // conversations. Keep those unscoped records visible instead of
        // showing a blank history panel, while still excluding conversations
        // explicitly tied to another workspace.
        filtered = summaries.filter(
          (summary) => summary.workspaceUris.length === 0 || summary.conversationId === lastConversationId
        );
      }
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
}
