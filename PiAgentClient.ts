import { ChildProcess, spawn, type SpawnOptions } from "child_process";
import { StringDecoder } from "string_decoder";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import {
  isPiCommandFromPath,
  type PiCommandInfo,
} from "./PiCommandUtils";

// ─── Windows pi resolution ──────────────────────────────────────────────────
// On Windows, `pi` is a .cmd shim that calls `node cli.js`.
// We can't spawn `.cmd` without `shell: true` (Node limitation), and using
// `shell: true` spawns cmd.exe which makes pi a grandchild that survives
// Obsidian quit (orphan process problem).
//
// Solution: locate the actual `node` + Pi package entry pair and spawn node
// directly.
// This way `node.exe` (and pi inside it) is a direct child of Electron and
// Windows cleans it up when Obsidian dies.
export interface WindowsPiSpawnResolverOptions {
  /** Injectable only to exercise Windows layouts from cross-platform tests. */
  platform?: string;
  pathValue?: string;
  exists?: (candidate: string) => boolean;
  readText?: (candidate: string) => string;
}

type PiSpawnResolution = { cmd: string; scriptArgs: string[]; nodePath?: string };

function packageBinEntrypoint(
  packageDir: string,
  exists: (candidate: string) => boolean,
  readText: (candidate: string) => string
): string | null {
  const packageJson = path.win32.join(packageDir, "package.json");
  if (!exists(packageJson)) return null;

  try {
    const manifest = JSON.parse(readText(packageJson)) as { bin?: unknown };
    const bin = manifest.bin;
    const entry = typeof bin === "string"
      ? bin
      : bin && typeof bin === "object" && !Array.isArray(bin)
        ? (bin as Record<string, unknown>).pi
        : undefined;
    if (typeof entry !== "string" || !entry.trim()) return null;

    // The package metadata is local, but it still must not redirect the
    // plugin to execute a script outside this Pi package.
    const trimmed = entry.trim();
    if (path.win32.isAbsolute(trimmed) || /^[a-z]:/i.test(trimmed)) return null;
    const resolved = path.win32.resolve(packageDir, trimmed);
    const relative = path.win32.relative(packageDir, resolved);
    if (
      !relative ||
      relative === "." ||
      relative === ".." ||
      relative.startsWith(`..${path.win32.sep}`) ||
      path.win32.isAbsolute(relative)
    ) return null;
    return exists(resolved) ? resolved : null;
  } catch {
    // A malformed package manifest should not prevent the legacy fallbacks.
    return null;
  }
}

