import { ChildProcess, spawn, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";

// ─── Windows pi resolution ──────────────────────────────────────────────────
// On Windows, `pi` is a .cmd shim that calls `node cli.js`.
// We can't spawn `.cmd` without `shell: true` (Node limitation), and using
// `shell: true` spawns cmd.exe which makes pi a grandchild that survives
// Obsidian quit (orphan process problem).
//
// Solution: locate the actual `node` + `cli.js` pair and spawn node directly.
// This way `node.exe` (and pi inside it) is a direct child of Electron and
// Windows cleans it up when Obsidian dies.
function resolveWindowsSpawn(
  userPiPath: string
): { cmd: string; scriptArgs: string[] } | null {
  if (process.platform !== "win32") return null;
  // If the user gave a full path or .exe, just use it as-is.
  if (/[\\/]/.test(userPiPath) || /\.exe$/i.test(userPiPath)) return null;

  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const shim = path.join(dir, userPiPath + ".cmd");
    if (!fs.existsSync(shim)) continue;
    const shimDir = path.dirname(shim);
    // npm shim 位于 `<install>/node_modules/.bin/`，真实包在
    // `<install>/node_modules/@earendil-works/pi-coding-agent/`。
    // 两种布局都试一下：
    const installRoot = path.basename(shimDir).toLowerCase() === ".bin"
      ? path.dirname(shimDir)
      : shimDir;
    const candidates = [
      path.join(
        installRoot,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js"
      ),
      path.join(
        shimDir,
        "node_modules",
        "@earendil-works",
        "pi-coding-agent",
        "dist",
        "cli.js"
      ),
    ];
    for (const cliJs of candidates) {
      if (!fs.existsSync(cliJs)) continue;
      // 优先用 shim 同目录的 node.exe（npm 会装一个），否则用 PATH 里的 node。
      const localNode = path.join(shimDir, "node.exe");
      const localNode2 = path.join(installRoot, "node.exe");
      const nodeCmd = fs.existsSync(localNode)
        ? localNode
        : fs.existsSync(localNode2)
          ? localNode2
          : "node";
      return { cmd: nodeCmd, scriptArgs: [cliJs] };
    }
  }
  return null;
}

function resolvePosixNode(): string | null {
  if (process.platform === "win32") return null;

  const searchDirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, "node");
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function resolvePosixScript(candidate: string, nodePath: string | null): { cmd: string; scriptArgs: string[] } | null {
  const realPath = fs.realpathSync(candidate);
  if (/\.js$/i.test(realPath) && nodePath) {
    return { cmd: nodePath, scriptArgs: [realPath] };
  }

  return null;
}

