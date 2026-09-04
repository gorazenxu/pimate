import {
  ItemView,
  WorkspaceLeaf,
  Notice,
  MarkdownRenderer,
  FileSystemAdapter,
  Modal,
  App,
  SuggestModal,
  TFile,
  TFolder,
  MarkdownView,
  Menu,
  setIcon,
} from "obsidian";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, relative } from "path";
import { homedir } from "os";
import type PiAgentPlugin from "./main";
import type {
  AgyConversationIndexEntry,
  AgyConversationScopeOverride,
} from "./PiAgentSettings";
import {
  PiAgentClient,
  type RpcEvent,
  type AssistantMessageEvent,
  type MessageContent,
  type ForkMessage,
  type SessionEntry,
  type PiModel as PiModelFromClient,
} from "./PiAgentClient";
import {
  AgyAgentClient,
  type AgyConversationSummary,
  type AgyConversationWorkspaceStatus,
} from "./AgyAgentClient";
import {
  AGY_GEMINI_PRICING_SOURCE,
  calculateAgyCost,
} from "./AgyPricing";
import {
  AgyUsageStore,
  getAgyUsageStorePath,
  type AgyUsageSnapshot,
  type AgyUsageTotals,
} from "./AgyUsageStore";

export type AgentClient = PiAgentClient | AgyAgentClient;

import {
  isPiCommandFromPath,
  type PiCommandInfo,
} from "./PiCommandUtils";
import { SessionTreeModal } from "./SessionTreeModal";

export const PI_AGENT_VIEW_TYPE = "pimate-chat-view";

// ─── Message Rendering Types ────────────────────────────────────────────

// Use Pi model metadata from the client (includes reasoning / thinkingLevelMap).
// Re-exported here to keep local usage ergonomic.
type PiModel = PiModelFromClient;

interface ExpandedSkillMessage {
  name: string;
  location: string;
  content: string;
  args: string;
}

// Pi's `get_commands` RPC intentionally returns only extension commands,
// prompt templates, and skills. These operations exist on the RPC protocol
// itself, so Pimate supplies them to the same slash-command picker and
// dispatches them directly instead of sending literal `/compact` text to a
// model.
const PIMATE_BUILTIN_COMMANDS: readonly PiCommandInfo[] = [
  { name: "compact", description: "Compress the current conversation context", source: "pimate" },
  { name: "model", description: "Choose the active model", source: "pimate" },
  { name: "fork", description: "Fork from an earlier user prompt", source: "pimate" },
  { name: "tree", description: "Open the current session tree", source: "pimate" },
  { name: "reload", description: "Reload Pi extensions, prompts, and skills", source: "pimate" },
  { name: "export", description: "Export the session (use `html` for HTML)", source: "pimate" },
  { name: "new", description: "Start a new conversation", source: "pimate" },
  { name: "clone", description: "Clone the current branch", source: "pimate" },
  { name: "stats", description: "Show current session statistics", source: "pimate" },
];

interface ResumeSessionItem {
  path: string;
  label: string;
  mtime: number;
  preview?: string;
  engine?: "pi" | "antigravity";
  conversationId?: string;
  agyHistoryScope?: "current" | "unassigned" | "other";
}

interface AgyHistoryBuckets {
  current: ResumeSessionItem[];
  unassigned: ResumeSessionItem[];
  all: ResumeSessionItem[];
}

interface ResumeSessionPreviewCacheEntry {
  mtimeMs: number;
  size: number;
  preview: string;
}

const SESSION_PREVIEW_MAX_BYTES = 128 * 1024;
const AGY_HISTORY_LIST_CACHE_MS = 10_000;
// AGY's stream-json input currently accepts text content blocks only. Pasted
// images are materialized here so AGY can read them from the active vault.
const AGY_IMAGE_ATTACHMENT_DIR = "999agy对话图片";
// Reuse one hidden AGY conversation for title requests, then rotate it before
// its accumulated context starts affecting title quality or startup latency.
const AGY_TITLE_SESSION_MAX_TURNS = 40;

interface ParsedSnippet {
  title: string;
  content: string;
  group?: string;
}

interface ContextItem {
  id: string;
  type: "file" | "folder" | "selection" | "image";
  label: string;
  value: string;
  mimeType?: string;
}

interface ChatTab {
  id: string;
  label: string;
  engine?: "pi" | "antigravity";
  client: AgentClient | null;
  isStreaming: boolean;
  queueCount?: number;
  steeringCount?: number;
  followUpCount?: number;
  modelProvider?: string;
  modelId?: string;
  thinkingLevel?: string;
  // Last known model metadata reported by Pi (only in memory; do not persist).
  // Used to derive available thinking levels without re-querying every popup.
  piModelMeta?: PiModel | null;
  // Monotonic counter incremented before each Pi state sync; stale responses
  // (older sequence) are discarded.
  syncSeq?: number;
  speedStartedAt?: number | null;
  speedEstimatedTokens?: number;
  speedHideAt?: number | null;
  sessionFile?: string;
  sessionId?: string;
  restored?: boolean;
  // True only when get_entries found entries outside the active leaf path.
  // Such sessions must keep using branch-aware RPC reloads after each turn.
  requiresBranchHistoryRpc?: boolean;
  isCompacting?: boolean;
  reloadInFlight?: boolean;
  // Composer state belongs to the tab even though the view reuses one visible
  // textarea and context row for the active tab.
  draft?: string;
  contextItems?: ContextItem[];
  pendingUserImages?: Array<{ data: string; mimeType: string }>;
  smartReviewContinues?: number;
  smartReviewOriginalGoal?: string | null;
}

interface InlineEditReviewResult {
  action: "apply" | "reject" | "regenerate";
  replacement?: string;
}

interface RenderedMessage {
  id: string;
  entryId?: string;
  role: string;
  el: HTMLElement;
  contentEl: HTMLElement;
  forkBtn?: HTMLButtonElement;
  steerBtn?: HTMLButtonElement;
  // For streaming assistant messages
  textBlock?: HTMLElement;
  thinkingBlock?: HTMLElement;
  thinkingContent?: HTMLElement;
  toolBlocks?: Map<string, HTMLElement>;
}

interface PendingQueuedMessage {
  rendered: RenderedMessage;
  rpcMessage: string;
  userInput: string;
  images: Array<{ data: string; mimeType: string }>;
}

interface MentionEntry {
  kind: "file" | "folder";
  file?: TFile;
  folder?: TFolder;
  score: number;
  path: string;
  name: string;
}

export class PiAgentView extends ItemView {
  plugin: PiAgentPlugin;
  client: AgentClient | null = null;
  private chatContainer: HTMLElement | null = null;
  private messageNavEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private streamingTextEl: HTMLElement | null = null;
  private streamingCursorEl: HTMLElement | null = null;
  private sessionTabsEl: HTMLElement | null = null;
  private contextRowEl: HTMLElement | null = null;
  private imagePreviewEl: HTMLElement | null = null;
  private widgetEl: HTMLElement | null = null;
  private abortBtn: HTMLButtonElement | null = null;
  private steerBtn: HTMLButtonElement | null = null;
  private statusBar: HTMLElement | null = null;
  private speedEl: HTMLElement | null = null;
  private speedStartedAt: number | null = null;
  private speedEstimatedTokens = 0;
  private speedTimer: number | null = null;
  private speedHideTimer: number | null = null;
  private footerEngineSelector: HTMLElement | null = null;
  private footerEngineLabel: HTMLElement | null = null;
  private footerModelLabel: HTMLElement | null = null;
  private footerModelDropdown: HTMLElement | null = null;
  private effortSelector: HTMLElement | null = null;
  private effortGearsEl: HTMLElement | null = null;
  private footerEffortCurrent: HTMLElement | null = null;
  private footerEffortOptions: HTMLElement | null = null;
  private compactedContextActive = false;
  private footerContextEl: HTMLElement | null = null;
  private footerContextFillEl: SVGCircleElement | null = null;
  private footerContextPercentEl: HTMLElement | null = null;
  private smartReviewToggleEl: HTMLElement | null = null;
  // Tab ids for which automatic title generation has already been requested.
  // A title is generated at most once per new tab, while manual titles remain
  // authoritative in settings.sessionTitles.
  private titleGenRequested = new Set<string>();
  private pendingAutoTitles = new Map<string, string>();
  private agyTitleGenerationTail: Promise<void> = Promise.resolve();
  private renderedMessages: RenderedMessage[] = [];
  // History paging (used for fast file-based load of large sessions).
  private historyShownCount = 0;     // currently displayed
  private historyTotalCount = 0;     // total messages in file
  private historyBannerEl: HTMLElement | null = null;
  private historyPrependAnchorEl: HTMLElement | null = null;
  private historyPrependInsertIndex = 0;
  // When history comes from Pi's session tree, retain the complete active
  // branch so paging never falls back to a flattened JSONL file.
  private activeBranchHistory: any[] | null = null;
  // Session previews only need the beginning of each JSONL file. Cache them
  // until the file changes so opening/closing the history panel is cheap.
  private readonly resumeSessionPreviewCache = new Map<
    string,
    ResumeSessionPreviewCacheEntry
  >();
  private tabs: ChatTab[] = [];
  private activeTabId: string | null = null;
  // A tab switch can involve several async RPCs. Only the newest switch is
  // allowed to publish its client/history back into the shared view state.
  private tabSwitchSeq = 0;
  private historyPanelEl: HTMLElement | null = null;
  private modelPopupEl: HTMLElement | null = null;
  private effortPopupEl: HTMLElement | null = null;
  private isHistoryOpen = false;
  // AGY's own cache is global. Keep a short-lived view cache after Pimate has
  // classified records by this vault, so reopening the history panel does not
  // repeatedly scan AGY metadata and the usage journal.
  private agyHistoryScope: "current" | "unassigned" | "all" = "current";
  private agyHistoryCache: {
    workspacePath: string;
    createdAt: number;
    buckets: AgyHistoryBuckets;
  } | null = null;
  private nextTabNumber = 1;
  private contextItems: ContextItem[] = [];
  private isStreaming = false;
  // A hard steer is intentionally different from Pi's native `steer`: it
  // first aborts the current stream, then starts a replacement prompt.
  private hardSteerInFlight = false;
  private abortInFlight = false;
  private pendingQueuedMessages: PendingQueuedMessage[] = [];
  private currentAssistantMsg: RenderedMessage | null = null;
  private currentTextBlock: HTMLElement | null = null;
  private currentThinkingBlock: HTMLElement | null = null;
  private currentThinkingContent: HTMLElement | null = null;
  private thinkingStartedAt: number | null = null;
  private thinkingTimer: number | null = null;
  private shouldAutoScroll = true;
  private pendingUIRequests = new Map<string, (value: unknown) => void>();
  // Pi get_fork_messages is the sole authority for card-level Fork actions.
  private forkMessagesByEntryId = new Map<string, ForkMessage>();
  private forkScopeVersion = 0;

  // ─── Stream Render Helper States ────────────────────────────────────
  private lastRenderTime = 0;
  private renderTimeout: number | null = null;
  private currentRawText = "";
  private currentBlockRawText = "";

  // ─── Autocomplete Mention Helper States ─────────────────────────────
  private mentionDropdown: HTMLElement | null = null;
  private filteredMentionFiles: MentionEntry[] = [];
  private activeMentionIndex = 0;
  private mentionQueryStart = -1;

  // ─── Autocomplete Slash Command Helper States ───────────────────────
  private commandDropdown: HTMLElement | null = null;
  private filteredCommands: PiCommandInfo[] = [];
  private activeCommandIndex = 0;
  private commandQueryStart = -1;
  private availableCommands: PiCommandInfo[] = [...PIMATE_BUILTIN_COMMANDS];
  private commandLoadPromise: Promise<void> | null = null;
  private commandLoadClient: AgentClient | null = null;
  private commandCatalogClient: AgentClient | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: PiAgentPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  setInputText(text: string): void {
    if (!this.inputEl) return;
    this.inputEl.value = text;
    this.resizeInputEl();
    this.inputEl.focus();
  }

  prependInputText(text: string): void {
    if (!this.inputEl) return;
    this.inputEl.value = text + this.inputEl.value;
    this.resizeInputEl();
    this.inputEl.focus();
  }

  appendInputText(text: string): void {
    if (!this.inputEl) return;
    const needsSpace = this.inputEl.value.length > 0 && !/\s$/.test(this.inputEl.value);
    this.inputEl.value = `${this.inputEl.value}${needsSpace ? " " : ""}${text}`;
    this.resizeInputEl();
    this.inputEl.focus();
  }

  private resizeInputEl(): void {
    if (!this.inputEl) return;
    this.inputEl.setCssProps({ height: "auto" });
    // 限制最大高度为 240px，防止高度占满整个聊天视口
    this.inputEl.setCssProps({ height: `${Math.min(this.inputEl.scrollHeight, 240)}px` });
  }

  focusComposer(): void {
    this.inputEl?.focus();
  }

  private runAsync(task: () => Promise<void>): void {
    void task().catch((err: unknown) => {
      console.error("[pimate] async action failed", err);
      new Notice(err instanceof Error ? err.message : String(err));
    });
  }

  async newChatSession(): Promise<void> {
    await this.newSession();
  }

  async closeActiveSessionTab(): Promise<void> {
    if (this.activeTabId) await this.closeTab(this.activeTabId);
  }

  async resumePreviousSession(): Promise<void> {
    await this.showResumeSelector();
  }

  async forkFromPreviousPrompt(): Promise<void> {
    await this.showForkSelector();
  }

  async cloneCurrentSessionBranch(): Promise<void> {
    await this.cloneCurrentBranch();
  }

  scrollToPreviousMessage(): void {
    this.focusAdjacentMessage(-1);
  }

  scrollToNextMessage(): void {
    this.focusAdjacentMessage(1);
  }

  toggleLastToolBlock(): void {
    const outputs = Array.from(this.chatContainer?.querySelectorAll(".pi-agent-tool-output") || []) as HTMLElement[];
    const output = outputs[outputs.length - 1];
    if (output) output.toggleClass("is-visible", !output.hasClass("is-visible"));
  }

  scrollToLastDiff(): void {
    const diff = Array.from(this.chatContainer?.querySelectorAll(".pi-agent-diff-pre") || []).pop() as HTMLElement | undefined;
    diff?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  addActiveFileContext(): void {
    this.addCurrentFileContext();
  }

  addExplorerSelectionContext(): void {
    const isZh = this.plugin.settings.language === "zh";
    const items = this.plugin.getExplorerSelectionForContext();
    if (items.length === 0) {
      new Notice(
        isZh
          ? "Pimate：没有检测到文件管理器选中项。请先在左侧文件管理器中多选文件/文件夹。"
          : "Pimate: no file-explorer selection detected. Select files/folders in the file explorer first."
      );
      return;
    }

    let count = 0;
    for (const item of items) {
      if (item instanceof TFile) {
        this.addFileContextItem(item);
        count++;
      } else if (item instanceof TFolder) {
        this.addFolderContextItem(item, true);
        count++;
      }
    }
    new Notice(
      isZh
        ? `Pimate：已附加 ${count} 个选中项到上下文`
        : `Pimate: attached ${count} selected item${count === 1 ? "" : "s"} to context`
    );
    this.inputEl?.focus();
  }

  openCommandsAndSkills(): void {
    this.runAsync(() => this.showCommandSelector());
  }

  addSelectionContext(selection: string): void {
    const trimmed = selection.trim();
    if (!trimmed) return;
    this.addContextItem({
      id: `ctx-sel-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "selection",
      label: `${trimmed.slice(0, 28)}${trimmed.length > 28 ? "…" : ""}`,
      value: trimmed,
    });
    this.inputEl?.focus();
  }

  getViewType(): string {
    return PI_AGENT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Pimate";
  }

  getIcon(): string {
    return "pimate-logo";
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("pi-agent-container");

    const isZh = this.plugin.settings.language === "zh";

    // ─── Build UI ──────────────────────────────────────────────────────
    const header = container.createDiv("pi-agent-header");

    const titleEl = header.createDiv("pi-agent-title");
    titleEl.createSpan({ text: "π", cls: "pi-agent-logo" });
    titleEl.createSpan({ text: "Pimate" });

    this.speedEl = header.createDiv("pi-agent-speed-indicator pi-agent-hidden");
    this.speedEl.setAttribute("title", isZh ? "实时输出速度（估算）" : "Realtime output speed (estimated)");

    // 右上角设置按钮 (按用户要求保留，放右上角合适的位置)
    const headerActions = header.createDiv("pi-agent-header-actions");

    const moreBtn = headerActions.createDiv("pi-agent-mini-action");
    setIcon(moreBtn, "more-horizontal");
    moreBtn.setAttribute("title", isZh ? "更多操作" : "More actions");
    moreBtn.onclick = (e) => this.showMoreMenu(e);

    const settingsBtn = headerActions.createDiv("pi-agent-mini-action");
    setIcon(settingsBtn, "settings");
    settingsBtn.setAttribute("title", isZh ? "插件设置" : "Plugin settings");
    settingsBtn.onclick = () => {
      const setting = (this.app as any).setting;
      if (setting) {
        setting.open();
        setting.openTabById(this.plugin.manifest.id);
      }
    };

    this.chatContainer = container.createDiv("pi-agent-chat");
    this.renderEmptyState();

    this.historyPanelEl = container.createDiv("pi-agent-history-panel");
    this.historyPanelEl.addClass("pi-agent-hidden");

    this.widgetEl = container.createDiv("pi-agent-widget");
    this.widgetEl.addClass("pi-agent-hidden");

    // Toolbar above input wrapper
    const composerTools = container.createDiv("pi-agent-composer-tools");
    this.sessionTabsEl = composerTools.createDiv("pi-agent-session-tabs");

    const composerActions = composerTools.createDiv("pi-agent-composer-actions");

    const newTabBtn = composerActions.createDiv("pi-agent-mini-action");
    setIcon(newTabBtn, "square-plus");
    newTabBtn.setAttribute("title", isZh ? "新建会话卡" : "New tab");
    newTabBtn.onclick = () => {
      const maxTabs = this.plugin.settings.maxTabs || 3;
      if (this.tabs.length < maxTabs) {
        this.runAsync(() => this.createAndSwitchTab());
      } else {
        new Notice(isZh ? `已达到最大会话卡数量限制 (${maxTabs})` : `Maximum tab count reached (${maxTabs})`);
      }
    };
    // 新建按钮右键：重置所有会话卡
    newTabBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "重置所有会话卡 (1, 2, 3)" : "Reset all session tabs")
            .setIcon("refresh-cw")
            .onClick(() => this.runAsync(async () => {
              for (const t of this.tabs) {
                await t.client?.destroy();
                t.client = null;
                t.sessionFile = undefined;
                t.sessionId = undefined;
                t.restored = false;
                t.requiresBranchHistoryRpc = false;
                t.label = t.id.split("-").pop() || "Tab";
              }
              if (this.chatContainer) this.chatContainer.empty();
              this.renderedMessages = [];
              this.renderEmptyState();
              
              const active = this.activeTab;
              if (active) {
                await this.ensureTabClient(active);
                this.client = active.client;
                await this.refreshStateDisplay();
                await this.loadAvailableCommands();
              }
              this.renderTabs();
              this.updateButtons();
              await this.persistSessionTabs();
              new Notice(isZh ? "所有会话卡均已重置" : "All session tabs reset");
            }));
      });
      menu.showAtMouseEvent(e);
    });

    const forkBtn = composerActions.createDiv("pi-agent-mini-action");
    setIcon(forkBtn, "square-pen");
    forkBtn.setAttribute("title", isZh ? "新建/重置当前会话" : "New conversation");
    forkBtn.onclick = () => this.runAsync(() => this.newSession());
    // 分支按钮右键：分支或克隆
    forkBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "分支当前会话..." : "Fork current conversation...")
            .setIcon("git-fork")
            .onClick(() => this.runAsync(() => this.showForkSelector()));
      });
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "克隆当前会话分支" : "Clone current branch")
            .setIcon("copy")
            .onClick(() => this.runAsync(() => this.cloneCurrentBranch()));
      });
      menu.showAtMouseEvent(e);
    });

    const historyBtn = composerActions.createDiv("pi-agent-mini-action");
    setIcon(historyBtn, "history");
    historyBtn.setAttribute("title", isZh ? "恢复会话/历史" : "History sessions");
    historyBtn.onclick = () => this.runAsync(() => this.toggleHistoryPanel());
    // 历史按钮右键：在系统管理器中打开历史目录
    historyBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "打开历史会话保存目录" : "Open history sessions directory")
            .setIcon("folder")
            .onClick(() => {
              try {
                const historyDir = join(homedir(), ".pi", "sessions");
                const electron = (window as unknown as { require?: (moduleName: string) => { shell?: { openPath: (target: string) => Promise<string> } } }).require?.("electron");
                void electron?.shell?.openPath(historyDir);
              } catch (err) {
                new Notice(isZh ? `无法打开目录: ${(err as Error).message}` : `Cannot open dir: ${(err as Error).message}`);
              }
            });
      });
      menu.showAtMouseEvent(e);
    });

    const inputArea = container.createDiv("pi-agent-input-area");
    this.contextRowEl = inputArea.createDiv("pi-agent-context-row");
    this.imagePreviewEl = inputArea.createDiv("pi-agent-image-preview");

    // Wrap textarea + right-side controls in a flex row. The right column
    // contains the 4 message-nav buttons stacked vertically.
    const inputRow = inputArea.createDiv("pi-agent-input-row");

    this.inputEl = inputRow.createEl("textarea", {
      cls: "pi-agent-input",
      attr: {
        placeholder: "How can I help you today?",
        rows: "4",
      },
    });

    // Right-side controls: 4 message-nav buttons stacked.
    const rightCol = inputRow.createDiv("pi-agent-input-right");
    const navEl = rightCol.createDiv("pi-agent-message-nav");
    const mkNavBtn = (cls: string, icon: string, title: string, handler: () => void) => {
      const btn = navEl.createDiv(`pi-agent-message-nav-btn ${cls}`);
      setIcon(btn, icon);
      btn.setAttribute("title", title);
      btn.onclick = handler;
      return btn;
    };
    mkNavBtn("is-first", "chevrons-up",       "Jump to first user message",     () => this.focusEdgeMessage("first"));
    mkNavBtn("is-prev",  "chevron-up",        "Previous user message (Alt+↑)",  () => this.focusAdjacentMessage(-1));
    mkNavBtn("is-next",  "chevron-down",      "Next user message (Alt+↓)",      () => this.focusAdjacentMessage(1));
    mkNavBtn("is-last",  "chevrons-down",     "Jump to last user message",      () => this.focusEdgeMessage("last"));
    this.messageNavEl = navEl;

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      // 1. Mention autocomplete key intercepts
      if (this.mentionDropdown && this.filteredMentionFiles.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.activeMentionIndex = (this.activeMentionIndex + 1) % this.filteredMentionFiles.length;
          this.renderMentionDropdownItems();
          return;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.activeMentionIndex =
            (this.activeMentionIndex - 1 + this.filteredMentionFiles.length) %
            this.filteredMentionFiles.length;
          this.renderMentionDropdownItems();
          return;
        } else if (e.key === "Enter") {
          e.preventDefault();
          this.insertMentionSelection();
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.closeMentionDropdown();
          return;
        }
      }

      // 2. Command autocomplete key intercepts
      if (this.commandDropdown && this.filteredCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.activeCommandIndex = (this.activeCommandIndex + 1) % this.filteredCommands.length;
          this.renderCommandDropdownItems();
          return;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          this.activeCommandIndex =
            (this.activeCommandIndex - 1 + this.filteredCommands.length) %
            this.filteredCommands.length;
          this.renderCommandDropdownItems();
          return;
        } else if (e.key === "Enter") {
          e.preventDefault();
          // A complete Pimate built-in command should run on the first Enter;
          // otherwise `/compact` would only be reinserted as `/compact ` and
          // look as if it had no effect.
          const builtin = this.parsePimateBuiltinCommand(this.inputEl?.value || "");
          if (builtin && !builtin.args) {
            this.closeCommandDropdown();
            this.runAsync(() => this.sendMessage());
            return;
          }
          this.insertCommandSelection();
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.closeCommandDropdown();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.runAsync(() => this.sendMessage());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        this.runAsync(() => this.showCommandSelector());
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        this.runAsync(() => this.newSession());
      } else if (e.altKey && e.key === "ArrowUp") {
        e.preventDefault();
        this.scrollToPreviousMessage();
      } else if (e.altKey && e.key === "ArrowDown") {
        e.preventDefault();
        this.scrollToNextMessage();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        this.toggleLastToolBlock();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "d") {
        e.preventDefault();
        this.scrollToLastDiff();
      } else if (e.key === "Escape" && this.isStreaming) {
        e.preventDefault();
        this.abortAgent();
      }
    });

     this.inputEl.addEventListener("paste", (e: ClipboardEvent) => {
      this.runAsync(() => this.handlePaste(e));
    });
    this.inputEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      this.inputEl?.addClass("is-drag-over");
    });
    this.inputEl.addEventListener("dragleave", () => {
      this.inputEl?.removeClass("is-drag-over");
    });
    this.inputEl.addEventListener("drop", (e: DragEvent) => {
      this.runAsync(() => this.handleDrop(e));
    });
    this.inputEl.addEventListener("input", () => {
      if (this.activeTab) this.activeTab.draft = this.inputEl?.value || "";
      this.updateInputModeState();
      this.handleMentionInput();
      this.handleCommandInput();
      this.resizeInputEl();
      this.updateButtons();
    });

    const footer = inputArea.createDiv("pi-agent-input-footer");
    const footerLeft = footer.createDiv("pi-agent-input-footer-left");
    
    // 0. Engine Selector Container
    this.footerEngineSelector = footerLeft.createDiv("pi-agent-engine-selector");
    const footerEngineBtn = this.footerEngineSelector.createDiv("pi-agent-engine-btn");
    this.footerEngineLabel = footerEngineBtn.createSpan("pi-agent-engine-label");
    this.updateEngineDisplay();

    footerEngineBtn.onclick = (e) => {
      e.stopPropagation();
      this.toggleEngineMenu(footerEngineBtn);
    };

    // 1. Model Selector Container (Compat with Claudian)
    const modelSelector = footerLeft.createDiv("pi-agent-model-selector");
    const footerModelBtn = modelSelector.createDiv("pi-agent-model-btn");
    this.footerModelLabel = footerModelBtn.createSpan("pi-agent-model-label");
    this.footerModelLabel.setText(this.getModelShortName(this.plugin.settings.modelId || "Sonnet"));
    this.footerModelLabel.setAttribute("title", `${this.plugin.settings.provider || ""}/${this.plugin.settings.modelId || ""}`);
    
    // 点击模型按钮，在按钮正上方弹起局部的模型选择浮层
    footerModelBtn.onclick = (e) => {
      e.stopPropagation();
      this.runAsync(() => this.toggleModelPopup(footerModelBtn));
    };

    // 2. Effort Selector Container (Compat with Claudian)
    this.effortSelector = footerLeft.createDiv("pi-agent-thinking-effort");
    const effortLabel = this.effortSelector.createSpan("pi-agent-thinking-label-text");
    effortLabel.setText(isZh ? "Effort:" : "Effort:");
    this.effortGearsEl = this.effortSelector.createDiv("pi-agent-thinking-gears");
    this.footerEffortCurrent = this.effortGearsEl.createDiv("pi-agent-thinking-current");
    this.footerEffortCurrent.setText(this.getThinkingLevelLabel(this.plugin.settings.thinkingLevel));
    
    // 点击思考强度，在上方弹起局部的思考强度选择浮层
    this.effortGearsEl.onclick = (e) => {
      e.stopPropagation();
      if (this.effortGearsEl) {
        this.runAsync(() => this.toggleEffortPopup(this.effortGearsEl!));
      }
    };

    // 3. Folder Context Button
    const folderBtn = footerLeft.createSpan({
      cls: "pi-agent-footer-folder-btn",
      attr: { title: isZh ? "选择文件上下文" : "Select file context" },
    });
    setIcon(folderBtn, "folder");
    folderBtn.onclick = () => this.runAsync(() => this.addFileContext());

    this.statusBar = footerLeft.createSpan({
      text: "Starting…",
      cls: "pi-agent-status pi-agent-status-thinking",
    });
    this.footerContextEl = footerLeft.createSpan({
      cls: "pi-agent-context-meter-inline",
      attr: { title: "Context usage" },
    });
    const svg = this.footerContextEl.createSvg("svg", {
      attr: { viewBox: "0 0 24 24", width: "18", height: "18" },
    });
    svg.createSvg("circle", {
      cls: "pi-agent-context-meter-bg",
      attr: { cx: "12", cy: "12", r: "8", fill: "none", "stroke-width": "2" },
    });
    this.footerContextFillEl = svg.createSvg("circle", {
      cls: "pi-agent-context-meter-fill",
      attr: {
        cx: "12",
        cy: "12",
        r: "8",
        fill: "none",
        "stroke-width": "2",
        "stroke-linecap": "round",
      },
    }) as SVGCircleElement;
    this.footerContextPercentEl = this.footerContextEl.createSpan({ text: "", cls: "pi-agent-context-meter-percent" });

    const footerRight = footer.createDiv("pi-agent-input-footer-right");

    // Smart Review Toggle
    this.smartReviewToggleEl = footerRight.createSpan({ cls: "pi-agent-smart-review-toggle" });
    this.smartReviewToggleEl.onclick = () => {
      this.runAsync(async () => {
        this.plugin.settings.smartReviewEnabled = !this.plugin.settings.smartReviewEnabled;
        await this.plugin.saveSettings();
        this.updateSmartReviewToggleUI();
      });
    };
    this.updateSmartReviewToggleUI();

    // While Pi is generating, ordinary sends are queued as follow-ups. This
    // one-shot action explicitly stops the current run and starts the typed
    // message as the new direction.
    this.steerBtn = footerRight.createEl("button", {
      cls: "pi-agent-footer-btn pi-agent-steer-btn pi-agent-hidden",
      attr: {
        title: isZh ? "中断当前回复并按输入调整" : "Stop current response and redirect",
        "aria-label": isZh ? "中断当前回复并按输入调整" : "Stop current response and redirect",
      },
    });
    setIcon(this.steerBtn, "corner-up-right");
    this.steerBtn.createSpan({ text: isZh ? "调整方向" : "Steer" });
    this.steerBtn.onclick = () => this.runAsync(() => this.sendMessage("steer"));

    this.abortBtn = footerRight.createEl("button", {
      text: "×",
      cls: "pi-agent-footer-btn pi-agent-abort-btn",
      attr: { title: "Abort" },
    });
    this.abortBtn.addClass("pi-agent-hidden");
    this.abortBtn.onclick = () => this.abortAgent();

    // ─── Start real Pi session tabs ───────────────────────────────────
    await this.restoreOrCreateInitialTab();
  }

  // ─── Client Management ────────────────────────────────────────────────

  private get activeTab(): ChatTab | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null;
  }

  private saveActiveComposerState(): void {
    const tab = this.activeTab;
    if (!tab) return;
    if (this.inputEl) tab.draft = this.inputEl.value;
    tab.contextItems = this.contextItems.map((item) => ({ ...item }));
  }

  private restoreComposerState(tab: ChatTab): void {
    if (this.inputEl) {
      this.inputEl.value = tab.draft || "";
      this.resizeInputEl();
    }
    this.contextItems = (tab.contextItems || []).map((item) => ({ ...item }));
    this.renderContextItems();
    this.updateInputModeState();
    this.closeMentionDropdown();
    this.closeCommandDropdown();
  }

  private async restoreOrCreateInitialTab(): Promise<void> {
    const maxTabs = this.plugin.settings.maxTabs || 3;
    const persisted = this.plugin.settings.sessionTabs || [];

    this.tabs = [];
    // 有历史缓存时按历史缓存的卡片数还原（保持关闭某些卡片后的数量），初次无缓存时直接满额开满 maxTabs 个
    const count = persisted.length > 0 ? Math.min(persisted.length, maxTabs) : maxTabs;

    for (let i = 1; i <= count; i++) {
      const pTab = persisted[i - 1];
      const defaultEngine = this.plugin.settings.enableAntigravity === false
        ? "pi"
        : (this.plugin.settings.defaultEngine || "pi");
      const engine = this.plugin.settings.enableAntigravity === false
        ? "pi"
        : (pTab?.engine || defaultEngine);
      this.tabs.push({
        id: `tab-static-${i}`,
        label: String(i),
        client: null,
        isStreaming: false,
        engine,
        modelProvider: pTab?.modelProvider || (engine === "antigravity" ? "antigravity" : this.plugin.settings.provider),
        modelId: pTab?.modelId || (engine === "antigravity" ? this.plugin.settings.agyModel : this.plugin.settings.modelId),
        thinkingLevel: pTab?.thinkingLevel || (engine === "antigravity" ? this.plugin.settings.agyEffort : this.plugin.settings.thinkingLevel),
        sessionFile: pTab?.sessionFile,
        sessionId: pTab?.sessionId,
        restored: !!pTab?.sessionFile || !!pTab?.sessionId,
        requiresBranchHistoryRpc: false,
      });
    }

    const savedIndex = this.plugin.settings.activeTabIndex;
    let active = (typeof savedIndex === "number" && savedIndex >= 0 && savedIndex < this.tabs.length)
      ? this.tabs[savedIndex]
      : undefined;
    if (!active && this.plugin.settings.activeSessionFile) {
      active = this.tabs.find((tab) => tab.sessionFile?.toLowerCase() === this.plugin.settings.activeSessionFile?.toLowerCase());
    }
    if (!active) {
      active = this.tabs[0];
    }
    this.activeTabId = active?.id || null;
    this.renderTabs();
    if (active) await this.switchToTab(active.id);
  }

  private async createAndSwitchTab(): Promise<void> {
    const defaultEngine = this.plugin.settings.enableAntigravity === false
      ? "pi"
      : (this.plugin.settings.defaultEngine || "pi");
    const tab: ChatTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label: "",
      client: null,
      isStreaming: false,
      engine: defaultEngine,
      modelProvider: defaultEngine === "antigravity" ? "antigravity" : this.plugin.settings.provider,
      modelId: defaultEngine === "antigravity" ? this.plugin.settings.agyModel : this.plugin.settings.modelId,
      thinkingLevel: defaultEngine === "antigravity" ? this.plugin.settings.agyEffort : this.plugin.settings.thinkingLevel,
      requiresBranchHistoryRpc: false,
    };
    this.saveActiveComposerState();
    this.tabs.push(tab);
    this.activeTabId = tab.id;
    this.renderTabs();
    await this.ensureTabClient(tab);
    await this.switchToTab(tab.id);
    await this.persistSessionTabs();
  }

  private renderTabs(): void {
    if (!this.sessionTabsEl) return;
    this.sessionTabsEl.empty();
    const isZh = this.plugin.settings.language === "zh";
    
    // 1. 渲染固定选项卡 1, 2, 3
    for (let index = 0; index < this.tabs.length; index++) {
      const tab = this.tabs[index];
      const tabEl = this.sessionTabsEl.createSpan({
        cls: `pi-agent-session-tab ${tab.id === this.activeTabId ? "is-active" : ""}`,
        attr: { title: isZh ? `会话卡 ${index + 1}` : `Session ${index + 1}` },
      });
      tabEl.createSpan({ text: String(index + 1), cls: "pi-agent-session-tab-label" });
      tabEl.onclick = () => this.runAsync(() => this.switchToTab(tab.id));
      
      // 选项卡右键功能：直接关闭，无需二级菜单
      tabEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.runAsync(() => this.closeTab(tab.id));
      });
    }

  }

  private async resetTabSession(tab: ChatTab): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";
    if (tab.isStreaming) {
      new Notice(isZh ? "该会话正在流式传输，请先停止" : "Streaming active, please stop first");
      return;
    }
    await tab.client?.destroy();
    tab.client = null;
    tab.sessionFile = undefined;
    tab.sessionId = undefined;
    tab.restored = false;
    tab.requiresBranchHistoryRpc = false;
    tab.label = tab.id.split("-").pop() || "Tab";
    
    if (tab.id === this.activeTabId) {
      if (this.chatContainer) this.chatContainer.empty();
      this.renderedMessages = [];
      this.pendingQueuedMessages = [];
      this.renderEmptyState();
      await this.ensureTabClient(tab);
      this.client = tab.client;
      await this.refreshStateDisplay();
      await this.loadAvailableCommands();
    }
    this.renderTabs();
    this.updateButtons();
    await this.persistSessionTabs();
    new Notice(isZh ? `会话卡 ${tab.label} 已重置` : `Session tab ${tab.label} reset`);
  }

  private async switchToTab(tabId: string): Promise<void> {
    const tab = this.tabs.find((item) => item.id === tabId);
    if (!tab) return;
    this.saveActiveComposerState();
    const switchSeq = ++this.tabSwitchSeq;
    this.activeTabId = tab.id;
    this.client = tab.client;
    this.updateEngineDisplay();
    this.restoreComposerState(tab);
    this.forkMessagesByEntryId.clear();
    this.forkScopeVersion++;
    this.pendingQueuedMessages = [];
    this.availableCommands = [...PIMATE_BUILTIN_COMMANDS];
    this.commandCatalogClient = null;
    this.isStreaming = tab.isStreaming;
    this.renderTabs();
    this.resetActiveRenderState();
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];
    this.activeBranchHistory = null;
    this.historyShownCount = 0;
    this.historyTotalCount = 0;
    this.historyBannerEl = null;
    this.renderEmptyState();
    this.updateWidget("tasks", undefined);
    await this.ensureTabClient(tab);
    if (this.tabSwitchSeq !== switchSeq || this.activeTab !== tab) return;

    const client = tab.client;
    this.client = client;
    this.renderActiveTabRuntimeStatus();
    this.renderActiveTabSpeed();
    // Parallelize non-blocking post-start calls so the UI feels snappy.
    // Each call sets a different part of the UI and they don't depend on each other.
    void this.refreshStateDisplay(tab, client);
    void this.loadAvailableCommands(client);
    // A Pi tab may restore a session that already contains sibling branches,
    // so calibrate once against Pi's authoritative active leaf. AGY has no
    // entry-tree RPC; asking it for one only adds a failed round trip before
    // its transcript-backed history is loaded.
    await this.loadMessages({
      forceRpc: tab.engine !== "antigravity",
      expectedTab: tab,
      expectedClient: client,
      expectedSwitchSeq: switchSeq,
    });
    if (this.tabSwitchSeq !== switchSeq || this.activeTab !== tab || this.client !== client) return;
    void this.refreshForkMessages();
    this.renderActiveTabRuntimeStatus();
    this.renderActiveTabSpeed();
    this.renderActiveTabModelAndEffort();
    this.updateButtons();
    void this.persistSessionTabs();
  }

  private async closeTab(tabId: string): Promise<void> {
    const index = this.tabs.findIndex((tab) => tab.id === tabId);
    if (index === -1) return;
    const [tab] = this.tabs.splice(index, 1);
    await tab.client?.destroy();
    tab.client = null;

    if (this.tabs.length === 0) {
      this.activeTabId = null;
      this.client = null;
      await this.createAndSwitchTab();
      return;
    }

    if (this.activeTabId === tabId) {
      const next = this.tabs[Math.max(0, index - 1)] || this.tabs[0];
      await this.switchToTab(next.id);
    } else {
      this.renderTabs();
    }
    await this.persistSessionTabs();
  }

  private isSessionFileInCurrentWorkspace(sessionFile: string): boolean {
    if (!sessionFile) return false;
    const vaultPath = (this.app.vault.adapter as any).getBasePath?.() || "";
    if (!vaultPath) return true;
    const encodedDirName = this.encodeWorkspacePath(vaultPath).toLowerCase();
    const pathLower = sessionFile.toLowerCase().replace(/\\/g, "/");
    return pathLower.includes(`/sessions/${encodedDirName}/`);
  }

  private async ensureTabClient(
    tab: ChatTab,
    options: { requireSessionRestore?: boolean } = {}
  ): Promise<void> {
    if (tab.engine === "antigravity" && tab.sessionId) {
      const conversationId = tab.sessionId.trim();
      const workspaceStatus = this.getAgyConversationWorkspaceStatus(conversationId);
      if (workspaceStatus === "foreign" || workspaceStatus === "missing") {
        const reason = workspaceStatus === "foreign"
          ? "another workspace"
          : "no longer exists";
        console.warn(
          `[pimate] Unbinding AGY conversation ${conversationId}: ${reason}.`
        );
        const staleClient = tab.client;
        if (staleClient) {
          await staleClient.destroy().catch(() => undefined);
          if (tab.client === staleClient) tab.client = null;
          if (this.client === staleClient) this.client = null;
        }
        // Keep the AGY transcript and Pimate title metadata. Only remove the
        // tab's runtime binding so the next client starts a new conversation
        // in the current Vault.
        tab.sessionId = undefined;
        tab.restored = false;
      }
    }

    if (tab.sessionFile && !this.isSessionFileInCurrentWorkspace(tab.sessionFile)) {
      console.log(`[pi-agent] SessionFile ${tab.sessionFile} belongs to another workspace, unbinding to start fresh.`);
      tab.sessionFile = undefined;
      tab.sessionId = undefined;
      tab.restored = false;
      tab.requiresBranchHistoryRpc = false;
    }

    if (tab.client?.isRunning()) {
      await this.applyTabRuntimePreferences(tab);
      return;
    }

    const client = this.createClient(tab);
    tab.client = client;

    client.on("event", (event: RpcEvent) => {
      this.recordTabRuntimeState(tab, event);
      if (this.activeTabId !== tab.id) return;
      this.handleEvent(event, tab);
    });

    client.on("error", (err: Error) => {
      if (this.activeTabId === tab.id) this.setStatus(`❌ Error: ${err.message}`, "error");
    });

    client.on("close", () => {
      tab.isStreaming = false;
      if (this.activeTabId === tab.id) {
        const engineLabel = client.engine === "antigravity" ? "Antigravity CLI" : "Pi process";
        this.setStatus(`⚠️ ${engineLabel} disconnected`, "warning");
        this.isStreaming = false;
        this.updateButtons();
      }
    });

    try {
      await client.start();
      if (client.engine === "antigravity") {
        tab.sessionId = (client as AgyAgentClient).getConversationId() || tab.sessionId;
      } else if (tab.sessionFile) {
        const result = await client.switchSession(tab.sessionFile);
        if (!result.success || (result.data as any)?.cancelled) {
          const restoreError = result.error || `Failed to restore session: ${tab.label}`;
          if (options.requireSessionRestore) throw new Error(restoreError);
          new Notice(restoreError);
        }
      }
      await this.applyTabRuntimePreferences(tab);
      if (this.activeTabId === tab.id) {
        this.setStatus("Ready", "ok");
        void this.loadAvailableCommands();
      }
    } catch (err) {
      if (this.activeTabId === tab.id) {
        const engineLabel = client.engine === "antigravity" ? "Antigravity CLI" : "pi";
        this.setStatus(
          `❌ Failed to start ${engineLabel}: ${(err as Error).message}`,
          "error"
        );
      }
      if (options.requireSessionRestore) {
        await client.destroy().catch(() => undefined);
        if (tab.client === client) tab.client = null;
        throw err;
      }
    }
  }

  private createClient(tab?: ChatTab): AgentClient {
    const settings = this.plugin.settings;
    const adapter = this.app.vault.adapter;
    const vaultBasePath =
      adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;

    let engine = tab?.engine || settings.defaultEngine || "antigravity";
    if (settings.enableAntigravity === false) {
      engine = "pi";
    }

    if (engine === "antigravity") {
      const modelId = tab?.modelId || settings.agyModel || "gemini-3.8-flash-high";
      const effort = tab?.thinkingLevel || settings.agyEffort || "high";
      return new AgyAgentClient({
        agyPath: settings.agyPath,
        modelId,
        effort,
        cwd: vaultBasePath,
        workspacePath: vaultBasePath,
        conversationId: tab?.sessionId,
        dangerouslySkipPermissions: settings.agyAutoApproveTools === true,
      });
    }

    const provider = tab?.modelProvider || settings.provider;
    const modelId = tab?.modelId || settings.modelId;
    const thinkingLevel = tab?.thinkingLevel || settings.thinkingLevel;

    return new PiAgentClient({
      piPath: settings.piPath,
      provider,
      modelId,
      thinkingLevel,
      // 优先用当前 provider 在 auth.json 里的 key（面板"凭证配置区"填的），
      // 否则回退到全局 settings.apiKey。PiAgentClient 会按 provider 把它
      // 注入对应环境变量（如 ZAI_API_KEY），让 pi 后端 models.json 的
      // "$XXX_API_KEY" 能解析成功。
      apiKey: this.readProviderApiKey(provider) || settings.apiKey,
      cwd: vaultBasePath,
      noSession: false,
      extensionPaths: this.plugin.piReloadBridgePath
        ? [this.plugin.piReloadBridgePath]
        : undefined,
    });
  }

  // 按当前 provider 从 ~/.pi/agent/auth.json 读取 API Key。
  // 与 PiAgentSettings.readApiKey 同源（面板"凭证配置区"写入的就是这里）。
  // OAuth 类型（如 openai-codex）不返回 key —— pi 后端自行用 auth.json 的 OAuth token。
  private readProviderApiKey(provider: string): string {
    try {
      const filePath = join(homedir(), ".pi", "agent", "auth.json");
      if (!existsSync(filePath)) return "";
      const data = JSON.parse(readFileSync(filePath, "utf-8"));
      const item = data?.[provider];
      if (item && item.type === "api_key" && typeof item.key === "string") {
        return item.key.trim();
      }
      return "";
    } catch (e) {
      console.warn("[pimate] readProviderApiKey failed:", e);
      return "";
    }
  }

  private async applyTabRuntimePreferences(tab: ChatTab): Promise<void> {
    if (!tab.client) return;
    try {
      if (tab.modelProvider && tab.modelId) {
        await tab.client.setModel(tab.modelProvider, tab.modelId);
      }
      if (typeof tab.thinkingLevel === "string") {
        await tab.client.setThinkingLevel(tab.thinkingLevel);
      }
    } catch (err) {
      console.warn("[pimate] failed to apply tab runtime preferences", err);
    } finally {
      // Pull authoritative state so any clamp by Pi overrides the
      // persisted preference value (e.g. `xhigh` was saved but the
      // resumed model only supports `high`).
      await this.syncTabStateFromPi(tab);
    }
  }

  private async updateActiveTabModel(provider: string, modelId: string): Promise<void> {
    const tab = this.activeTab;
    if (!tab?.client) {
      if (tab) {
        tab.modelProvider = provider;
        tab.modelId = modelId;
      }
      if (tab?.engine === "antigravity") {
        this.plugin.settings.agyModel = modelId;
      } else {
        this.plugin.settings.provider = provider;
        this.plugin.settings.modelId = modelId;
      }
      await this.plugin.saveSettings();
      await this.persistSessionTabs();
      this.renderActiveTabModelAndEffort();
      return;
    }

    let response;
    try {
      response = await tab.client.setModel(provider, modelId);
    } catch (err) {
      console.error("[pimate] setModel failed", err);
      throw err;
    }
    if (!response?.success) {
      throw new Error(response?.error || "setModel failed");
    }

    // Stash metadata returned by Pi so the effort popup can render correctly
    // before the explicit getState() round-trip lands. Pi versions have
    // returned both `data = model` and `data = { model }`; accept either.
    tab.piModelMeta = this.extractPiModelFromRpcData(response.data);

    // Now pull authoritative state from Pi — it may have clamped the
    // current thinking level to a value the new model supports.
    await this.syncTabStateFromPi(tab);
    this.renderActiveTabModelAndEffort();

    // If an effort popup is open, the displayed model just changed; close it
    // so the user reopens with the new model's options.
    if (this.effortPopupEl) this.closeEffortPopup();
  }

  private async updateActiveTabThinkingLevel(level: string): Promise<void> {
    const tab = this.activeTab;
    if (!tab?.client) {
      if (tab) tab.thinkingLevel = level;
      if (tab?.engine === "antigravity") {
        this.plugin.settings.agyEffort = level as any;
      } else {
        this.plugin.settings.thinkingLevel = level;
      }
      await this.plugin.saveSettings();
      await this.persistSessionTabs();
      this.renderActiveTabModelAndEffort();
      return;
    }

    let response;
    try {
      response = await tab.client.setThinkingLevel(level);
    } catch (err) {
      console.error("[pimate] setThinkingLevel failed", err);
      throw err;
    }
    if (!response?.success) {
      throw new Error(response?.error || "setThinkingLevel failed");
    }

    // Pi may clamp; let getState() be the authoritative source.
    await this.syncTabStateFromPi(tab);
    this.renderActiveTabModelAndEffort();
  }

  // ─── Pi authoritative state sync ───────────────────────────────────────────
  //
  // Pulls full state from Pi and reconciles it into the in-memory tab,
  // global settings, footer display, and persisted session. A monotonic
  // sequence plus client reference check guards against late responses that
  // arrive after a tab has switched clients or moved on to another sync.

  private extractPiModelFromRpcData(data: unknown): PiModel | null {
    if (!data || typeof data !== "object") return null;

    const maybeWrapped = data as { model?: unknown };
    if (maybeWrapped.model && typeof maybeWrapped.model === "object") {
      const model = maybeWrapped.model as Partial<PiModel>;
      if (typeof model.id === "string" && typeof model.provider === "string") {
        return model as PiModel;
      }
    }

    const maybeModel = data as Partial<PiModel>;
    if (typeof maybeModel.id === "string" && typeof maybeModel.provider === "string") {
      return maybeModel as PiModel;
    }

    return null;
  }

  private async syncTabStateFromPi(tab: ChatTab): Promise<boolean> {
    if (!tab.client) return false;
    const client = tab.client;
    const seq = (tab.syncSeq ?? 0) + 1;
    tab.syncSeq = seq;

    let response;
    try {
      response = await client.getState();
    } catch (err) {
      console.warn("[pimate] getState failed", err);
      return false;
    }

    // Drop stale responses: tab moved on, or its client was swapped out.
    if (tab.syncSeq !== seq) return false;
    if (tab.client !== client) return false;
    if (!response?.success || !response.data) return false;

    this.applyAuthoritativePiState(tab, response.data);
    return true;
  }

  private applyAuthoritativePiState(
    tab: ChatTab,
    state: import("./PiAgentClient").PiAgentState
  ): void {
    const previousProvider = tab.modelProvider;
    const previousModelId = tab.modelId;
    const previousLevel = tab.thinkingLevel;

    if (state.model) {
      tab.piModelMeta = state.model;
      tab.modelProvider = state.model.provider;
      tab.modelId = state.model.id;
    }
    if (typeof state.isCompacting === "boolean") {
      tab.isCompacting = state.isCompacting;
    }
    // Pi's get_state already carries the authoritative session binding. Keep
    // this independent of the context-meter UI/get_session_stats path so a
    // fork or clone cannot leave the tab pointing at its previous file.
    if (typeof state.sessionFile === "string") tab.sessionFile = state.sessionFile;
    if (typeof state.sessionId === "string") tab.sessionId = state.sessionId;
    if (typeof state.thinkingLevel === "string") {
      tab.thinkingLevel = state.thinkingLevel;
    } else if (state.thinkingLevel == null && tab.piModelMeta?.reasoning === false) {
      // Reasoning-off models may report no level at all; clear stale values.
      tab.thinkingLevel = "";
    }
    if (typeof state.isStreaming === "boolean") {
      tab.isStreaming = state.isStreaming;
      if (tab === this.activeTab) {
        this.isStreaming = state.isStreaming;
        this.updateButtons();
        this.renderActiveTabRuntimeStatus();
      }
    }

    const modelChanged =
      previousProvider !== tab.modelProvider ||
      previousModelId !== tab.modelId;
    const levelChanged = previousLevel !== tab.thinkingLevel;
    let settingsChanged = false;

    // Reflect into global settings so newly created/restarted tabs inherit
    // the Pi-confirmed pair (e.g. prevent openai-codex + MiniMax-M3 combos).
    if (
      modelChanged &&
      tab.modelProvider &&
      tab.modelId &&
      tab === this.activeTab
    ) {
      if (tab.engine === "antigravity") {
        this.plugin.settings.agyModel = tab.modelId;
      } else {
        this.plugin.settings.provider = tab.modelProvider;
        this.plugin.settings.modelId = tab.modelId;
      }
      settingsChanged = true;
    }
    if (
      levelChanged &&
      tab.thinkingLevel !== undefined &&
      tab === this.activeTab
    ) {
      if (tab.engine === "antigravity") {
        this.plugin.settings.agyEffort = tab.thinkingLevel as any;
      } else {
        this.plugin.settings.thinkingLevel = tab.thinkingLevel;
      }
      settingsChanged = true;
    }

    // Persist + notify footer only when something actually changed.
    if (modelChanged || levelChanged) {
      void this.persistSessionTabs();
      if (settingsChanged) void this.plugin.saveSettings();
      if (
        modelChanged &&
        tab.modelProvider &&
        tab.modelId &&
        tab === this.activeTab
      ) {
        this.updateModelDisplay(tab.modelProvider, tab.modelId);
      }
      if (levelChanged && tab === this.activeTab && this.footerEffortCurrent) {
        this.footerEffortCurrent.setText(
          this.getThinkingLevelLabel(tab.thinkingLevel ?? "")
        );
      }
    }
  }

  private resetActiveRenderState(): void {
    this.currentAssistantMsg = null;
    this.currentTextBlock = null;
    this.currentThinkingBlock = null;
    this.currentThinkingContent = null;
    this.currentBlockRawText = "";
  }

  // ─── Event Handling ───────────────────────────────────────────────────

  private getQueueCounts(event: RpcEvent): { steering: number; followUp: number } {
    const steering = event.steering as string[] | undefined;
    const followUp = event.followUp as string[] | undefined;
    return {
      steering: steering?.length || 0,
      followUp: followUp?.length || 0,
    };
  }

  private recordTabRuntimeState(tab: ChatTab, event: RpcEvent): void {
    switch (event.type) {
      case "agent_start":
        tab.isStreaming = true;
        break;
      case "agent_end":
        // A run can end while another queued run is about to start. Pi only
        // becomes fully idle at agent_settled.
        break;
      case "agent_settled":
        tab.isStreaming = false;
        break;
      case "compaction_start":
        tab.isCompacting = true;
        break;
      case "compaction_end":
        tab.isCompacting = false;
        break;
      case "queue_update": {
        const counts = this.getQueueCounts(event);
        tab.steeringCount = counts.steering;
        tab.followUpCount = counts.followUp;
        tab.queueCount = counts.steering + counts.followUp;
        break;
      }
      case "thinking_level_changed":
      case "model_changed":
        // Authoritative state — pull full state from Pi to reconcile.
        // The level / model fields on this event are advisory; getState()
        // is the single source of truth for clamp results.
        void this.syncTabStateFromPi(tab);
        break;
    }
  }

  private renderActiveTabRuntimeStatus(): void {
    const tab = this.activeTab;
    if (!tab) {
      this.setStatus("✅ Ready", "ok");
      return;
    }
    const queueCount = tab.queueCount || 0;
    if (queueCount > 0) {
      const steering = tab.steeringCount || 0;
      const followUp = tab.followUpCount || 0;
      const isZh = this.plugin.settings.language !== "en";
      const queueLabel = isZh
        ? [
            steering > 0 ? `转向 ${steering}` : "",
            followUp > 0 ? `排队 ${followUp}` : "",
          ].filter(Boolean).join(" · ")
        : [
            steering > 0 ? `steer ${steering}` : "",
            followUp > 0 ? `follow-up ${followUp}` : "",
          ].filter(Boolean).join(" · ");
      this.setStatus(`📋 ${queueLabel || `${queueCount} queued`}`, "thinking");
    } else if (tab.isStreaming) {
      this.setStatus("🤔 Thinking...", "thinking");
    } else {
      this.setStatus("✅ Ready", "ok");
    }
  }

  private handleEvent(event: RpcEvent, sourceTab?: ChatTab | null): void {
    const tab = sourceTab || this.activeTab;
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        if (tab) tab.isStreaming = true;
        this.startSpeedIndicator();
        this.updateButtons();
        this.setStatus("🤔 Thinking...", "thinking");
        break;

      case "agent_end":
        // End of one run is not the end of the queue. Keep the generating UI
        // active until Pi emits agent_settled.
        this.resetActiveRenderState();
        this.renderActiveTabRuntimeStatus();
        break;

      case "agent_settled":
        this.isStreaming = false;
        if (tab) tab.isStreaming = false;
        for (const pending of this.pendingQueuedMessages) {
          pending.rendered.el.removeClass("is-queued");
        }
        this.pendingQueuedMessages = [];
        this.resetActiveRenderState();
        this.stopSpeedIndicator();
        this.updateButtons();
        this.renderActiveTabRuntimeStatus();
        // A hard steer immediately follows this settled event with a fresh
        // prompt. Reloading history or starting Smart Review in between would
        // race that replacement prompt and can revive the old direction.
        if (!this.hardSteerInFlight) {
          void this.refreshForkMessagesAndReloadHistory();
          void this.maybeAutoContinueSmartReview(tab || undefined);
        }
        break;

      case "message_start":
        this.handleMessageStart(event, tab);
        break;

      case "message_update":
        this.handleMessageUpdate(event);
        break;

      case "message_end":
        this.handleMessageEnd(event);
        break;

      case "tool_execution_start":
        this.handleToolStart(event);
        break;

      case "tool_execution_update":
        this.handleToolUpdate(event);
        break;

      case "tool_execution_end":
        this.handleToolEnd(event);
        break;

      case "turn_start":
        this.setStatus("🔄 Processing turn...", "thinking");
        break;

      case "turn_end":
        this.renderActiveTabRuntimeStatus();
        break;

      case "queue_update":
        this.handleQueueUpdate(event, tab);
        break;

      case "thinking_level_changed":
      case "model_changed":
        // Authority lives in Pi. recordTabRuntimeState() will fire
        // syncTabStateFromPi() to reconcile this tab's state.
        if (this.activeTab) {
          this.recordTabRuntimeState(this.activeTab, event);
        }
        break;

      case "compaction_start":
        this.setStatus("📦 Compacting context...", "thinking");
        break;

      case "compaction_end":
        this.compactedContextActive = !event.aborted;
        this.setStatus("✅ Compaction complete", "ok");
        break;

      case "extension_error":
        console.error("[pi-agent] Extension error", event);
        if (event.event !== "command") {
          new Notice(`Pi 扩展错误: ${String(event.error || "未知错误")}`);
        }
        break;

      case "extension_ui_request":
        // Handle extension UI requests from pi extensions
        this.handleExtensionUIRequest(event);
        break;

      default:
        // Unknown event, log for debugging
        console.log("[pi-agent] Unhandled event:", event.type, event);
    }
  }

  private handleMessageStart(event: RpcEvent, sourceTab?: ChatTab | null): void {
    const message = event.message as {
      role: string;
      content?: string | MessageContent[];
      retry?: boolean;
    };
    if (!message) return;
    const tab = sourceTab || this.activeTab;

    if (message.role === "user") {
      if (message.retry) {
        this.addSystemMessage(
          this.plugin.settings.language !== "en"
            ? "↻ 正在重试上一轮 AGY 请求…"
            : "↻ Retrying the previous AGY request…"
        );
        return;
      }
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              ?.map((c) => c.text || c.thinking || "")
              .join("") || "";
      const pendingIndex = this.findPendingQueuedMessage(content);
      if (pendingIndex !== -1) {
        const [pending] = this.pendingQueuedMessages.splice(pendingIndex, 1);
        pending.rendered.el.removeClass("is-queued");
        if (this.parseExpandedSkillMessage(content)) {
          this.renderUserMessageContent(pending.rendered.el, pending.rendered.contentEl, content);
        }
        pending.rendered.el.setAttribute("data-rpc-message", content);
        if (tab) tab.pendingUserImages = [];
        this.updateButtons();
        return;
      }

      const rendered = this.addMessage("user", this.stripRecentContextGuard(content));
      // Attach any images that were sent with this message to the bubble.
      if (tab?.pendingUserImages?.length) {
        this.renderUserMessageImages(rendered, tab.pendingUserImages);
        tab.pendingUserImages = [];
      }
    } else if (message.role === "assistant") {
      this.currentAssistantMsg = this.addMessage("assistant", "");
      this.currentTextBlock = null;
      this.currentThinkingBlock = null;
      this.currentThinkingContent = null;
      this.currentRawText = "";
      this.currentBlockRawText = "";
      this.lastRenderTime = 0;
      if (this.renderTimeout) {
        window.clearTimeout(this.renderTimeout);
        this.renderTimeout = null;
      }
      this.scrollToBottom(true, true);
    } else if (message.role === "toolResult") {
      // Tool results are handled by tool_execution_end
    }
  }

  private ensureAssistantStreamMessage(): RenderedMessage {
    if (!this.currentAssistantMsg) {
      this.currentAssistantMsg = this.addMessage("assistant", "");
      this.currentTextBlock = null;
      this.currentThinkingBlock = null;
      this.currentThinkingContent = null;
      this.currentRawText = "";
      this.currentBlockRawText = "";
      this.lastRenderTime = 0;
    }
    return this.currentAssistantMsg;
  }

  private handleMessageUpdate(event: RpcEvent): void {
    const delta = event.assistantMessageEvent as AssistantMessageEvent;
    if (!delta) return;

    switch (delta.type) {
      case "text_start":
        this.currentBlockRawText = "";
        this.currentTextBlock = null;
        this.streamingTextEl = null;
        this.streamingCursorEl = null;
        break;

      case "text_delta": {
        const message = this.ensureAssistantStreamMessage();
        // A tool-only assistant wrapper is compact and has no role badge;
        // restore the normal badge if AGY later emits visible text in it.
        message.el.removeClass("is-tool-only");
        if (!this.currentTextBlock) {
          const usePretty = this.shouldUsePrettyStreaming(0);
          this.currentTextBlock =
            message.contentEl.createDiv(
              usePretty
                ? "pi-agent-text-block markdown-preview-view markdown-rendered"
                : "pi-agent-text-block pi-agent-streaming-block"
            );
          if (!usePretty) {
            this.streamingTextEl = this.currentTextBlock.createDiv(
              "pi-agent-streaming-text"
            );
            this.streamingCursorEl = this.currentTextBlock.createSpan(
              "pi-agent-streaming-cursor"
            );
          }
        }
        const deltaText = delta.delta || "";
        this.currentBlockRawText += deltaText;
        this.currentRawText += deltaText;
        this.addSpeedDelta(deltaText);
        this.currentTextBlock.setAttribute("data-stream-raw", this.currentBlockRawText);

        const usePretty = this.shouldUsePrettyStreaming(this.currentBlockRawText.length);
        if (usePretty) {
          this.throttleRender(this.currentBlockRawText, this.currentTextBlock);
        } else {
          if (!this.currentTextBlock.classList.contains("pi-agent-streaming-block")) {
            this.convertCurrentTextBlockToFastStreaming();
          }
          this.appendStreamingDelta(this.currentBlockRawText, deltaText);
        }
        break;
      }

      case "thinking_start":
        if (this.plugin.settings.showThinking) {
          const message = this.ensureAssistantStreamMessage();
          message.el.removeClass("is-tool-only");
          this.thinkingStartedAt = Date.now();
          this.currentThinkingBlock =
            message.contentEl.createDiv(
              "pi-agent-thinking-block"
            );
          const header = this.currentThinkingBlock.createDiv(
            "pi-agent-thinking-header"
          );
          const iconSpan = header.createSpan("pi-agent-thinking-icon");
          setIcon(iconSpan, "brain");
          const textSpan = header.createSpan("pi-agent-thinking-text");
          textSpan.setText(" Thinking (1s)...");

          this.currentThinkingContent =
            this.currentThinkingBlock.createDiv(
              "pi-agent-thinking-content"
            );

          const block = this.currentThinkingBlock;
          header.onclick = () => {
            block.toggleClass("is-collapsed", !block.hasClass("is-collapsed"));
          };

          if (this.thinkingTimer) {
            window.clearInterval(this.thinkingTimer);
          }
          this.thinkingTimer = window.setInterval(() => {
            const elapsed = this.thinkingStartedAt
              ? Math.max(1, Math.round((Date.now() - this.thinkingStartedAt) / 1000))
              : 1;
            const textSpan = header.querySelector(".pi-agent-thinking-text");
            if (textSpan) {
              textSpan.setText(` Thinking (${elapsed}s)...`);
            }
          }, 1000);
        }
        break;

      case "thinking_delta":
        if (this.currentThinkingContent) {
          const shouldStickToBottom = this.isNearBottom();
          this.currentThinkingContent.appendText(delta.delta || "");
          if (shouldStickToBottom) this.scrollToBottom(true, true);
        }
        break;

      case "thinking_end":
        if (this.thinkingTimer) {
          window.clearInterval(this.thinkingTimer);
          this.thinkingTimer = null;
        }
        if (this.currentThinkingBlock) {
          this.currentThinkingBlock.addClass("is-collapsed");
          const header =
            this.currentThinkingBlock.querySelector(
              ".pi-agent-thinking-header"
            );
          if (header) {
            const elapsed = this.thinkingStartedAt
              ? Math.max(1, Math.round((Date.now() - this.thinkingStartedAt) / 1000))
              : 0;
            const textSpan = header.querySelector(".pi-agent-thinking-text");
            if (textSpan) {
              textSpan.setText(elapsed > 0 ? ` Thought for ${elapsed}s` : " Thought");
            }
          }
        }
        break;

      case "toolcall_start":
        // Tool call started - will be fleshed out in tool_execution events
        break;

      case "done":
        break;

      case "error": {
        const message = this.ensureAssistantStreamMessage();
        message.el.removeClass("is-tool-only");
        const errorEl = message.contentEl.createDiv("pi-agent-error-block");
        const isAgyFailure = !!delta.errorCategory;
        const isZh = this.plugin.settings.language !== "en";
        const summary = isAgyFailure
          ? this.getAgyFailureSummary(delta.errorCategory || "unknown", isZh)
          : `Error: ${delta.reason || "Unknown error"}`;
        errorEl.createSpan({ text: `⚠️ ${summary}` });

        if (isAgyFailure && delta.reason) {
          errorEl.createDiv("pi-agent-error-detail").setText(
            `${isZh ? "AGY 原始信息：" : "AGY detail: "}${delta.reason}`
          );
        }
        if (delta.diagnostic) {
          errorEl.createDiv("pi-agent-error-detail").setText(delta.diagnostic);
        }
        if (delta.retryable) {
          const retryBtn = errorEl.createEl("button", {
            text: isZh ? "↻ 重试本轮" : "↻ Retry this turn",
            cls: "pi-agent-error-retry",
            attr: {
              title: isZh
                ? "仅重新发送本轮请求；Pimate 不会自动重试。"
                : "Resend this turn only. Pimate never retries automatically.",
            },
          });
          retryBtn.onclick = () => this.retryLastAgyTurn(retryBtn);
        }
        break;
      }
    }
  }

  private getAgyFailureSummary(category: string, isZh: boolean): string {
    if (!isZh) {
      switch (category) {
        case "network": return "AGY connection was interrupted; the session is preserved.";
        case "timeout": return "AGY timed out waiting for this turn; the session is preserved.";
        case "authentication": return "AGY authentication failed.";
        case "quota": return "AGY quota or rate limit was reached.";
        case "permission": return "AGY denied this operation.";
        case "process": return "AGY process exited unexpectedly; the session is preserved.";
        case "cancelled": return "Operation stopped by user.";
        default: return "AGY could not complete this turn; the session is preserved.";
      }
    }
    switch (category) {
      case "network": return "AGY 连接中断，会话已保留。";
      case "timeout": return "AGY 等待本轮响应超时，会话已保留。";
      case "authentication": return "AGY 登录或鉴权失败。";
      case "quota": return "AGY 用量额度或请求频率受限。";
      case "permission": return "AGY 拒绝了这项操作。";
      case "process": return "AGY 进程意外退出，会话已保留。";
      case "cancelled": return "已停止本轮任务。";
      default: return "AGY 未能完成本轮，会话已保留。";
    }
  }

  private retryLastAgyTurn(button: HTMLButtonElement): void {
    const tab = this.activeTab;
    const client = tab?.client;
    if (!tab || !client || client.engine !== "antigravity") return;

    button.disabled = true;
    this.runAsync(async () => {
      try {
        if (tab.isStreaming) {
          throw new Error("Wait for the current turn to finish before retrying");
        }
        const isZh = this.plugin.settings.language !== "en";
        this.setStatus(isZh ? "↻ 正在重试本轮…" : "↻ Retrying this turn…", "thinking");
        const response = await (client as AgyAgentClient).retryLastFailedPrompt();
        if (!response.success) throw new Error(response.error || "AGY did not accept the retry");
        button.remove();
      } catch (err) {
        button.disabled = false;
        new Notice(
          `❌ ${this.plugin.settings.language !== "en" ? "重试失败：" : "Retry failed: "}${(err as Error).message}`
        );
      }
    });
  }

  private handleMessageEnd(event: RpcEvent): void {
    if (this.thinkingTimer) {
      window.clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    if (this.renderTimeout) {
      window.clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }

    if (this.currentAssistantMsg) {
      this.currentAssistantMsg.el.setAttribute("data-raw-content", this.currentRawText);
      const shouldStickToBottom = this.isNearBottom();
      const renderPromises: Promise<unknown>[] = [];

      // Finalize all streaming text blocks: replace the cheap <pre>-style buffer
      // with a single full MarkdownRenderer pass.
      const streamingBlocks =
        this.currentAssistantMsg.contentEl.querySelectorAll(
          ".pi-agent-text-block"
        );
      streamingBlocks.forEach((textBlock: any) => {
        const pre = textBlock.querySelector(
          ".pi-agent-streaming-text"
        ) as HTMLElement | null;
        const raw = textBlock.getAttribute("data-stream-raw") || pre?.textContent || "";
        if (raw.trim().length > 0) {
          // Swap to a real markdown block.
          textBlock.classList.remove("pi-agent-streaming-block");
          textBlock.classList.add(
            "markdown-preview-view",
            "markdown-rendered"
          );
          textBlock.empty();
          renderPromises.push(MarkdownRenderer.render(
            this.app,
            this.normalizeAssistantMarkdown(raw),
            textBlock as HTMLElement,
            "",
            this
          ));
        } else {
          textBlock.remove();
        }
      });

      this.streamingTextEl = null;
      this.streamingCursorEl = null;

      // Inline option chips: when the AI ends its message with a list of
      // numbered/lettered options followed by a question, render them as
      // clickable chips that fill the input. The user can also type freely.
      const parsed = this.parseOptionsFromMessage(this.currentRawText);
      if (parsed && parsed.options.length >= 2) {
        this.renderOptionChips(this.currentAssistantMsg, parsed.options, parsed.isQuestion);
      }
      this.finalizeAssistantMessageVisibility(this.currentAssistantMsg);

      if (shouldStickToBottom) {
        this.scrollToBottom(true, true);
        void Promise.all(renderPromises).then(() => this.scrollToBottom(true, true));
      }
    } else {
      this.scrollToBottom();
    }
  }

  private parseOptionsFromMessage(
    text: string
  ): { options: string[]; isQuestion: boolean } | null {
    if (!text) return null;
    const lines = text.split("\n").map((l) => l.trim());
    // 只识别显式编号（1. / 2) / a. / 一、 等）；不再把普通 bullet（- * •）
    // 误判为选项，避免回复里随手列点 → 跳出快速选项。
    const optionRe = /^(?:\d+[.)]|[一二三四五六七八九十]+[、.)]|[a-zA-Z][.)])\s+(.+)$/;

    // 找到所有连续选项块及位置（不止一个，可能存在历史/总结 + 提问）
    type Block = { startIdx: number; endIdx: number; options: string[] };
    const blocks: Block[] = [];
    let cur: Block | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "") {
        if (cur && cur.options.length >= 2) blocks.push(cur);
        cur = null;
        continue;
      }
      const m = line.match(optionRe);
      if (m) {
        if (!cur) cur = { startIdx: i, endIdx: i, options: [] };
        cur.endIdx = i;
        cur.options.push(m[1].trim());
      } else {
        if (cur && cur.options.length >= 2) blocks.push(cur);
        cur = null;
      }
    }
    if (cur && cur.options.length >= 2) blocks.push(cur);
    if (blocks.length === 0) return null;

    const last = blocks[blocks.length - 1];

    // 要求：选项块后面**紧跟**的下一行是非空问题。
    // - 如果列表后面还有别的内容（其他段、表格、列表），不认为是在问选哪个
    // - 问题不能是 yes/no（不要 `要...吗` 模式），必须真的是在问选哪个
    let nextLine: string | null = null;
    for (let i = last.endIdx + 1; i < lines.length; i++) {
      if (lines[i] !== "") {
        nextLine = lines[i];
        break;
      }
    }
    if (nextLine === null) return null;

    const isSelectionQuestion =
      /[?？]\s*$/.test(nextLine) || // 以 ? / ？ 结尾（开放或选择问句）
      /请选择|请告诉我|选哪个|用哪个|choose|pick|select/i.test(nextLine); // 显式选择短语
    if (!isSelectionQuestion) return null;

    return { options: last.options.slice(0, 8), isQuestion: true };
  }

  private renderOptionChips(
    message: RenderedMessage,
    options: string[],
    isQuestion: boolean
  ): void {
    if (message.contentEl.querySelector(".pi-agent-option-chips")) return;
    const isZh = this.plugin.settings.language === "zh";
    const wrap = message.contentEl.createDiv("pi-agent-option-chips");
    const label = wrap.createDiv("pi-agent-option-chips-label");
    label.setText(
      isQuestion
        ? isZh
          ? "快捷选项（也可直接在下方输入框自行回复）："
          : "Quick options (or just type your answer in the input below):"
        : isZh
          ? "快捷选项（也可直接在下方输入框自行回复）："
          : "Quick options (or just type your answer in the input below):"
    );

    const selected = new Set<string>();
    const chipEls: HTMLElement[] = [];

    for (const opt of options) {
      const chip = wrap.createEl("button", {
        text: opt,
        cls: "pi-agent-option-chip",
        attr: { type: "button" },
      });
      chipEls.push(chip);
      chip.onclick = () => {
        if (selected.has(opt)) {
          selected.delete(opt);
          chip.removeClass("is-selected");
        } else {
          selected.add(opt);
          chip.addClass("is-selected");
        }
        updateSubmit();
      };
    }

    const submit = wrap.createEl("button", {
      text: isZh ? "提交 (0)" : "Submit (0)",
      cls: "pi-agent-option-submit is-disabled",
      attr: { type: "button" },
    });
    submit.onclick = () => {
      if (selected.size === 0) return;
      const text = Array.from(selected).join("\n");
      this.setInputText(text);
      this.inputEl?.focus();
      // Trigger send after the input is set.
      this.runAsync(() => this.sendMessage());
    };

    const customBtn = wrap.createEl("button", {
      text: isZh ? "✎ 自行输入" : "✎ Type your own",
      cls: "pi-agent-option-custom",
      attr: { type: "button" },
    });
    customBtn.onclick = () => {
      this.inputEl?.focus();
      this.inputEl?.scrollIntoView({ block: "center", behavior: "smooth" });
    };

    const clearBtn = wrap.createEl("button", {
      text: isZh ? "清空" : "Clear",
      cls: "pi-agent-option-clear",
      attr: { type: "button" },
    });
    clearBtn.onclick = () => {
      selected.clear();
      chipEls.forEach((c) => c.removeClass("is-selected"));
      updateSubmit();
    };

    const updateSubmit = () => {
      const count = selected.size;
      submit.setText(
        isZh ? `提交 (${count})` : `Submit (${count})`
      );
      submit.toggleClass("is-disabled", count === 0);
    };
  }

  private handleToolStart(event: RpcEvent): void {
    const toolName = event.toolName as string;
    const toolCallId = event.toolCallId as string;
    const args = event.args as Record<string, unknown> | undefined;

    if (!this.currentAssistantMsg) {
      this.currentAssistantMsg = this.addMessage("assistant", "");
    }

    const hasVisibleContent = !!this.currentAssistantMsg.contentEl.querySelector(
      ".pi-agent-text-block, .pi-agent-thinking-block, .pi-agent-error-block"
    );
    this.currentAssistantMsg.el.addClass("has-tool-content");
    if (!hasVisibleContent) {
      // Match the finalized tool-only rendering while the stream is live so
      // every AGY tool row does not carry an otherwise empty Pi badge.
      this.currentAssistantMsg.el.addClass("is-tool-only");
    }

    const toolBlock = this.currentAssistantMsg.contentEl.createDiv(
      "pi-agent-tool-block"
    );
    const header = toolBlock.createDiv("pi-agent-tool-header");
    header.createSpan({ text: this.getToolIcon(toolName), cls: "pi-agent-tool-icon" });
    header.createSpan({ text: this.toTitleCase(toolName), cls: "pi-agent-tool-name" });

    if (args) {
      const argsText = this.formatToolArgs(toolName, args);
      if (argsText) {
        const argsEl = header.createSpan({ text: argsText, cls: "pi-agent-tool-args" });
        let path = (typeof args.path === "string" ? args.path : "") ||
                   (typeof args.AbsolutePath === "string" ? args.AbsolutePath : "") ||
                   (typeof args.TargetFile === "string" ? args.TargetFile : "") ||
                   (typeof args.DirectoryPath === "string" ? args.DirectoryPath : "") ||
                   (typeof args.target === "string" ? args.target : "");

        const adapter = this.app.vault.adapter;
        const vaultBasePath = adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
        if (path && vaultBasePath && path.startsWith(vaultBasePath)) {
          path = path.slice(vaultBasePath.length).replace(/^[/\\]+/, "");
        }

        if (path) {
          argsEl.addClass("is-clickable");
          argsEl.setAttribute("title", `${path} (Click to open)`);
          argsEl.onclick = (event) => {
            event.stopPropagation();
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
              void this.app.workspace.getLeaf(false).openFile(file).catch((err: unknown) => {
                console.error("[pimate] open file failed", err);
              });
            }
          };
        } else if (["bash", "run_command"].includes(toolName) && (args.command || args.CommandLine)) {
          argsEl.addClass("is-clickable");
          const fullCmd = (args.command || args.CommandLine) as string;
          const isZh = this.plugin.settings.language === "zh";
          argsEl.setAttribute("title", `${fullCmd} (Click to copy)`);
          argsEl.onclick = (event) => {
            event.stopPropagation();
            void navigator.clipboard.writeText(fullCmd).then(() => {
              new Notice(isZh ? "命令已复制到剪贴板" : "Command copied to clipboard");
            }).catch((err: unknown) => {
              new Notice(`Failed to copy: ${err}`);
            });
          };
        }
      }
    }
    header.createSpan({ text: "...", cls: "pi-agent-tool-close is-loading" });

    const outputEl = toolBlock.createDiv("pi-agent-tool-output");
    header.onclick = () => outputEl.toggleClass("is-visible", !outputEl.hasClass("is-visible"));

    // Store reference for updates
    toolBlock.setAttribute("data-tool-id", toolCallId);
    (toolBlock as any).__outputEl = outputEl;
    (toolBlock as any).__startedAt = Date.now();
  }

  private shouldWarnToolExecution(toolName: string, args?: Record<string, unknown>): boolean {
    if (["write", "edit"].includes(toolName)) return true;
    if (toolName === "bash") {
      const command = String(args?.command || "");
      return this.isDangerousBashCommand(command);
    }
    return false;
  }

  private handleToolUpdate(event: RpcEvent): void {
    const toolCallId = event.toolCallId as string;
    const partialResult = event.partialResult as
      | { content?: Array<{ type: string; text: string }> }
      | undefined;

    const toolBlock = this.chatContainer?.querySelector(
      `[data-tool-id="${toolCallId}"]`
    ) as HTMLElement | null;
    if (toolBlock && partialResult?.content) {
      const outputEl = (toolBlock as any).__outputEl as HTMLElement;
      if (outputEl) {
        const text = partialResult.content.map((c) => c.text).join("");
        const preview = text.trim();
        outputEl.setText(preview.length > 1200 ? preview.slice(0, 1200) + "\n…" : preview);
        outputEl.toggleClass("is-visible", preview.length > 0);
        this.scrollToBottom();
      }
    }
  }

  private handleToolEnd(event: RpcEvent): void {
    const toolCallId = event.toolCallId as string;
    const result = event.result as
      | { content?: Array<{ type: string; text: string }>; isError?: boolean }
      | undefined;
    const isError = event.isError as boolean;

    const toolBlock = this.chatContainer?.querySelector(
      `[data-tool-id="${toolCallId}"]`
    ) as HTMLElement | null;
    if (toolBlock) {
      toolBlock.addClass(isError ? "is-error" : "is-success");
      const closeEl = toolBlock.querySelector(".pi-agent-tool-close") as HTMLElement | null;
      if (closeEl) {
        closeEl.removeClass("is-loading");
        closeEl.textContent = isError ? "×" : "✓";
      }

      const details = (event.result as any)?.details;
      const diffText = this.getDiffText(details);
      const stats = this.getDiffStats(details);
      if (stats) {
        const closeEl = toolBlock.querySelector(".pi-agent-tool-close");
        const statEl = activeDocument.createElement("span");
        statEl.className = "pi-agent-tool-diff";
        const addedEl = activeDocument.createElement("span");
        addedEl.className = "pi-agent-tool-add";
        addedEl.textContent = `+${stats.added}`;
        const removedEl = activeDocument.createElement("span");
        removedEl.className = "pi-agent-tool-remove";
        removedEl.textContent = `−${stats.removed}`;
        statEl.append(addedEl, removedEl);
        closeEl?.parentElement?.insertBefore(statEl, closeEl);
      }

      const outputEl = (toolBlock as any).__outputEl as HTMLElement;
      if (outputEl && result?.content) {
        const text = result.content.map((c) => c.text).join("").trim();
        outputEl.empty();
        if (isError) {
          outputEl.createSpan({ text, cls: "pi-agent-tool-error" });
          outputEl.addClass("is-visible");
        } else if (diffText && ["edit", "write", "replace_file_content", "write_to_file"].includes(event.toolName as string)) {
          this.renderDiffOutput(outputEl, diffText);
        } else if (text && ["bash", "grep", "find", "ls", "run_command", "grep_search", "find_by_name", "list_dir"].includes(event.toolName as string)) {
          const displayText =
            text.length > 1600 ? text.slice(0, 1600) + "\n…" : text;
          const pre = outputEl.createEl("pre");
          pre.setText(displayText);
          this.renderDetectedFiles(outputEl, text);
          if (isError) {
            outputEl.addClass("is-visible");
          }
        }
      }
    }
  }

  private handleQueueUpdate(event: RpcEvent, sourceTab?: ChatTab | null): void {
    const counts = this.getQueueCounts(event);
    const total = counts.steering + counts.followUp;
    const tab = sourceTab || this.activeTab;
    if (tab) {
      tab.steeringCount = counts.steering;
      tab.followUpCount = counts.followUp;
      tab.queueCount = total;
    }
    this.renderActiveTabRuntimeStatus();
  }

  private handleExtensionUIRequest(event: RpcEvent): void {
    const id = event.id as string;
    const method = event.method as string;

    if (method === "confirm") {
      const title = event.title as string;
      const message = event.message as string;
      new PiAgentConfirmModal(this.app, title, message, (confirmed) => {
        this.client?.sendUIResponse(id, { confirmed });
      }).open();
    } else if (method === "select") {
      const title = event.title as string;
      const options = event.options as string[];
      new PiAgentSelectModal(this.app, title, options, (value) => {
        if (value) this.client?.sendUIResponse(id, { value });
        else this.client?.sendUIResponse(id, { cancelled: true });
      }).open();
    } else if (method === "input") {
      const title = event.title as string;
      const placeholder = event.placeholder as string;
      new PiAgentInputModal(this.app, title, placeholder || "", (value) => {
        if (value !== null) this.client?.sendUIResponse(id, { value });
        else this.client?.sendUIResponse(id, { cancelled: true });
      }).open();
    } else if (method === "editor") {
      // Open in a new note for editing
      const title = event.title as string;
      const prefill = event.prefill as string;
      this.openEditorModal(id, title, prefill);
    } else {
      // notify, setStatus, setWidget, setTitle, set_editor_text are fire-and-forget
      if (method === "notify") {
        new Notice(
          `🔔 ${(event.message as string) || ""}`
        );
      } else if (method === "setWidget") {
        console.log("[pimate] setWidget event received:", event);
        const widgetKey = event.widgetKey as string;
        const widgetLines = event.widgetLines as string[] | undefined;
        this.updateWidget(widgetKey, widgetLines);
      }
    }
  }

  private async openEditorModal(
    id: string,
    title: string,
    prefill: string
  ): Promise<void> {
    const value = await new Promise<string | null>((resolve) => {
      new PiAgentEditorModal(this.app, title, prefill || "", resolve).open();
    });

    if (value === null) {
      this.client?.sendUIResponse(id, { cancelled: true });
    } else {
      this.client?.sendUIResponse(id, { value });
    }
  }

  // ─── UI Rendering ─────────────────────────────────────────────────────

  private async refreshForkMessages(): Promise<boolean> {
    const tab = this.activeTab;
    const client = this.client;
    const scopeVersion = this.forkScopeVersion;
    if (!tab || !client) return false;

    try {
      const result = await client.getForkMessages();
      if (
        this.activeTab !== tab ||
        this.client !== client ||
        this.forkScopeVersion !== scopeVersion ||
        !result.success
      ) {
        return false;
      }

      this.forkMessagesByEntryId = new Map(
        (result.data?.messages || [])
          .filter((message) => message.entryId && message.text)
          .map((message) => [message.entryId, message])
      );
      for (const message of this.renderedMessages) {
        if (message.role !== "user" || !message.entryId) continue;
        const forkMessage = this.forkMessagesByEntryId.get(message.entryId);
        if (forkMessage) this.bindForkEntry(message, forkMessage);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async refreshForkMessagesAndReloadHistory(): Promise<void> {
    const tab = this.activeTab;
    if (tab?.engine === "antigravity") {
      // Antigravity streams live into chatContainer without Pi fork metadata.
      // Retain live DOM so turn completion does not wipe the displayed message.
      return;
    }
    const scopeVersion = this.forkScopeVersion;
    // Session files are created lazily on the first completed response. Sync
    // the path before deciding between file history and branch-aware RPC.
    await this.refreshStateDisplay();
    if (
      this.activeTab !== tab ||
      this.forkScopeVersion !== scopeVersion ||
      this.activeTab?.isStreaming
    ) {
      return;
    }
    // Fork-button metadata is optional. Linear sessions can use the fast file
    // path; only sessions known to contain off-path entries need get_entries.
    await this.refreshForkMessages();
    if (
      this.activeTab !== tab ||
      this.forkScopeVersion !== scopeVersion ||
      this.activeTab?.isStreaming
    ) {
      return;
    }
    await this.reloadMessagesFromClient({
      forceRpc: tab?.requiresBranchHistoryRpc === true,
    });
  }

  private addMessage(
    role: string,
    content: string,
    options: {
      prependHistory?: boolean;
      entryId?: string;
      userInput?: string;
      queued?: boolean;
    } = {}
  ): RenderedMessage {
    if (!this.chatContainer) {
      throw new Error("Chat container not initialized");
    }

    this.clearEmptyState();
    const msgEl = this.chatContainer.createDiv(
      `pi-agent-message pi-agent-message-${role}`
    );
    if (options.prependHistory && this.historyPrependAnchorEl) {
      this.chatContainer.insertBefore(msgEl, this.historyPrependAnchorEl);
    }

    // Role badge
    const badge = msgEl.createDiv("pi-agent-message-badge");
    switch (role) {
      case "user":
        badge.setText("👤 You");
        break;
      case "assistant":
        badge.setText("π Pi");
        break;
      case "system":
        badge.setText("ℹ️ System");
        break;
      default:
        badge.setText(role);
    }

    // Content
    const contentEl = msgEl.createDiv("pi-agent-message-content");

    if (role === "user" && content) {
      this.renderUserMessageContent(msgEl, contentEl, content);
      if (options.userInput) {
        msgEl.setAttribute("data-user-input", options.userInput);
      }
      if (options.queued) {
        msgEl.addClass("is-queued");
      }
    }

    let forkBtn: HTMLButtonElement | undefined;
    let steerBtn: HTMLButtonElement | undefined;

    // Add floating hover actions
    if (role === "user" || role === "assistant") {
      const actionsEl = msgEl.createDiv("pi-agent-msg-actions");

      // 1. Copy button
      const copyBtn = actionsEl.createEl("button", {
        cls: "pi-agent-action-btn",
        attr: { title: "Copy message" },
      });
      copyBtn.setText("📋");
      copyBtn.onclick = (e) => {
        e.stopPropagation();
        const rawContent = msgEl.getAttribute("data-raw-content") || msgEl.textContent || "";
        void navigator.clipboard.writeText(rawContent).then(() => {
          new Notice("Copied to clipboard");
        }).catch((err: unknown) => {
          console.error("[pimate] copy message failed", err);
        });
      };

      // 2. Insert to active editor (assistant only)
      if (role === "assistant") {
        const insertBtn = actionsEl.createEl("button", {
          cls: "pi-agent-action-btn",
          attr: { title: "Insert into active note" },
        });
        insertBtn.setText("↵");
        insertBtn.onclick = (e) => {
          e.stopPropagation();
          const rawContent = msgEl.getAttribute("data-raw-content") || msgEl.textContent || "";
          const activeMarkdown = this.app.workspace.getActiveViewOfType(MarkdownView);
          const editor = activeMarkdown?.editor;
          if (!editor) {
            new Notice("Please open a markdown note first");
            return;
          }
          editor.replaceSelection(rawContent);
          new Notice("Inserted response into note");
        };
      }

      // 3. Fork & Edit / Reuse (user only)
      if (role === "user") {
        // While a run is active, a sent/queued user message can be sent
        // immediately as a one-shot steering instruction.
        steerBtn = actionsEl.createEl("button", {
          cls: "pi-agent-action-btn pi-agent-message-steer-btn pi-agent-hidden",
          attr: {
            title: "中断当前回复并按此消息调整",
            "aria-label": "中断当前回复并按此消息调整",
          },
        });
        setIcon(steerBtn, "corner-up-right");
        steerBtn.createSpan({ text: "调整方向" });
        steerBtn.onclick = (e) => {
          e.stopPropagation();
          this.runAsync(() => this.steerExistingMessage(msgEl, steerBtn));
        };

        // Fork button
        forkBtn = actionsEl.createEl("button", {
          cls: "pi-agent-action-btn",
          attr: { title: "Fork 从此提问分支 (Fork from this prompt)" },
        });
        forkBtn.setText("🌿");
        if (!options.entryId) {
          forkBtn.disabled = true;
          forkBtn.setAttribute("aria-label", "该提问暂不能 Fork");
          forkBtn.setAttribute("title", "该提问尚未写入会话，暂不能 Fork");
        }

        // Reuse button
        const reuseBtn = actionsEl.createEl("button", {
          cls: "pi-agent-action-btn",
          attr: { title: "Reuse and edit message" },
        });
        reuseBtn.setText("✏️");
        reuseBtn.onclick = (e) => {
          e.stopPropagation();
          const rawContent = msgEl.getAttribute("data-raw-content") || "";
          this.setInputText(rawContent);
        };

        // Double click card to auto fill
        msgEl.ondblclick = (e) => {
          e.stopPropagation();
          const rawContent = msgEl.getAttribute("data-raw-content") || "";
          this.setInputText(rawContent);
        };
      }
    }

    const rendered: RenderedMessage = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      entryId: options.entryId,
      role,
      el: msgEl,
      contentEl,
      forkBtn,
      steerBtn,
    };
    if (options.entryId) {
      const forkMessage = this.forkMessagesByEntryId.get(options.entryId);
      if (forkMessage) this.bindForkEntry(rendered, forkMessage);
    }

    if (options.prependHistory) {
      this.renderedMessages.splice(this.historyPrependInsertIndex++, 0, rendered);
    } else {
      this.renderedMessages.push(rendered);
    }

    // Limit displayed messages
    if (!options.prependHistory) {
      const maxDisplay = this.plugin.settings.maxHistoryDisplay;
      while (this.renderedMessages.length > maxDisplay) {
        const oldest = this.renderedMessages.shift();
        if (oldest) oldest.el.remove();
      }
      this.scrollToBottom(true, true);
    }
    return rendered;
  }

  /**
   * Pi expands `/skill:name` into a full `<skill ...>...</skill>` user message
   * before emitting it over RPC. Keep the original prompt in the session, but
   * make the chat bubble readable and let users inspect the expanded content
   * on demand.
   */
  private parseExpandedSkillMessage(content: string): ExpandedSkillMessage | null {
    const opening = content.match(/^\s*<skill\b([^>]*)>\s*/i);
    if (!opening) return null;

    const name = opening[1].match(/\bname\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    const location = opening[1]
      .match(/\blocation\s*=\s*["']([^"']+)["']/i)?.[1]
      ?.trim();
    if (!name || !location || !/(?:^|[\\/])SKILL\.md$/i.test(location)) return null;

    const closingIndex = content.toLowerCase().lastIndexOf("</skill>");
    if (closingIndex < opening[0].length) return null;
    const expandedContent = content.slice(opening[0].length, closingIndex).trim();
    const args = content.slice(closingIndex + "</skill>".length).trim();
    if (!expandedContent) return null;

    return { name, location, content: expandedContent, args };
  }

  private getExpandedSkillCommand(content: string): string | null {
    const skill = this.parseExpandedSkillMessage(content);
    if (!skill) return null;
    return [`/skill:${skill.name}`, skill.args].filter(Boolean).join(" ");
  }

  private renderExpandedSkillMessage(
    messageEl: HTMLElement,
    contentEl: HTMLElement,
    skill: ExpandedSkillMessage
  ): string {
    const isZh = this.plugin.settings.language !== "en";
    const command = [`/skill:${skill.name}`, skill.args].filter(Boolean).join(" ");

    messageEl.addClass("pi-agent-message-skill");
    messageEl.setAttribute("data-raw-content", command);

    const summaryRow = contentEl.createDiv("pi-agent-skill-summary");
    summaryRow.createSpan({ text: command, cls: "pi-agent-skill-command" });
    summaryRow.createSpan({
      text: isZh ? "已加载技能" : "Skill loaded",
      cls: "pi-agent-skill-status",
    });

    const details = contentEl.createEl("details", {
      cls: "pi-agent-skill-details",
    });
    const detailsSummary = details.createEl("summary", {
      cls: "pi-agent-skill-details-summary",
    });
    detailsSummary.setText(isZh ? "查看完整技能内容" : "View expanded skill content");
    details.createEl("pre", {
      cls: "pi-agent-skill-details-body",
      text: skill.content,
    });

    return command;
  }

  private renderUserMessageContent(
    messageEl: HTMLElement,
    contentEl: HTMLElement,
    content: string
  ): string {
    // Queued messages may already contain image attachments. Replace only the
    // text/details portion so an authoritative message_start event keeps them.
    for (const child of Array.from(contentEl.children)) {
      if (!(child as HTMLElement).classList.contains("pi-agent-message-attachments")) {
        child.remove();
      }
    }
    messageEl.removeClass("pi-agent-message-skill");

    const expandedSkill = this.parseExpandedSkillMessage(content);
    if (expandedSkill) {
      return this.renderExpandedSkillMessage(messageEl, contentEl, expandedSkill);
    }

    const visibleContent = this.stripRecentContextGuard(content);
    if (visibleContent) contentEl.createSpan({ text: visibleContent });
    messageEl.setAttribute("data-raw-content", visibleContent);
    return visibleContent;
  }

  private async steerExistingMessage(
    messageEl: HTMLElement,
    steerBtn?: HTMLButtonElement
  ): Promise<void> {
    const userInput = (
      messageEl.getAttribute("data-user-input") ||
      messageEl.getAttribute("data-raw-content") ||
      ""
    ).trim();
    if (!userInput) {
      new Notice("这条消息没有可调整的文字");
      return;
    }

    // A queued bubble already carries the exact RPC payload (including any
    // Pimate system prompt). Reuse it when possible; older history falls back
    // to the visible user text with the current system prompt applied.
    const queuedRpcMessage =
      messageEl.getAttribute("data-queue-rpc-message") ||
      messageEl.getAttribute("data-rpc-message");
    const message = queuedRpcMessage || this.applySystemPrompt(userInput);
    await this.hardSteerMessage(message, {
      steerBtn,
      userGoal: userInput,
    });
  }

  /**
   * Pi's native `steer` command is deliberately soft: it waits for the
   * current assistant turn to finish. Pimate's "调整方向" action promises a
   * user-visible direction change now, so it aborts first and then sends a
   * normal prompt once Pi has acknowledged that it is idle.
   */
  private async hardSteerMessage(
    message: string,
    options: {
      steerBtn?: HTMLButtonElement;
      userGoal?: string;
      images?: Array<{ type: string; data: string; mimeType: string }>;
      tab?: ChatTab;
      client?: AgentClient;
    } = {}
  ): Promise<boolean> {
    const tab = options.tab || this.activeTab;
    const initialClient = options.client || tab?.client || this.client;
    const isZh = this.plugin.settings.language !== "en";
    if (!initialClient || !tab || !tab.isStreaming) {
      new Notice(isZh ? "当前没有正在生成的任务" : "There is no active response to redirect");
      return false;
    }
    if (this.hardSteerInFlight || this.abortInFlight) {
      new Notice(isZh ? "正在调整方向，请稍候" : "Redirecting the current response…");
      return false;
    }

    // Pi 0.84 does not expose a clear-queue RPC. If follow-ups already exist,
    // a short RPC-process restart after abort is the only safe way to ensure
    // they cannot run after the selected redirect message.
    const queuedBeforeAbort = [...this.pendingQueuedMessages];
    const hasQueuedMessages =
      queuedBeforeAbort.length > 0 || (tab.queueCount || 0) > 0;

    this.hardSteerInFlight = true;
    tab.smartReviewContinues = 0;
    tab.smartReviewOriginalGoal = null;
    if (options.steerBtn) options.steerBtn.disabled = true;
    this.setStatus(isZh ? "↪ 正在中断并调整方向…" : "↪ Stopping and redirecting…", "thinking");
    this.updateButtons();

    try {
      const abortResponse = await initialClient.abort();
      if (!abortResponse.success) {
        throw new Error(abortResponse.error || "Pi did not stop the current response");
      }

      let client = initialClient;
      if (hasQueuedMessages) {
        if (initialClient.engine === "antigravity") {
          // Agy owns its in-memory queue and abort() clears it while
          // terminating the current print-mode process. It has no Pi-style
          // session file, so restarting through restartTabClient() would
          // incorrectly reject a valid redirect.
          this.discardQueuedMessageBubbles(queuedBeforeAbort);
        } else {
          client = await this.restartClientAfterHardSteer(tab, initialClient);
          this.discardQueuedMessageBubbles(queuedBeforeAbort);
        }
      }

      const response = await client.prompt(message, { images: options.images });
      if (!response.success) {
        throw new Error(response.error || "Pi did not accept the redirect message");
      }

      tab.smartReviewOriginalGoal = options.userGoal || message;
      if (this.activeTab === tab) {
        new Notice(isZh ? "已中断当前回复并调整方向" : "Current response stopped and redirected");
        this.setStatus(isZh ? "↪ 正在按新方向继续…" : "↪ Continuing in the new direction…", "thinking");
      }
      return true;
    } catch (err) {
      if (options.images?.length && tab) tab.pendingUserImages = [];
      new Notice(`❌ ${isZh ? "调整方向失败：" : "Could not redirect: "}${(err as Error).message}`);
      return false;
    } finally {
      this.hardSteerInFlight = false;
      this.updateButtons();
    }
  }

  /** Remove optimistic bubbles whose server-side queue is being discarded. */
  private discardQueuedMessageBubbles(messages: PendingQueuedMessage[]): void {
    if (messages.length === 0) return;
    const rendered = new Set(messages.map((message) => message.rendered));
    for (const message of rendered) message.el.remove();
    this.renderedMessages = this.renderedMessages.filter(
      (message) => !rendered.has(message)
    );
    this.pendingQueuedMessages = this.pendingQueuedMessages.filter(
      (message) => !rendered.has(message.rendered)
    );
  }

  /**
   * Restart only when a hard redirect must discard Pi's already-submitted
   * follow-up queue. Pi keeps that queue in memory and exposes no RPC command
   * to remove individual items.
   */
  private async restartClientAfterHardSteer(
    tab: ChatTab,
    previousClient: AgentClient
  ): Promise<AgentClient> {
    return this.restartTabClient(tab, previousClient, {
      clearQueuedState: true,
      missingSessionError: "Pi did not provide the current session to resume",
      restartError: "Could not restart Pi for the redirect",
    });
  }

  private async restartTabClient(
    tab: ChatTab,
    previousClient: AgentClient,
    options: {
      clearQueuedState: boolean;
      missingSessionError: string;
      restartError: string;
    }
  ): Promise<AgentClient> {
    const synchronized = await this.syncTabStateFromPi(tab);
    if (!synchronized) {
      throw new Error("Could not verify the current session before restarting Pi");
    }
    if (tab.client !== previousClient) {
      throw new Error("The conversation changed while restarting Pi");
    }
    if (!tab.sessionFile) {
      throw new Error(options.missingSessionError);
    }

    const sessionFile = tab.sessionFile;
    const sessionId = tab.sessionId;
    await previousClient.destroy();
    if (tab.client === previousClient) tab.client = null;
    if (options.clearQueuedState) {
      tab.queueCount = 0;
      tab.steeringCount = 0;
      tab.followUpCount = 0;
    }
    if (this.client === previousClient) this.client = null;

    // Preserve the authoritative binding even if startup fails, so a later
    // retry can still resume the user's conversation.
    tab.sessionFile = sessionFile;
    tab.sessionId = sessionId;
    await this.ensureTabClient(tab, { requireSessionRestore: true });
    if (!tab.client?.isRunning()) throw new Error(options.restartError);

    if (this.activeTab === tab) {
      this.client = tab.client;
      this.isStreaming = false;
      this.renderActiveTabRuntimeStatus();
    }
    return tab.client;
  }

  private normalizeQueuedMessage(text: string): string {
    const skillCommand = this.getExpandedSkillCommand(text);
    if (skillCommand) return skillCommand;
    return text.replace(/\s+/g, " ").trim();
  }

  private findPendingQueuedMessage(content: string): number {
    const normalized = this.normalizeQueuedMessage(content);
    if (!normalized) return -1;
    return this.pendingQueuedMessages.findIndex((pending) => {
      const rpcMessage = this.normalizeQueuedMessage(pending.rpcMessage);
      const userInput = this.normalizeQueuedMessage(pending.userInput);
      return (
        rpcMessage === normalized ||
        (userInput.length > 0 && userInput === normalized) ||
        rpcMessage.endsWith(normalized) ||
        (userInput.length > 0 && normalized.endsWith(userInput))
      );
    });
  }

  private addOptimisticQueuedMessage(
    rpcMessage: string,
    userInput: string,
    images: Array<{ data: string; mimeType: string }>
  ): void {
    const displayText = userInput || rpcMessage;
    const rendered = this.addMessage("user", displayText, {
      userInput: userInput || displayText,
      queued: true,
    });
    rendered.el.setAttribute("data-queue-rpc-message", rpcMessage);
    if (images.length > 0) {
      this.renderUserMessageImages(rendered, images);
    }
    this.pendingQueuedMessages.push({ rendered, rpcMessage, userInput, images });
    this.updateButtons();
  }

  private removePendingQueuedMessage(rpcMessage: string): void {
    const index = this.pendingQueuedMessages.findIndex(
      (pending) => pending.rpcMessage === rpcMessage
    );
    if (index === -1) return;
    const [pending] = this.pendingQueuedMessages.splice(index, 1);
    pending.rendered.el.remove();
    const renderedIndex = this.renderedMessages.indexOf(pending.rendered);
    if (renderedIndex !== -1) this.renderedMessages.splice(renderedIndex, 1);
  }

  private bindForkEntry(message: RenderedMessage, forkMessage: ForkMessage): void {
    if (!message.forkBtn || !forkMessage.entryId) return;
    message.entryId = forkMessage.entryId;
    const { forkBtn } = message;
    forkBtn.disabled = false;
    forkBtn.removeAttribute("aria-label");
    const isZh = this.plugin.settings.language === "zh";
    forkBtn.setAttribute("title", isZh ? "Fork 从此提问分支" : "Fork from this prompt");
    forkBtn.onclick = (e) => {
      e.stopPropagation();
      const fallbackText = message.el.getAttribute("data-raw-content") || "";
      this.runAsync(async () => {
        await this.forkFromEntry(forkMessage.entryId, fallbackText);
      });
    };
  }

  private addSystemMessage(text: string): void {
    if (!this.chatContainer) return;
    this.clearEmptyState();
    const el = this.chatContainer.createDiv("pi-agent-system-msg");
    el.setText(text);
    this.scrollToBottom(true, true);
  }

  private addCompactionSummaryMessage(
    summary: string,
    tokensBefore?: number,
    title = "Context compacted",
    options: { prependHistory?: boolean } = {}
  ): void {
    if (!this.chatContainer) return;
    this.clearEmptyState();
    const wrap = this.chatContainer.createDiv("pi-agent-compaction-summary");
    if (options.prependHistory && this.historyPrependAnchorEl) {
      this.chatContainer.insertBefore(wrap, this.historyPrependAnchorEl);
    }
    const header = wrap.createDiv("pi-agent-compaction-header");
    header.setText(
      tokensBefore
        ? `📦 ${title} · ${tokensBefore.toLocaleString()} tokens summarized`
        : `📦 ${title}`
    );
    if (summary && summary.trim()) {
      const body = wrap.createDiv("pi-agent-compaction-body markdown-preview-view markdown-rendered");
      void MarkdownRenderer.render(this.app, summary, body, "", this);
    }
    if (!options.prependHistory) this.scrollToBottom(true, true);
  }

  private renderEmptyState(): void {
    if (!this.chatContainer || this.chatContainer.querySelector(".pi-agent-empty-state")) return;
    const empty = this.chatContainer.createDiv("pi-agent-empty-state");
    empty.createDiv({ text: "π", cls: "pi-agent-empty-logo" });
    empty.createDiv({ text: "Pimate", cls: "pi-agent-empty-title" });
    empty.createDiv({ text: "Ask Pi to read, write, explain, or refactor your vault.", cls: "pi-agent-empty-subtitle" });
    const prompts = empty.createDiv("pi-agent-empty-prompts");
    for (const prompt of [
      "总结当前笔记",
      "把选中内容改得更克制",
      "搜索这个 vault 里的相关内容",
      "解释我粘贴的截图",
    ]) {
      const chip = prompts.createSpan({ text: prompt, cls: "pi-agent-empty-prompt" });
      chip.onclick = () => this.setInputText(prompt);
    }
  }

  private clearEmptyState(): void {
    this.chatContainer?.querySelector(".pi-agent-empty-state")?.remove();
  }

  private startSpeedIndicator(): void {
    if (this.speedHideTimer) {
      window.clearTimeout(this.speedHideTimer);
      this.speedHideTimer = null;
    }
    if (this.speedTimer) {
      window.clearInterval(this.speedTimer);
      this.speedTimer = null;
    }
    const tab = this.activeTab;
    if (tab) {
      tab.speedStartedAt = null;
      tab.speedEstimatedTokens = 0;
      tab.speedHideAt = null;
    }
    this.speedStartedAt = null;
    this.speedEstimatedTokens = 0;
    if (this.speedEl) {
      this.speedEl.addClass("pi-agent-hidden");
      this.speedEl.setText("…");
    }
  }

  private estimateTokenCount(text: string): number {
    if (!text) return 0;
    let cjk = 0;
    let other = 0;
    for (const ch of text) {
      if (/\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u.test(ch)) cjk++;
      else if (!/\s/.test(ch)) other++;
    }
    return cjk + other / 4;
  }

  private addSpeedDelta(text: string): void {
    if (!text) return;
    const estimatedTokens = this.estimateTokenCount(text);
    const tab = this.activeTab;
    if (tab) {
      if (!tab.speedStartedAt) tab.speedStartedAt = Date.now();
      tab.speedEstimatedTokens = (tab.speedEstimatedTokens || 0) + estimatedTokens;
      tab.speedHideAt = null;
    }
    if (!this.speedStartedAt) this.speedStartedAt = Date.now();
    this.speedEstimatedTokens += estimatedTokens;
    if (this.speedEl) this.speedEl.removeClass("pi-agent-hidden");
    if (!this.speedTimer) {
      this.speedTimer = window.setInterval(() => this.updateSpeedIndicator(false), 750);
    }
    this.updateSpeedIndicator(false);
  }

  private updateSpeedIndicator(final: boolean): void {
    if (!this.speedEl) return;
    const tab = this.activeTab;
    const startedAt = tab?.speedStartedAt ?? this.speedStartedAt;
    const tokens = tab?.speedEstimatedTokens ?? this.speedEstimatedTokens;
    if (!startedAt || tokens <= 0) {
      return;
    }
    this.speedEl.removeClass("pi-agent-hidden");
    const elapsedSec = Math.max(0.1, (Date.now() - startedAt) / 1000);
    const rate = tokens / elapsedSec;
    const rounded = rate >= 10 ? Math.round(rate) : Number(rate.toFixed(1));
    const prefix = final ? "" : "~";
    this.speedEl.setText(`${prefix}${rounded} tok/s`);
    this.speedEl.setAttribute(
      "title",
      `Estimated output speed: ${rounded} tok/s · ${Math.round(tokens)} tokens · ${elapsedSec.toFixed(1)}s`
    );
  }

  private stopSpeedIndicator(): void {
    if (this.speedTimer) {
      window.clearInterval(this.speedTimer);
      this.speedTimer = null;
    }
    const tab = this.activeTab;
    if (tab) tab.speedHideAt = Date.now() + 8000;
    this.updateSpeedIndicator(true);
    if (this.speedHideTimer) window.clearTimeout(this.speedHideTimer);
    this.speedHideTimer = window.setTimeout(() => {
      this.speedEl?.addClass("pi-agent-hidden");
      this.speedHideTimer = null;
    }, 8000);
  }

  private renderActiveTabSpeed(): void {
    if (!this.speedEl) return;
    if (this.speedTimer) {
      window.clearInterval(this.speedTimer);
      this.speedTimer = null;
    }
    if (this.speedHideTimer) {
      window.clearTimeout(this.speedHideTimer);
      this.speedHideTimer = null;
    }
    const tab = this.activeTab;
    if (!tab) {
      this.speedEl.addClass("pi-agent-hidden");
      return;
    }
    const startedAt = tab.speedStartedAt || null;
    const tokens = tab.speedEstimatedTokens || 0;
    this.speedStartedAt = startedAt;
    this.speedEstimatedTokens = tokens;
    if (!startedAt || tokens <= 0) {
      this.speedEl.addClass("pi-agent-hidden");
      return;
    }
    this.speedEl.removeClass("pi-agent-hidden");
    this.updateSpeedIndicator(true);
    if (tab.isStreaming) {
      this.speedTimer = window.setInterval(() => this.updateSpeedIndicator(false), 750);
    } else {
      const hideAt = tab.speedHideAt || 0;
      if (hideAt <= Date.now()) {
        this.speedEl.addClass("pi-agent-hidden");
        return;
      }
      this.speedHideTimer = window.setTimeout(() => {
        if (!this.activeTab?.isStreaming) {
          this.speedEl?.addClass("pi-agent-hidden");
        }
        this.speedHideTimer = null;
      }, hideAt - Date.now());
    }
  }

  private renderActiveTabModelAndEffort(): void {
    const tab = this.activeTab;
    if (!tab) return;
    this.updateEngineDisplay();
    const isAgy = (tab.engine || this.plugin.settings.defaultEngine) === "antigravity";
    const provider = tab.modelProvider || (isAgy ? "antigravity" : (this.plugin.settings.provider || ""));
    const modelId = tab.modelId || (isAgy ? (this.plugin.settings.agyModel || "gemini-3.8-flash-high") : (this.plugin.settings.modelId || ""));
    const level = tab.thinkingLevel ?? (isAgy ? (this.plugin.settings.agyEffort || "high") : (this.plugin.settings.thinkingLevel ?? ""));
    this.updateModelDisplay(provider, modelId);
    if (this.footerEffortCurrent) {
      this.footerEffortCurrent.setText(this.getThinkingLevelLabel(level));
    }
  }

  private isNearBottom(threshold = 80): boolean {
    if (!this.chatContainer) return true;
    const scrollOffset =
      this.chatContainer.scrollHeight -
      this.chatContainer.scrollTop -
      this.chatContainer.clientHeight;
    return scrollOffset <= threshold;
  }

  private scrollToBottom(immediate = true, force = false): void {
    if (!this.chatContainer || !this.plugin.settings.autoScroll) return;

    if (!force) {
      // Smart Auto-Scroll Lock: if user scrolled up more than 50px, do not hijack the view.
      const scrollOffset = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight;
      if (scrollOffset >= 50) {
        return;
      }
    }

    if (immediate) {
      this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
    }
    // Compensation delays for dynamic reflow
    window.setTimeout(() => {
      if (this.chatContainer) {
        if (!force) {
          const scrollOffset = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight;
          if (scrollOffset >= 50) return;
        }
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
      }
    }, 50);
    window.setTimeout(() => {
      if (this.chatContainer) {
        if (!force) {
          const scrollOffset = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight;
          if (scrollOffset >= 50) return;
        }
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
      }
    }, 150);
  }

  private focusAdjacentMessage(direction: -1 | 1): void {
    // Only navigate between USER messages, not assistant/system/tool messages.
    const messages = Array.from(
      this.chatContainer?.querySelectorAll(".pi-agent-message-user") || []
    ) as HTMLElement[];
    if (messages.length === 0) return;

    // Use viewport-relative position to find current message reliably.
    // This is more stable than scroll-center calculation.
    const containerRect = this.chatContainer?.getBoundingClientRect();
    if (!containerRect) return;
    const viewportCenterY = containerRect.top + containerRect.height / 2;

    // Find the message whose vertical center is closest to viewport center.
    let currentIndex = 0;
    let minDist = Infinity;
    messages.forEach((msg, i) => {
      const msgRect = msg.getBoundingClientRect();
      const msgCenter = msgRect.top + msgRect.height / 2;
      const dist = Math.abs(msgCenter - viewportCenterY);
      if (dist < minDist) {
        minDist = dist;
        currentIndex = i;
      }
    });

    // Navigate: clamp to valid range.
    const nextIndex = Math.max(0, Math.min(messages.length - 1, currentIndex + direction));
    if (nextIndex === currentIndex) return; // At boundary, nothing to do.
    messages[nextIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /** Jump to the first or last USER message in the chat (used by the floating nav). */
  private focusEdgeMessage(edge: "first" | "last"): void {
    const messages = Array.from(
      this.chatContainer?.querySelectorAll(".pi-agent-message-user") || []
    ) as HTMLElement[];
    if (messages.length === 0) return;
    const target = edge === "first" ? messages[0] : messages[messages.length - 1];
    target?.scrollIntoView({ block: "start", behavior: "smooth" });
  }

  /**
   * Show/hide the prev/next nav buttons based on how many user messages exist.
   * Hide both when there's < 2 user messages (only one target, prev/next are no-ops).
   */
  private setStatus(
    text: string,
    type: "ok" | "thinking" | "error" | "warning"
  ): void {
    if (!this.statusBar) return;
    this.statusBar.empty();
    this.statusBar.removeAttribute("title");
    this.statusBar.className = `pi-agent-status pi-agent-status-${type}`;

    if (type === "ok") return;

    if (type === "error") {
      setIcon(this.statusBar, "alert-circle");
      this.statusBar.setAttribute("title", text);
      return;
    }

    if (type === "warning") {
      setIcon(this.statusBar, "alert-triangle");
      this.statusBar.setAttribute("title", text);
      return;
    }

    if (type === "thinking") {
      const lowerText = text.toLowerCase();
      if (lowerText.includes("thinking")) {
        setIcon(this.statusBar, "brain");
        this.statusBar.setAttribute("title", "Thinking...");
      } else if (lowerText.includes("compact")) {
        setIcon(this.statusBar, "shrink");
        this.statusBar.setAttribute("title", "Compacting memory...");
      } else if (lowerText.includes("queue")) {
        setIcon(this.statusBar, "list-ordered");
        this.statusBar.setAttribute("title", text);
      } else {
        setIcon(this.statusBar, "loader-2");
        this.statusBar.setAttribute("title", "Running...");
      }
    }
  }

  private renderDetectedFiles(outputEl: HTMLElement, text: string): void {
    const pathRegex = /[a-zA-Z0-9_\-\/\\.]+\.[a-zA-Z]{2,10}/g;
    const words = text.match(pathRegex) || [];
    if (words.length === 0) return;

    const uniqueFiles = new Set<TFile>();
    for (const word of words) {
      if (word.includes("node_modules") || word.includes(".git") || word.startsWith("http")) continue;
      const base = this.getBasename(word);
      if (!base || base.length < 4) continue;
      const file = this.app.metadataCache.getFirstLinkpathDest(base, "");
      if (file instanceof TFile) {
        uniqueFiles.add(file);
      }
    }

    if (uniqueFiles.size > 0) {
      const chipsContainer = activeDocument.createElement("div");
      chipsContainer.className = "pi-agent-detected-files";
      chipsContainer.createSpan({ text: "Detected files: ", cls: "pi-agent-detected-label" });
      uniqueFiles.forEach((file) => {
        const chip = chipsContainer.createSpan({
          text: file.name,
          cls: "pi-agent-file-chip is-clickable",
          attr: { title: `${file.path} (Click to open)` }
        });
        chip.onclick = (e) => {
          e.stopPropagation();
          void this.app.workspace.getLeaf(false).openFile(file).catch((err: unknown) => {
            console.error("[pimate] open linked file failed", err);
          });
        };
      });
      outputEl.insertBefore(chipsContainer, outputEl.firstChild);
    }
  }

  private updateWidget(widgetKey: string, lines: string[] | undefined): void {
    if (!this.widgetEl) return;
    try {
      if (!lines || lines.length === 0) {
        this.widgetEl.empty();
        this.widgetEl.addClass("pi-agent-hidden");
        return;
      }

      this.widgetEl.empty();
      this.widgetEl.removeClass("pi-agent-hidden");
      this.widgetEl.className = `pi-agent-widget pi-agent-widget-${widgetKey}`;

      const titleLine = lines[0];
      const contentLines = lines.slice(1);

      const header = this.widgetEl.createDiv("pi-agent-widget-header");
      const icon = header.createSpan("pi-agent-widget-icon");
      try {
        setIcon(icon, "list-todo");
      } catch {
        icon.setText("📋");
      }

      header.createSpan({ text: titleLine, cls: "pi-agent-widget-title" });

      const listContainer = this.widgetEl.createDiv("pi-agent-widget-list");
      let foundActive = false;

      for (const line of contentLines) {
        const item = listContainer.createDiv("pi-agent-widget-item");
        let text = line.trim();
        let status = "pending";

        if (text.startsWith("✓")) {
          status = "done";
          text = text.slice(1).trim();
        } else {
          if (!foundActive) {
            status = "active";
            foundActive = true;
          } else {
            status = "pending";
          }
          if (text.startsWith("●")) {
            text = text.slice(1).trim();
          }
        }

        const iconEl = item.createSpan(`pi-agent-widget-item-icon pi-status-${status}`);
        iconEl.setText(status === "done" ? "✓" : "●");

        const textEl = item.createSpan(`pi-agent-widget-item-text pi-status-${status}`);
        textEl.setText(text);
      }
    } catch (err) {
      console.error("[pimate] updateWidget error:", err);
    }
  }

  // ─── Actions ───────────────────────────────────────────────────────────

  private showMoreMenu(event: MouseEvent): void {
    const menu = new Menu();
    const isZh = this.plugin.settings.language === "zh";

    menu.addItem((item) =>
      item
        .setTitle(isZh ? "指令 / 技能" : "Commands / Skills")
        .setIcon("terminal")
        .onClick(() => this.runAsync(() => this.showCommandSelector()))
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "附加当前打开的笔记" : "Attach current open note")
        .setIcon("file-plus")
        .onClick(() => this.addCurrentFileContext())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "附加文件管理器选中项" : "Attach file explorer selection")
        .setIcon("list-plus")
        .onClick(() => this.addExplorerSelectionContext())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "插入最后一条回复" : "Insert last response")
        .setIcon("pencil")
        .onClick(() => this.insertLastAssistantIntoActiveNote())
    );

    const snippets = this.getParsedSnippets();
    if (snippets.length > 0) {
      menu.addSeparator();
      for (const snippet of snippets.slice(0, 12)) {
        const title = snippet.group ? `${snippet.group} / ${snippet.title}` : snippet.title;
        const snippetLabel = isZh ? "片段" : "Snippet";
        menu.addItem((item) =>
          item
            .setTitle(`${snippetLabel}: ${title.slice(0, 42)}${title.length > 42 ? "…" : ""}`)
            .setIcon("text-cursor-input")
            .onClick(() => this.appendInputText(this.expandSnippet(snippet.content)))
        );
      }
    }

    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "恢复会话..." : "Resume session…")
        .setIcon("history")
        .onClick(() => this.showResumeSelector())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "可 Fork 的历史节点..." : "Forkable history…")
        .setIcon("git-branch")
        .onClick(() => this.showForkHistoryModal())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "从提示词分叉..." : "Fork from prompt…")
        .setIcon("git-fork")
        .onClick(() => this.showForkSelector())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "克隆当前分支" : "Clone current branch")
        .setIcon("copy")
        .onClick(() => this.cloneCurrentBranch())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "重载扩展与技能 (/reload)" : "Reload extensions & skills (/reload)")
        .setIcon("refresh-cw")
        .onClick(() => this.runAsync(() => this.reloadExtensions()))
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "压缩上下文" : "Compact context")
        .setIcon("archive")
        .onClick(() => this.runAsync(() => this.compactSession()))
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "导出为 Vault 笔记" : "Export to Vault Note")
        .setIcon("file-output")
        .onClick(() => this.runAsync(() => this.exportSessionToVaultNote()))
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "导出 HTML" : "Export HTML")
        .setIcon("download")
        .onClick(() => this.runAsync(() => this.exportSessionHtml()))
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "会话统计" : "Session stats")
        .setIcon("bar-chart-2")
        .onClick(() => this.runAsync(() => this.showStats()))
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "Token 用量..." : "Token Usage…")
        .setIcon("bar-chart-3")
        .onClick(() => this.showUsageStats())
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "上一条消息" : "Previous message")
        .setIcon("arrow-up")
        .onClick(() => this.scrollToPreviousMessage())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "下一条消息" : "Next message")
        .setIcon("arrow-down")
        .onClick(() => this.scrollToNextMessage())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "切换最后一条工具输出" : "Toggle last tool output")
        .setIcon("panel-bottom-close")
        .onClick(() => this.toggleLastToolBlock())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "跳到最后一次 diff" : "Jump to last diff")
        .setIcon("git-compare")
        .onClick(() => this.scrollToLastDiff())
    );

    menu.showAtMouseEvent(event);
  }

  private getParsedSnippets(): ParsedSnippet[] {
    return (this.plugin.settings.snippets || [])
      .map((line) => this.parseSnippet(line))
      .filter((snippet): snippet is ParsedSnippet => Boolean(snippet?.content));
  }

  private parseSnippet(line: string): ParsedSnippet | null {
    const raw = line.trim();
    if (!raw) return null;
    const [head, ...rest] = raw.split("::");
    if (rest.length === 0) {
      return {
        title: raw.slice(0, 36),
        content: raw,
      };
    }
    const content = rest.join("::").trim();
    if (!content) return null;
    const parts = head.split("/").map((part) => part.trim()).filter(Boolean);
    const title = parts.pop() || content.slice(0, 36);
    const group = parts.join(" / ") || undefined;
    return { title, group, content };
  }

  private expandSnippet(snippet: string): string {
    const activeFile = this.app.workspace.getActiveFile();
    const selection = this.contextItems.find((item) => item.type === "selection")?.value || "";
    return snippet
      .replace(/\{\{selection\}\}/g, selection)
      .replace(/\{\{current_file\}\}/g, activeFile?.path || "")
      .replace(/\{\{current_title\}\}/g, activeFile?.basename || "")
      .replace(/\{\{date\}\}/g, new Date().toISOString().slice(0, 10));
  }

  private updateInputModeState(): void {
    if (!this.inputEl) return;
    const isBash = this.inputEl.value.trimStart().startsWith("!");
    this.inputEl.toggleClass("is-bash-mode", isBash);
    this.inputEl.setAttribute(
      "placeholder",
      isBash
        ? "Bash mode — command will run locally"
        : "How can I help you today?"
    );
    this.statusBar?.toggleClass("is-bash-mode", isBash);
    if (isBash && this.statusBar) this.statusBar.setText("Bash mode");
  }

  private async sendMessage(streamingBehavior?: "steer" | "followUp"): Promise<void> {
    const tab = this.activeTab;
    const client = tab?.client;
    if (!tab || !client || !this.inputEl) {
      if (tab) new Notice("当前对话正在切换或尚未就绪，请稍后再发送");
      return;
    }
    // AGY print-mode processes may exit after an interrupted turn. Do not
    // reconnect proactively: only revive the same client when the user sends
    // a new message, preserving its conversation ID and avoiding background
    // work after an error.
    if (!client.isRunning()) {
      if (client.engine !== "antigravity" || tab.isStreaming) {
        new Notice("当前对话正在切换或尚未就绪，请稍后再发送");
        return;
      }
      const isZh = this.plugin.settings.language !== "en";
      try {
        this.setStatus(
          isZh ? "↻ 正在恢复 AGY 会话…" : "↻ Restoring AGY session…",
          "thinking"
        );
        await client.start();
      } catch (err) {
        this.setStatus(
          `❌ ${isZh ? "无法恢复 AGY 会话：" : "Could not restore AGY session: "}${(err as Error).message}`,
          "error"
        );
        return;
      }
    }
    // The visible composer belongs to the tab selected at the instant Enter
    // was pressed. Repair the legacy shared pointer if an older async tab
    // switch left it pointing at another client, but never use that pointer as
    // the send target below.
    if (this.client !== client) {
      console.warn("[pimate] repaired stale active client pointer before send", {
        tabId: tab.id,
      });
      this.client = client;
    }
    if (tab.reloadInFlight) {
      new Notice("Pi 正在重新加载资源，请稍候");
      return;
    }
    const rawMessage = this.inputEl.value.trim();
    const contextPrefix = this.buildContextPrefix();
    const images = this.getImagePayloads();
    const builtinCommand = this.parsePimateBuiltinCommand(rawMessage);
    if (builtinCommand) {
      this.inputEl.value = "";
      this.inputEl.setCssProps({ height: "auto" });
      this.updateInputModeState();
      this.closeCommandDropdown();
      this.clearContextItems();
      tab.pendingUserImages = [];
      if (images.length > 0) {
        new Notice("Pimate 内建命令不会使用附加图片");
      }
      await this.executePimateBuiltinCommand(builtinCommand.name, builtinCommand.args);
      return;
    }

    let agyImagePaths: string[] = [];
    if (client.engine === "antigravity" && images.length > 0) {
      try {
        agyImagePaths = await this.persistAgyImageAttachments(images);
      } catch (err) {
        new Notice(
          `❌ ${this.plugin.settings.language !== "en" ? "保存 AGY 图片失败：" : "Could not save image for AGY: "}${(err as Error).message}`
        );
        return;
      }
    }
    const agyImagePrefix = this.buildAgyImagePrefix(agyImagePaths);
    const userMessage = rawMessage || (images.length ? "Please analyze the attached image(s)." : "");
    const baseMessage = `${contextPrefix}${agyImagePrefix}${userMessage}`.trim();
    if (!baseMessage) {
      if (streamingBehavior === "steer") {
        this.inputEl.focus();
        new Notice("请先输入调整内容，再点击“调整方向”");
      }
      return;
    }

    const message = this.applySystemPrompt(baseMessage);
    const shouldQueue = tab.isStreaming && !message.startsWith("!");
    const shouldHardSteer = shouldQueue && streamingBehavior === "steer";
    // Pi receives native image payloads. AGY receives the generated local-file
    // references in `message` instead; its stream-json adapter must stay text-only.
    const sendImages = client.engine === "antigravity" ? [] : images;

    this.maybeTitleActiveTab(rawMessage || userMessage);

    // Stash images so the user-message bubble (rendered when Pi echoes via
    // message_start) can show the attached images at the top, like Claudian.
    tab.pendingUserImages = images.map((i) => ({ data: i.data, mimeType: i.mimeType }));

    // Queued prompts do not always emit message_start until Pi begins the next
    // turn. Render a temporary user bubble now, then reconcile it when the
    // authoritative event arrives.
    if (shouldQueue && !shouldHardSteer) {
      this.addOptimisticQueuedMessage(
        message,
        rawMessage || userMessage,
        images.map((i) => ({ data: i.data, mimeType: i.mimeType }))
      );
      tab.pendingUserImages = [];
    }

    // Clear input
    this.inputEl.value = "";
    this.inputEl.setCssProps({ height: "auto" });
    this.updateInputModeState();
    this.clearContextItems();

    // Reset smart-review counter for fresh user goals so the auto-continue
    // loop only runs within the same goal.
    tab.smartReviewContinues = 0;
    tab.smartReviewOriginalGoal = rawMessage || message;
    tab.draft = "";
    tab.contextItems = [];

    try {
      if (message.startsWith("!")) {
        tab.smartReviewOriginalGoal = null;
        await this.runBashMode(message, client);
      } else if (shouldHardSteer) {
        // This is deliberately not Pi's native `steer`: the action promises
        // to stop the current output before starting this input as a fresh
        // direction.
        await this.hardSteerMessage(message, {
          images: sendImages,
          userGoal: rawMessage || userMessage,
          tab,
          client,
        });
      } else if (shouldQueue) {
        // Normal Enter remains a non-destructive follow-up queue.
        const response = await client.prompt(message, {
          streamingBehavior: "followUp",
          images: sendImages,
        });
        if (!response.success) {
          throw new Error(response.error || "Pi did not accept the queued message");
        }
      } else {
        const response = await client.prompt(message, { images: sendImages });
        if (!response.success) {
          throw new Error(response.error || "Pi did not accept the message");
        }
      }
      if (client.engine === "antigravity" && !message.startsWith("!")) {
        void this.recordAgyConversationAfterAcceptedPrompt(
          tab,
          rawMessage || userMessage
        ).catch((err) => {
          console.warn("[pimate] could not record AGY conversation ownership:", err);
        });
      }
    } catch (err) {
      if (shouldQueue && !shouldHardSteer) this.removePendingQueuedMessage(message);
      if (this.activeTab === tab) {
        this.addSystemMessage(`❌ Failed to send: ${(err as Error).message}`);
      } else {
        new Notice(`❌ Failed to send: ${(err as Error).message}`);
      }
    }
  }

  private applySystemPrompt(message: string): string {
    // Pi only dispatches extension commands, skills, and prompt templates when
    // the slash command is the leading message token. Wrapping it in prose
    // would turn it into an ordinary model prompt.
    if (message.startsWith("!") || message.startsWith("/")) return message;

    const systemInstructions: string[] = [];
    const systemPrompt = (this.plugin.settings.systemPrompt || "").trim();
    if (systemPrompt) systemInstructions.push(systemPrompt);

    const smartReviewPrompt = this.getSmartReviewPrompt();
    if (smartReviewPrompt) systemInstructions.push(smartReviewPrompt);

    if (systemInstructions.length === 0) return message;
    return [
      "System instruction for this Pimate turn:",
      systemInstructions.join("\n\n"),
      "",
      "User request:",
      message,
    ].join("\n");
  }  private getSmartReviewPrompt(): string {
    if (this.plugin.settings.smartReviewEnabled !== true) return "";
    const isZh = this.plugin.settings.language !== "en";
    return isZh
      ? "智能审核已开启。任务完成后请明确回复“已完成”；若未完成，请简要说明还差什么。"
      : "Smart review is on. When the task is complete, reply exactly with \"Done\". If not yet complete, briefly state what is still missing.";
  }

  // ─── Smart Review Auto-Continue Loop ───────────────────────────────
  // Lightweight rule-based check against the last assistant text. We avoid an
  // extra LLM call here to keep latency and cost low; upgrade to a judge
  // later if we need richer semantics.

  private shouldAutoContinueFromAssistantText(text: string): boolean {
    const t = (text || "").trim();
    if (!t) return false;
    const lower = t.toLowerCase();

    // Clear "done" markers — if any of these are present we trust the reply.
    const doneMarkers = [
      /已完成/,
      /已经完成/,
      /任务完成/,
      /全部完成/,
      /最终结果/,
      /已经修复/,
      /已经通过/,
      /测试通过/,
      /build (?:passes|succeeded|ok)/i,
      /all (?:tests|checks?) pass/i,
      /task (?:is )?(?:complete|done|finished)/i,
      /no further (?:changes?|actions?) (?:needed|required)/i,
      /lgtm/i,
    ];
    if (doneMarkers.some((r) => r.test(t))) return false;

    // Incomplete markers — if any are present, continue.
    const continueMarkers = [
      /我将继续/,
      /接下来我会/,
      /下一步我会/,
      /现在去/,
      /我去/,
      /正在修复/,
      /尚未完成/,
      /还没有完成/,
      /未完成/,
      /还没修复/,
      /需要继续/,
      /需要进一步/,
      /还需要/,
      /仍然存在/,
      /测试失败/,
      /failed/i,
      /will (?:now |then )?(?:continue|fix|verify|run|check|proceed)/i,
      /next[, ]? i (?:will|'ll)/i,
      /todo:/i,
      /not (?:yet )?(?:complete|done|finished|fixed)/i,
      /still (?:need|needs|failing|pending)/i,
    ];
    if (continueMarkers.some((r) => r.test(t))) return true;

    // Trailing ellipsis or trailing action hint often means the reply was cut
    // off or the model is deferring action. Treat as continue.
    if (/[。.…]{1,3}$/.test(t) && /(我|我们|i|we)\s*(?:将|会|'ll|will)/.test(lower)) {
      return true;
    }

    return false;
  }

  private getSmartReviewMaxContinues(): number {
    const raw = this.plugin.settings.smartReviewMaxContinues;
    if (typeof raw !== "number" || isNaN(raw)) return 3;
    return Math.max(1, Math.min(10, Math.floor(raw)));
  }

  private async maybeAutoContinueSmartReview(expectedTab?: ChatTab): Promise<void> {
    const tab = expectedTab || this.activeTab;
    const client = tab?.client;
    if (this.plugin.settings.smartReviewEnabled !== true) return;
    if (!tab || !client) return;
    if (tab.isStreaming) return;
    if (tab.smartReviewOriginalGoal == null) return;

    const max = this.getSmartReviewMaxContinues();
    const continues = tab.smartReviewContinues || 0;
    if (continues >= max) {
      this.setStatus(
        `✅ Smart review limit reached (${continues}/${max})`,
        "ok",
      );
      tab.smartReviewOriginalGoal = null;
      return;
    }

    let result;
    try {
      result = await client.getLastAssistantText();
    } catch (err) {
      console.warn("[pimate] smart review: failed to fetch last assistant text", err);
      return;
    }
    if (!this.isCurrentTabClient(tab, client)) return;
    if (!result.success) return;
    const text = ((result.data as any)?.text as string | null | undefined) ?? "";
    if (!text.trim()) return;

    if (!this.shouldAutoContinueFromAssistantText(text)) {
      tab.smartReviewOriginalGoal = null;
      return;
    }

    tab.smartReviewContinues = continues + 1;
    const continuePrompt = this.buildSmartReviewContinuePrompt(tab.smartReviewOriginalGoal);
    this.setStatus(
      `🔁 Smart review continue ${tab.smartReviewContinues}/${max}`,
      "thinking",
    );
    this.addSystemMessage(`🔁 Smart review auto-continue (${tab.smartReviewContinues}/${max})`);

    try {
      if (!this.isCurrentTabClient(tab, client)) return;
      if (tab.isStreaming) {
        await client.steer(continuePrompt);
      } else {
        await client.prompt(continuePrompt);
      }
    } catch (err) {
      this.addSystemMessage(
        `❌ Smart review continue failed: ${(err as Error).message}`,
      );
      tab.smartReviewOriginalGoal = null;
    }
  }

  private buildSmartReviewContinuePrompt(goalOverride?: string | null): string {
    const isZh = this.plugin.settings.language !== "en";
    const goal = (goalOverride || "").trim();
    const goalSnippet = goal
      ? `${isZh ? "原始目标" : "Original goal"}: ${goal.slice(0, 400)}\n\n`
      : "";
    return isZh
      ? [
          "智能审核自动继续指令：",
          goalSnippet,
          "你最近一轮回复看起来尚未真正完成原始目标，或者显示出还需要继续/修复/验证的信号。",
          "请立即继续执行：不要再次复述目标，不要做新一轮总结性输出。",
          "优先：完成未完成的步骤、运行已有测试或工具验证、修正上一轮提到的问题。",
          "如果目标确实已经全部完成，请明确回复“已完成”并停止。",
        ].join("\n")
      : [
          "Smart review auto-continue:",
          goalSnippet,
          "Your previous reply suggests the original goal is not fully complete or contains signals that more work / verification is required.",
          "Continue executing now. Do not restate the goal; do not produce another summary first.",
          "Prioritize: finish remaining steps, run existing tests or tools to verify, fix issues called out last turn.",
          "If the goal is genuinely fully complete, reply exactly with \"Done\" and stop.",
        ].join("\n");
  }

  private normalizeSessionTitleKey(sessionPath: string): string {
    return sessionPath.replace(/\\/g, "/").toLowerCase();
  }

  private normalizeAgySessionTitleKey(conversationId: string): string {
    return conversationId.trim().toLowerCase();
  }

  private getCurrentAgyWorkspacePath(): string {
    const vaultPath = (this.app.vault.adapter as any).getBasePath?.();
    return AgyAgentClient.normalizeWorkspacePath(
      typeof vaultPath === "string" ? vaultPath : ""
    );
  }

  private getAgyConversationWorkspaceStatus(
    conversationId: string
  ): AgyConversationWorkspaceStatus {
    return AgyAgentClient.getConversationWorkspaceStatus(
      conversationId,
      this.getCurrentAgyWorkspacePath()
    );
  }

  private getAgyConversationIndex(): Record<string, AgyConversationIndexEntry> {
    const settings = this.plugin.settings as typeof this.plugin.settings & {
      agyConversationIndex?: Record<string, AgyConversationIndexEntry>;
    };
    if (!settings.agyConversationIndex || typeof settings.agyConversationIndex !== "object") {
      settings.agyConversationIndex = {};
    }
    return settings.agyConversationIndex;
  }

  private getAgyConversationScopeOverrides(): Record<string, AgyConversationScopeOverride> {
    const settings = this.plugin.settings as typeof this.plugin.settings & {
      agyConversationScopeOverrides?: Record<string, AgyConversationScopeOverride>;
    };
    if (
      !settings.agyConversationScopeOverrides ||
      typeof settings.agyConversationScopeOverrides !== "object"
    ) {
      settings.agyConversationScopeOverrides = {};
    }
    return settings.agyConversationScopeOverrides;
  }

  private getAgyConversationScopeOverride(
    conversationId: string
  ): AgyConversationScopeOverride | undefined {
    const id = conversationId.trim();
    if (!id) return undefined;
    const key = this.normalizeAgySessionTitleKey(id);
    const overrides = this.getAgyConversationScopeOverrides();
    const value = overrides[key] || overrides[id];
    return value === "current" || value === "unassigned" ? value : undefined;
  }

  private setAgyConversationScopeOverride(
    conversationId: string,
    scope: AgyConversationScopeOverride | null
  ): boolean {
    const id = conversationId.trim();
    if (!id) return false;
    const key = this.normalizeAgySessionTitleKey(id);
    const overrides = this.getAgyConversationScopeOverrides();
    let changed = false;
    for (const savedId of Object.keys(overrides)) {
      if (this.normalizeAgySessionTitleKey(savedId) !== key) continue;
      if (scope && savedId === key && overrides[savedId] === scope) continue;
      delete overrides[savedId];
      changed = true;
    }
    if (scope && overrides[key] !== scope) {
      overrides[key] = scope;
      changed = true;
    }
    if (changed) this.invalidateAgyHistoryCache();
    return changed;
  }

  private getAgyConversationIndexEntry(conversationId: string): AgyConversationIndexEntry | undefined {
    const id = conversationId.trim();
    if (!id) return undefined;
    const entries = this.getAgyConversationIndex();
    const key = this.normalizeAgySessionTitleKey(id);
    return entries[key] || entries[id];
  }

  private isAgyConversationTrackedInCurrentVault(
    conversationId: string,
    knownSummary?: AgyConversationSummary
  ): boolean {
    const workspacePath = this.getCurrentAgyWorkspacePath();
    const scopeOverride = this.getAgyConversationScopeOverride(conversationId);
    const summary = knownSummary || AgyAgentClient.getConversationSummary(conversationId);

    // An explicit AGY workspace remains authoritative for safety. A local
    // override can classify unscoped sessions, but cannot import a session
    // that AGY explicitly says belongs to another vault.
    if (
      summary &&
      summary.workspaceUris.length > 0 &&
      !AgyAgentClient.belongsToWorkspace(summary, workspacePath)
    ) {
      return false;
    }
    if (scopeOverride === "unassigned") return false;
    if (scopeOverride === "current") return !!workspacePath;

    const entry = this.getAgyConversationIndexEntry(conversationId);
    if (
      !workspacePath ||
      !entry ||
      AgyAgentClient.normalizeWorkspacePath(entry.workspacePath) !== workspacePath
    ) {
      return false;
    }

    // The local index is only a Pimate hint. AGY's own workspace metadata is
    // authoritative whenever it is available; this prevents a stale resume
    // record from reassigning a conversation created in another Vault.
    return !summary ||
      summary.workspaceUris.length === 0 ||
      AgyAgentClient.belongsToWorkspace(summary, workspacePath);
  }

  private invalidateAgyHistoryCache(): void {
    this.agyHistoryCache = null;
  }

  private upsertAgyConversationIndex(
    conversationId: string,
    source: AgyConversationIndexEntry["source"],
    details: {
      title?: string;
      preview?: string;
      clearTitle?: boolean;
      internal?: boolean;
    } = {},
    knownSummary?: AgyConversationSummary
  ): boolean {
    const id = conversationId.trim();
    const workspacePath = this.getCurrentAgyWorkspacePath();
    if (!id || !workspacePath) return false;

    const summary = knownSummary || AgyAgentClient.getConversationSummary(id);
    if (
      summary &&
      summary.workspaceUris.length > 0 &&
      !AgyAgentClient.belongsToWorkspace(summary, workspacePath)
    ) {
      console.warn(
        `[pimate] Refusing to bind AGY conversation ${id} from another workspace.`
      );
      return false;
    }

    const entries = this.getAgyConversationIndex();
    const key = this.normalizeAgySessionTitleKey(id);
    const existing = entries[key] || entries[id];
    const now = Date.now();
    const next: AgyConversationIndexEntry = {
      ...existing,
      conversationId: id,
      workspacePath,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      // Do not downgrade a session Pimate already owns to a weaker discovery
      // signal merely because AGY metadata happens to be inspected later.
      source:
        existing?.internal || existing?.source === "title"
          ? "title"
          : existing?.source === "pimate" || existing?.source === "resumed"
          ? existing.source
          : source,
    };
    if (existing?.internal || details.internal || source === "title") {
      next.internal = true;
    }
    if (details.clearTitle) {
      delete next.title;
    } else if (details.title?.trim()) {
      next.title = details.title.trim();
    }
    if (details.preview?.trim()) next.preview = details.preview.trim();

    const previous = existing ? JSON.stringify(existing) : "";
    const updated = JSON.stringify(next);
    if (previous === updated) return false;
    entries[key] = next;
    if (key !== id) delete entries[id];
    this.invalidateAgyHistoryCache();
    return true;
  }

  private async recordAgyConversationAfterAcceptedPrompt(
    tab: ChatTab,
    seed: string
  ): Promise<void> {
    if (tab.engine !== "antigravity") return;
    const conversationId = this.getAgyConversationId(tab);
    if (!conversationId) return;

    tab.sessionId = conversationId;
    const changed = this.upsertAgyConversationIndex(conversationId, "pimate", {
      title: this.getAgySessionTitle(conversationId),
      preview: seed,
    });
    const pendingTitle = this.pendingAutoTitles.get(tab.id);
    if (pendingTitle) {
      await this.persistAutoSessionTitle(tab, pendingTitle);
      return;
    }
    if (changed) await this.plugin.saveSettings();
  }

  private async recordAgyConversationResume(
    conversationId: string,
    preview?: string
  ): Promise<void> {
    const changed = this.upsertAgyConversationIndex(conversationId, "resumed", {
      title: this.getAgySessionTitle(conversationId),
      preview,
    });
    if (changed) await this.plugin.saveSettings();
  }

  private fallbackSessionTitle(seed: string): string {
    const compact = seed
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const firstLine = compact.split(/\r?\n/, 1)[0] || compact;
    const title = Array.from(firstLine).slice(0, 18).join("").trim();
    if (title) return title;
    return this.plugin.settings.language === "en" ? "Conversation" : "对话";
  }

  private getAgySessionTitle(conversationId: string): string | undefined {
    const id = conversationId.trim();
    if (!id) return undefined;
    const titles = this.plugin.settings.agySessionTitles || {};
    const key = this.normalizeAgySessionTitleKey(id);
    const exact = titles[key] || titles[id];
    return exact?.trim() || this.getAgyConversationIndexEntry(id)?.title?.trim() || undefined;
  }

  private hasAgySessionTitle(conversationId: string): boolean {
    return !!this.getAgySessionTitle(conversationId);
  }

  private deleteAgySessionTitle(conversationId: string): boolean {
    const titles = this.plugin.settings.agySessionTitles;
    if (!titles) return false;
    const id = conversationId.trim();
    if (!id) return false;
    const key = this.normalizeAgySessionTitleKey(id);
    let deleted = false;
    for (const savedId of Object.keys(titles)) {
      if (this.normalizeAgySessionTitleKey(savedId) === key) {
        delete titles[savedId];
        deleted = true;
      }
    }
    return deleted;
  }

  private getAgyConversationId(tab: ChatTab): string {
    const savedId = tab.sessionId?.trim();
    if (savedId) return savedId;
    if (tab.client?.engine === "antigravity") {
      return (tab.client as AgyAgentClient).getConversationId()?.trim() || "";
    }
    return "";
  }

  private getSessionTitle(sessionPath: string): string | undefined {
    const titles = this.plugin.settings.sessionTitles;
    if (!titles) return undefined;
    const key = this.normalizeSessionTitleKey(sessionPath);
    const exact = titles[key] || titles[sessionPath];
    if (exact?.trim()) return exact;
    for (const [savedPath, title] of Object.entries(titles)) {
      if (this.normalizeSessionTitleKey(savedPath) === key && title?.trim()) return title;
    }
    return undefined;
  }

  private hasSessionTitle(sessionPath: string): boolean {
    return !!this.getSessionTitle(sessionPath);
  }

  private deleteSessionTitle(sessionPath: string): boolean {
    const titles = this.plugin.settings.sessionTitles;
    if (!titles) return false;
    const key = this.normalizeSessionTitleKey(sessionPath);
    let deleted = false;
    for (const savedPath of Object.keys(titles)) {
      if (this.normalizeSessionTitleKey(savedPath) === key) {
        delete titles[savedPath];
        deleted = true;
      }
    }
    return deleted;
  }

  private maybeTitleActiveTab(seed: string): void {
    if (this.plugin.settings.autoNameSessions === false) return;
    const tab = this.activeTab;
    if (!tab || this.titleGenRequested.has(tab.id)) return;
    if (tab.engine === "antigravity") {
      const conversationId = this.getAgyConversationId(tab);
      if (conversationId && this.hasAgySessionTitle(conversationId)) return;
    } else if (tab.sessionFile && this.hasSessionTitle(tab.sessionFile)) {
      return;
    }
    const cleanedSeed = seed
      .replace(/@\S+/g, "")
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleanedSeed) return;
    this.titleGenRequested.add(tab.id);
    void this.generateTitleWithLLM(cleanedSeed, tab);
  }

  private async generateTitleWithLLM(seed: string, tab: ChatTab): Promise<void> {
    const settings = this.plugin.settings;
    if (tab.engine === "antigravity") {
      // AGY does not expose a no-session metadata request. Reuse one hidden
      // conversation per vault instead of creating one native record per
      // title. The queue is important because AGY cannot safely accept two
      // independent print-mode clients writing the same conversation.
      const queued = this.agyTitleGenerationTail.then(
        () => this.generateAgyTitleWithFixedSession(seed, tab),
        () => this.generateAgyTitleWithFixedSession(seed, tab)
      );
      this.agyTitleGenerationTail = queued.then(
        () => undefined,
        () => undefined
      );
      await queued;
      return;
    }

    const provider = tab.modelProvider || settings.provider || "";
    const modelId = tab.modelId || settings.modelId || "";
    if (!provider || !modelId) {
      await this.persistAutoSessionTitle(tab, this.fallbackSessionTitle(seed));
      return;
    }

    const oneOff = new PiAgentClient({
      piPath: settings.piPath,
      provider,
      modelId,
      thinkingLevel: tab.thinkingLevel || settings.thinkingLevel,
      apiKey: this.readProviderApiKey(provider) || settings.apiKey,
      // Pi supports noSession, so this metadata-only request never becomes a
      // visible Pi or AGY conversation.
      noSession: true,
    });

    try {
      await oneOff.start();
      const prompt = this.buildTitlePrompt(seed);
      const title = await this.raceTitleFetch(oneOff, prompt, 15_000);
      const cleaned = this.cleanTitleOutput(title);
      await this.persistAutoSessionTitle(tab, cleaned || this.fallbackSessionTitle(seed));
    } catch (err) {
      console.warn("[pi-agent] auto title generation failed:", err);
      await this.persistAutoSessionTitle(tab, this.fallbackSessionTitle(seed));
    } finally {
      await oneOff.destroy().catch(() => undefined);
    }
  }

  private async generateAgyTitleWithFixedSession(
    seed: string,
    tab: ChatTab
  ): Promise<void> {
    const settings = this.plugin.settings;
    const workspacePath = this.getCurrentAgyWorkspacePath();
    if (!workspacePath) {
      await this.persistAutoSessionTitle(tab, this.fallbackSessionTitle(seed));
      return;
    }

    let conversationId = settings.agyTitleConversationId?.trim() || "";
    let turns = Number(settings.agyTitleConversationTurns);
    if (!Number.isFinite(turns) || turns < 0) turns = 0;

    // Rotate occasionally so the helper's own old prompts do not become a
    // large hidden context that makes later titles less precise or slower.
    if (
      conversationId &&
      (turns >= AGY_TITLE_SESSION_MAX_TURNS ||
        !AgyAgentClient.conversationExists(conversationId))
    ) {
      conversationId = "";
      turns = 0;
      settings.agyTitleConversationId = "";
      settings.agyTitleConversationTurns = 0;
    }

    const titleClient = new AgyAgentClient({
      agyPath: settings.agyPath,
      modelId: tab.modelId || settings.agyModel || "gemini-3.8-flash-high",
      effort: tab.thinkingLevel || settings.agyEffort || "high",
      cwd: workspacePath,
      workspacePath,
      conversationId: conversationId || undefined,
      // A title request must not run tools, even if a model interprets the
      // surrounding conversation as an implementation task.
      dangerouslySkipPermissions: false,
      // Do not charge the internal title helper into Pimate's usage journal.
      trackUsage: false,
    });

    try {
      await titleClient.start();
      const actualConversationId = titleClient.getConversationId()?.trim();
      if (!actualConversationId) {
        throw new Error("AGY did not return a title conversation id");
      }

      const sameConversation =
        conversationId.toLowerCase() === actualConversationId.toLowerCase();
      settings.agyTitleConversationId = actualConversationId;
      settings.agyTitleConversationTurns = sameConversation ? turns : 0;

      const existing = this.getAgyConversationIndexEntry(actualConversationId);
      const indexChanged = existing?.internal
        ? false
        : this.upsertAgyConversationIndex(actualConversationId, "title", {
            internal: true,
            preview: "Pimate internal auto-title session",
          });
      if (!sameConversation || indexChanged) {
        await this.plugin.saveSettings();
      }

      const title = await this.raceTitleFetch(
        titleClient,
        this.buildTitlePrompt(seed),
        15_000
      );
      const cleaned = this.cleanTitleOutput(title);
      settings.agyTitleConversationTurns += 1;
      await this.plugin.saveSettings();
      await this.persistAutoSessionTitle(
        tab,
        cleaned || this.fallbackSessionTitle(seed)
      );
    } catch (err) {
      console.warn("[pimate] AGY auto title generation failed:", err);
      await this.persistAutoSessionTitle(tab, this.fallbackSessionTitle(seed));
    } finally {
      await titleClient.destroy().catch(() => undefined);
    }
  }

  private async persistAutoSessionTitle(tab: ChatTab, title: string): Promise<void> {
    if (tab.engine === "antigravity") {
      const conversationId = this.getAgyConversationId(tab);
      if (!conversationId || !this.isAgyConversationTrackedInCurrentVault(conversationId)) {
        this.pendingAutoTitles.set(tab.id, title);
        tab.label = title;
        this.renderTabs();
        await this.persistSessionTabs();
        return;
      }

      tab.sessionId = conversationId;
      const existing = this.getAgySessionTitle(conversationId);
      if (!existing) {
        if (!this.plugin.settings.agySessionTitles) this.plugin.settings.agySessionTitles = {};
        this.plugin.settings.agySessionTitles[
          this.normalizeAgySessionTitleKey(conversationId)
        ] = title;
      }
      this.upsertAgyConversationIndex(conversationId, "pimate", {
        title: existing || title,
      });
      this.pendingAutoTitles.delete(tab.id);
      tab.label = existing || title;
      this.renderTabs();
      await this.persistSessionTabs();
      return;
    }

    if (!tab.sessionFile) {
      this.pendingAutoTitles.set(tab.id, title);
      return;
    }
    if (this.hasSessionTitle(tab.sessionFile)) return;
    if (!this.plugin.settings.sessionTitles) this.plugin.settings.sessionTitles = {};
    this.plugin.settings.sessionTitles[this.normalizeSessionTitleKey(tab.sessionFile)] = title;
    await this.plugin.saveSettings();
  }

  private async raceTitleFetch(
    client: AgentClient,
    prompt: string,
    timeoutMs: number
  ): Promise<string> {
    let timer: number | null = null;
    try {
      return await new Promise<string>((resolve, reject) => {
        timer = window.setTimeout(() => {
          reject(new Error(`title gen timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        client
          .promptAndWait(prompt)
          .then((res) => {
            const text =
              ((res?.data as any)?.text as string | undefined) ??
              ((res?.data as any) as string | undefined) ??
              "";
            resolve(typeof text === "string" ? text : "");
          })
          .catch(reject);
      });
    } finally {
      if (timer !== null) window.clearTimeout(timer);
    }
  }

  private buildTitlePrompt(seed: string): string {
    const isZh = this.plugin.settings.language !== "en";
    const snippet = seed.slice(0, 500);
    return isZh
      ? [
          "你是一个会话标题生成器。",
          "这是一个可复用的内部命名会话；本次请求与之前的命名请求完全独立。只处理本次提供的用户首条消息，不要引用或延续之前的内容。",
          "",
          "用户输入是一条对话的首条消息，请输出 4-12 个字的简洁标题。",
          "",
          "要求：",
          "- 仅输出一行",
          "- 无引号、无前缀、无解释、无 emoji",
          "- 用用户原文的语言",
          '- 若无可概括内容，输出"对话"',
          "",
          `用户首条消息:<<<`,
          snippet,
          `>>>`,
        ].join("\n")
      : [
          "You are a session title generator.",
          "This is a reusable internal title session. Treat this request as fully independent from earlier title requests; use only the first user message provided below.",
          "",
          "Given the user's first message of a conversation, output a concise 3-8 word title.",
          "",
          "Requirements:",
          "- Output exactly one line",
          "- No quotes, no prefix, no explanation, no emoji",
          "- Match the user's original language",
          '- If there is nothing to summarize, output "Conversation"',
          "",
          `First user message: <<<`,
          snippet,
          `>>>`,
        ].join("\n");
  }

  private cleanTitleOutput(raw: string): string {
    return raw
      .replace(/^[\s"'“”‘’「」『』]+|[\s"'“”‘’「」『』]+$/g, "")
      .replace(/\n[\s\S]*/, "")
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
      .trim()
      .slice(0, 30);
  }

  private abortAgent(): void {
    const tab = this.activeTab;
    const client = tab?.client;
    const isZh = this.plugin.settings.language !== "en";
    if (!tab || !client || !tab.isStreaming || this.abortInFlight || this.hardSteerInFlight) {
      return;
    }

    this.abortInFlight = true;
    tab.smartReviewContinues = 0;
    tab.smartReviewOriginalGoal = null;
    this.setStatus(isZh ? "⏹ 正在停止…" : "⏹ Stopping…", "warning");
    this.updateButtons();

    this.runAsync(async () => {
      const queuedBeforeAbort = [...this.pendingQueuedMessages];
      try {
        const response = await client.abort();
        if (!response.success) {
          throw new Error(response.error || "Pi did not stop the current response");
        }
        if (client.engine === "antigravity") {
          // Agy abort() deliberately drops prompts that were still queued in
          // the adapter. Remove their optimistic bubbles instead of leaving
          // them in the transcript as if they had been sent.
          this.discardQueuedMessageBubbles(queuedBeforeAbort);
          if (client.isRunning()) {
            this.setStatus(isZh ? "✅ 已停止，连接保留" : "✅ Stopped; session kept", "ok");
          } else {
            this.setStatus(
              isZh ? "⏸ 已停止，下次发送时重连" : "⏸ Stopped; reconnects on next message",
              "warning"
            );
          }
        }
      } catch (err) {
        new Notice(`❌ ${isZh ? "停止失败：" : "Could not stop: "}${(err as Error).message}`);
      } finally {
        this.abortInFlight = false;
        this.updateButtons();
      }
    });
  }

  private async newSession(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    const operationSeq = this.tabSwitchSeq;

    const previousClient = tab.client;
    if (previousClient) {
      await previousClient.destroy().catch(() => undefined);
    }

    // 清空当前 Tab 绑定的会话参数
    tab.sessionFile = undefined;
    tab.sessionId = undefined;
    tab.restored = false;
    tab.requiresBranchHistoryRpc = false;
    tab.draft = "";
    tab.contextItems = [];
    tab.pendingUserImages = [];
    tab.smartReviewContinues = 0;
    tab.smartReviewOriginalGoal = null;
    tab.client = null;
    tab.isStreaming = false;

    // 清除聊天框 DOM 状态
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];
    this.pendingQueuedMessages = [];
    this.activeBranchHistory = null;
    if (this.inputEl) {
      this.inputEl.value = "";
      this.resizeInputEl();
    }
    this.contextItems = [];
    this.renderContextItems();
    this.renderEmptyState();
    this.updateWidget("tasks", undefined);

    // 重新实例化并同步空白客户端
    await this.ensureTabClient(tab);
    if (this.activeTab !== tab || this.tabSwitchSeq !== operationSeq) {
      await this.persistSessionTabs();
      return;
    }
    this.client = tab.client;
    await this.refreshStateDisplay();
    await this.loadAvailableCommands();
    this.updateButtons();
    await this.persistSessionTabs();

    const isZh = this.plugin.settings.language === "zh";
    new Notice(isZh ? "已重置并开启新会话" : "Session reset and new chat started");
  }

  private parsePimateBuiltinCommand(
    rawMessage: string
  ): { name: string; args: string } | null {
    const match = rawMessage.trim().match(/^\/([\w-]+)(?:\s+([\s\S]*))?$/);
    if (!match) return null;
    const name = match[1].toLowerCase();
    if (!PIMATE_BUILTIN_COMMANDS.some((command) => command.name === name)) {
      return null;
    }
    return { name, args: (match[2] || "").trim() };
  }

  /** Execute the Pimate-side half of the unified slash-command catalog. */
  private async executePimateBuiltinCommand(
    name: string,
    args: string
  ): Promise<void> {
    const isZh = this.plugin.settings.language !== "en";
    switch (name) {
      case "compact":
        if (this.isStreaming) {
          new Notice(isZh ? "请先等待当前回复结束或停止，再压缩上下文" : "Wait for the current response to finish or stop it before compacting");
          return;
        }
        await this.compactSession(args || undefined);
        return;
      case "model":
        if (args) {
          new Notice(isZh ? "请在弹出的列表中选择模型" : "Choose a model from the selector");
        }
        await this.showModelSelector();
        return;
      case "fork":
        await this.showForkSelector();
        return;
      case "tree":
        this.showForkHistoryModal();
        return;
      case "reload":
        await this.reloadExtensions();
        return;
      case "export":
        if (args.toLowerCase() === "html") {
          await this.exportSessionHtml();
        } else {
          await this.exportSessionToVaultNote();
        }
        return;
      case "new":
        await this.newSession();
        return;
      case "clone":
        await this.cloneCurrentBranch();
        return;
      case "stats":
        await this.showStats();
        return;
    }
  }

  private async compactSession(customInstructions?: string): Promise<void> {
    const tab = this.activeTab;
    const client = tab?.client;
    if (!tab || !client) return;
    const isZh = this.plugin.settings.language === "zh";
    if (tab.reloadInFlight) {
      new Notice(isZh ? "Pi 正在重新加载资源，请稍候" : "Pi resources are reloading");
      return;
    }
    tab.isCompacting = true;
    // 保险：60 秒后还在 thinking 就强制重置（防止事件丢失导致水印死转）
    const safetyTimer = window.setTimeout(() => {
      this.setStatus("⚠️ Compaction stuck (no event)", "warning");
    }, 60_000);
    try {
      const result = await client.compact(customInstructions?.trim() || undefined);
      // 响应回来后强制重置状态，不管 compaction_end 事件是否被正确处理
      window.clearTimeout(safetyTimer);
      this.setStatus("✅ Ready", "ok");
      if (result.success) {
        this.compactedContextActive = true;
        const summary = (result.data as any)?.summary || "";
        this.addCompactionSummaryMessage(summary, (result.data as any)?.tokensBefore);
        new Notice(isZh ? "上下文已压缩；可见对话已保留" : "Context compacted; visible chat preserved");
      } else {
        new Notice(isZh ? "上下文压缩失败" : "Compaction failed");
      }
    } catch (err) {
      window.clearTimeout(safetyTimer);
      this.setStatus("✅ Ready", "ok");
      new Notice(`Compaction failed: ${(err as Error).message}`);
    } finally {
      tab.isCompacting = false;
    }
  }

  private showUsageStats(): void {
    new UsageStatsModal(this.app, this.plugin.settings.language).open();
  }

  private async showStats(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.getSessionStats();
      if (result.success && result.data) {
        const data = result.data as any;
        const tokens = data.tokens || {};
        const usageKnown = data.usageKnown !== false;
        const info = [
          `Messages: ${data.totalMessages || 0}`,
          usageKnown
            ? `Tokens: ${tokens.total || 0} (in: ${tokens.input || 0}, out: ${tokens.output || 0}, thinking: ${tokens.thinking || 0}, cache read: ${tokens.cacheRead || 0})`
            : "Tokens: unavailable until AGY completes a turn",
          data.costKnown === false
            ? "Cost: unavailable"
            : `Cost: $${(data.cost || 0).toFixed(4)}`,
        ];
        if (data.contextUsage?.percent != null) {
          info.push(
            `Context: ${data.contextUsage.percent}% (${data.contextUsage.tokens}/${data.contextUsage.contextWindow})`
          );
        }
        new Notice(info.join("\n"), 8000);
      }
    } catch (err) {
      new Notice(`Failed: ${(err as Error).message}`);
    }
  }

  private showForkHistoryModal(): void {
    const client = this.client;
    const scopeVersion = this.forkScopeVersion;
    if (!client) {
      new Notice("Pi Agent 客户端尚未就绪");
      return;
    }
    new SessionTreeModal(this.app, client, async (node) => {
      if (this.client !== client || this.forkScopeVersion !== scopeVersion) {
        new Notice("当前会话已切换，请重新选择历史节点");
        return false;
      }
      return this.forkFromEntry(node.entryId, node.text);
    }).open();
  }

  private async reloadExtensions(): Promise<void> {
    const tab = this.activeTab;
    const client = tab?.client;
    const isZh = this.plugin.settings.language !== "en";
    if (!tab || !client) {
      new Notice(isZh ? "Pi 进程未运行" : "Pi is not running");
      return;
    }
    if (tab.reloadInFlight) {
      new Notice(isZh ? "Pi 正在重新加载资源" : "Pi resources are already reloading");
      return;
    }
    if (
      tab.isStreaming ||
      tab.isCompacting ||
      this.hardSteerInFlight ||
      this.abortInFlight ||
      (tab.queueCount || 0) > 0
    ) {
      new Notice(
        isZh
          ? "请等待当前回复、压缩或排队消息处理完毕后再重载"
          : "Wait for the current response, compaction, and queued messages before reloading"
      );
      return;
    }

    tab.reloadInFlight = true;
    this.setStatus(isZh ? "🔄 正在重新加载 Pi 资源..." : "🔄 Reloading Pi resources...", "thinking");
    try {
      const stateResponse = await client.getState();
      if (tab.client !== client) throw new Error("The conversation changed while reloading");
      if (!stateResponse.success || !stateResponse.data) {
        throw new Error(
          stateResponse.error ||
            (isZh
              ? "无法确认 Pi 当前状态，请稍后重试"
              : "Could not verify Pi's current state; try again shortly")
        );
      }
      const state = stateResponse.data;
      if (
        state?.isStreaming ||
        state?.isCompacting ||
        (state?.pendingMessageCount || 0) > 0
      ) {
        throw new Error(
          isZh ? "Pi 当前不空闲，请稍后重试" : "Pi is not idle; try again shortly"
        );
      }
      if (state) this.applyAuthoritativePiState(tab, state);

      let reloadedInProcess = false;
      let fallbackToRestart = !this.plugin.piReloadBridgePath;
      let bridgeError = "Pimate reload bridge is unavailable";
      const bridgePath = this.plugin.piReloadBridgePath;
      if (bridgePath) {
        const result = await client.reloadExtensionsViaBridge(bridgePath);
        reloadedInProcess = result.success;
        fallbackToRestart = result.fallbackToRestart === true;
        bridgeError = result.error || bridgeError;
      }

      if (!reloadedInProcess) {
        if (!fallbackToRestart) throw new Error(bridgeError);
        console.warn(`[pimate] In-process reload unavailable: ${bridgeError}`);
        await this.restartTabClient(tab, client, {
          clearQueuedState: false,
          missingSessionError: isZh
            ? `热重载失败（${bridgeError}），且当前会话尚无可恢复的 session file；为防止丢失内容，未重启 Pi`
            : `Hot reload failed (${bridgeError}), and this conversation has no resumable session file; Pi was not restarted`,
          restartError: isZh
            ? "重启 Pi 后未能恢复当前会话"
            : "Could not restore the current session after restarting Pi",
        });
      }

      if (reloadedInProcess && tab.client !== client) {
        throw new Error("The conversation changed while reloading");
      }
      if (this.activeTab === tab) {
        this.client = tab.client;
        this.commandCatalogClient = null;
        this.commandLoadClient = null;
        await this.syncTabStateFromPi(tab);
        await this.loadAvailableCommands();
        this.renderActiveTabModelAndEffort();
        this.renderActiveTabRuntimeStatus();
      }
      await this.persistSessionTabs();

      new Notice(
        reloadedInProcess
          ? (isZh
              ? "✅ 已重新加载 Pi 扩展、技能、提示词及相关资源"
              : "✅ Reloaded Pi extensions, skills, prompts, and related resources")
          : (isZh
              ? "✅ 已重启 Pi 并恢复当前会话，资源已重新加载"
              : "✅ Restarted Pi, restored this session, and reloaded resources")
      );
    } catch (err) {
      const message = (err as Error).message;
      new Notice(`${isZh ? "重载扩展失败" : "Could not reload Pi resources"}: ${message}`);
      if (this.activeTab === tab) this.setStatus(`❌ ${message}`, "error");
    } finally {
      tab.reloadInFlight = false;
      if (this.activeTab === tab && tab.client?.isRunning()) {
        this.renderActiveTabRuntimeStatus();
      }
      this.updateButtons();
    }
  }

  private async exportSessionToVaultNote(): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.getMessages();
      if (!res.success || !res.data) {
        new Notice("无法获取当前会话消息记录");
        return;
      }
      const rawMessages = ((res.data as any).messages || []) as any[];
      if (rawMessages.length === 0) {
        new Notice("当前会话暂无可导出的消息");
        return;
      }

      const now = new Date();
      const dateStr = now.toISOString().slice(0, 10);
      const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, "-");
      const fileName = `Pimate Export ${dateStr} ${timeStr}.md`;

      let mdContent = `# Pimate 对话记录 — ${dateStr}\n\n`;
      mdContent += `> 导出时间: ${now.toLocaleString()}\n\n---\n\n`;

      for (const msg of rawMessages) {
        const roleStr = msg.role === "user" ? "👤 User" : msg.role === "assistant" ? "🤖 Pi Agent" : msg.role;
        mdContent += `### ${roleStr}\n\n`;
        if (typeof msg.content === "string") {
          mdContent += `${msg.content}\n\n`;
        } else if (Array.isArray(msg.content)) {
          for (const item of msg.content) {
            if (item.type === "text" && item.text) {
              mdContent += `${item.text}\n\n`;
            } else if (item.type === "thinking" && item.thinking) {
              mdContent += `> [!note] 思考过程\n> ${item.thinking.replace(/\n/g, "\n> ")}\n\n`;
            } else if (item.type === "tool_call") {
              mdContent += `> [!info] 工具调用: \`${item.name}\`\n\n`;
            }
          }
        }
        mdContent += `---\n\n`;
      }

      const createdFile = await this.app.vault.create(fileName, mdContent);
      const leaf = this.app.workspace.getLeaf(true);
      await leaf.openFile(createdFile);
      new Notice(`已导出笔记: ${fileName}`);
    } catch (err) {
      new Notice(`导出笔记失败: ${(err as Error).message}`);
    }
  }

  private async exportSessionHtml(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.exportHtml();
      if (!result.success) {
        new Notice(result.error || "Export failed");
        return;
      }
      new Notice(`Exported: ${((result.data as any)?.path || "HTML file")}`);
    } catch (err) {
      new Notice(`Export failed: ${(err as Error).message}`);
    }
  }

  private async showResumeSelector(): Promise<void> {
    try {
      const isAgy = this.activeTab?.engine === "antigravity";
      const sessions = await this.listResumeSessionsForActiveEngine();
      if (sessions.length === 0) {
        new Notice("No previous sessions found");
        return;
      }
      new ResumeSessionSuggestModal(this.app, sessions, async (session) => {
        if (isAgy) {
          await this.openResumeSession(session);
          return;
        }
        new ResumeActionModal(this.app, session, async (action) => {
          if (action === "open") await this.openResumeSession(session);
          if (action === "delete") await this.deleteResumeSession(session);
        }).open();
      }, isAgy ? "Resume which Antigravity conversation?" : "Resume which Pi session?").open();
    } catch (err) {
      new Notice(`Resume failed: ${(err as Error).message}`);
    }
  }

  private async listAgyHistoryBuckets(): Promise<AgyHistoryBuckets> {
    const workspacePath = this.getCurrentAgyWorkspacePath();
    const empty: AgyHistoryBuckets = { current: [], unassigned: [], all: [] };
    if (!workspacePath) return empty;

    const cached = this.agyHistoryCache;
    if (
      cached &&
      cached.workspacePath === workspacePath &&
      Date.now() - cached.createdAt < AGY_HISTORY_LIST_CACHE_MS
    ) {
      return cached.buckets;
    }

    const [usageSnapshots] = await Promise.all([
      AgyUsageStore.readAll(),
    ]);
    // AGY's metadata cache is global. Do the one synchronous scan once, then
    // classify it against Pimate's vault-owned index and usage journal.
    const summaries = AgyAgentClient.listConversations();
    const indexedEntries = Object.values(this.getAgyConversationIndex());
    const currentWorkspace = indexedEntries.filter(
      (entry) =>
        !!entry &&
        AgyAgentClient.normalizeWorkspacePath(entry.workspacePath) === workspacePath
    );
    const summaryById = new Map(
      summaries.map((summary) => [this.normalizeAgySessionTitleKey(summary.conversationId), summary])
    );
    // AGY may create the transcript immediately but update its global
    // conversation_metadata.json only later (or after the process exits). A
    // Pimate-owned index entry is enough to show that just-created session in
    // this Vault while AGY's cache catches up. The actual backing file check
    // prevents stale local index entries from becoming ghost history items.
    for (const entry of currentWorkspace) {
      if (!entry) continue;
      const id = entry.conversationId?.trim();
      if (!id) continue;
      const key = this.normalizeAgySessionTitleKey(id);
      if (summaryById.has(key) || !AgyAgentClient.conversationExists(id)) continue;
      const synthetic: AgyConversationSummary = {
        conversationId: id,
        title: entry.title?.trim() || "",
        preview: entry.preview?.trim() || "",
        mtime: Math.max(entry.updatedAt || 0, entry.createdAt || 0),
        stepCount: 1,
        workspaceUris: [],
      };
      summaries.push(synthetic);
      summaryById.set(key, synthetic);
    }
    const isExplicitlyForeign = (summary: AgyConversationSummary | undefined): boolean =>
      !!summary &&
      summary.workspaceUris.length > 0 &&
      !AgyAgentClient.belongsToWorkspace(summary, workspacePath);
    const currentIds = new Set<string>();
    let indexChanged = false;

    for (const entry of indexedEntries) {
      const id = entry?.conversationId?.trim();
      if (!id) continue;
      if (AgyAgentClient.normalizeWorkspacePath(entry.workspacePath) !== workspacePath) continue;
      const key = this.normalizeAgySessionTitleKey(id);
      if (this.getAgyConversationScopeOverride(id) === "unassigned") continue;
      const summary = summaryById.get(key);
      if (summary && !isExplicitlyForeign(summary)) currentIds.add(key);
    }

    // Migrate conversations that Pimate's existing usage journal can prove
    // were run from this vault. This recovers pre-index AGY sessions without
    // guessing about every global, unscoped AGY record.
    for (const snapshot of usageSnapshots) {
      const key = this.normalizeAgySessionTitleKey(snapshot.conversationId);
      const summary = summaryById.get(key);
      if (
        AgyAgentClient.normalizeWorkspacePath(snapshot.cwd) !== workspacePath ||
        !summary ||
        isExplicitlyForeign(summary)
      ) {
        continue;
      }
      if (this.getAgyConversationScopeOverride(snapshot.conversationId) === "unassigned") {
        continue;
      }
      currentIds.add(key);
      if (!this.isAgyConversationTrackedInCurrentVault(snapshot.conversationId, summary)) {
        indexChanged = this.upsertAgyConversationIndex(
          snapshot.conversationId,
          "usage",
          {},
          summary
        ) || indexChanged;
      }
    }

    for (const summary of summaries) {
      const key = this.normalizeAgySessionTitleKey(summary.conversationId);
      const scopeOverride = this.getAgyConversationScopeOverride(summary.conversationId);
      if (scopeOverride === "unassigned") continue;
      if (scopeOverride === "current") {
        if (isExplicitlyForeign(summary)) continue;
        currentIds.add(key);
        continue;
      }
      if (!AgyAgentClient.belongsToWorkspace(summary, workspacePath)) continue;
      currentIds.add(key);
      if (!this.isAgyConversationTrackedInCurrentVault(summary.conversationId, summary)) {
        indexChanged = this.upsertAgyConversationIndex(
          summary.conversationId,
          "provider",
          {},
          summary
        ) || indexChanged;
      }
    }

    const toItem = (
      summary: ReturnType<typeof AgyAgentClient.listConversations>[number],
      agyHistoryScope: ResumeSessionItem["agyHistoryScope"]
    ): ResumeSessionItem => {
      const indexed = this.getAgyConversationIndexEntry(summary.conversationId);
      const useIndexedMetadata =
        agyHistoryScope !== "other" &&
        !!indexed &&
        AgyAgentClient.normalizeWorkspacePath(indexed.workspacePath) === workspacePath;
      const customTitle = useIndexedMetadata
        ? this.getAgySessionTitle(summary.conversationId)
        : undefined;
      return {
        path: "",
        label:
          customTitle ||
          (useIndexedMetadata ? indexed?.title : undefined) ||
          summary.title ||
          (summary.preview
            ? summary.preview.slice(0, 24)
            : summary.conversationId.slice(0, 12)),
        mtime: Math.max(summary.mtime, useIndexedMetadata ? indexed?.updatedAt || 0 : 0),
        preview: useIndexedMetadata ? indexed?.preview || summary.preview : summary.preview,
        engine: "antigravity",
        conversationId: summary.conversationId,
        agyHistoryScope,
      };
    };

    const current: ResumeSessionItem[] = [];
    const unassigned: ResumeSessionItem[] = [];
    const all: ResumeSessionItem[] = [];
    for (const summary of summaries) {
      const indexed = this.getAgyConversationIndexEntry(summary.conversationId);
      if (indexed?.internal || indexed?.source === "title") {
        // The reusable AGY title session is a real native conversation, but it
        // is implementation detail rather than user history.
        continue;
      }
      const key = this.normalizeAgySessionTitleKey(summary.conversationId);
      const scopeOverride = this.getAgyConversationScopeOverride(summary.conversationId);
      const scope: NonNullable<ResumeSessionItem["agyHistoryScope"]> =
        scopeOverride === "current"
          ? "current"
          : scopeOverride === "unassigned"
            ? "unassigned"
            : currentIds.has(key)
              ? "current"
              : summary.workspaceUris.length === 0
                ? "unassigned"
                : "other";
      const item = toItem(summary, scope);
      all.push(item);
      if (scope === "current") current.push(item);
      if (scope === "unassigned") unassigned.push(item);
    }

    const sortNewest = (items: ResumeSessionItem[]) =>
      items.sort((a, b) => b.mtime - a.mtime);
    const buckets: AgyHistoryBuckets = {
      current: sortNewest(current),
      unassigned: sortNewest(unassigned),
      all: sortNewest(all),
    };
    this.agyHistoryCache = {
      workspacePath,
      createdAt: Date.now(),
      buckets,
    };
    if (indexChanged) void this.plugin.saveSettings();
    return buckets;
  }

  private async listResumeSessionsForActiveEngine(): Promise<ResumeSessionItem[]> {
    if (this.activeTab?.engine === "antigravity") {
      return (await this.listAgyHistoryBuckets()).current;
    }

    const directory = this.getSessionDirectory();
    return directory ? this.listResumeSessions(directory) : [];
  }

  private async openResumeSession(session: ResumeSessionItem): Promise<void> {
    if (session.engine === "antigravity" || session.conversationId) {
      await this.openAgyResumeSession(session);
      return;
    }

    const active = this.activeTab;
    if (!active) return;

    const isZh = this.plugin.settings.language === "zh";

    const existing = this.tabs.find((tab) => tab.sessionFile?.toLowerCase() === session.path?.toLowerCase());
    if (existing) {
      await this.switchToTab(existing.id);
      return;
    }

    // If the session belongs to a different workspace (different CWD), we
    // cannot just hot-switch — the running Pi child process is pinned to the
    // current vault. Force a destroy + recreate so ensureTabClient picks up
    // the new session file on the next start.
    const crossWorkspace = !this.isSessionFileInCurrentWorkspace(session.path);
    if (crossWorkspace && active.client) {
      await active.client.destroy();
      active.client = null;
    }

    // 核心优化：若进程已运行，直接热切换 session 文件，避免拉起子进程的庞大开销，实现秒开
    if (active.client && active.client.isRunning()) {
      try {
        this.setStatus(isZh ? "正在载入历史会话..." : "Restoring session...", "thinking");
        const result = await active.client.switchSession(session.path);
        if (!result.success || (result.data as any)?.cancelled) {
          new Notice(isZh ? "切换历史会话失败" : "Failed to switch session");
          return;
        }
        active.sessionFile = session.path;
        active.sessionId = undefined;
        active.restored = true;

        await this.applyTabRuntimePreferences(active);

        await this.reloadAfterSessionRebind();
        this.setStatus("Ready", "ok");
        this.updateButtons();
        await this.persistSessionTabs();
        return;
      } catch (err) {
        new Notice(isZh ? `切换历史会话出错: ${(err as Error).message}` : `Switch error: ${(err as Error).message}`);
        // 异常则降级到传统的销毁重建流程
      }
    }

    if (active.client) {
      await active.client.destroy();
      active.client = null;
    }

    active.sessionFile = session.path;
    active.sessionId = undefined;
    active.restored = true;

    this.resetActiveRenderState();
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];

    await this.switchToTab(active.id);
  }

  private async openAgyResumeSession(session: ResumeSessionItem): Promise<void> {
    const active = this.activeTab;
    const conversationId = session.conversationId?.trim();
    const isZh = this.plugin.settings.language === "zh";
    if (!active || !conversationId) return;
    if (active.engine !== "antigravity") {
      new Notice(
        isZh
          ? "当前会话卡不是 AGY，无法载入 AGY 历史会话"
          : "The active tab is not using Antigravity, so this conversation cannot be loaded here"
      );
      return;
    }
    if (!AgyAgentClient.conversationExists(conversationId)) {
      new Notice(isZh ? "AGY 历史会话不存在或已被删除" : "Antigravity conversation was not found");
      return;
    }
    if (this.getAgyConversationWorkspaceStatus(conversationId) === "foreign") {
      new Notice(
        isZh
          ? "该 AGY 会话属于其他工作区，不能载入当前 Vault"
          : "This Antigravity conversation belongs to another workspace and cannot be loaded here"
      );
      return;
    }

    const existing = this.tabs.find(
      (tab) => tab.engine === "antigravity" && tab.sessionId === conversationId
    );
    if (existing) {
      await this.switchToTab(existing.id);
      return;
    }

    if (active.isStreaming) {
      new Notice(
        isZh
          ? "当前会话正在生成中，请先等待或停止"
          : "The current conversation is still generating; wait or stop it first"
      );
      return;
    }

    const client = active.client;
    if (client?.engine === "antigravity" && client.isRunning()) {
      try {
        this.setStatus(isZh ? "正在载入历史会话..." : "Restoring session...", "thinking");
        const result = await (client as AgyAgentClient).switchSession(conversationId);
        if (!result.success || (result.data as any)?.cancelled) {
          new Notice(
            isZh
              ? result.error || "切换历史会话失败"
              : result.error || "Failed to switch Antigravity conversation"
          );
          return;
        }

        active.sessionFile = undefined;
        active.sessionId = conversationId;
        active.restored = true;
        this.client = active.client;
        await this.applyTabRuntimePreferences(active);
        await this.recordAgyConversationResume(conversationId, session.preview);
        await this.reloadAfterSessionRebind();
        this.setStatus("Ready", "ok");
        this.updateButtons();
        await this.persistSessionTabs();
        return;
      } catch (err) {
        new Notice(
          isZh
            ? `切换历史会话出错: ${(err as Error).message}`
            : `Switch error: ${(err as Error).message}`
        );
        return;
      }
    }

    if (active.client) {
      await active.client.destroy().catch(() => undefined);
      active.client = null;
    }
    active.sessionFile = undefined;
    active.sessionId = conversationId;
    active.restored = true;
    this.resetActiveRenderState();
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];
    await this.switchToTab(active.id);
    const restoredClient = active.client as AgentClient | null;
    if (restoredClient?.isRunning()) {
      await this.recordAgyConversationResume(conversationId, session.preview);
    }
  }

  private async toggleModelPopup(anchorEl: HTMLElement): Promise<void> {
    if (this.modelPopupEl) {
      this.closeModelPopup();
      return;
    }
    this.closeEffortPopup();

    if (!this.client) return;
    const isZh = this.plugin.settings.language === "zh";

    const currentEngine = this.activeTab?.engine || this.plugin.settings.defaultEngine || "pi";
    const cache = this.getModelsCacheForEngine(currentEngine);

    // 1. 如果有缓存，立即瞬间弹出渲染，实现“零延迟秒开”！
    if (cache && cache.length > 0) {
      this.renderModelPopup(anchorEl, cache);
      // 同时在后台静默抓取最新模型列表并更新缓存
      this.client.getAvailableModels().then(result => {
        if (result.success && result.data) {
          const models = ((result.data as any).models || []) as PiModel[];
          if (models.length > 0) {
            this.setModelsCacheForEngine(currentEngine, models);
          }
        }
      }).catch(err => {
        console.warn("[pi-agent] Background model update failed:", err);
      });
      return;
    }

    // 2. 如果无缓存，先画一个 Loading 占位层，决不让界面卡死无响应
    const parent = anchorEl.parentElement;
    if (parent) {
      this.modelPopupEl = parent.createDiv({ cls: "pi-agent-model-popup" });
      const loadingEl = this.modelPopupEl.createDiv("pi-agent-model-popup-group-title");
      loadingEl.setText(isZh ? "正在加载模型列表..." : "Loading models...");
      
      // 注册关闭事件，使得即使在 Loading 期间，用户点击别处也能随时关闭它！
      this.modelOutsideClickHandler = (e: MouseEvent) => {
        if (this.modelPopupEl && !this.modelPopupEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
          this.closeModelPopup();
        }
      };
      window.setTimeout(() => {
        activeDocument.addEventListener("pointerdown", this.modelOutsideClickHandler!);
      }, 0);
    }

    try {
      const result = await this.client.getAvailableModels();
      if (!result.success || !result.data) {
        if (!cache) this.closeModelPopup();
        return;
      }

      const models = ((result.data as any).models || []) as PiModel[];
      if (models.length === 0) {
        new Notice(isZh ? "没有可用的模型" : "No models available");
        this.closeModelPopup();
        return;
      }

      this.setModelsCacheForEngine(currentEngine, models);
      // 关闭 Loading 骨架，渲染正式菜单
      this.closeModelPopup();
      this.renderModelPopup(anchorEl, models);
    } catch (err) {
      this.closeModelPopup();
      new Notice(isZh ? `获取模型失败: ${(err as Error).message}` : `Failed to load models: ${(err as Error).message}`);
    }
  }

  private closeModelPopup(): void {
    if (this.modelPopupEl) {
      this.modelPopupEl.remove();
      this.modelPopupEl = null;
    }
    if (this.modelOutsideClickHandler) {
      activeDocument.removeEventListener("pointerdown", this.modelOutsideClickHandler);
      this.modelOutsideClickHandler = null;
    }
  }

  private renderModelPopup(anchorEl: HTMLElement, models: PiModel[]): void {
    const parent = anchorEl.parentElement;
    if (!parent) return;

    const isZh = this.plugin.settings.language === "zh";

    this.modelPopupEl = parent.createDiv({ cls: "pi-agent-model-popup" });
    
    const groups = new Map<string, PiModel[]>();
    for (const model of models) {
      let groupName = model.provider.toUpperCase();
      if (groupName === "ANTHROPIC" || groupName === "CLAUDE") {
        groupName = "CLAUDE";
      }
      if (!groups.has(groupName)) {
        groups.set(groupName, []);
      }
      groups.get(groupName)!.push(model);
    }

    const isAgy = (this.activeTab?.engine || this.plugin.settings.defaultEngine) === "antigravity";
    const currentProvider = this.activeTab?.modelProvider || (isAgy ? "antigravity" : this.plugin.settings.provider) || "";
    const currentModelId = this.activeTab?.modelId || (isAgy ? (this.plugin.settings.agyModel || "gemini-3.8-flash-high") : this.plugin.settings.modelId) || "";

    for (const [groupName, groupModels] of groups.entries()) {
      const titleEl = this.modelPopupEl.createDiv("pi-agent-model-popup-group-title");
      titleEl.setText(groupName);

      for (const model of groupModels) {
        const isCurrent = currentModelId === model.id && (!currentProvider || currentProvider === model.provider);
        const itemEl = this.modelPopupEl.createDiv({
          cls: `pi-agent-model-popup-item ${isCurrent ? "is-active" : ""}`
        });

        const iconEl = itemEl.createDiv("pi-agent-model-popup-item-icon");
        setIcon(iconEl, this.getProviderIconName(model.provider, model.id));

        const shortName = model.name || this.getModelShortName(model.id);
        itemEl.createSpan({ text: shortName, cls: "pi-agent-model-popup-item-name" });

        itemEl.onclick = (e) => {
          e.stopPropagation();
          this.runAsync(async () => {
            await this.updateActiveTabModel(model.provider, model.id);
            new Notice(isZh ? `模型已切换为 ${shortName}` : `Model set to ${shortName}`);
            this.closeModelPopup();
          });
        };
      }
    }

    this.modelOutsideClickHandler = (e: MouseEvent) => {
      if (this.modelPopupEl && !this.modelPopupEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
        this.closeModelPopup();
      }
    };
    window.setTimeout(() => {
      activeDocument.addEventListener("pointerdown", this.modelOutsideClickHandler!);
    }, 0);
  }

  private async toggleEffortPopup(anchorEl: HTMLElement): Promise<void> {
    if (this.effortPopupEl) {
      this.closeEffortPopup();
      return;
    }
    this.closeModelPopup();

    // Pull latest Pi state so the popup renders against current model
    // metadata (reasoning / thinkingLevelMap) instead of stale local data.
    const tab = this.activeTab;
    if (tab?.client) {
      await this.syncTabStateFromPi(tab);
    }

    this.renderEffortPopup(anchorEl);
  }

  private closeEffortPopup(): void {
    if (this.effortPopupEl) {
      this.effortPopupEl.remove();
      this.effortPopupEl = null;
    }
    if (this.effortOutsideClickHandler) {
      activeDocument.removeEventListener("pointerdown", this.effortOutsideClickHandler);
      this.effortOutsideClickHandler = null;
    }
  }

  // ─── Thinking level options derivation ────────────────────────────────────
  //
  // Pi advertises per-model thinking-level availability via
  // `model.thinkingLevelMap`. We render the popup from that map's keys:
  //   - `reasoning !== true`  → no clickable options, informational row.
  //   - `thinkingLevelMap`    → only the keys Pi declared.
  //   - reasoning without map → safe fallback: show current Pi level as a
  //     read-only note (we do NOT invent a static list, because we have
  //     no authoritative source for what the model supports).

  private getStaticLevelDescription(
    id: string,
    isZh: boolean
  ): { name: string; desc: string } {
    const known: Record<string, { name: string; zh: string; en: string }> = {
      off: { name: "off", zh: "关闭", en: "Reasoning Off" },
      minimal: { name: "minimal", zh: "最低", en: "Minimal Reasoning" },
      low: { name: "low", zh: "较低", en: "Low Reasoning" },
      medium: { name: "medium", zh: "中等", en: "Medium Reasoning" },
      high: { name: "high", zh: "较高", en: "High Reasoning" },
      xhigh: { name: "xhigh", zh: "极高", en: "X-High Reasoning" },
      max: { name: "max", zh: "极限", en: "Max Reasoning" },
    };
    const entry = known[id];
    if (entry) return { name: entry.name, desc: isZh ? entry.zh : entry.en };
    return {
      name: id,
      desc: isZh ? "当前 Pi 模型声明的档位" : "Declared by current Pi model",
    };
  }

  private buildThinkingLevelOptions(tab: ChatTab | null | undefined): {
    options: { id: string; name: string; desc: string }[];
    note?: string;
  } {
    const isZh = this.plugin.settings.language === "zh";
    const meta = tab?.piModelMeta;

    if (!meta) {
      return {
        options: [],
        note: isZh
          ? "等待 Pi 返回当前模型能力"
          : "Awaiting Pi model capabilities",
      };
    }

    if (meta.reasoning !== true) {
      return {
        options: [],
        note: isZh
          ? "当前模型不支持可配置推理"
          : "Current model does not expose configurable reasoning",
      };
    }

    // Pi's thinkingLevelMap is an override/extension map, not a complete
    // availability list. Reasoning models support the base levels; map keys
    // add higher/provider-specific levels (e.g. xhigh/max) or remove a level
    // when explicitly mapped to null.
    const orderedKnownLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    const ids = new Set<string>(["off", "minimal", "low", "medium", "high"]);
    const map = meta.thinkingLevelMap;
    if (map && typeof map === "object" && !Array.isArray(map)) {
      for (const [id, mapped] of Object.entries(map as Record<string, unknown>)) {
        if (mapped === null) {
          ids.delete(id);
        } else {
          ids.add(id);
        }
      }
    }

    const ordered = [
      ...orderedKnownLevels.filter((id) => ids.has(id)),
      ...Array.from(ids).filter((id) => !orderedKnownLevels.includes(id)),
    ];

    return {
      options: ordered.map((id) => ({
        id,
        ...this.getStaticLevelDescription(id, isZh),
      })),
    };
  }

  private renderEffortPopup(anchorEl: HTMLElement): void {
    const parent = anchorEl.parentElement;
    if (!parent) return;

    const isZh = this.plugin.settings.language === "zh";
    const tab = this.activeTab;
    const { options, note } = this.buildThinkingLevelOptions(tab);

    this.effortPopupEl = parent.createDiv({ cls: "pi-agent-effort-popup" });

    const currentLevel = tab?.thinkingLevel ?? "";
    const renderItem = (
      id: string,
      name: string,
      desc: string,
      onClick?: () => void | Promise<void>
    ) => {
      const isCurrent = currentLevel === id;
      const itemEl = this.effortPopupEl!.createDiv({
        cls: `pi-agent-effort-popup-item ${isCurrent ? "is-active" : ""}`,
      });

      const leftEl = itemEl.createSpan({ cls: "pi-agent-effort-popup-left" });
      const checkEl = leftEl.createSpan({ cls: "pi-agent-effort-popup-item-check" });
      checkEl.setText("✓");

      leftEl.createSpan({ text: name, cls: "pi-agent-effort-popup-item-name" });
      itemEl.createSpan({ text: desc, cls: "pi-agent-effort-popup-item-desc" });

      if (onClick) {
        itemEl.onclick = (e) => {
          e.stopPropagation();
          this.runAsync(async () => {
            await onClick();
            new Notice(isZh ? `思考强度已设为 ${name}` : `Thinking level set to ${name}`);
            this.closeEffortPopup();
          });
        };
      } else {
        itemEl.addClass("is-disabled");
      }
    };

    if (options.length === 0) {
      // Informational / safe-fallback row. Do not expose a clickable level
      // when Pi has not declared any supported option for this model.
      const noteEl = this.effortPopupEl.createDiv({
        cls: "pi-agent-effort-popup-note",
      });
      noteEl.setText(note ?? "");
    } else {
      for (const option of options) {
        renderItem(option.id, option.name, option.desc, async () => {
          await this.updateActiveTabThinkingLevel(option.id);
        });
      }
    }

    this.effortOutsideClickHandler = (e: MouseEvent) => {
      if (this.effortPopupEl && !this.effortPopupEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
        this.closeEffortPopup();
      }
    };
    window.setTimeout(() => {
      activeDocument.addEventListener("pointerdown", this.effortOutsideClickHandler!);
    }, 0);
  }

  private async toggleHistoryPanel(): Promise<void> {
    this.isHistoryOpen = !this.isHistoryOpen;
    
    const historyBtn = this.containerEl.querySelector(".pi-agent-mini-action:has(svg.svg-icon[class*='history'])") || 
                       this.containerEl.querySelector(".pi-agent-mini-action svg[class*='history']")?.parentElement;
    if (historyBtn) {
      historyBtn.toggleClass("is-active", this.isHistoryOpen);
    }

    if (this.isHistoryOpen) {
      if (this.chatContainer) this.chatContainer.addClass("pi-agent-hidden");
      if (this.historyPanelEl) {
        this.historyPanelEl.removeClass("pi-agent-hidden");
        await this.renderHistoryPanel();
      }
    } else {
      if (this.chatContainer) this.chatContainer.removeClass("pi-agent-hidden");
      if (this.historyPanelEl) this.historyPanelEl.addClass("pi-agent-hidden");
    }
  }

  private getShortPath(pathText: string): string {
    if (!pathText) return "";
    const sep = pathText.includes("/") ? "/" : "\\";
    const parts = pathText.split(sep).filter(Boolean);
    if (parts.length <= 2) return pathText;
    return ".../" + parts.slice(-2).join(sep);
  }

  private decodeWorkspaceDirName(name: string): string {
    if (name.startsWith("--") && name.endsWith("--")) {
      const core = name.slice(2, -2);
      if (core.includes("--")) {
        const idx = core.indexOf("--");
        const drive = core.slice(0, idx);
        const rest = core.slice(idx + 2).replace(/-/g, "/");
        return `${drive}:/${rest}`;
      }
      return core.replace(/-/g, "/");
    }
    return name;
  }

  private listAllWorkspaceSessions(): Array<{
    pathName: string;
    rawDirName: string;
    dirPath: string;
    isCurrent: boolean;
    sessions: ResumeSessionItem[];
  }> {
    const home = homedir().replace(/\\/g, "/");
    const sessionsBaseDir = `${home}/.pi/agent/sessions`;
    
    if (!existsSync(sessionsBaseDir)) return [];
    
    const vaultPath = (this.app.vault.adapter as any).getBasePath?.() || "";
    const currentEncoded = vaultPath ? this.encodeWorkspacePath(vaultPath).toLowerCase() : "";
    
    const groups = [];
    const dirs = readdirSync(sessionsBaseDir);
    
    for (const name of dirs) {
      const dirPath = `${sessionsBaseDir}/${name}`;
      try {
        const stat = statSync(dirPath);
        if (!stat.isDirectory()) continue;
        
        const sessions = this.listResumeSessions(dirPath);
        const isCurrent = name.toLowerCase() === currentEncoded;
        
        // 解码得到可读路径
        let readablePath = name;
        if (name.startsWith("--") && name.endsWith("--")) {
          let core = name.slice(2, -2);
          if (core.includes("--")) {
            const idx = core.indexOf("--");
            const drive = core.slice(0, idx);
            const rest = core.slice(idx + 2).replace(/-/g, "/");
            readablePath = `${drive}:/${rest}`;
          } else {
            readablePath = core.replace(/-/g, "/");
          }
        }
        
        groups.push({
          pathName: readablePath,
          rawDirName: name,
          dirPath,
          isCurrent,
          sessions,
        });
      } catch (e) {
        new Notice(`读取目录 ${name} 报错: ${(e as Error).message}`);
        console.error("[pi-agent] listAllWorkspaceSessions error", e);
      }
    }
    
    // 排序：当前工作区最前，其余按路径名排序
    return groups.sort((a, b) => {
      if (a.isCurrent) return -1;
      if (b.isCurrent) return 1;
      return a.pathName.localeCompare(b.pathName);
    });
  }

  private async renderHistoryPanel(): Promise<void> {
    if (!this.historyPanelEl) return;
    this.historyPanelEl.empty();

    const isZh = this.plugin.settings.language === "zh";
    const header = this.historyPanelEl.createDiv("pi-agent-history-header");
    header.createDiv({ text: "CONVERSATIONS", cls: "pi-agent-history-title" });

    try {
      const isAgy = this.activeTab?.engine === "antigravity";
      const agyBuckets = isAgy ? await this.listAgyHistoryBuckets() : null;
      // Pi reads its current-workspace JSONL directory. AGY records are
      // classified by Pimate before display, rather than trusting AGY's
      // global metadata cache as this vault's history list.
      const sessions = agyBuckets
        ? agyBuckets[this.agyHistoryScope]
        : await this.listResumeSessionsForActiveEngine();

      if (agyBuckets) {
        const scopeRow = this.historyPanelEl.createDiv("pi-agent-history-scope");
        const scopes: Array<{
          id: "current" | "unassigned" | "all";
          label: string;
          count: number;
        }> = [
          {
            id: "current",
            label: isZh ? "当前空间" : "This vault",
            count: agyBuckets.current.length,
          },
          {
            id: "unassigned",
            label: isZh ? "未归属" : "Unassigned",
            count: agyBuckets.unassigned.length,
          },
          {
            id: "all",
            label: isZh ? "全部 AGY" : "All AGY",
            count: agyBuckets.all.length,
          },
        ];
        for (const scope of scopes) {
          const button = scopeRow.createEl("button", {
            text: `${scope.label} ${scope.count}`,
            cls: "pi-agent-history-scope-btn",
          });
          button.toggleClass("is-active", this.agyHistoryScope === scope.id);
          button.onclick = () => {
            if (this.agyHistoryScope === scope.id) return;
            this.agyHistoryScope = scope.id;
            void this.renderHistoryPanel();
          };
        }
      }

      if (sessions.length === 0) {
        this.historyPanelEl.createDiv({
          text:
            agyBuckets && this.agyHistoryScope === "current" && agyBuckets.unassigned.length > 0
              ? (isZh
                  ? "当前空间暂无已归属会话；可在“未归属”中手动导入。"
                  : "No conversations belong to this vault yet. Import one from Unassigned if needed.")
              : (isZh ? "暂无会话历史" : "No conversation history"),
          cls: "pi-agent-history-empty",
        });
        return;
      }

      const searchWrap = this.historyPanelEl.createDiv("pi-agent-history-search-wrap");
      const searchInput = searchWrap.createEl("input", {
        cls: "pi-agent-history-search",
        attr: {
          type: "search",
          placeholder: isZh ? "搜索历史会话..." : "Search conversations...",
        },
      });

      const listContainer = this.historyPanelEl.createDiv("pi-agent-history-list");
      const renderList = (query = "") => {
        listContainer.empty();
        const q = query.trim().toLowerCase();
        const filtered = q
            ? sessions.filter((session) => {
              const haystack = [session.label, session.preview, session.path, session.conversationId]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
              return haystack.includes(q);
            })
          : sessions;

        if (filtered.length === 0) {
          listContainer.createDiv({
            text: isZh ? "没有匹配的会话" : "No matching conversations",
            cls: "pi-agent-history-empty",
          });
          return;
        }

        const currentConversationId = isAgy
          ? this.activeTab?.sessionId ||
            (this.activeTab?.client?.engine === "antigravity"
              ? (this.activeTab.client as AgyAgentClient).getConversationId() || ""
              : "")
          : "";
        const currentSessionPath = !isAgy
          ? this.activeTab?.sessionFile?.replace(/\\/g, "/").toLowerCase()
          : "";

        for (const session of filtered) {
          const sessionPath = session.path?.replace(/\\/g, "/").toLowerCase();
          const isCurrentSession = isAgy
            ? !!currentConversationId && session.conversationId === currentConversationId
            : !!currentSessionPath && sessionPath === currentSessionPath;
          const itemEl = listContainer.createDiv(
            isCurrentSession
              ? "pi-agent-history-item is-current-session"
              : "pi-agent-history-item"
          );
          const iconEl = itemEl.createDiv("pi-agent-history-item-icon");
          setIcon(iconEl, isCurrentSession ? "message-square-dot" : "message-square");

          const contentEl = itemEl.createDiv("pi-agent-history-item-content");
          const nameText = session.label || (isZh ? "未命名对话" : "Untitled Session");
          contentEl.createDiv({ text: nameText, cls: "pi-agent-history-item-name" });
          if (isCurrentSession) {
            contentEl.createDiv({
              text: "Current session",
              cls: "pi-agent-history-item-current",
            });
          } else {
            const timeText = this.formatHistoryTime(session.mtime);
            contentEl.createDiv({ text: timeText, cls: "pi-agent-history-item-time" });
          }

          const agyScopeAction: AgyConversationScopeOverride | null =
            isAgy && session.engine === "antigravity" && session.agyHistoryScope === "current"
              ? "unassigned"
              : isAgy && session.engine === "antigravity" && session.agyHistoryScope === "unassigned"
                ? "current"
                : null;
          const runAgyScopeAction = () => {
            if (!agyScopeAction) return;
            this.runAsync(async () => {
              await this.setAgyConversationHistoryScope(session, agyScopeAction);
              await this.renderHistoryPanel();
            });
          };
          if (agyScopeAction) {
            const actionsEl = itemEl.createDiv("pi-agent-history-item-actions");
            const actionBtn = actionsEl.createEl("button", {
              cls: "pi-agent-history-item-action",
              attr: {
                "aria-label": agyScopeAction === "unassigned"
                  ? (isZh ? "移至未归属" : "Move to unassigned")
                  : (isZh ? "归入当前空间" : "Assign to this vault"),
                title: agyScopeAction === "unassigned"
                  ? (isZh ? "移至未归属" : "Move to unassigned")
                  : (isZh ? "归入当前空间" : "Assign to this vault"),
              },
            });
            setIcon(actionBtn, agyScopeAction === "unassigned" ? "archive" : "folder-plus");
            actionBtn.onclick = (event) => {
              event.stopPropagation();
              runAgyScopeAction();
            };
          }

          itemEl.onclick = () => {
            this.runAsync(async () => {
              await this.openResumeSession(session);
              this.isHistoryOpen = false;
            if (this.chatContainer) this.chatContainer.removeClass("pi-agent-hidden");
            this.historyPanelEl!.addClass("pi-agent-hidden");
            const historyBtn = this.containerEl.querySelector(".pi-agent-mini-action.is-active");
              historyBtn?.removeClass("is-active");
            });
          };

          itemEl.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const menu = new Menu();
            menu.addItem((item: any) => {
              item
                .setTitle(isZh ? "重命名" : "Rename")
                .setIcon("pencil")
                .onClick(() => this.runAsync(async () => {
                  await this.renameResumeSession(session);
                  await this.renderHistoryPanel();
                }));
            });
            if (agyScopeAction) {
              menu.addItem((item: any) => {
                item
                  .setTitle(
                    agyScopeAction === "unassigned"
                      ? (isZh ? "移至未归属" : "Move to unassigned")
                      : (isZh ? "归入当前空间" : "Assign to this vault")
                  )
                  .setIcon(agyScopeAction === "unassigned" ? "archive" : "folder-plus")
                  .onClick(runAgyScopeAction);
              });
            }
            if (session.engine !== "antigravity") {
              menu.addItem((item: any) => {
                item
                  .setTitle(isZh ? "删除此会话" : "Delete session")
                  .setIcon("trash-2")
                  .onClick(() => this.runAsync(async () => {
                    await this.deleteResumeSession(session);
                    await this.renderHistoryPanel();
                  }));
              });
            }
            menu.showAtMouseEvent(e);
          });
        }
      };

      searchInput.addEventListener("input", () => renderList(searchInput.value));
      renderList();
    } catch (err) {
      this.historyPanelEl.createDiv({
        text: `Failed to load: ${(err as Error).message}`,
        cls: "pi-agent-history-error",
      });
    }
  }

  private formatHistoryTime(mtime: number): string {
    const isZh = this.plugin.settings.language === "zh";
    const date = new Date(mtime);
    const now = new Date();
    
    if (date.toDateString() === now.toDateString()) {
      const hours = String(date.getHours()).padStart(2, "0");
      const minutes = String(date.getMinutes()).padStart(2, "0");
      return `${hours}:${minutes}`;
    }
    
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (date.toDateString() === yesterday.toDateString()) {
      return isZh ? "昨天" : "Yesterday";
    }

    const month = date.getMonth() + 1;
    const day = date.getDate();
    return isZh ? `${month}月${day}日` : date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  }

  private async renameResumeSession(session: ResumeSessionItem): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";
    if (session.engine === "antigravity") {
      const conversationId = session.conversationId?.trim();
      if (!conversationId) return;
      const current = this.getAgySessionTitle(conversationId) || session.label || "";
      const value = await new Promise<string | null>((resolve) => {
        new PiAgentEditorModal(
          this.app,
          isZh ? "重命名会话" : "Rename session",
          current,
          resolve
        ).open();
      });
      if (value === null) return;
      const title = value.trim();
      if (title) {
        if (!this.plugin.settings.agySessionTitles) this.plugin.settings.agySessionTitles = {};
        this.plugin.settings.agySessionTitles[
          this.normalizeAgySessionTitleKey(conversationId)
        ] = title;
        this.upsertAgyConversationIndex(conversationId, "resumed", {
          title,
          preview: session.preview,
        });
        session.label = title;
      } else {
        this.deleteAgySessionTitle(conversationId);
        this.upsertAgyConversationIndex(conversationId, "resumed", {
          clearTitle: true,
          preview: session.preview,
        });
        const fallback = AgyAgentClient.listConversations().find(
          (conversation) => conversation.conversationId === conversationId
        );
        session.label = fallback?.title || fallback?.preview?.slice(0, 24) || conversationId.slice(0, 12);
      }
      await this.plugin.saveSettings();
      new Notice(isZh ? "会话已重命名" : "Session renamed");
      return;
    }
    const current = this.getSessionTitle(session.path) || session.label || "";
    const value = await new Promise<string | null>((resolve) => {
      new PiAgentEditorModal(
        this.app,
        isZh ? "重命名会话" : "Rename session",
        current,
        resolve
      ).open();
    });
    if (value === null) return;
    const title = value.trim();
    if (!this.plugin.settings.sessionTitles) this.plugin.settings.sessionTitles = {};
    if (title) {
      this.plugin.settings.sessionTitles[this.normalizeSessionTitleKey(session.path)] = title;
      session.label = title;
    } else {
      this.deleteSessionTitle(session.path);
    }
    await this.plugin.saveSettings();
    new Notice(isZh ? "会话已重命名" : "Session renamed");
  }

  private async setAgyConversationHistoryScope(
    session: ResumeSessionItem,
    scope: AgyConversationScopeOverride
  ): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";
    const conversationId = session.conversationId?.trim();
    if (session.engine !== "antigravity" || !conversationId) return;

    if (scope === "current") {
      const workspaceStatus = this.getAgyConversationWorkspaceStatus(conversationId);
      if (workspaceStatus === "missing") {
        new Notice(isZh ? "AGY 历史会话不存在或已被删除" : "Antigravity conversation was not found");
        return;
      }
      if (workspaceStatus === "foreign") {
        new Notice(
          isZh
            ? "该 AGY 会话属于其他工作区，不能归入当前空间"
            : "This Antigravity conversation belongs to another workspace"
        );
        return;
      }
    }

    const overrideChanged = this.setAgyConversationScopeOverride(conversationId, scope);
    const indexChanged = scope === "current"
      ? this.upsertAgyConversationIndex(conversationId, "resumed", {
          title: this.getAgySessionTitle(conversationId) || session.label,
          preview: session.preview,
        })
      : false;
    if (overrideChanged || indexChanged) await this.plugin.saveSettings();

    new Notice(
      scope === "unassigned"
        ? (isZh
            ? "已移至未归属（不会删除 AGY 原始会话）"
            : "Moved to Unassigned; the native AGY conversation was not deleted")
        : (isZh ? "已归入当前空间" : "Conversation assigned to this vault")
    );
  }

  private async deleteResumeSession(session: ResumeSessionItem): Promise<void> {
    if (session.engine === "antigravity") {
      const isZh = this.plugin.settings.language === "zh";
      new Notice(
        isZh
          ? "AGY 历史会话的删除请在 AGY 原生 /resume 中进行"
          : "Delete Antigravity conversations from AGY's native /resume picker"
      );
      return;
    }
    const confirmed = await new Promise<boolean>((resolve) => {
      new PiAgentConfirmModal(
        this.app,
        "Delete Pimate session?",
        `Delete this session file?\n\n${session.path}\n\nThis cannot be undone from Pimate.`,
        resolve
      ).open();
    });
    if (!confirmed) return;
    const tab = this.tabs.find((item) => item.sessionFile?.toLowerCase() === session.path?.toLowerCase());
    if (tab) await this.closeTab(tab.id);
    try {
      unlinkSync(session.path);
      if (this.deleteSessionTitle(session.path)) {
        await this.plugin.saveSettings();
      }
      new Notice("Session deleted");
    } catch (err) {
      new Notice(`Failed to delete session: ${(err as Error).message}`);
    }
  }

  private encodeWorkspacePath(vaultPath: string): string {
    let p = vaultPath.replace(/\\/g, "/");
    if (p.match(/^[A-Za-z]:/)) {
      const drive = p[0].toUpperCase();
      let rest = p.slice(2);
      if (rest.startsWith("/")) rest = rest.slice(1);
      const restEncoded = rest.replace(/\//g, "-");
      return `--${drive}--${restEncoded}--`;
    } else {
      if (p.startsWith("/")) p = p.slice(1);
      if (p.endsWith("/")) p = p.slice(0, -1);
      return `--${p.replace(/\//g, "-")}--`;
    }
  }

  private getSessionDirectory(): string {
    try {
      const vaultPath = (this.app.vault.adapter as any).getBasePath?.() || "";
      if (vaultPath) {
        const encodedDirName = this.encodeWorkspacePath(vaultPath);
        const home = homedir().replace(/\\/g, "/");
        const sessionsBaseDir = `${home}/.pi/agent/sessions`;

        // 1. 优先使用原本的 directory
        const directory = `${sessionsBaseDir}/${encodedDirName}`;
        if (existsSync(directory)) {
          return directory;
        }

        // 2. 如果不存在，在 sessions 目录下进行大小写无关的查找
        if (existsSync(sessionsBaseDir)) {
          const targetNameLower = encodedDirName.toLowerCase();
          const dirs = readdirSync(sessionsBaseDir);
          const matchedDir = dirs.find((d: string) => d.toLowerCase() === targetNameLower);
          if (matchedDir) {
            return `${sessionsBaseDir}/${matchedDir}`;
          }
        }
      }
    } catch (err) {
      console.log("[pi-agent] Failed to auto detect workspace sessions dir, fallback to old logic", err);
    }

    const sessionFile =
      this.activeTab?.sessionFile ||
      this.plugin.settings.activeSessionFile ||
      this.plugin.settings.sessionTabs?.find((tab) => tab.sessionFile)?.sessionFile ||
      "";
    return sessionFile ? dirname(sessionFile) : "";
  }

  private listResumeSessions(directory: string): ResumeSessionItem[] {
    const files: Array<{ name: string; path: string; mtimeMs: number; size: number }> = [];

    for (const name of readdirSync(directory)) {
      if (!name.endsWith(".jsonl")) continue;

      const path = join(directory, name);
      try {
        const stat = statSync(path);
        if (!stat.isFile()) continue;
        files.push({ name, path, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        // A session can disappear while the directory is being scanned.
      }
    }

    files.sort((a, b) => b.mtimeMs - a.mtimeMs);

    return files.map(({ name, path, mtimeMs, size }) => {
      const cached = this.resumeSessionPreviewCache.get(path);
      const preview =
        cached && cached.mtimeMs === mtimeMs && cached.size === size
          ? cached.preview
          : this.readSessionPreview(path);

      if (!cached || cached.mtimeMs !== mtimeMs || cached.size !== size) {
        this.resumeSessionPreviewCache.set(path, { mtimeMs, size, preview });
      }

      const customTitle = this.getSessionTitle(path);
      return {
        path,
        label:
          customTitle ||
          (preview ? preview.slice(0, 24) : basename(name, ".jsonl").slice(0, 12)),
        mtime: mtimeMs,
        preview,
      };
    });
  }

  private readSessionPreview(path: string): string {
    let fd: number | null = null;
    try {
      fd = openSync(path, "r");
      const buffer = Buffer.alloc(SESSION_PREVIEW_MAX_BYTES);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      // Ignore a possibly truncated final JSONL line. Earlier lines contain
      // the session metadata and normally the first user message we need.
      const lastNewline = text.lastIndexOf("\n");
      const completeText = lastNewline >= 0 ? text.slice(0, lastNewline) : text;

      for (const line of completeText.split(/\r?\n/)) {
        if (!line.trim()) continue;
        let entry: any;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const content = entry.message?.content ?? entry.content;
        const role = entry.message?.role ?? entry.role;
        if (role === "user") {
          if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
          if (Array.isArray(content)) {
            const part = content.find((item) => item?.type === "text" && item.text);
            if (part?.text) return String(part.text).replace(/\s+/g, " ").trim();
          }
        }
      }
    } catch {
      // Ignore malformed/locked session files.
    } finally {
      if (fd !== null) closeSync(fd);
    }
    return "";
  }

  /**
   * Convert one Pi session-tree entry into the history payload understood by
   * renderMessageFromHistory.  Non-renderable metadata entries are skipped.
   */
  private sessionEntryToHistoryMessage(entry: SessionEntry): any | null {
    if (!entry?.id) return null;
    if (entry.type === "message" && entry.message) {
      return { ...entry.message, entryId: entry.id };
    }
    if (entry.type === "compaction") {
      return {
        role: "compactionSummary",
        summary: typeof entry.summary === "string" ? entry.summary : "",
        tokensBefore: entry.tokensBefore,
        entryId: entry.id,
      };
    }
    if (entry.type === "branch_summary") {
      return {
        role: "branchSummary",
        summary: typeof entry.summary === "string" ? entry.summary : "",
        entryId: entry.id,
      };
    }
    return null;
  }

  /**
   * Follow parentId from Pi's active leaf instead of treating every JSONL
   * entry as part of the conversation.  A session file can contain abandoned
   * branches after /tree or fork operations; only this path is renderable.
   */
  private buildActiveBranchHistory(
    entries: SessionEntry[],
    leafId?: string | null
  ): { messages: any[]; activeEntryCount: number } {
    if (!entries.length || leafId === null) {
      return { messages: [], activeEntryCount: 0 };
    }

    const byId = new Map<string, SessionEntry>();
    for (const entry of entries) {
      if (entry?.id) byId.set(entry.id, entry);
    }

    // `null` is an authoritative Pi state meaning "before the first entry".
    // Only undefined (older/partial payloads) may fall back to the last entry.
    let cursor = leafId ?? entries[entries.length - 1]?.id ?? "";
    const path: SessionEntry[] = [];
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const entry = byId.get(cursor);
      if (!entry) break;
      path.push(entry);
      cursor = typeof entry.parentId === "string" ? entry.parentId : "";
    }

    path.reverse();
    const messages = path
      .map((entry) => this.sessionEntryToHistoryMessage(entry))
      .filter((message): message is any => !!message);
    return { messages, activeEntryCount: path.length };
  }

  /**
   * Read the active branch through Pi.  `get_entries` is preferred because it
   * carries entry ids (needed by Fork buttons) and the selected leaf.  Older
   * Pi builds can fall back to `get_messages`, which still keeps the UI
   * usable, albeit without entry ids for those messages.
   */
  private async readActiveBranchFromPi(
    expectedTab: ChatTab | null = this.activeTab,
    expectedClient: AgentClient | null = expectedTab?.client ?? this.client
  ): Promise<any[]> {
    const tab = expectedTab;
    const client = expectedClient;
    if (!client) return [];

    try {
      const entriesResult = await client.getEntries();
      const data = entriesResult.data as any;
      if (entriesResult.success && Array.isArray(data?.entries)) {
        const entries = data.entries as SessionEntry[];
        const branch = this.buildActiveBranchHistory(entries, data.leafId);
        if (tab && this.activeTab === tab && this.client === client) {
          // A linear persisted fork has every entry on the active path and can
          // return to fast JSONL reloads. Sessions with off-path entries must
          // keep asking Pi for its authoritative leaf after each turn.
          tab.requiresBranchHistoryRpc = branch.activeEntryCount !== entries.length;
        }
        // A successful get_entries response is authoritative even when the
        // active branch currently has no renderable messages. Falling back to
        // get_messages here could reintroduce the very branch flattening this
        // path is meant to prevent.
        return branch.messages;
      }
    } catch {
      // Fall back below for Pi versions without get_entries.
    }

    try {
      const result = await client.getMessages();
      if (!result.success) return [];
      const messages = Array.isArray((result.data as any)?.messages)
        ? (result.data as any).messages
        : [];
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Read the last N renderable history entries from a JSONL session file.
   * Returns { messages, total } where total matches the UI history count.
   *
   * This bypasses the Pi RPC roundtrip which would otherwise serialize the
   * whole session.messages to JSON and pipe it back. For multi-MB sessions
   * (3000+ messages) this is 10-50x faster than the RPC path.
   */
  private readLastMessagesFromFile(
    filePath: string,
    limit: number
  ): { messages: any[]; total: number } {
    try {
      if (!existsSync(filePath)) return { messages: [], total: 0 };
      // Read whole file once. 30MB on SSD = ~50-200ms; comparable to the
      // RPC overhead we're avoiding. We do NOT go through MarkdownRenderer
      // here, so this is cheap relative to the render step.
      const text = readFileSync(filePath, "utf8");
      const messageLines: any[] = [];
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line) as SessionEntry;
          const historyMessage = this.sessionEntryToHistoryMessage(entry);
          if (historyMessage) messageLines.push(historyMessage);
        } catch {
          // skip malformed
        }
      }
      const total = messageLines.length;
      const messages = limit > 0 ? messageLines.slice(-limit) : messageLines;
      return { messages, total };
    } catch (err) {
      console.warn("[pi-agent] readLastMessagesFromFile failed:", err);
      return { messages: [], total: 0 };
    }
  }

  /**
   * A successful fork/clone/resume replaces Pi's active runtime. Reconcile the
   * tab metadata first, then rebuild the visible history from Pi's selected
   * leaf exactly once and refresh the entry-id map used by Fork buttons.
   */
  private async reloadAfterSessionRebind(): Promise<void> {
    const tab = this.activeTab;
    const client = this.client;
    if (!tab || !client) return;

    this.forkMessagesByEntryId.clear();
    const scopeVersion = ++this.forkScopeVersion;
    await this.refreshStateDisplay();
    if (
      this.activeTab !== tab ||
      this.client !== client ||
      this.forkScopeVersion !== scopeVersion
    ) {
      return;
    }
    await this.persistSessionTabs();

    this.resetActiveRenderState();
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];
    this.activeBranchHistory = null;
    await this.loadMessages({ forceRpc: tab.engine !== "antigravity" });
    if (
      this.activeTab !== tab ||
      this.client !== client ||
      this.forkScopeVersion !== scopeVersion
    ) {
      return;
    }
    await this.refreshForkMessages();
  }

  private async forkFromEntry(entryId: string, fallbackText: string): Promise<boolean> {
    if (!this.client) return false;
    const isZh = this.plugin.settings.language === "zh";

    try {
      const forked = await this.client.fork(entryId);
      if (!forked.success) {
        new Notice(
          isZh
            ? `Fork 失败: ${forked.error || "未知原因"}`
            : `Fork failed: ${forked.error || "Unknown error"}`
        );
        return false;
      }
      if ((forked.data as any)?.cancelled) {
        new Notice(isZh ? "已取消 Fork" : "Fork cancelled");
        return false;
      }

      this.setInputText(((forked.data as any)?.text || fallbackText).trim());
      await this.reloadAfterSessionRebind();
      new Notice(isZh ? "分支已创建" : "Fork created");
      return true;
    } catch (err) {
      new Notice(
        isZh
          ? `Fork 失败: ${(err as Error).message}`
          : `Fork failed: ${(err as Error).message}`
      );
      return false;
    }
  }

  private async showForkSelector(): Promise<void> {
    if (!this.client) return;
    const isZh = this.plugin.settings.language === "zh";
    try {
      const result = await this.client.getForkMessages();
      const messages = (result.data?.messages || []).filter(
        (item) => item.entryId && item.text
      );
      if (!result.success || messages.length === 0) {
        new Notice(
          isZh
            ? "当前没有可用于分支的历史提问节点"
            : "No previous user prompts available to fork"
        );
        return;
      }
      new ForkMessageSuggestModal(this.app, messages, (message) =>
        this.forkFromEntry(message.entryId, message.text)
      ).open();
    } catch (err) {
      new Notice(
        isZh
          ? `获取历史节点失败: ${(err as Error).message}`
          : `Fork failed: ${(err as Error).message}`
      );
    }
  }

  private async cloneCurrentBranch(): Promise<void> {
    if (!this.client) return;
    const isZh = this.plugin.settings.language === "zh";
    try {
      const result = await this.client.clone();
      if (!result.success) {
        new Notice(
          isZh
            ? `克隆分支失败: ${result.error || "未知原因"}`
            : `Clone failed: ${result.error || "Unknown error"}`
        );
        return;
      }
      if ((result.data as any)?.cancelled) {
        new Notice(isZh ? "已取消克隆" : "Clone cancelled");
        return;
      }
      await this.reloadAfterSessionRebind();
      new Notice(isZh ? "当前分支已克隆" : "Current branch cloned");
    } catch (err) {
      new Notice(
        isZh
          ? `克隆分支失败: ${(err as Error).message}`
          : `Clone failed: ${(err as Error).message}`
      );
    }
  }

  private async runBashMode(message: string, targetClient?: AgentClient): Promise<void> {
    const client = targetClient || this.activeTab?.client || this.client;
    if (!client) return;

    if (client.engine === "antigravity") {
      const isZh = this.plugin.settings.language !== "en";
      new Notice(
        isZh
          ? "Antigravity 不支持 Pimate 的直接 Bash 模式；请用普通消息请求它执行命令。"
          : "Antigravity does not support Pimate's direct Bash mode; ask it to run the command in a normal prompt."
      );
      return;
    }

    const command = message.replace(/^!+/, "").trim();
    if (!command) return;

    if (this.isDangerousBashCommand(command)) {
      const allowed = await new Promise<boolean>((resolve) => {
        new PiAgentConfirmModal(
          this.app,
          "Dangerous bash command",
          `Pimate is about to run:\n\n${command}\n\nThis looks destructive. Allow it?`,
          resolve
        ).open();
      });
      if (!allowed) {
        this.addSystemMessage("Dangerous bash command blocked");
        return;
      }
    }

    const toolMsg = this.addMessage("assistant", "");
    const toolBlock = toolMsg.contentEl.createDiv("pi-agent-tool-block");
    const header = toolBlock.createDiv("pi-agent-tool-header");
    header.createSpan({ text: this.getToolIcon("bash"), cls: "pi-agent-tool-icon" });
    header.createSpan({ text: "Bash", cls: "pi-agent-tool-name" });
    header.createSpan({ text: command, cls: "pi-agent-tool-args" });
    header.createSpan({ text: "...", cls: "pi-agent-tool-close is-loading" });
    
    const outputEl = toolBlock.createDiv("pi-agent-tool-output is-visible");
    header.onclick = () => outputEl.toggleClass("is-visible", !outputEl.hasClass("is-visible"));

    try {
      const result = await client.bash(command);
      const data = result.data as any;
      const closeEl = toolBlock.querySelector(".pi-agent-tool-close") as HTMLElement | null;
      if (closeEl) {
        closeEl.removeClass("is-loading");
        closeEl.textContent = result.success ? "✓" : "×";
      }
      outputEl.setText((data?.output || "").slice(0, 3000));
      if (!result.success) outputEl.addClass("pi-agent-tool-error");
    } catch (err) {
      const closeEl = toolBlock.querySelector(".pi-agent-tool-close") as HTMLElement | null;
      if (closeEl) {
        closeEl.removeClass("is-loading");
        closeEl.textContent = "×";
      }
      outputEl.setText((err as Error).message);
      outputEl.addClass("pi-agent-tool-error");
    }
  }

  private isDangerousBashCommand(command: string): boolean {
    const normalized = command.toLowerCase().replace(/\s+/g, " ").trim();
    return [
      /\brm\s+-[^\n]*r[^\n]*f\b/,
      /\brm\s+-rf\b/,
      /\bdel\s+\/s\b/,
      /\brmdir\s+\/s\b/,
      /\bformat\b/,
      /\bgit\s+reset\s+--hard\b/,
      /\bgit\s+clean\s+-[^\n]*f/,
      /\bmkfs\b/,
      /\bshutdown\b/,
      /\breboot\b/,
    ].some((pattern) => pattern.test(normalized));
  }

  private async showCommandSelector(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.getCommands();
      const piCommands = result.success && result.data
        ? ((result.data as any).commands || []) as PiCommandInfo[]
        : [];
      const commands = this.mergePimateCommands(piCommands);
      if (!commands.length) {
        new Notice("No Pi commands or skills available");
        return;
      }
      new CommandSuggestModal(this.app, commands, (command) => {
        this.prependInputText(`/${command.name} `);
      }).open();
    } catch (err) {
      new Notice(`Failed: ${(err as Error).message}`);
    }
  }

  private async showModelSelector(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.getAvailableModels();
      if (!result.success || !result.data) return;

      const models = ((result.data as any).models || []) as PiModel[];
      if (models.length === 0) {
        new Notice("No models available");
        return;
      }

      new ModelSuggestModal(this.app, models, async (model) => {
        await this.updateActiveTabModel(model.provider, model.id);
        new Notice(`Model set to ${model.provider}/${model.id}`);
      }).open();
    } catch (err) {
      new Notice(`Failed: ${(err as Error).message}`);
    }
  }

  async inlineEditSelection(
    selection: string,
    applyReplacement: (replacement: string) => void
  ): Promise<void> {
    if (!this.client) return;
    const trimmed = selection.trim();
    if (!trimmed) return;

    const instruction = await new Promise<string | null>((resolve) => {
      new PiAgentInlineEditModal(this.app, resolve).open();
    });
    if (!instruction) return;

    this.addSystemMessage("Inline edit started…");
    let attempt = 1;

    try {
      while (true) {
        const replacement = await this.generateInlineReplacement(selection, instruction, attempt);
        if (!replacement) {
          new Notice("Pimate returned an empty replacement");
          return;
        }
        const review = await new Promise<InlineEditReviewResult>((resolve) => {
          new PiAgentInlineEditReviewModal(
            this.app,
            selection,
            replacement,
            resolve
          ).open();
        });
        if (review.action === "reject") {
          new Notice("Inline edit rejected");
          return;
        }
        if (review.action === "regenerate") {
          attempt++;
          this.addSystemMessage(`Regenerating inline edit… (${attempt})`);
          continue;
        }
        applyReplacement((review.replacement || replacement).trim());
        new Notice("Selection edited by Pimate");
        return;
      }
    } catch (err) {
      new Notice(`Inline edit failed: ${(err as Error).message}`);
    }
  }

  private async generateInlineReplacement(
    selection: string,
    instruction: string,
    attempt: number
  ): Promise<string> {
    if (!this.client) return "";
    const prompt = [
      "You are editing a selected passage from an Obsidian markdown note.",
      "Return ONLY the replacement text. Do not add explanations, markdown fences, or commentary.",
      `Instruction: ${instruction}`,
      attempt > 1 ? `This is regeneration attempt ${attempt}. Produce a different, better version.` : "",
      "Selected text:",
      "```markdown",
      selection,
      "```",
    ]
      .filter(Boolean)
      .join("\n");

    const result = await this.client.promptAndWait(prompt);
    return ((result.data as any)?.text || "").trim();
  }

  /**
   * Files that Pimate considers attachable to chat context.
   * Includes markdown (for reading), PDFs (for vision-capable models),
   * and common image formats (for vision models).
   */
  private getAttachableFiles(): TFile[] {
    const exts = new Set([
      "md", "markdown",
      "pdf",
      "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif",
    ]);
    return this.app.vault
      .getFiles()
      .filter((f) => exts.has(f.extension.toLowerCase()));
  }

  /** Returns a small emoji-style tag for the file type (used in @ dropdown). */
  private getFileTypeIcon(extension: string): string {
    const e = extension.toLowerCase();
    if (e === "pdf") return "📄";
    if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"].includes(e)) return "🖼";
    return "📝"; // markdown
  }

  private async addFileContext(): Promise<void> {
    const files = this.getAttachableFiles();
    if (files.length === 0) {
      new Notice("No attachable files in this vault");
      return;
    }
    new FileSuggestModal(this.app, files, (file) => this.addFileContextItem(file)).open();
  }

  private addCurrentFileContext(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active file");
      return;
    }
    this.addFileContextItem(file);
  }

  public addFileContextItem(file: TFile): void {
    this.addContextItem({
      id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "file",
      label: file.basename,
      value: file.path,
    });
  }

  public addFolderContextItem(folder: TFolder, isRecursive: boolean): void {
    const path = folder.path || "/";
    this.addContextItem({
      id: `ctx-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "folder",
      label: folder.name || path,
      value: path,
      mimeType: isRecursive ? "recursive" : "files",
    });
  }

  private async handlePaste(event: ClipboardEvent): Promise<void> {
    const items = Array.from(event.clipboardData?.items ?? []);
    const imageItems = items.filter((item) => item.type.startsWith("image/"));
    if (imageItems.length === 0) return;

    event.preventDefault();
    for (const item of imageItems) {
      const file = item.getAsFile();
      if (!file) continue;
      await this.addImageContextFromFile(file, "pasted image");
    }
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.inputEl?.removeClass("is-drag-over");

    const files = Array.from(event.dataTransfer?.files ?? []);
    let handled = false;
    for (const file of files) {
      if (file.type.startsWith("image/")) {
        await this.addImageContextFromFile(file, file.name || "dropped image");
        handled = true;
      }
    }

    const text = event.dataTransfer?.getData("text/plain") || "";
    for (const path of this.extractVaultPaths(text)) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        this.addFileContextItem(file);
        handled = true;
      }
    }

    if (handled) this.inputEl?.focus();
  }

  private async addImageContextFromFile(file: File, fallbackLabel: string): Promise<void> {
    const dataUrl = await this.readFileAsDataUrl(file);
    const [, base64 = ""] = dataUrl.split(",", 2);
    this.addContextItem({
      id: `ctx-img-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type: "image",
      label: file.name && file.name !== "image.png" ? file.name : fallbackLabel,
      value: base64,
      mimeType: file.type || "image/png",
    });
  }

  private extractVaultPaths(text: string): string[] {
    if (!text) return [];
    const candidates = text
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^obsidian:\/\/open\?/, ""))
      .filter(Boolean);
    const paths: string[] = [];
    for (const candidate of candidates) {
      const decoded = decodeURIComponent(candidate);
      const fileMatch = decoded.match(/(?:^|[?&])file=([^&]+)/);
      const path = fileMatch ? decodeURIComponent(fileMatch[1]) : decoded;
      if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) paths.push(path);
    }
    return paths;
  }

  private readFileAsDataUrl(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Failed to read pasted image"));
      reader.readAsDataURL(file);
    });
  }

  /**
   * AGY's documented stream-json input accepts text content blocks only. Save
   * pasted/drop images into the vault and send their relative paths as text so
   * AGY can open them with its workspace file tools.
   */
  private async persistAgyImageAttachments(
    images: Array<{ data: string; mimeType: string }>
  ): Promise<string[]> {
    if (images.length === 0) return [];

    const existingFolder = this.app.vault.getAbstractFileByPath(AGY_IMAGE_ATTACHMENT_DIR);
    if (existingFolder && !(existingFolder instanceof TFolder)) {
      throw new Error(`Vault path is not a folder: ${AGY_IMAGE_ATTACHMENT_DIR}`);
    }
    if (!existingFolder) {
      await this.app.vault.createFolder(AGY_IMAGE_ATTACHMENT_DIR);
    }

    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const paths: string[] = [];
    for (const [index, image] of images.entries()) {
      const extension = this.getAgyImageExtension(image.mimeType);
      const suffix = Math.random().toString(36).slice(2, 8);
      const imagePath = `${AGY_IMAGE_ATTACHMENT_DIR}/agy-${stamp}-${index + 1}-${suffix}.${extension}`;
      await this.app.vault.createBinary(
        imagePath,
        this.decodeBase64ToArrayBuffer(image.data)
      );
      paths.push(imagePath);
    }
    return paths;
  }

  private getAgyImageExtension(mimeType: string): string {
    const normalized = mimeType.toLowerCase().split(";", 1)[0];
    switch (normalized) {
      case "image/jpeg":
      case "image/jpg":
        return "jpg";
      case "image/gif":
        return "gif";
      case "image/webp":
        return "webp";
      case "image/bmp":
        return "bmp";
      case "image/svg+xml":
        return "svg";
      case "image/avif":
        return "avif";
      case "image/tiff":
        return "tiff";
      default:
        return "png";
    }
  }

  private decodeBase64ToArrayBuffer(value: string): ArrayBuffer {
    const commaIndex = value.indexOf(",");
    const base64 = (commaIndex >= 0 ? value.slice(commaIndex + 1) : value).replace(/\s/g, "");
    if (!base64) throw new Error("Image data is empty");

    let binary: string;
    try {
      binary = atob(base64);
    } catch {
      throw new Error("Image data is not valid base64");
    }
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes.buffer;
  }

  private buildAgyImagePrefix(paths: string[]): string {
    if (paths.length === 0) return "";
    const references = paths.map((imagePath) => `@${imagePath}`).join("\n");
    // The @-references are sufficient context for AGY. Avoid adding an
    // implementation-oriented sentence to the user's visible prompt/history.
    return `${references}\n\n`;
  }

  private addContextItem(item: ContextItem): void {
    if (this.contextItems.some((existing) => existing.value === item.value)) return;
    this.contextItems.push(item);
    if (this.activeTab) {
      this.activeTab.contextItems = this.contextItems.map((contextItem) => ({ ...contextItem }));
    }
    this.renderContextItems();
  }

  private removeContextItem(id: string): void {
    this.contextItems = this.contextItems.filter((item) => item.id !== id);
    if (this.activeTab) {
      this.activeTab.contextItems = this.contextItems.map((contextItem) => ({ ...contextItem }));
    }
    this.renderContextItems();
  }

  private clearContextItems(): void {
    this.contextItems = [];
    if (this.activeTab) this.activeTab.contextItems = [];
    this.renderContextItems();
  }

  private renderContextItems(): void {
    if (!this.contextRowEl) return;
    this.contextRowEl.empty();
    if (this.imagePreviewEl) this.imagePreviewEl.empty();

    // Split: images go to a dedicated large-thumbnail preview row;
    // files/folders/selections stay in the chip row.
    const images = this.contextItems.filter((i) => i.type === "image");
    const others = this.contextItems.filter((i) => i.type !== "image");

    if (this.imagePreviewEl) {
      this.imagePreviewEl.toggleClass("has-content", images.length > 0);
      for (const item of images) {
        const card = this.imagePreviewEl.createDiv("pi-agent-image-card");
        const img = card.createEl("img", {
          cls: "pi-agent-image-card-thumb",
          attr: {
            src: `data:${item.mimeType || "image/png"};base64,${item.value}`,
            title: item.label,
          },
        });
        img.onclick = (e) => {
          e.stopPropagation();
          new ContextPreviewModal(this.app, item).open();
        };
        const remove = card.createSpan({ text: "×", cls: "pi-agent-image-card-remove" });
        remove.onclick = (e) => {
          e.stopPropagation();
          this.removeContextItem(item.id);
        };
      }
    }

    this.contextRowEl.toggleClass("has-content", others.length > 0);
    for (const item of others) {
      const chip = this.contextRowEl.createSpan({ cls: "pi-agent-file-chip" });
      chip.createSpan({
        text: item.type === "selection" ? "▤" : item.type === "folder" ? "▦" : "▣",
        cls: "pi-agent-file-chip-icon",
      });
      chip.createSpan({ text: item.label, cls: "pi-agent-file-chip-name" });
      const remove = chip.createSpan({ text: "×", cls: "pi-agent-file-chip-remove" });
      remove.onclick = (event) => {
        event.stopPropagation();
        this.removeContextItem(item.id);
      };
      chip.onclick = () => {
        this.runAsync(async () => {
          if (item.type === "file") {
          const file = this.app.vault.getAbstractFileByPath(item.value);
          if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
        } else if (item.type === "folder") {
          // Open the first markdown file in the folder.
          const all = this.app.vault.getMarkdownFiles();
          const prefix = item.value === "/" ? "" : item.value + "/";
          const first = all.find((f) => {
            const parent = f.parent;
            if (!parent) return false;
            return item.value === "/"
              ? !f.path.includes("/")
              : f.path.startsWith(prefix) || parent.path === item.value;
          });
          if (first) {
            const leaf = this.app.workspace.getLeaf(false);
            await leaf.openFile(first);
          } else {
            const fileExplorer = this.app.workspace.getLeavesOfType("file-explorer")[0];
            if (fileExplorer) {
              this.app.workspace.setActiveLeaf(fileExplorer);
            }
          }
        } else {
            new ContextPreviewModal(this.app, item).open();
          }
        });
      };
    }
  }

  /**
   * Render image attachments at the top of a user message bubble.
   * Mirrors Claudian's layout: image(s) above the text prompt, click to zoom.
   */
  private renderUserMessageImages(
    msg: RenderedMessage,
    images: Array<{ data: string; mimeType: string }>
  ): void {
    const attachments = msg.el.createDiv("pi-agent-message-attachments");
    // Move the attachments block above the text content.
    msg.el.insertBefore(attachments, msg.contentEl);
    for (const img of images) {
      const card = attachments.createDiv("pi-agent-message-image");
      const el = card.createEl("img", {
        attr: { src: `data:${img.mimeType || "image/png"};base64,${img.data}` },
      });
      el.onclick = (e) => {
        e.stopPropagation();
        const url = `data:${img.mimeType || "image/png"};base64,${img.data}`;
        window.open(url, "_blank");
      };
    }
  }

  private stripRecentContextGuard(text: string): string {
    return text
      .replace(/<recent_context_guard>[\s\S]*?<\/recent_context_guard>\s*/g, "")
      .trim();
  }


  private buildContextPrefix(): string {
    const fileItems = this.contextItems.filter((item) => item.type === "file");
    const folderItems = this.contextItems.filter((item) => item.type === "folder");
    const selectionItems = this.contextItems.filter((item) => item.type === "selection");
    const fileText = fileItems.map((item) => `@${item.value}`).join(" ");
    const folderText = folderItems
      .map((item) => `Folder @${item.value}`)
      .join("\n\n");
    const selectionText = selectionItems
      .map((item, index) => `Selection ${index + 1}:\n${item.value}`)
      .join("\n\n");
    const parts = [fileText, folderText, selectionText].filter(Boolean);
    return parts.length ? `${parts.join("\n\n")}\n\n` : "";
  }

  private listFolderFiles(folderPath: string, recursive: boolean): string[] {
    const allFiles = this.app.vault.getMarkdownFiles();
    const out: string[] = [];
    for (const f of allFiles) {
      const parent = f.parent;
      if (!parent) continue;
      const parentPath = parent.path || "/";
      if (
        parentPath === folderPath ||
        (recursive &&
          parentPath.startsWith(folderPath === "/" ? "/" : folderPath + "/"))
      ) {
        out.push(f.path);
      }
    }
    return out;
  }

  private getImagePayloads(): Array<{ type: string; data: string; mimeType: string }> {
    return this.contextItems
      .filter((item) => item.type === "image")
      .map((item) => ({
        type: "image",
        data: item.value,
        mimeType: item.mimeType || "image/png",
      }));
  }

  private async refreshStateDisplay(
    expectedTab: ChatTab | null = this.activeTab,
    expectedClient: AgentClient | null = expectedTab?.client ?? this.client
  ): Promise<void> {
    const tab = expectedTab;
    const client = expectedClient;
    if (!tab || !client) return;
    try {
      await this.syncTabStateFromPi(tab);
      if (!this.isCurrentTabClient(tab, client)) return;

      await this.refreshContextUsageDisplay(tab, client);
      if (!this.isCurrentTabClient(tab, client)) return;

      // 预热可用模型列表缓存，确保点击弹出时能“秒开”且不阻塞用户
      client.getAvailableModels().then(res => {
        if (this.isCurrentTabClient(tab, client) && res.success && res.data) {
          const engine = tab.engine || this.plugin.settings.defaultEngine || "pi";
          this.setModelsCacheForEngine(engine, (res.data.models || []) as PiModel[]);
        }
      }).catch(() => {});
    } catch {
      // Non-fatal; UI can still function without state display.
    }
  }

  private async refreshContextUsageDisplay(
    expectedTab: ChatTab | null = this.activeTab,
    expectedClient: AgentClient | null = expectedTab?.client ?? this.client
  ): Promise<void> {
    const tab = expectedTab;
    const client = expectedClient;
    if (!tab || !client || !this.footerContextEl) return;
    try {
      const result = client.engine === "antigravity"
        ? await (client as AgyAgentClient).getSessionStats({ includeHistory: false })
        : await client.getSessionStats();
      if (!this.isCurrentTabClient(tab, client)) return;
      if (result.success) {
        this.updateActiveTabSessionInfo(result.data as any, tab);
        await this.persistSessionTabs();
        if (!this.isCurrentTabClient(tab, client)) return;
      }
      const usage = (result.data as any)?.contextUsage;
      if (result.success && usage?.percent != null) {
        this.updateContextMeter(Number(usage.percent), `Context: ${usage.tokens ?? "?"}/${usage.contextWindow ?? "?"}`);
      } else {
        this.updateContextMeter(null, "Context usage");
      }
    } catch {
      if (this.isCurrentTabClient(tab, client)) {
        this.updateContextMeter(null, "Context usage");
      }
    }
  }

  private isCurrentTabClient(
    tab: ChatTab | null,
    client: AgentClient | null
  ): boolean {
    return !!tab && !!client && this.activeTab === tab && tab.client === client && this.client === client;
  }

  private updateContextMeter(percent: number | null, title: string): void {
    if (!this.footerContextEl || !this.footerContextFillEl || !this.footerContextPercentEl) return;
    const circumference = 2 * Math.PI * 8;
    this.footerContextFillEl.setAttribute("stroke-dasharray", `${circumference}`);
    if (percent == null || Number.isNaN(percent)) {
      this.footerContextPercentEl.setText("");
      this.footerContextFillEl.setAttribute("stroke-dashoffset", `${circumference}`);
      this.footerContextEl.removeClass("warning");
      this.footerContextEl.removeClass("danger");
      this.footerContextEl.setAttribute("title", title);
      return;
    }
    const clamped = Math.max(0, Math.min(100, percent));
    this.footerContextFillEl.setAttribute("stroke-dashoffset", `${circumference * (1 - clamped / 100)}`);
    this.footerContextPercentEl.setText(`${Math.round(clamped)}%`);
    this.footerContextEl.toggleClass("warning", clamped >= 70 && clamped < 85);
    this.footerContextEl.toggleClass("danger", clamped >= 85);
    this.footerContextEl.setAttribute("title", title);
  }

  private updateActiveTabSessionInfo(data: any, expectedTab?: ChatTab): void {
    const tab = expectedTab || this.activeTab;
    if (!tab || !data) return;
    if (typeof data.sessionFile === "string") tab.sessionFile = data.sessionFile;
    if (typeof data.sessionId === "string") tab.sessionId = data.sessionId;
    const pendingTitle = this.pendingAutoTitles.get(tab.id);
    const agyConversationId = tab.engine === "antigravity" ? this.getAgyConversationId(tab) : "";
    if (pendingTitle && (tab.sessionFile || agyConversationId)) {
      this.pendingAutoTitles.delete(tab.id);
      void this.persistAutoSessionTitle(tab, pendingTitle);
    }
    const maybeName = data.name || data.sessionName || data.title;
    if (typeof maybeName === "string" && maybeName.trim()) {
      tab.label = maybeName.trim().slice(0, 24);
      this.renderTabs();
    }
  }

  private async persistSessionTabs(): Promise<void> {
    this.plugin.settings.sessionTabs = this.tabs.map((tab) => ({
      label: tab.label,
      sessionFile: tab.sessionFile,
      sessionId: tab.sessionId,
      engine: tab.engine,
      modelProvider: tab.modelProvider,
      modelId: tab.modelId,
      thinkingLevel: tab.thinkingLevel,
    }));
    const activeIndex = this.tabs.findIndex((tab) => tab.id === this.activeTabId);
    this.plugin.settings.activeTabIndex = activeIndex >= 0 ? activeIndex : 0;
    this.plugin.settings.activeSessionFile = this.activeTab?.sessionFile || "";
    await this.plugin.saveSettings();
  }

  private restoreTabModelConfig(): void {
    const persisted = this.plugin.settings.sessionTabs || [];
    for (let i = 0; i < this.tabs.length && i < persisted.length; i++) {
      const saved = persisted[i];
      if (!saved) continue;
      if (saved.engine) this.tabs[i].engine = saved.engine;
      if (saved.modelProvider) this.tabs[i].modelProvider = saved.modelProvider;
      if (saved.modelId) this.tabs[i].modelId = saved.modelId;
      if (typeof saved.thinkingLevel === "string") this.tabs[i].thinkingLevel = saved.thinkingLevel;
    }
  }

  public refreshEngineVisibility(): void {
    this.updateEngineDisplay();
    if (this.plugin.settings.enableAntigravity === false) {
      for (const tab of this.tabs) {
        if (tab.engine === "antigravity") {
          void this.switchTabEngine(tab, "pi");
        }
      }
    }
  }

  private updateEngineDisplay(): void {
    if (this.plugin.settings.enableAntigravity === false) {
      if (this.footerEngineSelector) {
        this.footerEngineSelector.style.display = "none";
      }
      return;
    }
    if (this.footerEngineSelector) {
      this.footerEngineSelector.style.display = "";
    }
    if (!this.footerEngineLabel) return;
    const isZh = this.plugin.settings.language === "zh";
    const engine = this.activeTab?.engine || this.plugin.settings.defaultEngine || "antigravity";
    if (engine === "antigravity") {
      this.footerEngineLabel.setText("✦ Antigravity");
      this.footerEngineLabel.setAttribute(
        "title",
        isZh ? "当前引擎：Antigravity CLI (点击切换)" : "Engine: Antigravity CLI (Click to switch)"
      );
      this.footerEngineLabel.addClass("is-antigravity");
      this.footerEngineLabel.removeClass("is-pi");
    } else {
      this.footerEngineLabel.setText("π Pi Agent");
      this.footerEngineLabel.setAttribute(
        "title",
        isZh ? "当前引擎：Pi Coding Agent (点击切换)" : "Engine: Pi Coding Agent (Click to switch)"
      );
      this.footerEngineLabel.addClass("is-pi");
      this.footerEngineLabel.removeClass("is-antigravity");
    }
  }

  private toggleEngineMenu(anchorEl: HTMLElement): void {
    const isZh = this.plugin.settings.language === "zh";
    const tab = this.activeTab;
    if (!tab) return;
    const currentEngine = tab.engine || this.plugin.settings.defaultEngine || "antigravity";

    const menu = new Menu();

    menu.addItem((item) => {
      item.setTitle(isZh ? "✦ Antigravity CLI (Google 免密生态)" : "✦ Antigravity CLI (Google OAuth)")
        .setChecked(currentEngine === "antigravity")
        .onClick(async () => {
          if (currentEngine === "antigravity") return;
          await this.switchTabEngine(tab, "antigravity");
        });
    });

    menu.addItem((item) => {
      item.setTitle(isZh ? "π Pi Coding Agent (多 Provider/Key)" : "π Pi Coding Agent (Providers/Key)")
        .setChecked(currentEngine === "pi")
        .onClick(async () => {
          if (currentEngine === "pi") return;
          await this.switchTabEngine(tab, "pi");
        });
    });

    const rect = anchorEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.top - 10 });
  }

  private async switchTabEngine(tab: ChatTab, newEngine: "pi" | "antigravity"): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";
    if (tab.isStreaming) {
      new Notice(isZh ? "当前会话正在生成中，请先等待或停止" : "Cannot switch engine while generating");
      return;
    }

    tab.engine = newEngine;

    if (tab.client) {
      await tab.client.destroy().catch(() => undefined);
      tab.client = null;
    }

    // Reset session bindings when switching engines so the new engine starts cleanly
    tab.sessionFile = undefined;
    tab.sessionId = undefined;
    tab.restored = false;
    tab.requiresBranchHistoryRpc = false;

    if (newEngine === "antigravity") {
      tab.modelProvider = "antigravity";
      tab.modelId = this.plugin.settings.agyModel || "gemini-3.8-flash-high";
      tab.thinkingLevel = this.plugin.settings.agyEffort || "high";
    } else {
      tab.modelProvider = this.plugin.settings.provider;
      tab.modelId = this.plugin.settings.modelId;
      tab.thinkingLevel = this.plugin.settings.thinkingLevel;
    }

    await this.persistSessionTabs();
    this.renderActiveTabModelAndEffort();

    if (this.activeTab === tab) {
      if (this.chatContainer) this.chatContainer.empty();
      this.renderedMessages = [];
      this.pendingQueuedMessages = [];
      this.renderEmptyState();
      this.setStatus(isZh ? `正在连接 ${newEngine === "antigravity" ? "Antigravity CLI" : "Pi Agent"}…` : `Starting ${newEngine}…`, "thinking");
    }

    await this.ensureTabClient(tab);
    if (this.activeTab === tab) {
      this.client = tab.client;
      await this.refreshStateDisplay();
      await this.loadAvailableCommands();
      this.renderActiveTabRuntimeStatus();
      this.renderActiveTabSpeed();
      this.renderActiveTabModelAndEffort();
    }
    this.updateButtons();
    this.renderTabs();
    new Notice(isZh ? `已切换引擎为 ${newEngine === "antigravity" ? "✦ Antigravity CLI" : "π Pi Agent"}` : `Switched to ${newEngine === "antigravity" ? "Antigravity CLI" : "Pi Agent"}`);
  }

  private updateModelDisplay(provider: string, modelId: string): void {
    if (!this.footerModelLabel) return;
    const shortName = modelId
      .replace(/^claude-/, "")
      .replace(/^gemini-/, "Gemini ")
      .replace(/^gpt-/, "GPT-")
      .replace(/^deepseek-/, "DeepSeek ")
      .slice(0, 22);
    this.footerModelLabel.setText(shortName || provider);
    this.footerModelLabel.setAttribute("title", `${provider}/${modelId}`);
  }

  public refreshSmartReviewToggle(): void {
    this.updateSmartReviewToggleUI();
  }

  private updateSmartReviewToggleUI(): void {
    if (!this.smartReviewToggleEl) return;
    const isEnabled = this.plugin.settings.smartReviewEnabled === true;
    const isZh = this.plugin.settings.language !== "en";
    this.smartReviewToggleEl.setText(isZh ? "审" : "Review");
    this.smartReviewToggleEl.setAttribute(
      "title",
      isEnabled
        ? isZh
          ? "智能审核已开启：长任务会自检并优化后再输出"
          : "Smart review on: long tasks self-check before replying"
        : isZh
          ? "智能审核已关闭"
          : "Smart review off"
    );
    this.smartReviewToggleEl.toggleClass("is-enabled", isEnabled);
  }

  async insertLastAssistantIntoActiveNote(): Promise<void> {
    if (!this.client) return;

    const activeMarkdown =
      this.app.workspace.getActiveViewOfType(MarkdownView) ||
      (this.app.workspace
        .getLeavesOfType("markdown")
        .map((leaf) => leaf.view)
        .find((view): view is MarkdownView => view instanceof MarkdownView) ??
        null);
    const editor = activeMarkdown?.editor;
    if (!editor) {
      new Notice("Open a markdown note first");
      return;
    }

    try {
      const result = await this.client.getLastAssistantText();
      const text = (result.data as any)?.text as string | null | undefined;
      if (!result.success || !text) {
        new Notice("No Pimate response to insert");
        return;
      }
      editor.replaceSelection(text);
      new Notice("Inserted last Pimate response");
    } catch (err) {
      new Notice(`Insert failed: ${(err as Error).message}`);
    }
  }

  public async refreshThinkingVisibility(): Promise<void> {
    if (this.activeTab?.isStreaming) return;
    await this.reloadMessagesFromClient();
  }

  private async reloadMessagesFromClient(
    options: { forceRpc?: boolean } = {}
  ): Promise<void> {
    if (this.chatContainer) {
      this.chatContainer.empty();
    }
    this.renderedMessages = [];
    this.activeBranchHistory = null;
    this.historyShownCount = 0;
    this.historyTotalCount = 0;
    this.historyBannerEl = null;
    this.renderEmptyState();
    await this.loadMessages(options);
  }

  private async loadMessages(
    options: {
      forceRpc?: boolean;
      expectedTab?: ChatTab | null;
      expectedClient?: AgentClient | null;
      expectedSwitchSeq?: number;
    } = {}
  ): Promise<void> {
    const tab = options.expectedTab ?? this.activeTab;
    const client = options.expectedClient ?? tab?.client ?? this.client;
    const isCurrentRequest = (): boolean =>
      !!tab &&
      !!client &&
      this.isCurrentTabClient(tab, client) &&
      (options.expectedSwitchSeq === undefined || this.tabSwitchSeq === options.expectedSwitchSeq);

    if (!tab || !client || !isCurrentRequest()) return;

    // Decide source: prefer direct file read (fast, paginated) when we
    // have a known sessionFile. Falls back to RPC for sessions that live
    // only in memory (e.g. --no-session) or when the file is missing.
    const filePath = tab?.sessionFile;
    const limit = this.plugin.settings.maxHistoryDisplay;
    let messages: any[] = [];
    let total = 0;
    let usedFile = false;

    // A normal session load is allowed to use the fast JSONL path; do not let
    // a branch cache from the previously active tab leak into its pager.
    if (!options.forceRpc) this.activeBranchHistory = null;

    if (options.forceRpc) {
      const branchMessages = await this.readActiveBranchFromPi(tab, client);
      if (!isCurrentRequest()) return;
      this.activeBranchHistory = branchMessages;
      total = branchMessages.length;
      messages = limit > 0 ? branchMessages.slice(-limit) : branchMessages;
    }

    // Prefer direct jsonl reads when possible. During streaming, RPC getMessages
    // can contend with live generation on the same subprocess and make large
    // model replies feel slower; missed live deltas are recovered by
    // ensureAssistantStreamMessage().
    if (!options.forceRpc && filePath) {
      const fileResult = this.readLastMessagesFromFile(filePath, limit);
      if (fileResult.total > 0) {
        messages = fileResult.messages;
        total = fileResult.total;
        usedFile = true;
      }
    }
    if (!options.forceRpc && !usedFile) {
      try {
        const result = client.engine === "antigravity"
          ? await (client as AgyAgentClient).getMessages({ limit })
          : await client.getMessages();
        if (!isCurrentRequest()) return;
        if (result.success && result.data) {
          const rpcMessages = (result.data as any).messages || [];
          const reportedTotal = Number((result.data as any).totalMessages);
          total = Number.isFinite(reportedTotal) && reportedTotal >= rpcMessages.length
            ? reportedTotal
            : rpcMessages.length;
          messages = limit > 0 ? rpcMessages.slice(-limit) : rpcMessages;
        }
      } catch {
        console.log("[pi-agent] No existing messages to load");
        return;
      }
    }

    if (!isCurrentRequest()) return;

    this.historyShownCount = messages.length;
    this.historyTotalCount = total;
    for (const msg of messages) {
      this.renderMessageFromHistory(msg);
    }
    this.renderHistoryBanner();
    this.scrollToBottom(true, true);
  }

  /** Append more history (e.g. when user clicks "Load earlier"). */
  private async loadMoreHistory(moreBy: number): Promise<void> {
    const tab = this.activeTab;
    const newLimit = this.historyShownCount + moreBy;
    let allMessages: any[];
    let total: number;

    if (this.activeBranchHistory !== null) {
      allMessages = this.activeBranchHistory;
      total = allMessages.length;
    } else {
      if (!tab?.sessionFile) return;
      const fileResult = this.readLastMessagesFromFile(tab.sessionFile, newLimit);
      allMessages = fileResult.messages;
      total = fileResult.total;
    }

    const visibleMessages = this.activeBranchHistory !== null
      ? (newLimit > 0 ? allMessages.slice(-newLimit) : allMessages)
      : allMessages;
    if (visibleMessages.length <= this.historyShownCount) {
      new Notice("No more messages to load");
      return;
    }
    const newOnes = visibleMessages.slice(
      0,
      visibleMessages.length - this.historyShownCount
    );
    const chat = this.chatContainer;
    const oldScrollHeight = chat?.scrollHeight || 0;
    const oldScrollTop = chat?.scrollTop || 0;
    this.historyPrependAnchorEl = this.historyBannerEl?.nextElementSibling as HTMLElement | null;
    this.historyPrependInsertIndex = 0;
    try {
      for (const msg of newOnes) {
        this.renderMessageFromHistory(msg, { prependHistory: true });
      }
    } finally {
      this.historyPrependAnchorEl = null;
      this.historyPrependInsertIndex = 0;
    }
    this.historyShownCount = visibleMessages.length;
    this.historyTotalCount = total;
    this.renderHistoryBanner();
    if (chat) {
      chat.scrollTop = oldScrollTop + (chat.scrollHeight - oldScrollHeight);
    }
  }

  /** Render the "Showing N of M" + "Load earlier" banner above the chat. */
  private renderHistoryBanner(): void {
    if (!this.chatContainer) return;
    if (this.historyBannerEl) this.historyBannerEl.remove();
    this.historyBannerEl = null;
    if (this.historyTotalCount <= this.historyShownCount) return;

    const banner = this.chatContainer.createDiv("pi-agent-history-banner");
    const text = banner.createSpan("pi-agent-history-banner-text");
    text.setText(
      `Showing the latest ${this.historyShownCount} of ${this.historyTotalCount} messages`
    );
    const btn = banner.createEl("button", {
      text: "Load 50 more",
      cls: "pi-agent-history-banner-btn",
    });
    btn.onclick = () => {
      btn.setText("Loading…");
      btn.disabled = true;
      void this.loadMoreHistory(50).finally(() => {
        btn.setText("Load 50 more");
        btn.disabled = false;
      });
    };
    const allBtn = banner.createEl("button", {
      text: "Load all",
      cls: "pi-agent-history-banner-btn pi-agent-history-banner-btn-secondary",
    });
    allBtn.onclick = () => {
      allBtn.setText("Loading…");
      allBtn.disabled = true;
      void this.loadMoreHistory(this.historyTotalCount).finally(() => {
        allBtn.setText("Load all");
        allBtn.disabled = false;
      });
    };
    this.chatContainer.prepend(banner);
    this.historyBannerEl = banner;
  }

  private finalizeAssistantMessageVisibility(message: RenderedMessage): void {
    const hasText = !!message.contentEl.querySelector(".pi-agent-text-block");
    const thinkingBlocks = Array.from(
      message.contentEl.querySelectorAll(".pi-agent-thinking-block")
    ) as HTMLElement[];
    const hasThinking = thinkingBlocks.some((block) => {
      const content = block.querySelector(".pi-agent-thinking-content") as HTMLElement | null;
      return !!content?.textContent?.trim();
    });
    const hasTool = !!message.contentEl.querySelector(".pi-agent-tool-block");
    const hasError = !!message.contentEl.querySelector(".pi-agent-error-block");

    for (const block of thinkingBlocks) {
      const content = block.querySelector(".pi-agent-thinking-content") as HTMLElement | null;
      if (!content?.textContent?.trim()) block.remove();
    }

    if (!hasText && !hasThinking && !hasTool && !hasError) {
      message.el.remove();
      this.renderedMessages = this.renderedMessages.filter((m) => m !== message);
      return;
    }

    message.el.toggleClass("is-tool-only", hasTool && !hasText && !hasThinking);
  }

  /** Render a single message from a history payload (file or RPC). */
  private renderMessageFromHistory(
    msg: any,
    options: { prependHistory?: boolean } = {}
  ): void {
    const messageOptions = { ...options, entryId: msg.entryId };
    if (msg.role === "user") {
      const content =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? msg.content.map((c: any) => c.text || "").join("")
            : "";
      this.addMessage("user", this.stripRecentContextGuard(content), messageOptions);
    } else if (msg.role === "compactionSummary") {
      this.addCompactionSummaryMessage(msg.summary || "", msg.tokensBefore, "Context compacted", options);
    } else if (msg.role === "branchSummary") {
      this.addCompactionSummaryMessage(msg.summary || "", undefined, "Branch summary", options);
    } else if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === "string" && msg.content.trim()
          ? [{ type: "text", text: msg.content }]
          : [];
      const hasVisibleText = blocks.some((block: any) => block.type === "text" && String(block.text || "").trim());
      const hasVisibleThinking = blocks.some((block: any) => block.type === "thinking" && String(block.thinking || "").trim());
      const hasToolCall = blocks.some((block: any) => block.type === "toolCall");
      if (!hasVisibleText && !hasVisibleThinking && !hasToolCall) return;

      const rendered = this.addMessage("assistant", "", messageOptions);
      this.currentAssistantMsg = rendered;
      if (blocks.length > 0) {
        for (const block of blocks) {
          if (block.type === "text" && block.text) {
            rendered.el.setAttribute("data-raw-content", block.text);
            const textBlock =
              rendered.contentEl.createDiv("pi-agent-text-block markdown-preview-view markdown-rendered");
            void MarkdownRenderer.render(this.app, this.normalizeAssistantMarkdown(block.text), textBlock, "", this);
          } else if (block.type === "thinking" && this.plugin.settings.showThinking && String(block.thinking || "").trim()) {
            const tb = rendered.contentEl.createDiv("pi-agent-thinking-block is-collapsed");
            const header = tb.createDiv("pi-agent-thinking-header");
            const iconSpan = header.createSpan("pi-agent-thinking-icon");
            setIcon(iconSpan, "brain");
            const textSpan = header.createSpan("pi-agent-thinking-text");
            textSpan.setText(" Thought");
            tb.createDiv("pi-agent-thinking-content").textContent = block.thinking || "";
            header.onclick = () => {
              tb.toggleClass("is-collapsed", !tb.hasClass("is-collapsed"));
            };
          } else if (block.type === "toolCall") {
            this.handleToolStart({
              type: "tool_execution_start",
              toolName: block.name,
              toolCallId: block.id,
              args: block.arguments
            });
          }
        }
      }
      this.finalizeAssistantMessageVisibility(rendered);
      this.currentAssistantMsg = null;
    } else if (msg.role === "toolResult") {
      const toolResultContent = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === "string"
          ? [{ type: "text", text: msg.content }]
          : [];
      this.handleToolEnd({
        type: "tool_execution_end",
        toolName: msg.toolName,
        toolCallId: msg.toolCallId,
        isError: msg.isError,
        result: {
          content: toolResultContent,
          isError: msg.isError,
          details: msg.details
        }
      });
    }
  }

  private updateButtons(): void {
    const redirectBusy = this.hardSteerInFlight || this.abortInFlight;
    const latestUserMessage = [...this.renderedMessages]
      .reverse()
      .find((message) => message.role === "user");
    for (const message of this.renderedMessages) {
      if (!message.steerBtn) continue;
      const canSteer =
        this.isStreaming &&
        (message.el.hasClass("is-queued") || message === latestUserMessage);
      if (canSteer) {
        message.steerBtn.removeClass("pi-agent-hidden");
        message.steerBtn.disabled = redirectBusy;
      } else {
        message.steerBtn.addClass("pi-agent-hidden");
        message.steerBtn.disabled = true;
      }
    }
    if (this.steerBtn) {
      if (this.isStreaming) {
        this.steerBtn.removeClass("pi-agent-hidden");
        this.steerBtn.disabled = redirectBusy;
      } else {
        this.steerBtn.addClass("pi-agent-hidden");
        this.steerBtn.disabled = redirectBusy;
      }
    }
    if (this.abortBtn) {
      if (this.isStreaming) {
        this.abortBtn.removeClass("pi-agent-hidden");
      } else {
        this.abortBtn.addClass("pi-agent-hidden");
      }
      this.abortBtn.disabled = redirectBusy;
    }
    this.containerEl.toggleClass("is-generating", this.isStreaming);
  }

  private getBasename(pathText: string): string {
    if (!pathText) return "";
    const parts = pathText.split(/[/\\]/);
    return parts[parts.length - 1] || pathText;
  }

  private formatToolArgs(
    toolName: string,
    args: Record<string, unknown>
  ): string {
    switch (toolName) {
      case "read":
      case "view_file":
      case "read_url_content":
      case "read_browser_page": {
        const path = (args.path as string) || (args.AbsolutePath as string) || (args.Url as string) || (args.TargetFile as string) || (args.target as string) || "";
        const base = this.getBasename(path);
        return `${base}${args.offset ? ` (offset: ${args.offset})` : ""}`;
      }
      case "bash":
      case "run_command": {
        const cmd = (args.command as string) || (args.CommandLine as string) || "";
        return cmd.length > 35 ? cmd.slice(0, 35) + "..." : cmd;
      }
      case "write":
      case "write_to_file": {
        const path = (args.path as string) || (args.TargetFile as string) || (args.target as string) || "";
        return this.getBasename(path);
      }
      case "edit":
      case "replace_file_content":
      case "multi_replace_file_content": {
        const path = (args.path as string) || (args.TargetFile as string) || (args.target as string) || "";
        return this.getBasename(path);
      }
      case "grep":
      case "grep_search":
        return `${args.pattern || args.Query || ""}`;
      case "find":
      case "find_by_name":
        return `${args.pattern || args.Pattern || ""}`;
      case "search_web":
        return `${args.query || ""}`;
      case "ls":
      case "list_dir": {
        return this.getBasename((args.path as string) || (args.DirectoryPath as string) || ".");
      }
      default:
        return JSON.stringify(args).slice(0, 100);
    }
  }

  private getToolIcon(toolName: string): string {
    switch (toolName) {
      case "read":
      case "view_file":
      case "read_url_content":
      case "read_browser_page":
        return "◇";
      case "write":
      case "write_to_file":
        return "⊞";
      case "edit":
      case "replace_file_content":
      case "multi_replace_file_content":
        return "✎";
      case "bash":
      case "run_command":
        return "⌘";
      case "grep":
      case "grep_search":
      case "find":
      case "find_by_name":
      case "search_web":
        return "⌕";
      case "ls":
      case "list_dir":
        return "▣";
      default:
        return "✧";
    }
  }

  private toTitleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }

  private renderDiffOutput(container: HTMLElement, diffText: string): void {
    const actions = container.createDiv("pi-agent-diff-actions");
    const copy = actions.createEl("button", { text: "Copy diff" });
    copy.onclick = (event) => {
      event.stopPropagation();
      void navigator.clipboard.writeText(diffText).then(() => {
        new Notice("Diff copied");
      }).catch((err: unknown) => {
        console.error("[pimate] copy diff failed", err);
      });
    };

    const pre = container.createEl("pre", { cls: "pi-agent-diff-pre" });
    const shown = diffText.length > 12000 ? diffText.slice(0, 12000) + "\n…" : diffText;
    for (const line of shown.split("\n")) {
      const span = pre.createSpan({ text: `${line}\n` });
      if (line.startsWith("+") && !line.startsWith("+++")) span.addClass("pi-agent-diff-line-add");
      else if (line.startsWith("-") && !line.startsWith("---")) span.addClass("pi-agent-diff-line-remove");
      else if (line.startsWith("@@")) span.addClass("pi-agent-diff-line-hunk");
      else if (line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---")) {
        span.addClass("pi-agent-diff-line-meta");
      }
    }
  }

  private getDiffText(details: unknown): string {
    if (!details || typeof details !== "object") return "";
    const maybeDetails = details as Record<string, unknown>;
    return typeof maybeDetails.patch === "string"
      ? maybeDetails.patch
      : typeof maybeDetails.diff === "string"
      ? maybeDetails.diff
      : "";
  }

  private getDiffStats(
    details: unknown
  ): { added: number; removed: number } | null {
    const diff = this.getDiffText(details);
    if (!diff) return null;

    let added = 0;
    let removed = 0;
    for (const line of diff.split("\n")) {
      if (line.startsWith("+++") || line.startsWith("---")) continue;
      if (line.startsWith("+")) added++;
      if (line.startsWith("-")) removed++;
    }
    return added || removed ? { added, removed } : null;
  }

  async onClose(): Promise<void> {
    if (this.thinkingTimer) {
      window.clearInterval(this.thinkingTimer);
      this.thinkingTimer = null;
    }
    if (this.renderTimeout) {
      window.clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    if (this.speedTimer) {
      window.clearInterval(this.speedTimer);
      this.speedTimer = null;
    }
    if (this.speedHideTimer) {
      window.clearTimeout(this.speedHideTimer);
      this.speedHideTimer = null;
    }

    await this.persistSessionTabs();
    for (const tab of this.tabs) {
      await tab.client?.destroy();
      tab.client = null;
    }
    this.client = null;
  }

  // ─── Stream Render Methods ──────────────────────────────────────────

  private shouldUsePrettyStreaming(rawLength: number): boolean {
    const mode = this.plugin.settings.streamingRenderMode || "auto";
    if (mode === "pretty") return true;
    if (mode === "fast") return false;
    // Auto: stay in cheap fast streaming while tokens are flowing; an idle
    // debounce in throttleRender() promotes the accumulated text to pretty
    // when the model pauses. Pretty is also force-flushed at text_end /
    // message_end so we never leave a reply half-decorated.
    return false;
  }

  private isAutoStreamingMode(): boolean {
    const mode = this.plugin.settings.streamingRenderMode || "auto";
    return mode === "auto";
  }

  private convertCurrentTextBlockToFastStreaming(): void {
    if (!this.currentTextBlock) return;
    this.currentTextBlock.classList.remove("markdown-preview-view", "markdown-rendered");
    this.currentTextBlock.classList.add("pi-agent-streaming-block");
    this.currentTextBlock.empty();
    this.streamingTextEl = this.currentTextBlock.createDiv("pi-agent-streaming-text");
    this.streamingCursorEl = this.currentTextBlock.createSpan("pi-agent-streaming-cursor");
  }

  private throttleRender(rawText: string, targetEl: HTMLElement): void {
    if (this.renderTimeout) {
      window.clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }

    // In auto mode we behave like an idle debounce: keep fast text on screen,
    // and only promote to pretty MarkdownRenderer when the model pauses.
    // Pretty throttles on a 150ms cadence (was 80ms) to leave the main thread
    // some breathing room on long replies. Fast mode is unaffected.
    const isAuto = this.isAutoStreamingMode();
    const delay = isAuto ? 140 : 150;

    const now = Date.now();
    if (now - this.lastRenderTime >= delay) {
      this.renderMarkdownWithCursor(rawText, targetEl);
      this.lastRenderTime = now;
    } else {
      this.renderTimeout = window.setTimeout(() => {
        this.renderMarkdownWithCursor(rawText, targetEl);
        this.lastRenderTime = Date.now();
      }, delay - (now - this.lastRenderTime));
    }
  }

  // Lightweight appender used during streaming. We only set the textContent of
  // two <div>/<span> nodes — no MarkdownRenderer pass, no DOM re-build, no
  // markdown re-parse. The final MarkdownRenderer.render() happens once at
  // message_end in handleMessageEnd().
  //
  // In auto mode we additionally promote the in-flight fast text to pretty
  // Markdown as soon as the model emits a newline, so each completed
  // paragraph / list item / table row is rendered with full formatting
  // exactly once, without forcing a 140ms idle wait.
  private appendStreamingDelta(rawText: string, deltaText: string): void {
    if (this.renderTimeout) {
      window.clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    const now = Date.now();
    const delay = 50;
    const apply = () => {
      const shouldStickToBottom = this.isNearBottom();
      if (this.streamingTextEl) {
        this.streamingTextEl.textContent = rawText;
      }
      if (shouldStickToBottom) this.scrollToBottom(true, true);
      this.lastRenderTime = Date.now();
    };
    if (now - this.lastRenderTime >= delay) {
      apply();
    } else {
      this.renderTimeout = window.setTimeout(
        apply,
        delay - (now - this.lastRenderTime)
      );
    }

    if (
      this.isAutoStreamingMode() &&
      deltaText &&
      deltaText.includes("\n") &&
      !this.isInsideUnclosedFence(rawText)
    ) {
      this.flushPrettyIfNeeded();
    }
  }

  private isInsideUnclosedFence(text: string): boolean {
    // Treat a line as a fenced code block delimiter only when the marker
    // occupies the whole line (after optional indentation). This avoids
    // mis-counting lines like `open \`\`\` here` or `\`\`\`` embedded in
    // prose as fence openers/closers.
    let inFence = false;
    let fenceChar = "";
    let fenceLen = 0;
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)\s*$/);
      if (!match) continue;
      const marker = match[1];
      const markerChar = marker[0];
      if (!inFence) {
        inFence = true;
        fenceChar = markerChar;
        fenceLen = marker.length;
      } else if (markerChar === fenceChar && marker.length >= fenceLen) {
        inFence = false;
        fenceChar = "";
        fenceLen = 0;
      }
    }
    return inFence;
  }

  // Promote the in-flight fast text to pretty Markdown right now. Used by
  // auto mode at text_end / message_end to guarantee the user never sees an
  // unrendered reply.
  private flushPrettyIfNeeded(): void {
    if (!this.isAutoStreamingMode()) return;
    if (!this.currentTextBlock || !this.streamingTextEl) return;
    const raw = this.currentTextBlock.getAttribute("data-stream-raw")
      || this.streamingTextEl.textContent
      || "";
    if (!raw) return;
    this.renderMarkdownWithCursor(raw, this.currentTextBlock);
  }

  private normalizeAssistantMarkdown(text: string): string {
    if (!text) return text;
    const codeBlocks: string[] = [];
    const placeholderPrefix = "@@PIMATE_CODE_BLOCK_";
    const protectedText = text.replace(/```[\s\S]*?```/g, (block) => {
      const key = `${placeholderPrefix}${codeBlocks.length}@@`;
      codeBlocks.push(block);
      return key;
    });

    const normalized = protectedText
      // Fix: "文字###标题" -> "文字\n\n### 标题".
      .replace(/([^\n])([ \t]*#{2,6})(?=[\p{L}\p{N}])/gu, (_m, before, hashes) => {
        return `${before}\n\n${hashes.trim()} `;
      })
      // Fix: "###A." / "###第1步" -> "### A." / "### 第1步".
      .replace(/^(#{1,6})(?!\s)([^#\s].*)$/gmu, (_m, hashes, rest) => {
        return `${hashes} ${rest}`;
      })
      // Fix: "### C.暂停" -> "### C. 暂停".
      .replace(/^(#{1,6}\s+[A-Za-z]\.)(?=\S)/gmu, "$1 ");

    return normalized.replace(
      new RegExp(`${placeholderPrefix}(\\d+)@@`, "g"),
      (_m, index) => codeBlocks[Number(index)] || ""
    );
  }

  private renderMarkdownWithCursor(rawText: string, targetEl: HTMLElement): void {
    const shouldStickToBottom = this.isNearBottom();
    targetEl.empty();

    const normalizedText = this.normalizeAssistantMarkdown(rawText);
    const inCodeblock = this.isInsideUnclosedFence(normalizedText);

    const cursor = inCodeblock ? " ▊" : ' <span class="pi-agent-typing-cursor">▊</span>';
    const textWithCursor = normalizedText + cursor;
    const finalRenderText = inCodeblock ? textWithCursor + "\n```" : textWithCursor;

    void MarkdownRenderer.render(
      this.app,
      finalRenderText,
      targetEl,
      "",
      this
    ).then(() => {
      if (shouldStickToBottom) this.scrollToBottom(true, true);
    });
  }

  // ─── Autocomplete Mention Methods ───────────────────────────────────

  private handleMentionInput(): void {
    if (!this.inputEl) return;
    const value = this.inputEl.value;
    const caretPos = this.inputEl.selectionStart;

    let atIndex = -1;
    for (let i = caretPos - 1; i >= 0; i--) {
      const char = value[i];
      if (char === " " || char === "\n") {
        break;
      }
      if (char === "@") {
        if (i === 0 || value[i - 1] === " " || value[i - 1] === "\n") {
          atIndex = i;
          break;
        }
      }
    }

    if (atIndex !== -1) {
      const query = value.slice(atIndex + 1, caretPos).toLowerCase();
      this.mentionQueryStart = atIndex;
      this.showMentionDropdown(query);
    } else {
      this.closeMentionDropdown();
    }
  }

  private showMentionDropdown(query: string): void {
    if (!this.inputEl) return;

    if (!this.mentionDropdown) {
      const inputArea = this.inputEl.parentElement;
      if (!inputArea) return;
      this.mentionDropdown = inputArea.createDiv({ cls: "pi-agent-mention-dropdown" });
    }

    const q = query.toLowerCase();
    const files = this.getAttachableFiles();
    const folders: TFolder[] = (this.app.vault as any).getAllFolders
      ? (this.app.vault as any).getAllFolders()
      : this.collectAllFolders();

    const fileEntries = files
      .map((file) => this.createMentionEntry("file", file, q))
      .filter((entry): entry is MentionEntry => entry !== null);
    const folderEntries = folders
      .map((folder) => this.createMentionEntry("folder", folder, q))
      .filter((entry): entry is MentionEntry => entry !== null);

    this.filteredMentionFiles = [...folderEntries, ...fileEntries]
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        return a.path.localeCompare(b.path);
      })
      .slice(0, 20);

    this.renderMentionDropdownItems();
  }

  private createMentionEntry(
    kind: "file" | "folder",
    item: TFile | TFolder,
    query: string
  ): MentionEntry | null {
    const path = item.path || "/";
    const name = item instanceof TFile ? item.basename : item.name || path;
    const score = this.scoreMentionMatch(name, path, query);
    if (score <= 0) return null;

    const activeFile = this.app.workspace.getActiveFile();
    const activeFileBonus = item instanceof TFile && activeFile?.path === item.path ? 100 : 0;
    const typeBonus = kind === "folder" ? 20 : 0;

    return {
      kind,
      file: item instanceof TFile ? item : undefined,
      folder: item instanceof TFolder ? item : undefined,
      score: score + activeFileBonus + typeBonus,
      path,
      name,
    };
  }

  private scoreMentionMatch(name: string, path: string, query: string): number {
    if (!query) return 100;

    const q = query.toLowerCase();
    const n = name.toLowerCase();
    const p = path.toLowerCase();

    if (n === q || p === q) return 1000;
    if (n.startsWith(q)) return 800;
    if (p.startsWith(q)) return 700;
    if (n.includes(q)) return 600;
    if (p.includes(q)) return 400;
    return 0;
  }

  private collectAllFolders(): TFolder[] {
    const out: TFolder[] = [];
    const root = this.app.vault.getRoot();
    const walk = (folder: TFolder) => {
      out.push(folder);
      for (const child of folder.children ?? []) {
        if (child instanceof TFolder) walk(child);
      }
    };
    if (root) walk(root);
    return out;
  }

  private renderMentionDropdownItems(): void {
    if (!this.mentionDropdown) return;
    this.mentionDropdown.empty();

    if (this.filteredMentionFiles.length === 0) {
      this.closeMentionDropdown();
      return;
    }

    this.activeMentionIndex = Math.min(
      this.activeMentionIndex,
      this.filteredMentionFiles.length - 1
    );
    if (this.activeMentionIndex < 0) this.activeMentionIndex = 0;

    this.filteredMentionFiles.forEach((entry, index) => {
      const itemEl = this.mentionDropdown!.createDiv({
        cls: `pi-agent-mention-item ${index === this.activeMentionIndex ? "is-active" : ""}`,
      });
      const icon =
        entry.kind === "folder"
          ? "📁"
          : this.getFileTypeIcon(entry.file!.extension);
      const label = entry.kind === "folder" ? entry.path : entry.name;
      const subLabel = entry.kind === "folder" ? "" : entry.path;

      itemEl.createSpan({ text: icon + " ", cls: "pi-agent-mention-item-icon" });
      const textEl = itemEl.createDiv({ cls: "pi-agent-mention-item-text" });
      textEl.createSpan({ text: label, cls: "pi-agent-mention-item-name" });
      if (subLabel && subLabel !== label) {
        textEl.createSpan({ text: subLabel, cls: "pi-agent-mention-item-path" });
      }

      itemEl.onclick = (e) => {
        e.stopPropagation();
        this.activeMentionIndex = index;
        this.insertMentionSelection();
      };
    });
  }

  private insertMentionSelection(): void {
    if (!this.inputEl || this.mentionQueryStart === -1) return;
    const entry = this.filteredMentionFiles[this.activeMentionIndex];
    if (!entry) return;

    const value = this.inputEl.value;
    const caretPos = this.inputEl.selectionStart;

    const before = value.slice(0, this.mentionQueryStart);
    const after = value.slice(caretPos);

    let mentionText: string;
    if (entry.kind === "folder") {
      const folder = entry.folder;
      if (!folder) return;
      mentionText = `[[${(folder.path || "/")}/]]`;
      this.addFolderContextItem(folder, false);
    } else {
      const file = entry.file;
      if (!file) return;
      mentionText = `[[${file.basename}]]`;
      this.addFileContextItem(file);
    }

    this.inputEl.value = before + mentionText + " " + after;

    const newCaretPos = this.mentionQueryStart + mentionText.length + 1;
    this.inputEl.setSelectionRange(newCaretPos, newCaretPos);

    this.closeMentionDropdown();
    this.inputEl.focus();
  }

  private closeMentionDropdown(): void {
    if (this.mentionDropdown) {
      this.mentionDropdown.remove();
      this.mentionDropdown = null;
    }
    this.mentionQueryStart = -1;
    this.filteredMentionFiles = [];
    this.activeMentionIndex = 0;
  }

  // ─── Autocomplete Slash Command Methods ─────────────────────────────

  /** Add direct RPC operations that Pi intentionally omits from get_commands. */
  private mergePimateCommands(piCommands: PiCommandInfo[]): PiCommandInfo[] {
    const seen = new Set<string>();
    const bridgePath = this.plugin.piReloadBridgePath;
    const vaultBasePath = (this.app.vault.adapter as any).getBasePath?.() || process.cwd();
    const visiblePiCommands = bridgePath
      ? piCommands.filter(
          (command) => !isPiCommandFromPath(command, bridgePath, vaultBasePath)
        )
      : piCommands;
    return [...PIMATE_BUILTIN_COMMANDS, ...visiblePiCommands].filter((command) => {
      const name = command?.name?.trim();
      if (!name) return false;
      const key = name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private async loadAvailableCommands(expectedClient: AgentClient | null = this.client): Promise<void> {
    const client = expectedClient;
    if (!client) return;

    if (this.commandCatalogClient === client) return;

    if (this.commandLoadPromise && this.commandLoadClient === client) {
      await this.commandLoadPromise;
      return;
    }

    const request = (async () => {
      try {
        const res = await client.getCommands();
        // A tab switch can replace the active client while the RPC is in
        // flight. Do not leak the previous tab's command list into the new
        // composer.
        if (this.client !== client || this.activeTab?.client !== client) return;
        const piCommands = res.success && res.data
          ? ((res.data as any).commands || []) as PiCommandInfo[]
          : [];
        this.availableCommands = this.mergePimateCommands(piCommands);
        this.commandCatalogClient = client;
      } catch {}
    })();

    this.commandLoadClient = client;
    this.commandLoadPromise = request;
    try {
      await request;
    } finally {
      if (this.commandLoadPromise === request) {
        this.commandLoadPromise = null;
        this.commandLoadClient = null;
      }
    }
  }

  private getSlashCommandQuery(): string | null {
    if (!this.inputEl) return null;
    const value = this.inputEl.value;
    const caretPos = this.inputEl.selectionStart;
    if (caretPos <= 0) return null;

    // Pi executes extension commands, skills, and prompt templates only when the
    // command begins the submitted message. Keep completion aligned with that
    // execution contract rather than suggesting inert mid-sentence tokens.
    const beforeCaret = value.slice(0, caretPos);
    const match = beforeCaret.match(/^\s*(\/[^\s]*)$/);
    if (!match) return null;

    const commandToken = match[1];
    this.commandQueryStart = beforeCaret.length - commandToken.length;
    return commandToken.slice(1).toLowerCase();
  }

  private handleCommandInput(): void {
    if (!this.inputEl) return;
    const query = this.getSlashCommandQuery();

    if (query !== null) {
      this.showCommandDropdown(query);

      // Command loading is intentionally fire-and-forget during tab startup.
      // If the user types `/` before that RPC completes, retry the render as
      // soon as the authoritative list arrives instead of leaving an empty
      // inline dropdown.
      if (this.commandCatalogClient !== this.client) {
        void this.loadAvailableCommands().then(() => {
          const refreshedQuery = this.getSlashCommandQuery();
          if (refreshedQuery !== null) {
            this.showCommandDropdown(refreshedQuery);
          }
        });
      }
    } else {
      this.closeCommandDropdown();
    }
  }

  private showCommandDropdown(query: string): void {
    if (!this.inputEl) return;

    if (!this.commandDropdown) {
      const inputArea = this.inputEl.parentElement;
      if (!inputArea) return;
      this.commandDropdown = inputArea.createDiv({ cls: "pi-agent-command-dropdown" });
    }

    this.filteredCommands = this.availableCommands
      .filter((cmd) => cmd.name.toLowerCase().includes(query) || (cmd.description && cmd.description.toLowerCase().includes(query)))
      .slice(0, 5);

    this.renderCommandDropdownItems();
  }

  private renderCommandDropdownItems(): void {
    if (!this.commandDropdown) return;
    this.commandDropdown.empty();

    if (this.filteredCommands.length === 0) {
      this.closeCommandDropdown();
      return;
    }

    this.activeCommandIndex = Math.min(
      this.activeCommandIndex,
      this.filteredCommands.length - 1
    );
    if (this.activeCommandIndex < 0) this.activeCommandIndex = 0;

    this.filteredCommands.forEach((cmd, index) => {
      const itemEl = this.commandDropdown!.createDiv({
        cls: `pi-agent-command-item ${index === this.activeCommandIndex ? "is-active" : ""}`,
      });
      itemEl.createSpan({ text: "⚡ ", cls: "pi-agent-command-item-icon" });
      itemEl.createSpan({ text: `/${cmd.name}`, cls: "pi-agent-command-item-name" });
      if (cmd.description) {
        itemEl.createSpan({ text: ` - ${cmd.description}`, cls: "pi-agent-command-item-desc" });
      }

      itemEl.onclick = (e) => {
        e.stopPropagation();
        this.activeCommandIndex = index;
        this.insertCommandSelection();
      };
    });
  }

  private insertCommandSelection(): void {
    if (!this.inputEl || this.commandQueryStart === -1) return;
    const cmd = this.filteredCommands[this.activeCommandIndex];
    if (!cmd) return;

    const value = this.inputEl.value;
    const caretPos = this.inputEl.selectionStart;

    const before = value.slice(0, this.commandQueryStart);
    const after = value.slice(caretPos);

    const commandText = `/${cmd.name}`;
    this.inputEl.value = before + commandText + " " + after;

    const newCaretPos = this.commandQueryStart + commandText.length + 1;
    this.inputEl.setSelectionRange(newCaretPos, newCaretPos);

    this.closeCommandDropdown();
    this.resizeInputEl();
    this.inputEl.focus();
  }

  private closeCommandDropdown(): void {
    if (this.commandDropdown) {
      this.commandDropdown.remove();
      this.commandDropdown = null;
    }
    this.commandQueryStart = -1;
    this.filteredCommands = [];
    this.activeCommandIndex = 0;
  }

  private getThinkingLevelLabel(level: string): string {
    const v = level?.toLowerCase() || "";
    switch (v) {
      case "":
      case "auto":
        return "Auto";
      case "off":
        return "Off";
      case "minimal":
        return "Minimal";
      case "low":
        return "Low";
      case "medium":
        return "Medium";
      case "high":
        return "High";
      case "xhigh":
        return "XHigh";
      case "max":
        return "Max";
      default:
        // Unknown level from Pi — render the raw id so the user can see
        // exactly what the model is using, instead of masking it as "Auto".
        return level || "Auto";
    }
  }

  private async showThinkingLevelSelector(): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";

    const tab = this.activeTab;
    if (tab?.client) {
      await this.syncTabStateFromPi(tab);
    }
    const { options, note } = this.buildThinkingLevelOptions(tab);

    let modalOptions: ThinkingLevelOption[];
    if (options.length === 0) {
      new Notice(note ?? (isZh ? "当前模型没有可选思考档位" : "No selectable thinking level for current model"));
      return;
    } else {
      modalOptions = options.map((opt) => ({
        id: opt.id,
        name: `${opt.name} (${opt.id})`,
        desc: opt.desc,
      }));
    }

    new ThinkingLevelSuggestModal(this.app, modalOptions, isZh, async (option) => {
      await this.updateActiveTabThinkingLevel(option.id);
      new Notice(isZh ? `思考强度已设为 ${option.name}` : `Thinking level set to ${option.name}`);
    }).open();
  }

  public async setupStaticTabs(): Promise<void> {
    const maxTabs = this.plugin.settings.maxTabs || 3;
    if (this.tabs.length > maxTabs) {
      this.tabs = this.tabs.slice(0, maxTabs);
    } else {
      while (this.tabs.length < maxTabs) {
        const i = this.tabs.length + 1;
        const defaultEngine = this.plugin.settings.enableAntigravity === false
          ? "pi"
          : (this.plugin.settings.defaultEngine || "pi");
        this.tabs.push({
          id: `tab-static-${i}`,
          label: String(i),
          client: null,
          isStreaming: false,
          engine: defaultEngine,
          modelProvider: defaultEngine === "antigravity" ? "antigravity" : this.plugin.settings.provider,
          modelId: defaultEngine === "antigravity" ? this.plugin.settings.agyModel : this.plugin.settings.modelId,
          thinkingLevel: defaultEngine === "antigravity" ? this.plugin.settings.agyEffort : this.plugin.settings.thinkingLevel,
        });
      }
    }
    this.restoreTabModelConfig();
    if (!this.tabs.some((t) => t.id === this.activeTabId)) {
      this.saveActiveComposerState();
      this.activeTabId = this.tabs[0]?.id || null;
    }
    this.renderTabs();
    if (this.activeTabId) {
      await this.switchToTab(this.activeTabId);
    }
  }

  private activeDropdown: "model" | "effort" | null = null;
  private activeDropdownEl: HTMLElement | null = null;
  private piModelsCache: PiModel[] | null = null;
  private agyModelsCache: PiModel[] | null = null;

  private getModelsCacheForEngine(engine?: string): PiModel[] | null {
    const eng = engine || this.activeTab?.engine || this.plugin.settings.defaultEngine || "pi";
    return eng === "antigravity" ? this.agyModelsCache : this.piModelsCache;
  }

  private setModelsCacheForEngine(engine: string, models: PiModel[]): void {
    if (engine === "antigravity") {
      this.agyModelsCache = models;
    } else {
      this.piModelsCache = models;
    }
  }

  private modelOutsideClickHandler: ((e: MouseEvent) => void) | null = null;
  private effortOutsideClickHandler: ((e: MouseEvent) => void) | null = null;

  private getModelShortName(modelId: string): string {
    const lower = modelId.toLowerCase();
    if (lower.includes("opus")) return "Opus";
    if (lower.includes("sonnet")) return "Sonnet";
    if (lower.includes("haiku")) return "Haiku";
    if (lower.includes("deepseek")) {
      if (lower.includes("reasoner") || lower.includes("r1")) return "DeepSeek-R1";
      if (lower.includes("chat") || lower.includes("v3")) return "DeepSeek-V3";
      const last = modelId.split("/").pop() || modelId;
      if (last.toLowerCase() === "deepseek") return "DeepSeek";
      return last.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join("-");
    }
    if (lower.includes("gemini")) return "Gemini";
    if (lower.includes("gpt-4o")) return "GPT-4o";
    if (lower.includes("o1")) return "o1";
    if (lower.includes("o3")) return "o3";
    return modelId.split("/").pop() || modelId;
  }

  private getProviderIconName(provider: string, modelId: string): string {
    const p = provider.toLowerCase();
    const m = modelId.toLowerCase();
    if (p.includes("xiaomi") || p.includes("小米") || m.includes("xiaomi") || m.includes("milm")) return "pi-agent-icon-xiaomi";
    if (p.includes("openai") || p.includes("gpt") || m.includes("gpt")) return "pi-agent-icon-openai";
    if (p.includes("anthropic") || p.includes("claude") || m.includes("claude")) return "pi-agent-icon-claude";
    if (p.includes("deepseek") || m.includes("deepseek")) return "pi-agent-icon-deepseek";
    if (p.includes("minimax") || m.includes("minimax")) return "pi-agent-icon-minimax";
    if (p.includes("google") || p.includes("gemini") || m.includes("gemini")) return "pi-agent-icon-gemini";
    if (p.includes("volcengine") || p.includes("doubao") || p.includes("seed") || m.includes("doubao") || m.includes("seed")) return "pi-agent-icon-volcengine";
    if (p.includes("siliconflow") || p.includes("siliconcloud") || m.includes("siliconflow") || m.includes("siliconcloud")) return "pi-agent-icon-siliconflow";
    if (p.includes("zhipu") || p.includes("智谱") || m.includes("glm") || m.includes("zhipu")) return "pi-agent-icon-zhipu";
    return "pi-agent-icon-claude";
  }

}

class CommandSuggestModal extends SuggestModal<PiCommandInfo> {
  constructor(
    app: App,
    private readonly commands: PiCommandInfo[],
    private readonly onChoose: (command: PiCommandInfo) => void
  ) {
    super(app);
    this.setPlaceholder("Search commands and skills...");
  }

  getSuggestions(query: string): PiCommandInfo[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.commands.slice(0, 80);
    return this.commands
      .filter((command) =>
        `${command.name} ${command.description || ""} ${command.source || ""}`
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 80);
  }

  renderSuggestion(command: PiCommandInfo, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({
      text: `/${command.name}`,
      cls: "pi-agent-suggestion-title",
    });
    el.createDiv({
      text: `${command.source || "command"}${command.description ? ` · ${command.description}` : ""}`,
      cls: "pi-agent-suggestion-note",
    });
  }

  onChooseSuggestion(command: PiCommandInfo): void {
    this.onChoose(command);
  }
}

class ResumeSessionSuggestModal extends SuggestModal<ResumeSessionItem> {
  constructor(
    app: App,
    private readonly sessions: ResumeSessionItem[],
    private readonly onChoose: (session: ResumeSessionItem) => void | Promise<void>,
    placeholder = "Resume which Pi session?"
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): ResumeSessionItem[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.sessions;
    return this.sessions
      .filter((session) =>
        `${session.label} ${session.preview || ""} ${session.path || ""} ${session.conversationId || ""}`
          .toLowerCase()
          .includes(q)
      );
  }

  renderSuggestion(session: ResumeSessionItem, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({
      text: session.label || session.conversationId || basename(session.path),
      cls: "pi-agent-suggestion-title",
    });
    const date = new Date(session.mtime).toLocaleString();
    el.createDiv({
      text: `${date} · ${session.preview || session.conversationId || session.path}`,
      cls: "pi-agent-suggestion-note",
    });
  }

  onChooseSuggestion(session: ResumeSessionItem): void {
    void Promise.resolve(this.onChoose(session)).catch((err: unknown) => {
      console.error("[pimate] resume session selection failed", err);
    });
  }
}

class ResumeActionModal extends Modal {
  constructor(
    app: App,
    private readonly session: ResumeSessionItem,
    private readonly done: (action: "open" | "delete" | "cancel") => void | Promise<void>
  ) {
    super(app);
    this.titleEl.setText("Pimate session");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");
    contentEl.createDiv({ text: this.session.label, cls: "pi-agent-suggestion-title" });
    contentEl.createDiv({ text: this.session.path, cls: "pi-agent-suggestion-note" });
    if (this.session.preview) {
      const pre = contentEl.createEl("pre", { cls: "pi-agent-context-preview-text" });
      pre.setText(this.session.preview);
    }
    const buttons = contentEl.createDiv("pi-agent-editor-modal-buttons");
    const cancel = buttons.createEl("button", { text: "Cancel" });
    const del = buttons.createEl("button", { text: "Delete" });
    const open = buttons.createEl("button", { text: "Open", cls: "mod-cta" });
    cancel.onclick = () => {
      void Promise.resolve(this.done("cancel")).catch((err: unknown) => console.error("[pimate] resume action failed", err));
      this.close();
    };
    del.onclick = () => {
      void Promise.resolve(this.done("delete")).catch((err: unknown) => console.error("[pimate] resume action failed", err));
      this.close();
    };
    open.onclick = () => {
      void Promise.resolve(this.done("open")).catch((err: unknown) => console.error("[pimate] resume action failed", err));
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class ForkMessageSuggestModal extends SuggestModal<ForkMessage> {
  constructor(
    app: App,
    private readonly messages: ForkMessage[],
    private readonly onChoose: (message: ForkMessage) => void | Promise<unknown>
  ) {
    super(app);
    this.setPlaceholder("Fork from which previous prompt?");
  }

  getSuggestions(query: string): ForkMessage[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.messages.slice().reverse().slice(0, 80);
    return this.messages
      .filter((message) => message.text.toLowerCase().includes(q))
      .reverse()
      .slice(0, 80);
  }

  renderSuggestion(message: ForkMessage, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({
      text: message.text.split("\n")[0].slice(0, 90) || "Untitled prompt",
      cls: "pi-agent-suggestion-title",
    });
    el.createDiv({
      text: message.entryId,
      cls: "pi-agent-suggestion-note",
    });
  }

  onChooseSuggestion(message: ForkMessage): void {
    void Promise.resolve(this.onChoose(message)).catch((err: unknown) => {
      console.error("[pimate] fork message selection failed", err);
    });
  }
}

class ModelSuggestModal extends SuggestModal<PiModel> {
  constructor(
    app: App,
    private readonly models: PiModel[],
    private readonly onChoose: (model: PiModel) => void | Promise<void>
  ) {
    super(app);
    this.setPlaceholder("Search model, e.g. deepseek / claude / gpt...");
  }

  getSuggestions(query: string): PiModel[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.models.slice(0, 80);
    return this.models
      .filter((model) =>
        `${model.provider}/${model.id} ${model.name || ""}`
          .toLowerCase()
          .includes(q)
      )
      .slice(0, 80);
  }

  renderSuggestion(model: PiModel, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({
      text: model.name || model.id,
      cls: "pi-agent-suggestion-title",
    });
    el.createDiv({
      text: `${model.provider}/${model.id}`,
      cls: "pi-agent-suggestion-note",
    });
  }

  onChooseSuggestion(model: PiModel): void {
    void Promise.resolve(this.onChoose(model)).catch((err: unknown) => {
      console.error("[pimate] model selection failed", err);
    });
  }
}

class FileSuggestModal extends SuggestModal<TFile> {
  constructor(
    app: App,
    private readonly files: TFile[],
    private readonly onChoose: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Search file to attach as @context...");
  }

  getSuggestions(query: string): TFile[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.files.slice(0, 80);
    return this.files
      .filter((file) => file.path.toLowerCase().includes(q))
      .slice(0, 80);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({ text: file.basename, cls: "pi-agent-suggestion-title" });
    el.createDiv({ text: file.path, cls: "pi-agent-suggestion-note" });
  }

  onChooseSuggestion(file: TFile): void {
    this.onChoose(file);
  }
}

class PiAgentSelectModal extends SuggestModal<string> {
  private answered = false;

  constructor(
    app: App,
    private readonly modalTitle: string,
    private readonly options: string[],
    private readonly done: (value: string | null) => void
  ) {
    super(app);
    this.setPlaceholder(modalTitle || "Select an option");
  }

  getSuggestions(query: string): string[] {
    const q = query.toLowerCase();
    return this.options.filter((option) => option.toLowerCase().includes(q));
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.setText(value);
  }

  onChooseSuggestion(value: string): void {
    this.answered = true;
    this.done(value);
  }

  onClose(): void {
    super.onClose();
    if (!this.answered) this.done(null);
  }
}

class PiAgentInputModal extends Modal {
  private answered = false;
  private inputEl!: HTMLInputElement;

  constructor(
    app: App,
    title: string,
    private readonly placeholder: string,
    private readonly done: (value: string | null) => void
  ) {
    super(app);
    this.titleEl.setText(title || "Pimate input");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");
    this.inputEl = contentEl.createEl("input", {
      cls: "pi-agent-input-modal-input",
      attr: { type: "text", placeholder: this.placeholder },
    });
    this.inputEl.value = this.placeholder || "";
    this.inputEl.focus();
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.submit();
      if (e.key === "Escape") this.cancel();
    });

    const buttons = contentEl.createDiv("pi-agent-editor-modal-buttons");
    buttons.createEl("button", { text: "Cancel" }).onclick = () => this.cancel();
    buttons.createEl("button", { text: "OK", cls: "mod-cta" }).onclick = () => this.submit();
  }

  private submit(): void {
    this.answered = true;
    this.done(this.inputEl.value);
    this.close();
  }

  private cancel(): void {
    this.answered = true;
    this.done(null);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(null);
  }
}

class PiAgentConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    title: string,
    private readonly message: string,
    private readonly done: (confirmed: boolean) => void
  ) {
    super(app);
    this.titleEl.setText(title || "Pimate confirmation");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");
    const pre = contentEl.createEl("pre", { cls: "pi-agent-context-preview-text" });
    pre.setText(this.message || "Allow this action?");

    const buttons = contentEl.createDiv("pi-agent-editor-modal-buttons");
    const deny = buttons.createEl("button", { text: "Deny" });
    const allow = buttons.createEl("button", { text: "Allow", cls: "mod-cta" });
    deny.onclick = () => {
      this.answered = true;
      this.done(false);
      this.close();
    };
    allow.onclick = () => {
      this.answered = true;
      this.done(true);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done(false);
  }
}

class ContextPreviewModal extends Modal {
  constructor(app: App, private readonly item: ContextItem) {
    super(app);
    this.titleEl.setText(this.item.label || "Context preview");
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-context-preview-modal");

    if (this.item.type === "image") {
      contentEl.createEl("img", {
        cls: "pi-agent-context-preview-image",
        attr: { src: `data:${this.item.mimeType || "image/png"};base64,${this.item.value}` },
      });
      return;
    }

    const pre = contentEl.createEl("pre", { cls: "pi-agent-context-preview-text" });
    pre.setText(this.item.value);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class PiAgentInlineEditModal extends Modal {
  private readonly done: (value: string | null) => void;
  private submitted = false;

  constructor(app: App, done: (value: string | null) => void) {
    super(app);
    this.titleEl.setText("Inline edit with Pimate");
    this.done = done;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");

    contentEl.createDiv({
      text: "Describe how Pimate should rewrite the selected text.",
      cls: "pi-agent-suggestion-note",
    });

    const textarea = contentEl.createEl("textarea", {
      cls: "pi-agent-editor-modal-textarea",
      attr: { placeholder: "Make it clearer, shorter, more direct..." },
    });
    textarea.addClass("pi-agent-textarea-min-height");
    textarea.focus();

    const buttons = contentEl.createDiv("pi-agent-editor-modal-buttons");
    const cancel = buttons.createEl("button", { text: "Cancel" });
    const submit = buttons.createEl("button", {
      text: "Apply",
      cls: "mod-cta",
    });

    cancel.onclick = () => {
      this.submitted = true;
      this.done(null);
      this.close();
    };
    submit.onclick = () => {
      this.submitted = true;
      this.done(textarea.value.trim() || null);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.done(null);
  }
}

class PiAgentInlineEditReviewModal extends Modal {
  private readonly done: (result: InlineEditReviewResult) => void;
  private answered = false;

  constructor(
    app: App,
    private readonly original: string,
    private readonly replacement: string,
    done: (result: InlineEditReviewResult) => void
  ) {
    super(app);
    this.titleEl.setText("Review Pimate inline edit");
    this.done = done;
  }

  private renderSimpleDiff(container: HTMLElement, original: string, replacement: string): void {
    container.empty();
    const lines = this.computeSimpleDiff(original, replacement);
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      container.createSpan({ text: line.text, cls: line.cls });
      if (idx < lines.length - 1) container.appendText("\n");
    }
  }

  private computeSimpleDiff(original: string, replacement: string): Array<{ text: string; cls?: string }> {
    const origLines = original.split("\n");
    const replLines = replacement.split("\n");

    const dp: number[][] = Array(origLines.length + 1)
      .fill(null)
      .map(() => Array(replLines.length + 1).fill(0));

    for (let i = 1; i <= origLines.length; i++) {
      for (let j = 1; j <= replLines.length; j++) {
        if (origLines[i - 1] === replLines[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    let i = origLines.length;
    let j = replLines.length;
    const result: Array<{ text: string; cls?: string }> = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && origLines[i - 1] === replLines[j - 1]) {
        result.unshift({ text: origLines[i - 1] });
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift({ text: `+ ${replLines[j - 1]}`, cls: "pi-diff-ins" });
        j--;
      } else {
        result.unshift({ text: `- ${origLines[i - 1]}`, cls: "pi-diff-del" });
        i--;
      }
    }

    return result;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");

    contentEl.createDiv({
      text: "Changes Preview (红绿差异比对)",
      cls: "pi-agent-suggestion-title",
    });

    const diffContainer = contentEl.createEl("pre", {
      cls: "pi-agent-diff-view-pre",
    });
    this.renderSimpleDiff(diffContainer, this.original, this.replacement);

    contentEl.createDiv({
      text: "Edit Replacement (可选：微调修改文)",
      cls: "pi-agent-suggestion-title",
    });
    const replacementBox = contentEl.createEl("textarea", {
      cls: "pi-agent-editor-modal-textarea",
    });
    replacementBox.value = this.replacement;
    replacementBox.addClass("pi-agent-textarea-min-height");
    replacementBox.focus();

    // Live update diff view when editing replacement text
    replacementBox.addEventListener("input", () => {
      this.renderSimpleDiff(diffContainer, this.original, replacementBox.value);
    });

    const buttons = contentEl.createDiv("pi-agent-editor-modal-buttons");
    const reject = buttons.createEl("button", { text: "Reject" });
    const regenerate = buttons.createEl("button", { text: "Regenerate" });
    const apply = buttons.createEl("button", {
      text: "Apply",
      cls: "mod-cta",
    });

    reject.onclick = () => {
      this.answered = true;
      this.done({ action: "reject" });
      this.close();
    };
    regenerate.onclick = () => {
      this.answered = true;
      this.done({ action: "regenerate" });
      this.close();
    };
    apply.onclick = () => {
      this.answered = true;
      this.done({ action: "apply", replacement: replacementBox.value });
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.answered) this.done({ action: "reject" });
  }
}

class PiAgentEditorModal extends Modal {
  private value: string;
  private readonly done: (value: string | null) => void;
  private submitted = false;

  constructor(
    app: App,
    title: string,
    prefill: string,
    done: (value: string | null) => void
  ) {
    super(app);
    this.titleEl.setText(title || "Edit response");
    this.value = prefill;
    this.done = done;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");

    const textarea = contentEl.createEl("textarea", {
      cls: "pi-agent-editor-modal-textarea",
    });
    textarea.value = this.value;
    textarea.focus();

    const buttons = contentEl.createDiv("pi-agent-editor-modal-buttons");
    const cancel = buttons.createEl("button", { text: "Cancel" });
    const submit = buttons.createEl("button", {
      text: "Submit",
      cls: "mod-cta",
    });

    cancel.onclick = () => {
      this.submitted = true;
      this.done(null);
      this.close();
    };
    submit.onclick = () => {
      this.submitted = true;
      this.done(textarea.value);
      this.close();
    };
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.done(null);
  }
}

export interface ThinkingLevelOption {
  id: string;
  name: string;
  desc: string;
}

export class ThinkingLevelSuggestModal extends SuggestModal<ThinkingLevelOption> {
  constructor(
    app: App,
    private readonly options: ThinkingLevelOption[],
    private readonly isZh: boolean,
    private readonly onChoose: (option: ThinkingLevelOption) => void | Promise<void>
  ) {
    super(app);
    this.setPlaceholder(isZh ? "搜索或选择思考强度..." : "Search or select thinking level...");
  }

  getSuggestions(query: string): ThinkingLevelOption[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.options;
    return this.options.filter(
      (opt) =>
        opt.name.toLowerCase().includes(q) ||
        opt.id.toLowerCase().includes(q) ||
        opt.desc.toLowerCase().includes(q)
    );
  }

  renderSuggestion(option: ThinkingLevelOption, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({
      text: option.name,
      cls: "pi-agent-suggestion-title",
    });
    el.createDiv({
      text: option.desc,
      cls: "pi-agent-suggestion-note",
    });
  }

  onChooseSuggestion(option: ThinkingLevelOption): void {
    void Promise.resolve(this.onChoose(option)).catch((err: unknown) => {
      console.error("[pimate] thinking level selection failed", err);
    });
  }
}

// ─── Usage Stats Modal (mirrors pi-web UsageStats) ────────────────────
type UsageRangePreset =
  | "today"
  | "yesterday"
  | "last7"
  | "last30"
  | "thisMonth"
  | "all"
  | "custom";

interface UsageModelRow {
  provider: string;
  model: string;
  messageCount: number;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  cacheTotal: number;
  totalTokens: number;
  cost: number;
  costKnown: boolean;
  hitRate: number | null;
  firstUsed: number | null;
  lastUsed: number | null;
}

interface UsageTotals {
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  cacheTotal: number;
  totalTokens: number;
  cost: number;
  costKnownMessages: number;
  estimatedCostMessages: number;
  unknownCostMessages: number;
  messageCount: number;
}

interface UsageResult {
  from: number | null;
  to: number | null;
  sessionCount: number;
  byModel: UsageModelRow[];
  totals: UsageTotals;
}

type UsageSortKey =
  | "messageCount"
  | "totalTokens"
  | "input"
  | "output"
  | "thinking"
  | "cacheRead"
  | "cacheWrite"
  | "cacheTotal"
  | "hitRate"
  | "cost";

function startOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfLocalDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInputValue(s: string): Date {
  return new Date(s);
}
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 10_000) return (n / 1000).toFixed(1) + "k";
  if (n >= 1000) return (n / 1000).toFixed(2) + "k";
  return String(n);
}
function fmtCost(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  if (n < 0.01) return "$" + n.toFixed(4);
  if (n < 1) return "$" + n.toFixed(3);
  return "$" + n.toFixed(2);
}
function fmtDateCompact(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function computeHitRate(input: number, cacheRead: number, cacheWrite = 0): number | null {
  const denom = input + cacheRead + cacheWrite;
  if (denom <= 0) return null;
  return cacheRead / denom;
}
function hitRateColor(hr: number | null): string {
  if (hr === null) return "var(--text-muted)";
  if (hr >= 0.7) return "rgba(34, 197, 94, 0.95)";
  if (hr >= 0.3) return "rgba(234, 179, 8, 0.95)";
  return "rgba(239, 68, 68, 0.95)";
}
function hitRateLabel(hr: number | null): string {
  if (hr === null) return "—";
  return (hr * 100).toFixed(1) + "%";
}

function buildRange(
  preset: UsageRangePreset,
  customFrom: string,
  customTo: string
): { from: number | null; to: number | null; label: string } {
  const now = new Date();
  switch (preset) {
    case "today":
      return {
        from: startOfLocalDay(now).getTime(),
        to: endOfLocalDay(now).getTime(),
        label: "今天 / Today",
      };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return {
        from: startOfLocalDay(y).getTime(),
        to: endOfLocalDay(y).getTime(),
        label: "昨天 / Yesterday",
      };
    }
    case "last7": {
      const s = new Date(now);
      s.setDate(s.getDate() - 6);
      return {
        from: startOfLocalDay(s).getTime(),
        to: endOfLocalDay(now).getTime(),
        label: "最近 7 天 / Last 7 days",
      };
    }
    case "last30": {
      const s = new Date(now);
      s.setDate(s.getDate() - 29);
      return {
        from: startOfLocalDay(s).getTime(),
        to: endOfLocalDay(now).getTime(),
        label: "最近 30 天 / Last 30 days",
      };
    }
    case "thisMonth": {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      return {
        from: startOfLocalDay(s).getTime(),
        to: endOfLocalDay(now).getTime(),
        label: "本月 / This month",
      };
    }
    case "all":
      return { from: null, to: null, label: "全部 / All time" };
    case "custom": {
      const from = customFrom
        ? fromLocalInputValue(customFrom).getTime()
        : startOfLocalDay(now).getTime();
      const to = customTo ? fromLocalInputValue(customTo).getTime() : now.getTime();
      const f = new Date(from);
      const t = new Date(to);
      const fmt = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
      return { from, to, label: `${fmt(f)} – ${fmt(t)}` };
    }
  }
}

// 一条精简的用量记录（按文件持久化，供增量缓存与范围过滤复用）：
// [ts, provider, model, input, output, cacheRead, cacheWrite, total, cost]
type UsageRecord = [number, string, string, number, number, number, number, number, number];

interface UsageCacheFile {
  size: number;
  mtimeMs: number;
  processedLines: number;
  records: UsageRecord[];
}

interface UsageCache {
  version: number;
  perFile: Record<string, UsageCacheFile>;
}

const USAGE_CACHE_VERSION = 1;

function usageCachePath(): string {
  return join(homedir(), ".pi", "agent", "usage-cache.json");
}

function loadUsageCache(cachePath: string): UsageCache | null {
  try {
    if (!existsSync(cachePath)) return null;
    const raw = readFileSync(cachePath, "utf8");
    const c = JSON.parse(raw) as UsageCache;
    if (!c || c.version !== USAGE_CACHE_VERSION || !c.perFile) return null;
    return c;
  } catch {
    return null;
  }
}

function saveUsageCache(cachePath: string, cache: UsageCache): void {
  try {
    writeFileSync(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // 缓存写入失败不影响统计结果，下次重建即可。
  }
}

// 解析单个会话文件。命中增量时只解析新增行；截断/轮转时全量重建。
function parseUsageFile(
  fullPath: string,
  cached: UsageCacheFile | undefined,
  st: { size: number; mtimeMs: number }
): UsageCacheFile {
  let content = "";
  try {
    content = readFileSync(fullPath, "utf8");
  } catch {
    return cached ?? { size: 0, mtimeMs: 0, processedLines: 0, records: [] };
  }
  const lines = content.split(/\r?\n/);
  // 末尾换行后的完整行数；未以 \n 结尾的尾行视为未完成，留待下次重读补全。
  const completeLines = content.endsWith("\n") ? lines.length - 1 : lines.length;
  const truncated = !!cached && st.size < cached.size;
  const startLine = cached && !truncated ? cached.processedLines : 0;
  const records: UsageRecord[] = cached && !truncated ? cached.records.slice() : [];
  for (let i = startLine; i < completeLines; i++) {
    const line = lines[i];
    if (!line) continue;
    let evt: any;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (evt?.type !== "message") continue;
    const msg = evt.message;
    if (!msg || msg.role !== "assistant") continue;
    const usage = msg.usage;
    if (!usage) continue;
    const ts = typeof evt.timestamp === "string" ? Date.parse(evt.timestamp) : 0;
    const provider = (msg.provider as string) || (evt.provider as string) || "unknown";
    const model = (msg.model as string) || (evt.model as string) || "unknown";
    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const cacheRead = Number(usage.cacheRead) || 0;
    const cacheWrite = Number(usage.cacheWrite) || 0;
    const total =
      Number(usage.totalTokens) || input + output + cacheRead + cacheWrite;
    const cost = Number(usage.cost?.total) || 0;
    records.push([ts, provider, model, input, output, cacheRead, cacheWrite, total, cost]);
  }
  return { size: st.size, mtimeMs: st.mtimeMs, processedLines: completeLines, records };
}

// 增量扫描：mtime+size 未变的文件直接复用缓存记录，只读变化的文件；
// 清理已删除文件；有变更时回写缓存。
function scanUsageIncremental(
  sessionsBaseDir: string,
  cachePath: string
): UsageCache {
  let cache = loadUsageCache(cachePath);
  if (!cache) cache = { version: USAGE_CACHE_VERSION, perFile: {} };
  let dirty = false;
  if (existsSync(sessionsBaseDir)) {
    const workspaceDirs = readdirSync(sessionsBaseDir)
      .filter((n: string) => n.startsWith("--") && n.endsWith("--"))
      .map((n) => join(sessionsBaseDir, n));
    for (const wsDir of workspaceDirs) {
      let files: string[] = [];
      try {
        files = readdirSync(wsDir).filter((f) => f.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const f of files) {
        const fullPath = join(wsDir, f);
        let st: { size: number; mtimeMs: number };
        try {
          const s = statSync(fullPath);
          st = { size: s.size, mtimeMs: s.mtimeMs };
        } catch {
          continue;
        }
        const rel = relative(sessionsBaseDir, fullPath).replace(/\\/g, "/");
        const cached = cache.perFile[rel];
        if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
          continue; // 命中缓存，复用 cached.records
        }
        cache.perFile[rel] = parseUsageFile(fullPath, cached, st);
        dirty = true;
      }
    }
  }
  // 注意：已从磁盘删除的 session 文件不清理 —— 其 records 作为历史保留，
  // 仍参与统计。文件截断/轮转（size 变小）由 parseUsageFile 全量重建处理。
  if (dirty) saveUsageCache(cachePath, cache);
  return cache;
}

// 在已缓存的全量记录上按 [from, to] 过滤并聚合，无需再次读盘。
function aggregateUsage(
  perFile: Record<string, UsageCacheFile>,
  from: number | null,
  to: number | null
): UsageResult {
  const byModel = new Map<string, UsageModelRow>();
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheTotal: 0,
    totalTokens: 0,
    cost: 0,
    costKnownMessages: 0,
    estimatedCostMessages: 0,
    unknownCostMessages: 0,
    messageCount: 0,
  };
  let sessionCount = 0;
  for (const key of Object.keys(perFile)) {
    const fileRecords = perFile[key].records;
    let touched = false;
    for (const r of fileRecords) {
      const ts = r[0];
      if (ts && ((from != null && ts < from) || (to != null && ts > to))) {
        continue;
      }
      const provider = r[1];
      const model = r[2];
      const mk = `${provider}::${model}`;
      let row = byModel.get(mk);
      if (!row) {
        row = {
          provider,
          model,
          messageCount: 0,
          input: 0,
          output: 0,
          thinking: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cacheTotal: 0,
          totalTokens: 0,
          cost: 0,
          costKnown: true,
          hitRate: null,
          firstUsed: null,
          lastUsed: null,
        };
        byModel.set(mk, row);
      }
      const input = r[3];
      const output = r[4];
      const cacheRead = r[5];
      const cacheWrite = r[6];
      const total = r[7];
      const cost = r[8];
      row.messageCount += 1;
      row.input += input;
      row.output += output;
      row.cacheRead += cacheRead;
      row.cacheWrite += cacheWrite;
      row.cacheTotal += cacheRead + cacheWrite;
      row.totalTokens += total;
      row.cost += cost;
      if (ts) {
        if (row.firstUsed == null || ts < row.firstUsed) row.firstUsed = ts;
        if (row.lastUsed == null || ts > row.lastUsed) row.lastUsed = ts;
      }
      totals.input += input;
      totals.output += output;
      totals.costKnownMessages += 1;
      totals.cacheRead += cacheRead;
      totals.cacheWrite += cacheWrite;
      totals.totalTokens += total;
      totals.cost += cost;
      totals.messageCount += 1;
      touched = true;
    }
    if (touched) sessionCount += 1;
  }
  for (const row of byModel.values()) {
    row.hitRate = computeHitRate(row.input, row.cacheRead, row.cacheWrite);
  }
  totals.cacheTotal = totals.cacheRead + totals.cacheWrite;
  const list = Array.from(byModel.values()).sort(
    (a, b) => b.totalTokens - a.totalTokens
  );
  return { from, to, sessionCount, byModel: list, totals };
}

function scanUsageRange(
  sessionsBaseDir: string,
  from: number | null,
  to: number | null
): UsageResult {
  const cache = scanUsageIncremental(sessionsBaseDir, usageCachePath());
  return aggregateUsage(cache.perFile, from, to);
}

function subtractAgyUsage(
  current: AgyUsageTotals,
  previous: AgyUsageTotals | null
): AgyUsageTotals {
  if (!previous) return { ...current };
  const subtract = (a: number, b: number) => Math.max(0, a - b);
  return {
    input: subtract(current.input, previous.input),
    output: subtract(current.output, previous.output),
    thinking: subtract(current.thinking, previous.thinking),
    cacheRead: subtract(current.cacheRead, previous.cacheRead),
    total: subtract(current.total, previous.total),
  };
}

function agyUsageHasValues(usage: AgyUsageTotals): boolean {
  return usage.input > 0 || usage.output > 0 || usage.thinking > 0 || usage.cacheRead > 0 || usage.total > 0;
}

function deriveAgyUsageDeltas(
  snapshots: AgyUsageSnapshot[]
): Array<{ snapshot: AgyUsageSnapshot; delta: AgyUsageTotals; baseline: boolean }> {
  const grouped = new Map<string, AgyUsageSnapshot[]>();
  const seen = new Set<string>();
  for (const snapshot of snapshots) {
    const totals = snapshot.cumulative;
    const key = [
      snapshot.conversationId,
      snapshot.numTurns ?? "",
      totals.input,
      totals.output,
      totals.thinking,
      totals.cacheRead,
      totals.total,
    ].join(":");
    if (seen.has(key)) continue;
    seen.add(key);
    const list = grouped.get(snapshot.conversationId) || [];
    list.push(snapshot);
    grouped.set(snapshot.conversationId, list);
  }

  const result: Array<{ snapshot: AgyUsageSnapshot; delta: AgyUsageTotals; baseline: boolean }> = [];
  for (const list of grouped.values()) {
    list.sort((a, b) => {
      if (a.numTurns != null && b.numTurns != null && a.numTurns !== b.numTurns) {
        return a.numTurns - b.numTurns;
      }
      if (a.numTurns != null && b.numTurns == null) return -1;
      if (a.numTurns == null && b.numTurns != null) return 1;
      return a.observedAt - b.observedAt;
    });

    let previous: AgyUsageSnapshot | null = null;
    for (const snapshot of list) {
      const current = snapshot.cumulative;
      const reset = !!previous && (
        current.input < previous.cumulative.input ||
        current.output < previous.cumulative.output ||
        current.thinking < previous.cumulative.thinking ||
        current.cacheRead < previous.cumulative.cacheRead ||
        current.total < previous.cumulative.total
      );
      const baseline = !previous
        ? snapshot.numTurns == null || snapshot.numTurns > 1
        : reset;
      result.push({
        snapshot,
        delta: reset ? { ...current } : subtractAgyUsage(current, previous?.cumulative || null),
        baseline,
      });
      previous = snapshot;
    }
  }
  return result;
}

async function scanAgyUsageRange(
  from: number | null,
  to: number | null
): Promise<UsageResult> {
  const snapshots = await AgyUsageStore.readAll();
  const boundedRange = from != null || to != null;
  const byModel = new Map<string, UsageModelRow>();
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheTotal: 0,
    totalTokens: 0,
    cost: 0,
    costKnownMessages: 0,
    estimatedCostMessages: 0,
    unknownCostMessages: 0,
    messageCount: 0,
  };
  const sessions = new Set<string>();

  for (const { snapshot, delta, baseline } of deriveAgyUsageDeltas(snapshots)) {
    // A first observation of an existing conversation contains AGY's entire
    // historical cumulative usage. Keep it available in "All time", but do
    // not attribute that old usage to the day on which Pimate first saw it.
    if (boundedRange && baseline) continue;
    if (from != null && snapshot.observedAt < from) continue;
    if (to != null && snapshot.observedAt > to) continue;
    if (!agyUsageHasValues(delta)) continue;

    const provider = "Antigravity";
    const model = snapshot.model || "unknown";
    const cost = calculateAgyCost(model, delta, snapshot.observedAt);
    const key = `${provider}::${model}`;
    let row = byModel.get(key);
    if (!row) {
      row = {
        provider,
        model,
        messageCount: 0,
        input: 0,
        output: 0,
        thinking: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cacheTotal: 0,
        totalTokens: 0,
        cost: 0,
        costKnown: cost !== null,
        hitRate: null,
        firstUsed: null,
        lastUsed: null,
      };
      byModel.set(key, row);
    }
    row.messageCount += 1;
    row.input += delta.input;
    row.output += delta.output;
    row.thinking += delta.thinking;
    row.cacheRead += delta.cacheRead;
    row.cacheTotal += delta.cacheRead;
    row.totalTokens += delta.total;
    row.cost += cost ?? 0;
    row.costKnown = row.costKnown && cost !== null;
    if (row.firstUsed == null || snapshot.observedAt < row.firstUsed) row.firstUsed = snapshot.observedAt;
    if (row.lastUsed == null || snapshot.observedAt > row.lastUsed) row.lastUsed = snapshot.observedAt;

    totals.input += delta.input;
    totals.output += delta.output;
    totals.thinking += delta.thinking;
    totals.cacheRead += delta.cacheRead;
    totals.cacheTotal += delta.cacheRead;
    totals.totalTokens += delta.total;
    if (cost === null) {
      totals.unknownCostMessages += 1;
    } else {
      totals.cost += cost;
      totals.costKnownMessages += 1;
      totals.estimatedCostMessages += 1;
    }
    totals.messageCount += 1;
    sessions.add(snapshot.conversationId);
  }

  for (const row of byModel.values()) {
    row.hitRate = computeHitRate(row.input, row.cacheRead, row.cacheWrite);
  }

  return {
    from,
    to,
    sessionCount: sessions.size,
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    totals,
  };
}

function mergeUsageResults(results: UsageResult[]): UsageResult {
  const byModel = new Map<string, UsageModelRow>();
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    thinking: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheTotal: 0,
    totalTokens: 0,
    cost: 0,
    costKnownMessages: 0,
    estimatedCostMessages: 0,
    unknownCostMessages: 0,
    messageCount: 0,
  };
  for (const result of results) {
    totals.input += result.totals.input;
    totals.output += result.totals.output;
    totals.thinking += result.totals.thinking;
    totals.cacheRead += result.totals.cacheRead;
    totals.cacheWrite += result.totals.cacheWrite;
    totals.cacheTotal += result.totals.cacheTotal;
    totals.totalTokens += result.totals.totalTokens;
    totals.cost += result.totals.cost;
    totals.costKnownMessages += result.totals.costKnownMessages;
    totals.estimatedCostMessages += result.totals.estimatedCostMessages;
    totals.unknownCostMessages += result.totals.unknownCostMessages;
    totals.messageCount += result.totals.messageCount;

    for (const row of result.byModel) {
      const key = `${row.provider}::${row.model}`;
      const existing = byModel.get(key);
      if (!existing) {
        byModel.set(key, { ...row });
        continue;
      }
      existing.messageCount += row.messageCount;
      existing.input += row.input;
      existing.output += row.output;
      existing.thinking += row.thinking;
      existing.cacheRead += row.cacheRead;
      existing.cacheWrite += row.cacheWrite;
      existing.cacheTotal += row.cacheTotal;
      existing.totalTokens += row.totalTokens;
      existing.cost += row.cost;
      existing.costKnown = existing.costKnown && row.costKnown;
      if (row.firstUsed != null && (existing.firstUsed == null || row.firstUsed < existing.firstUsed)) {
        existing.firstUsed = row.firstUsed;
      }
      if (row.lastUsed != null && (existing.lastUsed == null || row.lastUsed > existing.lastUsed)) {
        existing.lastUsed = row.lastUsed;
      }
    }
  }

  for (const row of byModel.values()) {
    row.hitRate = computeHitRate(row.input, row.cacheRead, row.cacheWrite);
  }

  return {
    from: results[0]?.from ?? null,
    to: results[0]?.to ?? null,
    sessionCount: results.reduce((sum, result) => sum + result.sessionCount, 0),
    byModel: [...byModel.values()].sort((a, b) => b.totalTokens - a.totalTokens),
    totals,
  };
}

async function scanUnifiedUsageRange(
  sessionsBaseDir: string,
  from: number | null,
  to: number | null
): Promise<UsageResult> {
  const piResult = scanUsageRange(sessionsBaseDir, from, to);
  const agyResult = await scanAgyUsageRange(from, to);
  return mergeUsageResults([piResult, agyResult]);
}

class UsageStatsModal extends Modal {
  private preset: UsageRangePreset = "last7";
  private customFrom: string = toLocalInputValue(
    startOfLocalDay(new Date(new Date().setDate(new Date().getDate() - 6)))
  );
  private customTo: string = toLocalInputValue(new Date());
  private data: UsageResult | null = null;
  private loading = false;
  private error: string | null = null;
  private sortKey: UsageSortKey = "totalTokens";
  private sortDir: "asc" | "desc" = "desc";
  private bodyEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private tableEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private rangeLabelEl: HTMLElement | null = null;
  private reqId = 0;
  private lang: "zh" | "en" = "zh";

  constructor(app: App, lang: string) {
    super(app);
    this.lang = lang === "zh" ? "zh" : "en";
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    modalEl.addClass("pi-agent-usage-modal");
    contentEl.addClass("pi-agent-usage-content");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
    this.modalEl.removeClass("pi-agent-usage-modal");
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const isZh = this.lang === "zh";
    const range = buildRange(this.preset, this.customFrom, this.customTo);
    // Header
    const header = contentEl.createDiv("pi-agent-usage-header");
    const titleWrap = header.createDiv("pi-agent-usage-title");
    const titleIcon = titleWrap.createSpan();
    setIcon(titleIcon, "bar-chart-3");
    const titleText = titleWrap.createSpan({ text: isZh ? "Token 用量" : "Token Usage" });
    titleText.addClass("pi-agent-title-text-spaced");
    this.rangeLabelEl = titleWrap.createSpan({ text: " · " + range.label, cls: "pi-agent-usage-range-label" });
    const refreshBtn = header.createEl("button", { cls: "pi-agent-usage-btn-icon", attr: { title: isZh ? "刷新" : "Refresh", "aria-label": "Refresh" } });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.onclick = () => this.scan();
    const closeBtn = header.createEl("button", { cls: "pi-agent-usage-btn-icon", attr: { title: isZh ? "关闭" : "Close", "aria-label": "Close" } });
    setIcon(closeBtn, "x");
    closeBtn.onclick = () => this.close();
    // Range selector
    const rangeBar = contentEl.createDiv("pi-agent-usage-rangebar");
    const presets: { id: UsageRangePreset; label: string }[] = [
      { id: "today", label: isZh ? "今天" : "Today" },
      { id: "yesterday", label: isZh ? "昨天" : "Yesterday" },
      { id: "last7", label: isZh ? "最近 7 天" : "Last 7d" },
      { id: "last30", label: isZh ? "最近 30 天" : "Last 30d" },
      { id: "thisMonth", label: isZh ? "本月" : "This month" },
      { id: "all", label: isZh ? "全部" : "All time" },
      { id: "custom", label: isZh ? "自定义…" : "Custom…" },
    ];
    for (const p of presets) {
      const btn = rangeBar.createEl("button", {
        text: p.label,
        cls: "pi-agent-usage-preset" + (this.preset === p.id ? " is-active" : ""),
      });
      btn.onclick = () => {
        this.preset = p.id;
        this.render();
        // render() 末尾已调用 scan()，无需重复扫描。
      };
    }
    if (this.preset === "custom") {
      const wrap = rangeBar.createDiv("pi-agent-usage-custom-range");
      const fromInp = wrap.createEl("input", {
        attr: { type: "datetime-local", value: this.customFrom },
      });
      wrap.createSpan({ text: "→" });
      const toInp = wrap.createEl("input", {
        attr: { type: "datetime-local", value: this.customTo },
      });
      fromInp.onchange = () => {
        this.customFrom = fromInp.value;
        this.scan();
      };
      toInp.onchange = () => {
        this.customTo = toInp.value;
        this.scan();
      };
    }
    this.statusEl = rangeBar.createDiv("pi-agent-usage-status");
    // Summary
    this.summaryEl = contentEl.createDiv("pi-agent-usage-summary");
    // Table area
    this.tableEl = contentEl.createDiv("pi-agent-usage-table");
    this.tableEl.addClass("pi-agent-usage-table-scroll");


    // Footer
    const footer = contentEl.createDiv("pi-agent-usage-footer");
    const source = footer.createSpan({
      text: isZh
        ? "点击列标题排序 · 数据源：Pi 会话日志 + AGY 用量日志"
        : "Click a column to sort · Data source: Pi session logs + AGY usage journal",
    });
    source.setAttribute(
      "title",
      `${usageCachePath()}\n${getAgyUsageStorePath()}\n${AGY_GEMINI_PRICING_SOURCE}`
    );
    footer.createSpan({ text: "Esc", cls: "pi-agent-usage-foot-hint" });
    this.scan();
  }

  private scan(): void {
    const reqId = ++this.reqId;
    this.loading = true;
    this.error = null;
    this.updateStatus();
    window.setTimeout(() => {
      if (reqId !== this.reqId) return;
      void (async () => {
        try {
          const home = homedir().replace(/\\/g, "/");
          const sessionsBaseDir = `${home}/.pi/agent/sessions`;
          const range = buildRange(this.preset, this.customFrom, this.customTo);
          const result = await scanUnifiedUsageRange(sessionsBaseDir, range.from, range.to);
          if (reqId !== this.reqId) return;
          this.data = result;
          this.loading = false;
          this.updateRangeLabel();
          this.renderSummary();
          this.renderTable();
          this.updateStatus();
        } catch (err) {
          if (reqId !== this.reqId) return;
          this.error = (err as Error).message;
          this.loading = false;
          this.updateStatus();
        }
      })();
    }, 0);
  }

  private updateRangeLabel(): void {
    if (!this.rangeLabelEl) return;
    const range = buildRange(this.preset, this.customFrom, this.customTo);
    this.rangeLabelEl.setText(" · " + range.label);
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    const isZh = this.lang === "zh";
    if (this.error) {
      this.statusEl.setText(`❌ ${this.error}`);
      this.statusEl.addClass("pi-agent-text-error");
      return;
    }
    if (this.loading) {
      this.statusEl.setText(isZh ? "扫描中…" : "Scanning…");
      this.statusEl.removeClass("pi-agent-text-error");
      this.statusEl.addClass("pi-agent-text-muted");
      return;
    }
    if (this.data) {
      this.statusEl.setText(
        `${isZh ? "已扫描" : "scanned"} ${this.data.sessionCount} ${isZh ? "个会话" : "session" + (this.data.sessionCount === 1 ? "" : "s")}`
      );
      this.statusEl.removeClass("pi-agent-text-error");
      this.statusEl.addClass("pi-agent-text-muted");
    }
  }

  private renderSummary(): void {
    if (!this.summaryEl) return;
    this.summaryEl.empty();
    if (!this.data) return;
    const isZh = this.lang === "zh";
    const t = this.data.totals;
    const hr = computeHitRate(t.input, t.cacheRead, t.cacheWrite);
    const estimatedCost = t.estimatedCostMessages > 0;
    const costSub = t.unknownCostMessages > 0
      ? (t.costKnownMessages > 0
        ? (estimatedCost
          ? (isZh ? "部分按 Gemini API 官方价计算；AGY 部分未知" : "Partly calculated at Gemini API list price; some AGY costs unavailable")
          : (isZh ? "AGY 费用未提供" : "AGY cost unavailable"))
        : (isZh ? "AGY 未提供费用" : "AGY does not provide cost"))
      : estimatedCost
        ? (isZh ? "按 Gemini API Standard 官方价计算" : "Calculated at Gemini API Standard list price")
      : `${t.messageCount.toLocaleString()} ${isZh ? "条消息" : "msgs"}`;
    const cards = [
      { label: isZh ? "总 Token" : "Total tokens", value: fmtNum(t.totalTokens), sub: t.totalTokens.toLocaleString() },
      { label: isZh ? "输入" : "Input", value: fmtNum(t.input), sub: t.input.toLocaleString() },
      { label: isZh ? "输出" : "Output", value: fmtNum(t.output), sub: t.output.toLocaleString() },
      { label: isZh ? "思考" : "Thinking", value: fmtNum(t.thinking), sub: t.thinking.toLocaleString() },
      {
        label: isZh ? "缓存读" : "Cache read",
        value: fmtNum(t.cacheRead),
        sub: hr === null ? "—" : `${isZh ? "占比" : "share"} ${(hr * 100).toFixed(1)}%`,
        subColor: hitRateColor(hr),
      },
      {
        label: isZh ? "费用" : "Cost",
        value: t.costKnownMessages > 0 ? fmtCost(t.cost) : "—",
        sub: costSub,
      },
    ];
    for (const c of cards) {
      const card = this.summaryEl.createDiv("pi-agent-usage-card");
      card.createDiv({ text: c.label, cls: "pi-agent-usage-card-label" });
      card.createDiv({ text: c.value, cls: "pi-agent-usage-card-value" });
      const sub = card.createDiv({ text: c.sub, cls: "pi-agent-usage-card-sub" });
      if (c.subColor) sub.setCssProps({ color: c.subColor });
    }
  }

  private renderTable(): void {
    if (!this.tableEl) return;
    this.tableEl.empty();
    const isZh = this.lang === "zh";
    if (this.error) {
      this.tableEl.createDiv({
        text: `${isZh ? "错误" : "Error"}: ${this.error}`,
        cls: "pi-agent-usage-empty",
      }).addClass("pi-agent-text-error");
      return;
    }
    if (!this.data) {
      this.tableEl.createDiv({
        text: isZh ? "加载中…" : "Loading…",
        cls: "pi-agent-usage-empty",
      });
      return;
    }
    if (this.data.byModel.length === 0) {
      this.tableEl.createDiv({
        text: isZh ? "此时间范围内没有用量数据" : "No usage data in this range.",
        cls: "pi-agent-usage-empty",
      });
      return;
    }
    const sorted = [...this.data.byModel].sort((a, b) => {
      const aNull = a[this.sortKey] === null || a[this.sortKey] === undefined;
      const bNull = b[this.sortKey] === null || b[this.sortKey] === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      const av = a[this.sortKey] as number;
      const bv = b[this.sortKey] as number;
      return this.sortDir === "desc" ? bv - av : av - bv;
    });
    const maxTotal = Math.max(...sorted.map((m) => m.totalTokens));
    const totalAll = this.data.totals.totalTokens || 0;
    const table = this.tableEl.createEl("table", { cls: "pi-agent-usage-table-el" });
    const thead = table.createEl("thead");
    const trh = thead.createEl("tr");
    const cols: { key: UsageSortKey | "model" | "provider" | "share" | "firstLast"; label: string; align: "left" | "right" }[] = [
      { key: "model", label: isZh ? "模型" : "Model", align: "left" },
      { key: "provider", label: isZh ? "提供方" : "Provider", align: "left" },
      { key: "messageCount", label: isZh ? "消息" : "Msgs", align: "right" },
      { key: "input", label: isZh ? "输入" : "Input", align: "right" },
      { key: "output", label: isZh ? "输出" : "Output", align: "right" },
      { key: "thinking", label: isZh ? "思考" : "Thinking", align: "right" },
      { key: "cacheRead", label: isZh ? "缓存读" : "Cache R", align: "right" },
      { key: "cacheWrite", label: isZh ? "缓存写" : "Cache W", align: "right" },
      { key: "totalTokens", label: isZh ? "总计" : "Total", align: "right" },
      { key: "hitRate", label: isZh ? "命中率" : "Hit", align: "right" },
      { key: "cost", label: isZh ? "费用" : "Cost", align: "right" },
      { key: "share", label: isZh ? "占比" : "Share", align: "left" },
    ];
    const sortArrow = (k: string) => this.sortKey === k ? (this.sortDir === "desc" ? " ↓" : " ↑") : "";
    for (const c of cols) {
      const th = trh.createEl("th", {
        text: c.label + (c.key === this.sortKey ? sortArrow(c.key) : ""),
        attr: { title: c.label },
      });
      th.setCssProps({ textAlign: c.align });
      if (c.key !== "share") {
        th.addClass("is-sortable");
        th.onclick = () => {
          if (this.sortKey === c.key) {
            this.sortDir = this.sortDir === "desc" ? "asc" : "desc";
          } else {
            this.sortKey = c.key as UsageSortKey;
            this.sortDir = c.key === "hitRate" ? "asc" : "desc";
          }
          this.renderTable();
        };
      }
    }
    const tbody = table.createEl("tbody");
    for (const m of sorted) {
      const tr = tbody.createEl("tr");
      // Model
      const tdModel = tr.createEl("td");
      tdModel.addClass("pi-agent-text-left");
      tdModel.createDiv({ cls: "pi-agent-usage-model-name", text: m.model });
      tdModel.createDiv({ cls: "pi-agent-usage-model-time", text: `${fmtDateCompact(m.firstUsed ? new Date(m.firstUsed).toISOString() : null)} → ${fmtDateCompact(m.lastUsed ? new Date(m.lastUsed).toISOString() : null)}` });
      // Provider
      const tdProv = tr.createEl("td", { text: m.provider });
      tdProv.addClass("pi-agent-text-left");
      tdProv.addClass("pi-agent-text-muted");
      // Numeric cells
      const cells: Array<[string, "right" | "left", string?]> = [
        [m.messageCount.toLocaleString(), "right"],
        [fmtNum(m.input), "right"],
        [fmtNum(m.output), "right"],
        [fmtNum(m.thinking), "right"],
        [fmtNum(m.cacheRead), "right"],
        [fmtNum(m.cacheWrite), "right"],
        [fmtNum(m.totalTokens), "right"],
        [hitRateLabel(m.hitRate), "right", hitRateColor(m.hitRate)],
        [m.costKnown ? fmtCost(m.cost) : "—", "right"],
      ];
      for (const [val, align, color] of cells) {
        const td = tr.createEl("td", { text: val });
        td.setCssProps({ textAlign: align });
        td.addClass("pi-agent-tabular-nums");
        if (color) td.setCssProps({ color });
      }
      // Share bar
      const tdShare = tr.createEl("td");
      tdShare.addClass("pi-agent-text-left");
      tdShare.addClass("pi-agent-share-cell");
      const pct = totalAll > 0 ? (m.totalTokens / totalAll) * 100 : 0;
      const barW = maxTotal > 0 ? (m.totalTokens / maxTotal) * 100 : 0;
      const barWrap = tdShare.createDiv({ cls: "pi-agent-usage-bar" });
      const bar = barWrap.createDiv({ cls: "pi-agent-usage-bar-fill" });
      bar.setCssProps({ width: `${barW}%` });
      tdShare.createSpan({ text: `${pct.toFixed(1)}%`, cls: "pi-agent-usage-pct" });
    }
  }
}
