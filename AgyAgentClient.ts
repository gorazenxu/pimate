import { ChildProcess, spawn, execFile, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
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

export interface AgyAgentClientOptions {
  agyPath?: string;
  modelId?: string;
  effort?: string;
  cwd?: string;
  conversationId?: string;
  dangerouslySkipPermissions?: boolean;
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
  if (path.isAbsolute(p)) {
    if (fs.existsSync(p)) return { cmd: p, scriptArgs: [] };
  }

  const searchDirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, p);
    if (fs.existsSync(candidate)) {
      return { cmd: candidate, scriptArgs: [] };
    }
  }

  return { cmd: p, scriptArgs: [] };
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

  private options: AgyAgentClientOptions;
  private conversationId: string | null = null;
  private currentModelId: string;
  private currentEffort: string;
  private availableTools: string[] = [];

  private lastAssistantText = "";
  private isTurnStreaming = false;
  private inputTokens = 0;
  private outputTokens = 0;
  private thinkingTokens = 0;
  private totalTokens = 0;

  private initResolve: ((value?: unknown) => void) | null = null;
  private initReject: ((reason?: unknown) => void) | null = null;

  constructor(options: AgyAgentClientOptions) {
    super();
    this.options = { ...options };
    this.conversationId = options.conversationId || null;
    this.currentModelId = options.modelId || "gemini-3.8-flash-high";
    this.currentEffort = options.effort || "high";
  }

  getConversationId(): string | null {
    return this.conversationId;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Launch `agy` process in stream-json mode and wait for the "init" event.
   */
  async start(): Promise<void> {
    if (this.destroyed) throw new Error("Client destroyed");
    if (this.isRunning()) return;

    const resolved = resolveAgySpawn(this.options.agyPath);
    const args: string[] = [
      ...resolved.scriptArgs,
      "--input-format", "stream-json",
      "--output-format", "stream-json",
    ];

    if (this.options.dangerouslySkipPermissions !== false) {
      args.push("--dangerously-skip-permissions");
    }

    // Harmonize model and effort to prevent agy flag conflict
    let targetModel = this.currentModelId;
    let targetEffort: string | undefined = this.currentEffort;

    const suffixMatch = targetModel?.match(/-(low|medium|high)$/);
    if (suffixMatch) {
      const suffix = suffixMatch[1];
      if (targetEffort && targetEffort !== suffix) {
        // Adapt model suffix to match target effort
        const base = targetModel.slice(0, -suffix.length);
        targetModel = `${base}${targetEffort}`;
      }
      // Omit --effort flag when model ID already explicitly specifies effort
      targetEffort = undefined;
    }

    if (targetModel) {
      args.push("--model", targetModel);
    }
    if (targetEffort) {
      args.push("--effort", targetEffort);
    }
    if (this.conversationId) {
      args.push("--conversation", this.conversationId);
    }

    const spawnOptions: SpawnOptions = {
      cwd: this.options.cwd || process.cwd(),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      try {
        const child = spawn(resolved.cmd, args, spawnOptions);
        this.process = child;
        this.buffer = "";

        // Wait up to 20s for the init event
        const initTimeout = setTimeout(() => {
          if (!settled) {
            settle(new Error("Timeout waiting for agy init event"));
          }
        }, 20_000);

        this.initResolve = () => {
          clearTimeout(initTimeout);
          settle();
        };
        this.initReject = (err: unknown) => {
          clearTimeout(initTimeout);
          settle(err instanceof Error ? err : new Error(String(err)));
        };

        child.stdout!.on("data", (chunk: Buffer) => {
          this.handleData(chunk);
        });

        child.stderr!.on("data", (chunk: Buffer) => {
          console.warn("[agy stderr]", chunk.toString());
        });

        child.on("error", (err) => {
          console.error("[agy] Process error:", err);
          if (!settled) settle(err);
          else this.emit("error", err);
        });

        child.on("close", (code) => {
          console.log(`[agy] Process closed with code ${code}`);
          const wasRunningTurn = this.isTurnStreaming;
          this.isTurnStreaming = false;
          this.process = null;

          if (!settled) {
            settle(new Error(`agy exited with code ${code} before initialization`));
          } else {
            if (wasRunningTurn) {
              this.emit("event", {
                type: "message_update",
                assistantMessageEvent: {
                  type: "error",
                  reason: `Process exited with code ${code}`,
                },
              });
              this.emit("event", { type: "turn_end" });
              this.emit("event", { type: "agent_settled" });
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

        const isError = step.state === "ERROR";

        // Emit tool execution start
        this.emit("event", {
          type: "tool_execution_start",
          toolCallId,
          toolName,
          args,
        });

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
      if (result?.usage) {
        this.updateUsage(result.usage);
      }

      if (result?.status === "SUCCESS") {
        const responseText = result.response || this.lastAssistantText;
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
            content: responseText,
          },
        });
        this.emit("event", { type: "turn_end" });
        this.emit("event", { type: "agent_settled" });
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
        this.emit("event", { type: "turn_end" });
        this.emit("event", { type: "agent_settled" });
      }

      this.isTurnStreaming = false;
      return;
    }
  }

  private updateUsage(usage: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    total_tokens?: number;
  }): void {
    if (typeof usage.input_tokens === "number") this.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === "number") this.outputTokens = usage.output_tokens;
    if (typeof usage.thinking_tokens === "number") this.thinkingTokens = usage.thinking_tokens;
    if (typeof usage.total_tokens === "number") this.totalTokens = usage.total_tokens;
  }

  /**
   * Send a prompt to Antigravity CLI over stdin stream.
   */
  async prompt(
    message: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      images?: Array<{ type: string; data: string; mimeType: string }>;
    }
  ): Promise<RpcResponse> {
    if (this.destroyed) throw new Error("Client destroyed");
    if (!this.isRunning()) {
      await this.start();
    }

    this.lastAssistantText = "";
    this.isTurnStreaming = true;

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

    try {
      this.process!.stdin!.write(payload);
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
    return this.prompt(message, options);
  }

  /**
   * Queue follow-up message (equivalent to prompt for AGY).
   */
  async followUp(
    message: string,
    options?: { images?: Array<{ type: string; data: string; mimeType: string }> }
  ): Promise<RpcResponse> {
    return this.prompt(message, options);
  }

  /**
   * Abort the active turn.
   */
  async abort(): Promise<RpcResponse> {
    if (!this.process || this.process.killed) {
      return { type: "response", command: "abort", success: true };
    }

    try {
      this.process.kill("SIGINT");
    } catch (err) {
      console.warn("[agy] Failed to send SIGINT:", err);
    }

    this.isTurnStreaming = false;
    this.emit("event", {
      type: "message_update",
      assistantMessageEvent: {
        type: "error",
        reason: "Operation aborted by user",
      },
    });
    this.emit("event", {
      type: "message_end",
      message: { role: "assistant", content: this.lastAssistantText },
    });
    this.emit("event", { type: "turn_end" });
    this.emit("event", { type: "agent_settled" });

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
    return {
      type: "response",
      command: "get_available_models",
      success: true,
      data: { models },
    };
  }

  async getMessages(): Promise<RpcResponse> {
    return {
      type: "response",
      command: "get_messages",
      success: true,
      data: { messages: [] },
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
    return {
      type: "response",
      command: "get_session_stats",
      success: true,
      data: {
        totalTokens: this.totalTokens,
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        thinkingTokens: this.thinkingTokens,
      },
    };
  }

  /**
   * Switch or resume a previous conversation by ID.
   */
  async switchSession(conversationId: string): Promise<RpcResponse> {
    this.conversationId = conversationId;
    await this.restart();
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
      success: true,
      data: { messages: [] },
    };
  }

  async getEntries(): Promise<RpcResponse<SessionEntriesResult>> {
    return {
      type: "response",
      command: "get_entries",
      success: true,
      data: { entries: [] },
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
      success: true,
      data: { compacted: false },
    };
  }

  async bash(command: string): Promise<RpcResponse> {
    return this.prompt(`!${command}`);
  }

  async getLastAssistantText(): Promise<RpcResponse> {
    return {
      type: "response",
      command: "get_last_assistant_text",
      success: true,
      data: this.lastAssistantText,
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
    // agy runs with auto-approved permissions; stub for UI compatibility
  }

  async reloadExtensionsViaBridge(bridgePath: string): Promise<any> {
    return { success: true };
  }

  async restart(): Promise<void> {
    await this.destroy();
    this.destroyed = false;
    await this.start();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.initReject) {
      this.initReject(new Error("Client destroyed"));
      this.initResolve = null;
      this.initReject = null;
    }

    if (this.process) {
      const p = this.process;
      this.process = null;

      if (!p.killed) {
        p.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 300));
        if (!p.killed) {
          p.kill("SIGKILL");
        }
      }
    }
  }

  // ─── Static Helpers ────────────────────────────────────────────────────────

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
            // Fallback to default list if command fails
            return resolve([
              {
                id: "gemini-3.8-flash-high",
                provider: "antigravity",
                name: "Gemini 3.8 Flash (High)",
                reasoning: true,
                thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
              },
              {
                id: "gemini-3.8-flash-medium",
                provider: "antigravity",
                name: "Gemini 3.8 Flash (Medium)",
                reasoning: true,
                thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
              },
              {
                id: "gemini-3.1-pro-high",
                provider: "antigravity",
                name: "Gemini 3.1 Pro (High)",
                reasoning: true,
                thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
              },
              {
                id: "claude-sonnet-4-6",
                provider: "antigravity",
                name: "Claude Sonnet 4.6 (Thinking)",
                reasoning: true,
                thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
              },
            ]);
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

          if (models.length === 0) {
            models.push({
              id: "gemini-3.8-flash-high",
              provider: "antigravity",
              name: "Gemini 3.8 Flash (High)",
              reasoning: true,
              thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
            });
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
  ): Promise<{ installed: boolean; authenticated: boolean; version?: string; error?: string }> {
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
    const authRes = await new Promise<boolean>((res) => {
      execFile(
        resolved.cmd,
        [...resolved.scriptArgs, "models"],
        { timeout: 15000, env: process.env },
        (err, stdout) => {
          if (err || !stdout) return res(false);
          // If models list contains known model names or has at least 1 model
          if (stdout.includes("gemini") || stdout.includes("claude") || stdout.includes("gpt")) {
            return res(true);
          }
          res(false);
        }
      );
    });

    return {
      installed: true,
      authenticated: authRes,
      version: versionRes.version,
    };
  }
}