function resolvePosixSpawn(
  userPiPath: string
): { cmd: string; scriptArgs: string[] } | null {
  if (process.platform === "win32") return null;

  const nodePath = resolvePosixNode();

  if (/\.js$/i.test(userPiPath)) {
    return nodePath ? { cmd: nodePath, scriptArgs: [userPiPath] } : null;
  }

  if (/[\\/]/.test(userPiPath)) {
    if (!fs.existsSync(userPiPath)) return null;
    return resolvePosixScript(userPiPath, nodePath);
  }

  const searchDirs = [
    ...(process.env.PATH || "").split(path.delimiter),
    process.env.HOME ? path.join(process.env.HOME, ".local", "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, userPiPath);
    if (!fs.existsSync(candidate)) continue;

    return resolvePosixScript(candidate, nodePath) || { cmd: candidate, scriptArgs: [] };
  }

  return null;
}

function resolvePiSpawn(
  userPiPath: string
): { cmd: string; scriptArgs: string[] } | null {
  return resolveWindowsSpawn(userPiPath) || resolvePosixSpawn(userPiPath);
}

// ─── RPC Types ─────────────────────────────────────────────────────────────

export interface RpcRequest {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RpcResponse {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

// Message update delta types
export type DeltaType =
  | "start"
  | "text_start"
  | "text_delta"
  | "text_end"
  | "thinking_start"
  | "thinking_delta"
  | "thinking_end"
  | "toolcall_start"
  | "toolcall_delta"
  | "toolcall_end"
  | "done"
  | "error";

export interface AssistantMessageEvent {
  type: DeltaType;
  contentIndex?: number;
  delta?: string;
  partial?: unknown;
  content?: string;
  toolCall?: ToolCall;
  reason?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  toolName: string;
  content: Array<{ type: string; text: string }>;
  isError: boolean;
  details?: Record<string, unknown>;
}

export interface Message {
  role: string;
  content: string | Array<MessageContent>;
  timestamp?: number;
  [key: string]: unknown;
}

export interface MessageContent {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

// ─── RPC Client ─────────────────────────────────────────────────────────────

export interface PiAgentClientOptions {
  piPath: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  apiKey?: string;
  cwd?: string;
  noSession?: boolean;
  tools?: string[];
}


export class PiAgentClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private nextId = 0;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: RpcResponse) => void;
      reject: (error: Error) => void;
      timeout: number;
    }
  >();
  private options: PiAgentClientOptions;
  private destroyed = false;

  constructor(options: PiAgentClientOptions) {
    super();
    this.options = options;
  }

  /**
   * Start the pi process and initialize
   */
  async start(): Promise<void> {
    if (this.destroyed) throw new Error("Client destroyed");

    const args = ["--mode", "rpc"];

    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }
    if (this.options.modelId) {
      args.push("--model", this.options.modelId);
    }
    if (this.options.thinkingLevel) {
      args.push("--thinking", this.options.thinkingLevel);
    }
    if (this.options.noSession) {
      args.push("--no-session");
    }
    if (this.options.tools?.length) {
      args.push("--tools", this.options.tools.join(","));
    }

    const env: Record<string, string> = { ...process.env } as Record<
      string,
      string
    >;
    if (this.options.apiKey) {
      // Set common API key env vars based on provider
      const provider = this.options.provider || "anthropic";
      const keyMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        google: "GOOGLE_API_KEY",
        deepseek: "DEEPSEEK_API_KEY",
        groq: "GROQ_API_KEY",
        xai: "XAI_API_KEY",
        mistral: "MISTRAL_API_KEY",
        // 自定义 provider（在 ~/.pi/agent/models.json 里用 "$XXX_API_KEY" 鉴权）：
        // Pimate 面板"凭证配置区"填的 key 存 auth.json，这里按 provider 注入
        // 对应环境变量，让 pi 后端能解析 models.json 的 apiKey 引用。
        "minimax": "MINIMAX_API_KEY",
        "minimax-cn": "MINIMAX_API_KEY",
        "siliconflow": "SILICONFLOW_API_KEY",
        "zhipu": "ZHIPU_API_KEY",
      };
      const envVar = keyMap[provider];
      if (envVar) {
        env[envVar] = this.options.apiKey;
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const spawnOptions: SpawnOptions = {
          cwd: this.options.cwd || process.cwd(),
          env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        };

        // 直接 spawn，不再走 cmd.exe shell。
        // 在 Windows 上，`pi` 是 .cmd shim，没 shell 跑不了——所以先
        // 解析 shim 找到真正的 `node` + `cli.js`，直接 spawn node。
        // 这样 pi 是 Electron 的亲生进程，Obsidian 退出时 Windows 会清理。
        // 中文路径无影响：Node 在 Windows 上对 spawn 的 argv 走 UTF-16/UTF-8
        // 安全传递，pi 自己用 Node 也是 UTF-8。
        let executable = this.options.piPath;
        let execArgs = args;
        const resolved = resolvePiSpawn(this.options.piPath);
        if (resolved) {
          executable = resolved.cmd;
          execArgs = [...resolved.scriptArgs, ...args];
        }
        const child = spawn(executable, execArgs, spawnOptions);

        this.process = child;

        let settled = false;

        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        };

        // Handle stdout (events and responses)
        child.stdout!.on("data", (chunk: Buffer) => {
          this.handleData(chunk);
        });

        // Handle stderr
        child.stderr!.on("data", (chunk: Buffer) => {
          console.error("[pi-agent stderr]", chunk.toString());
        });

        // Handle process exit
        child.on("error", (err) => {
          console.error("[pi-agent] Process error:", err);
          if (!settled) settle(err);
          else this.emit("error", err);
        });

        child.on("close", (code) => {
          console.log(`[pi-agent] Process closed with code ${code}`);
          if (!settled) settle(new Error(`pi exited with code ${code}`));
          else this.emit("close");
          this.process = null;
        });

        // Consider ready after a short delay (pi initializes)
        // 150ms 给 pi 足够时间完成工具加载和模型绑定，避免下一个 RPC
        // 命令与初始化指令重载。Node 管道 buffer 会保留前面写入的指令。
        window.setTimeout(() => settle(), 150);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Handle incoming data from pi stdout
   */
  private handleData(chunk: Buffer): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex === -1) break;

      let line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      // Strip trailing \r
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (line.trim().length === 0) continue;

      try {
        const parsed = JSON.parse(line) as RpcResponse | RpcEvent;

        if (parsed.type === "response") {
          // Handle command response
          const response = parsed as RpcResponse;
          const pending = this.pendingRequests.get(response.id || "");
          if (pending) {
            this.pendingRequests.delete(response.id || "");
            window.clearTimeout(pending.timeout);
            pending.resolve(response);
          }
        } else {
          // Handle event
          this.emit("event", parsed as RpcEvent);
        }
      } catch (err) {
        console.error("[pi-agent] Failed to parse JSON line:", line, err);
      }
    }
  }

  /**
   * Send a command and wait for response
   */
  private async sendCommand(
    command: RpcRequest
  ): Promise<RpcResponse> {
    if (!this.process || this.process.killed) {
      throw new Error("Process not running");
    }

    const id = command.id || `cmd-${++this.nextId}`;
    command.id = id;

    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`Command ${command.type} timed out`));
        }
      }, 60_000);

      this.pendingRequests.set(id, { resolve, reject, timeout });

      const payload = JSON.stringify(command) + "\n";
      try {
        this.process!.stdin!.write(payload);
      } catch (err) {
        this.pendingRequests.delete(id);
        window.clearTimeout(timeout);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Send a fire-and-forget command (no response expected)
   */
  private sendFireAndForget(command: RpcRequest): void {
    if (!this.process || this.process.killed) {
      console.warn("[pi-agent] Cannot send, process not running");
      return;
    }
    if (!command.id) command.id = `ff-${++this.nextId}`;
    try {
      this.process.stdin!.write(JSON.stringify(command) + "\n");
    } catch (err) {
      console.error("[pi-agent] Failed to send command:", err);
    }
  }

  // ─── Public API ────────────────────────────────────────────────────────

  /**
   * Send a prompt to the agent
   */
  async prompt(
    message: string,
    options?: {
      streamingBehavior?: "steer" | "followUp";
      images?: Array<{ type: string; data: string; mimeType: string }>;
    }
  ): Promise<RpcResponse> {
    return this.sendCommand({
      type: "prompt",
      message,
      ...(options?.streamingBehavior && {
        streamingBehavior: options.streamingBehavior,
      }),
      ...(options?.images && { images: options.images }),
    });
  }

  /**
   * Queue a steering message during streaming
   */
  async steer(
    message: string,
    options?: { images?: Array<{ type: string; data: string; mimeType: string }> }
  ): Promise<RpcResponse> {
    return this.sendCommand({
      type: "steer",
      message,
      ...(options?.images && { images: options.images }),
    });
  }

  /**
   * Queue a follow-up message
   */
  async followUp(
    message: string,
    options?: { images?: Array<{ type: string; data: string; mimeType: string }> }
  ): Promise<RpcResponse> {
    return this.sendCommand({
      type: "follow_up",
      message,
      ...(options?.images && { images: options.images }),
    });
  }

  /**
   * Abort current agent operation
   */
  abort(): void {
    this.sendFireAndForget({ type: "abort" });
  }

  /**
   * Get current session state
   */
  async getState(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_state" });
  }

  /**
   * Get all messages
   */
  async getMessages(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_messages" });
  }

  /**
   * Set model
   */
  async setModel(provider: string, modelId: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "set_model", provider, modelId });
  }

  /**
   * Set thinking level
   */
  async setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "set_thinking_level", level });
  }

  /**
   * Get available models
   */
  async getAvailableModels(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_available_models" });
  }

  /**
   * Execute a bash command
   */
  async bash(command: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "bash", command });
  }

  /**
   * Get session stats (tokens, cost)
   */
  async getSessionStats(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_session_stats" });
  }

  async switchSession(sessionPath: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "switch_session", sessionPath });
  }

  async exportHtml(outputPath?: string): Promise<RpcResponse> {
    return this.sendCommand({
      type: "export_html",
      ...(outputPath ? { outputPath } : {}),
    });
  }

  async getCommands(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_commands" });
  }

  async getLastAssistantText(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_last_assistant_text" });
  }

  async getForkMessages(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_fork_messages" });
  }

  async fork(entryId: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "fork", entryId });
  }

  async clone(): Promise<RpcResponse> {
    return this.sendCommand({ type: "clone" });
  }

  async promptAndWait(message: string): Promise<RpcResponse> {
    await this.prompt(message);
    return this.waitForAgentEnd().then(() => this.getLastAssistantText());
  }

  private waitForAgentEnd(timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.off("event", onEvent);
        reject(new Error("Timed out waiting for assistant response"));
      }, timeoutMs);
      const onEvent = (event: RpcEvent) => {
        if (event.type === "agent_end") {
          window.clearTimeout(timeout);
          this.off("event", onEvent);
          resolve();
        }
      };
      this.on("event", onEvent);
    });
  }

  /**
   * Start a new session
   */
  async newSession(): Promise<RpcResponse> {
    return this.sendCommand({ type: "new_session" });
  }

  /**
   * Manual compaction
   */
  async compact(customInstructions?: string): Promise<RpcResponse> {
    const cmd: RpcRequest = { type: "compact" };
    if (customInstructions) {
      cmd.customInstructions = customInstructions;
    }
    return this.sendCommand(cmd);
  }

  /**
   * Send extension UI response (for dialog handling)
   */
  sendUIResponse(id: string, response: Record<string, unknown>): void {
    this.sendFireAndForget({
      type: "extension_ui_response",
      id,
      ...response,
    });
  }

  /**
   * Request OAuth login URL.
   * NOTE: This RPC does not exist in pi-coding-agent. OAuth/device-code login
   * must be done by importing AuthStorage directly from pi-coding-agent in
   * the settings tab. We keep this stub returning a failure so the caller
   * surfaces a clear error instead of silently hanging.
   */
  async oauthLogin(provider: string): Promise<RpcResponse> {
    return {
      type: "response",
      command: "oauth_login",
      success: false,
      error:
        "oauth_login is not a Pi RPC command. Use the device-code login flow from the Pimate settings tab instead.",
    };
  }

  /**
   * Check if the process is running
   */
  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }

  /**
   * Restart the pi process (e.g., after settings change)
   */
  async restart(): Promise<void> {
    await this.destroy();
    this.destroyed = false;
    await this.start();
  }

  /**
   * Destroy the client and kill the process
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      window.clearTimeout(pending.timeout);
      pending.reject(new Error("Client destroyed"));
    }
    this.pendingRequests.clear();

    if (this.process) {
      const p = this.process;
      this.process = null;

      if (!p.killed) {
        p.kill("SIGTERM");
        // Give it a moment to exit gracefully
        await new Promise((resolve) => window.setTimeout(resolve, 500));
        if (!p.killed) {
          p.kill("SIGKILL");
        }
      }
    }
  }
}