function packageCliEntrypoint(
  packageDir: string,
  exists: (candidate: string) => boolean,
  readText: (candidate: string) => string
): string | null {
  // Pi's package metadata is the source of truth. Pi >= 0.85 publishes the
  // command as dist/bundle/cli.js; calling dist/cli.js directly bypasses the
  // bundle and can miss dependencies in the standalone Windows runtime.
  const fromManifest = packageBinEntrypoint(packageDir, exists, readText);
  if (fromManifest) return fromManifest;

  // Preserve compatibility with older Pi package layouts and with damaged
  // installs whose package.json cannot be read.
  for (const relativePath of [
    ["dist", "bundle", "cli.js"],
    ["dist", "cli.js"],
  ]) {
    const candidate = path.win32.join(packageDir, ...relativePath);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function resolveWindowsSpawn(
  userPiPath: string,
  options: WindowsPiSpawnResolverOptions = {}
): PiSpawnResolution | null {
  if ((options.platform ?? process.platform) !== "win32") return null;
  // If the user gave a full path or .exe, just use it as-is.
  if (/[\\/]/.test(userPiPath) || /\.exe$/i.test(userPiPath)) return null;

  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const readText = options.readText ?? ((candidate: string) => fs.readFileSync(candidate, "utf8"));
  const pathValue = options.pathValue ?? process.env.PATH ?? process.env.Path ?? "";
  const pathDirs = pathValue.split(path.win32.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const shim = path.win32.join(dir, userPiPath + ".cmd");
    if (!exists(shim)) continue;
    const shimDir = path.win32.dirname(shim);
    // npm shim 位于 `<install>/node_modules/.bin/`，真实包在
    // `<install>/node_modules/@earendil-works/pi-coding-agent/`。
    // 全局安装则通常位于 `<install>/node_modules/...`。两种布局都支持。
    const installRoot = path.win32.basename(shimDir).toLowerCase() === ".bin"
      ? path.win32.dirname(shimDir)
      : shimDir;
    const packageDirs = [...new Set([
      path.win32.join(installRoot, "@earendil-works", "pi-coding-agent"),
      path.win32.join(installRoot, "node_modules", "@earendil-works", "pi-coding-agent"),
      path.win32.join(shimDir, "node_modules", "@earendil-works", "pi-coding-agent"),
    ])];
    for (const packageDir of packageDirs) {
      const cliJs = packageCliEntrypoint(packageDir, exists, readText);
      if (!cliJs) continue;
      // 优先用 shim 同目录的 node.exe（npm 会装一个），否则用 PATH 里的 node。
      const localNode = path.win32.join(shimDir, "node.exe");
      const localNode2 = path.win32.join(installRoot, "node.exe");
      const nodeCmd = exists(localNode)
        ? localNode
        : exists(localNode2)
          ? localNode2
          : "node";
      return { cmd: nodeCmd, scriptArgs: [cliJs] };
    }
  }
  return null;
}

export interface PosixPiSpawnResolverOptions {
  platform?: string;
  pathValue?: string;
  homeDir?: string;
  isExecutable?: (candidate: string) => boolean;
  realPath?: (candidate: string) => string;
}

function isExecutableFile(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return fs.statSync(candidate).isFile();
  } catch { return false; }
}

function resolvePosixNode(options: PosixPiSpawnResolverOptions): string | null {

  const searchDirs = [
    ...(options.pathValue ?? process.env.PATH ?? "").split(":"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!path.posix.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, "node");
    if ((options.isExecutable ?? isExecutableFile)(candidate)) return candidate;
  }

  return null;
}

function resolvePosixScript(candidate: string, nodePath: string | null, options: PosixPiSpawnResolverOptions): PiSpawnResolution | null {
  let realPath: string;
  try { realPath = (options.realPath ?? fs.realpathSync)(candidate); }
  catch { return null; }
  if (/\.js$/i.test(realPath) && nodePath) {
    return { cmd: nodePath, scriptArgs: [realPath], nodePath };
  }

  return null;
}

export function resolvePosixSpawn(
  userPiPath: string,
  options: PosixPiSpawnResolverOptions = {}
): PiSpawnResolution | null {
  if ((options.platform ?? process.platform) === "win32") return null;

  const nodePath = resolvePosixNode(options);
  const executable = options.isExecutable ?? isExecutableFile;
  const launcher = (candidate: string): PiSpawnResolution =>
    resolvePosixScript(candidate, nodePath, options) || {
      cmd: candidate, scriptArgs: [], ...(nodePath ? { nodePath } : {}),
    };

  if (/\.js$/i.test(userPiPath)) {
    return nodePath ? { cmd: nodePath, scriptArgs: [userPiPath], nodePath } : null;
  }

  if (/[\\/]/.test(userPiPath)) {
    if (!executable(userPiPath)) return null;
    return launcher(userPiPath);
  }

  // Reuse the existing HOME lookup only for Pi's known install locations.
  // Never pin a managed release: its launcher must follow `pi update`.
  const homeDir = options.homeDir ?? process.env.HOME;
  const searchDirs = [
    ...(options.pathValue ?? process.env.PATH ?? "").split(":"),
    userPiPath === "pi" && homeDir ? path.join(homeDir, ".pi", "agent", "bin") : "",
    homeDir ? path.join(homeDir, ".local", "bin") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ];

  const seen = new Set<string>();
  for (const dir of searchDirs) {
    if (!path.posix.isAbsolute(dir) || seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, userPiPath);
    if (!executable(candidate)) continue;

    return launcher(candidate);
  }

  return null;
}

function resolvePiSpawn(
  userPiPath: string
): PiSpawnResolution | null {
  return resolveWindowsSpawn(userPiPath) || resolvePosixSpawn(userPiPath);
}

export function piChildPath(inheritedPath: string, nodePath: string): string {
  const nodeDir = path.posix.dirname(nodePath);
  return [nodeDir, ...inheritedPath.split(":").filter(dir => dir !== nodeDir)].join(":");
}

// ─── RPC Types ─────────────────────────────────────────────────────────────

export interface RpcRequest {
  type: string;
  id?: string;
  [key: string]: unknown;
}

export interface RpcResponse<T = unknown> {
  type: "response";
  id?: string;
  command: string;
  success: boolean;
  error?: string;
  data?: T;
}

export interface ForkMessage {
  entryId: string;
  text: string;
}

export interface ForkMessagesResult {
  messages: ForkMessage[];
}

/**
 * Session entries returned by Pi's `get_entries` RPC.  Keep the payload
 * intentionally open-ended because Pi adds entry-specific fields (for
 * example `tokensBefore` on compaction entries) over time.
 */
export interface SessionEntry {
  id: string;
  parentId?: string | null;
  type: string;
  message?: Message;
  summary?: string;
  tokensBefore?: number;
  [key: string]: unknown;
}

export interface SessionEntriesResult {
  entries: SessionEntry[];
  leafId?: string | null;
}

// ─── Pi model & state types ────────────────────────────────────────────────
// Pi 返回的完整 model 元数据。Pimate 仅依赖 `reasoning` 与 `thinkingLevelMap`
// 的键集来决定档位弹窗；`thinkingLevelMap` 的 value 类型由 Pi 内部约定，
// UI 暂不解释，仅透传给 Pi。
export interface PiModel {
  id: string;
  provider: string;
  name?: string;
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, unknown> | null;
}

export interface PiAgentState {
  model?: PiModel;
  thinkingLevel?: string;
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  [key: string]: unknown;
}

export interface AvailableModelsResult {
  models: PiModel[];
}

export type SetModelResult = PiModel;

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
  /** Optional classification supplied by adapters that can distinguish failures. */
  errorCategory?: string;
  /** A user-triggered retry is available; adapters must never retry implicitly. */
  retryable?: boolean;
  /** Short technical detail retained from the underlying process, when available. */
  diagnostic?: string;
  /** The adapter received model-generated content before the turn failed. */
  receivedModelOutput?: boolean;
  /** At least one tool step was observed before the turn failed. */
  hadToolActivity?: boolean;
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
  extensionPaths?: string[];
}

export interface ReloadExtensionsResult {
  success: boolean;
  fallbackToRestart?: boolean;
  error?: string;
}


export class PiAgentClient extends EventEmitter {
  readonly engine: "pi" = "pi";
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
  private processGeneration = 0;
  private startPromise: Promise<void> | null = null;
  private destroyPromise: Promise<void> | null = null;
  private cancelStartup: (() => void) | null = null;
  private restartTail: Promise<void> = Promise.resolve();
  private restartEpoch = 0;

  constructor(options: PiAgentClientOptions) {
    super();
    this.options = options;
  }

  /**
   * Start the pi process and initialize
   */
  async start(): Promise<void> {
    if (this.destroyed) throw new Error("Client destroyed");
    if (this.startPromise) return this.startPromise;
    if (this.isRunning()) return;
    const pending = Promise.resolve().then(() => this.startInternal());
    this.startPromise = pending;
    try { await pending; } finally {
      if (this.startPromise === pending) this.startPromise = null;
    }
  }

  private async startInternal(): Promise<void> {
    if (this.destroyed) throw new Error("Client destroyed");
    const generation = ++this.processGeneration;
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");

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
    for (const extensionPath of this.options.extensionPaths || []) {
      args.push("--extension", extensionPath);
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
        // Pi 官方 env 映射：国内 MiniMax 使用 MINIMAX_CN_API_KEY。
        // 之前误写成 MINIMAX_API_KEY，会让国际 minimax 也被 getAvailable()
        // 判定为已配置，导致模型 picker 同时出现 MINIMAX 和 MINIMAX-CN 两组。
        "minimax-cn": "MINIMAX_CN_API_KEY",
        "siliconflow": "SILICONFLOW_API_KEY",
        "zai": "ZAI_API_KEY",
        "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
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
          if (resolved.nodePath && process.platform !== "win32") {
            // A shell launcher may invoke /usr/bin/env node. Resolving Node
            // alone is insufficient unless its directory reaches the child.
            env.PATH = piChildPath(env.PATH || "", resolved.nodePath);
          }
        }
        const child = spawn(executable, execArgs, spawnOptions);

        this.process = child;
        const isCurrent = () => this.process === child && this.processGeneration === generation && !this.destroyed;

        let settled = false;
        let readyTimer: number | undefined;

        const settle = (err?: Error) => {
          if (settled) return;
          settled = true;
          if (readyTimer !== undefined) window.clearTimeout(readyTimer);
          if (this.cancelStartup === cancel) this.cancelStartup = null;
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        };
        const cancel = () => settle(new Error("Client destroyed during startup"));
        this.cancelStartup = cancel;

        // Handle stdout (events and responses)
        child.stdout!.on("data", (chunk: Buffer) => {
          if (isCurrent()) this.handleData(chunk, generation);
        });

        // Handle stderr
        child.stderr!.on("data", (chunk: Buffer) => {
          if (isCurrent()) console.warn(`[pi-agent] stderr received (${chunk.length} bytes; content omitted)`);
        });

        // Handle process exit
        child.on("error", (err) => {
          if (!isCurrent()) return;
          this.rejectPending(new Error("Pi process failed"));
          if (!settled) settle(err);
          else this.emit("error", err);
        });

        child.stdin?.on("error", () => {
          if (isCurrent()) this.rejectPending(new Error("Pi input pipe failed"));
        });

        child.on("close", (code) => {
          if (!isCurrent()) return;
          this.process = null;
          this.buffer = "";
          this.decoder = new StringDecoder("utf8");
          this.rejectPending(new Error(`Pi process exited (${code ?? "signal"})`));
          if (!settled) settle(new Error(`pi exited with code ${code}`));
          else this.emit("close");
        });

        // Consider ready after a short delay (pi initializes)
        // 150ms 给 pi 足够时间完成工具加载和模型绑定，避免下一个 RPC
        // 命令与初始化指令重载。Node 管道 buffer 会保留前面写入的指令。
        readyTimer = window.setTimeout(() => {
          if (isCurrent()) settle(); else cancel();
        }, 150);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Handle incoming data from pi stdout
   */
  private handleData(chunk: Buffer, generation = this.processGeneration): void {
    this.buffer +=
      typeof chunk === "string" ? chunk : this.decoder.write(chunk);

    while (true) {
      if (generation !== this.processGeneration) return;
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
        console.warn(`[pi-agent] Invalid JSON frame (${line.length} characters; content omitted)`);
      }
    }
  }

  /**
   * Send a command and wait for response
   */
  private async sendCommand<T = unknown>(
    command: RpcRequest
  ): Promise<RpcResponse<T>> {
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

      this.pendingRequests.set(id, {
        resolve: resolve as (value: RpcResponse<unknown>) => void,
        reject,
        timeout,
      });

      const payload = JSON.stringify(command) + "\n";
      try {
        this.process!.stdin!.write(payload, (error?: Error | null) => {
          const pending = this.pendingRequests.get(id);
          if (!error || !pending) return;
          this.pendingRequests.delete(id);
          window.clearTimeout(pending.timeout);
          pending.reject(new Error("Pi command could not be written"));
        });
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
   * Abort the current agent operation.
   *
   * The RPC server responds only after Pi reaches an idle state.  Callers
   * that need to start a replacement prompt must await this acknowledgement;
   * otherwise the next prompt is merely placed in Pi's streaming queue.
   */
  async abort(): Promise<RpcResponse> {
    return this.sendCommand({ type: "abort" });
  }

  /**
   * Get full Pi agent state, including current model and thinkingLevel.
   * This is the authoritative source for clamping / sync decisions.
   */
  async getState(): Promise<RpcResponse<PiAgentState>> {
    return this.sendCommand({ type: "get_state" });
  }

  /**
   * Get all messages
   */
  async getMessages(): Promise<RpcResponse> {
    return this.sendCommand({ type: "get_messages" });
  }

  /**
   * Set model. Pi responds with the resolved model metadata
   * (including `reasoning` and `thinkingLevelMap`), which the UI uses
   * to derive the available thinking-level options.
   */
  async setModel(
    provider: string,
    modelId: string
  ): Promise<RpcResponse<SetModelResult>> {
    return this.sendCommand({ type: "set_model", provider, modelId });
  }

  /**
   * Set thinking level. Pi may clamp the requested level to what the
   * current model supports; the authoritative result comes back via
   * `thinking_level_changed` events and `getState`.
   */
  async setThinkingLevel(level: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "set_thinking_level", level });
  }

  /**
   * List currently-available models for the configured providers.
   */
  async getAvailableModels(): Promise<RpcResponse<AvailableModelsResult>> {
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

  async getForkMessages(): Promise<RpcResponse<ForkMessagesResult>> {
    return this.sendCommand({ type: "get_fork_messages" });
  }

  /**
   * Get the persisted session tree and the currently selected leaf.  Unlike
   * `get_messages`, this preserves entry ids and lets the UI reconstruct only
   * the active branch instead of flattening abandoned branches into history.
   */
  async getEntries(): Promise<RpcResponse<SessionEntriesResult>> {
    return this.sendCommand({ type: "get_entries" });
  }

  async fork(entryId: string): Promise<RpcResponse> {
    return this.sendCommand({ type: "fork", entryId });
  }

  async clone(): Promise<RpcResponse> {
    return this.sendCommand({ type: "clone" });
  }

  /**
   * Invoke Pimate's private extension command. Pi has no `reload` RPC command;
   * extension commands are the supported RPC route to ExtensionContext.reload().
   */
  async reloadExtensionsViaBridge(
    bridgePath: string
  ): Promise<ReloadExtensionsResult> {
    const commandsResponse = await this.getCommands();
    if (!commandsResponse.success || !commandsResponse.data) {
      return {
        success: false,
        error: commandsResponse.error || "Could not query Pi extension commands",
      };
    }

    const commands = ((commandsResponse.data as any).commands || []) as PiCommandInfo[];
    const bridgeCommand = commands.find((command) =>
      isPiCommandFromPath(command, bridgePath, this.options.cwd || process.cwd())
    );
    if (!bridgeCommand?.name) {
      return {
        success: false,
        fallbackToRestart: true,
        error: "Pi did not load Pimate's reload bridge",
      };
    }

    let commandError: string | undefined;
    const onEvent = (event: RpcEvent) => {
      if (
        event.type === "extension_error" &&
        event.event === "command" &&
        event.extensionPath === `command:${bridgeCommand.name}`
      ) {
        commandError = String(event.error || "Reload bridge failed");
      }
    };

    this.on("event", onEvent);
    try {
      const response = await this.prompt(`/${bridgeCommand.name}`);
      if (!response.success) {
        return { success: false, error: response.error };
      }
      if (commandError) {
        return { success: false, error: commandError };
      }

      // A successful extension-command response means ctx.reload() completed.
      // The view refreshes the command catalog afterward; a transient catalog
      // read must not turn a completed reload into a destructive restart.
      return { success: true };
    } finally {
      this.off("event", onEvent);
    }
  }

  async promptAndWait(message: string): Promise<RpcResponse> {
    await this.prompt(message);
    return this.waitForAgentSettled().then(() => this.getLastAssistantText());
  }

  private waitForAgentSettled(timeoutMs = 120_000): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.off("event", onEvent);
        reject(new Error("Timed out waiting for assistant response"));
      }, timeoutMs);
      const onEvent = (event: RpcEvent) => {
        if (event.type === "agent_settled") {
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
    return this.process !== null && !this.process.killed
      && this.process.exitCode === null && this.process.signalCode === null;
  }

  /**
   * Restart the pi process (e.g., after settings change)
   */
  async restart(): Promise<void> {
    const epoch = this.restartEpoch;
    const operation = this.restartTail.then(async () => {
      if (epoch !== this.restartEpoch) throw new Error("Restart cancelled by client shutdown");
      await this.disposeProcess();
      if (epoch !== this.restartEpoch) throw new Error("Restart cancelled by client shutdown");
      this.destroyed = false;
      await this.start();
    });
    this.restartTail = operation.catch(() => undefined);
    return operation;
  }

  /**
   * Destroy the client and kill the process
   */
  async destroy(): Promise<void> {
    ++this.restartEpoch;
    return this.disposeProcess();
  }

  private async disposeProcess(): Promise<void> {
    if (this.destroyPromise) return this.destroyPromise;
    const pending = this.destroyInternal();
    this.destroyPromise = pending;
    try { await pending; } finally {
      if (this.destroyPromise === pending) this.destroyPromise = null;
    }
  }

  private async destroyInternal(): Promise<void> {
    if (this.destroyed && !this.process) return;
    this.destroyed = true;
    ++this.processGeneration;
    this.cancelStartup?.();
    this.buffer = "";
    this.decoder = new StringDecoder("utf8");
    this.rejectPending(new Error("Client destroyed"));
    const child = this.process;
    this.process = null;
    if (child) {
      try { await this.terminateChild(child); } catch (error) {
        // Keep a failed termination available for an explicit later cleanup.
        if (!this.process) this.process = child;
        throw error;
      }
    }
    if (this.startPromise) await this.startPromise.catch(() => undefined);
  }

  private rejectPending(error: Error): void {
    for (const [, pending] of this.pendingRequests) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

  }

  private terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let timer: number;
      let finished = false;
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        window.clearTimeout(timer);
        child.removeListener("close", onClose);
        if (error) reject(error); else resolve();
      };
      const onClose = () => finish();
      child.once("close", onClose);
      timer = window.setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return finish();
        try { child.kill("SIGKILL"); } catch { return finish(new Error("Could not terminate Pi process")); }
        if (finished) return;
        timer = window.setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null) finish();
          else finish(new Error("Pi process did not exit after SIGKILL"));
        }, 500);
      }, 500);
      try { child.kill("SIGTERM"); } catch { finish(new Error("Could not terminate Pi process")); }
    });
  }
}
