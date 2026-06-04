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
  TAbstractFile,
  MarkdownView,
  Menu,
  setIcon,
} from "obsidian";
import { readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { basename, dirname } from "path";
import type PiAgentPlugin from "./main";
import {
  PiAgentClient,
  type RpcEvent,
  type AssistantMessageEvent,
  type ToolCall,
  type MessageContent,
} from "./PiAgentClient";

export const PI_AGENT_VIEW_TYPE = "pisidian-chat-view";

// ─── Message Rendering Types ────────────────────────────────────────────

interface PiModel {
  id: string;
  name?: string;
  provider: string;
}

interface PiCommand {
  name: string;
  description?: string;
  source?: string;
  path?: string;
}

interface ForkMessage {
  entryId: string;
  text: string;
}

interface ResumeSessionItem {
  path: string;
  label: string;
  mtime: number;
  preview?: string;
}

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
  client: PiAgentClient | null;
  isStreaming: boolean;
  sessionFile?: string;
  sessionId?: string;
  restored?: boolean;
}

interface InlineEditReviewResult {
  action: "apply" | "reject" | "regenerate";
  replacement?: string;
}

interface RenderedMessage {
  id: string;
  role: string;
  el: HTMLElement;
  contentEl: HTMLElement;
  // For streaming assistant messages
  textBlock?: HTMLElement;
  thinkingBlock?: HTMLElement;
  thinkingContent?: HTMLElement;
  toolBlocks?: Map<string, HTMLElement>;
}

export class PiAgentView extends ItemView {
  plugin: PiAgentPlugin;
  client: PiAgentClient | null = null;
  private chatContainer: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private streamingTextEl: HTMLElement | null = null;
  private streamingCursorEl: HTMLElement | null = null;
  private sessionTabsEl: HTMLElement | null = null;
  private contextRowEl: HTMLElement | null = null;
  private widgetEl: HTMLElement | null = null;
  private sendBtn: HTMLButtonElement | null = null;
  private abortBtn: HTMLButtonElement | null = null;
  private statusBar: HTMLElement | null = null;
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
  private yoloToggleEl: HTMLElement | null = null;
  private yoloLabelEl: HTMLElement | null = null;
  private renderedMessages: RenderedMessage[] = [];
  private tabs: ChatTab[] = [];
  private activeTabId: string | null = null;
  private historyPanelEl: HTMLElement | null = null;
  private modelPopupEl: HTMLElement | null = null;
  private effortPopupEl: HTMLElement | null = null;
  private isHistoryOpen = false;
  private nextTabNumber = 1;
  private contextItems: ContextItem[] = [];
  private isStreaming = false;
  private currentAssistantMsg: RenderedMessage | null = null;
  private currentTextBlock: HTMLElement | null = null;
  private currentThinkingBlock: HTMLElement | null = null;
  private currentThinkingContent: HTMLElement | null = null;
  private thinkingStartedAt: number | null = null;
  private thinkingTimer: number | null = null;
  private shouldAutoScroll = true;
  private pendingUIRequests = new Map<string, (value: unknown) => void>();

  // ─── Stream Render Helper States ────────────────────────────────────
  private lastRenderTime = 0;
  private renderTimeout: number | null = null;
  private currentRawText = "";
  private currentBlockRawText = "";

  // ─── Autocomplete Mention Helper States ─────────────────────────────
  private mentionDropdown: HTMLElement | null = null;
  private filteredMentionFiles: TFile[] = [];
  private activeMentionIndex = 0;
  private mentionQueryStart = -1;

  // ─── Autocomplete Slash Command Helper States ───────────────────────
  private commandDropdown: HTMLElement | null = null;
  private filteredCommands: PiCommand[] = [];
  private activeCommandIndex = 0;
  private commandQueryStart = -1;
  private availableCommands: PiCommand[] = [];

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
    this.inputEl.style.height = "auto";
    // 限制最大高度为 240px，防止高度占满整个聊天视口
    this.inputEl.style.height = `${Math.min(this.inputEl.scrollHeight, 240)}px`;
  }

  focusComposer(): void {
    this.inputEl?.focus();
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
          ? "Pisidian：没有检测到文件管理器选中项。请先在左侧文件管理器中多选文件/文件夹。"
          : "Pisidian: no file-explorer selection detected. Select files/folders in the file explorer first."
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
        ? `Pisidian：已附加 ${count} 个选中项到上下文`
        : `Pisidian: attached ${count} selected item${count === 1 ? "" : "s"} to context`
    );
    this.inputEl?.focus();
  }

  openCommandsAndSkills(): void {
    this.showCommandSelector();
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
    return "Pisidian";
  }

  getIcon(): string {
    return "pisidian-logo";
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
    titleEl.createSpan({ text: "Pisidian" });

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
    this.historyPanelEl.style.display = "none";

    this.widgetEl = container.createDiv("pi-agent-widget");
    this.widgetEl.style.display = "none";

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
        this.createAndSwitchTab();
      } else {
        new Notice(isZh ? `已达到最大会话卡数量限制 (${maxTabs})` : `Maximum tab count reached (${maxTabs})`);
      }
    };
    // 新建按钮右键：重置所有会话卡
    newTabBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const Menu = (require("obsidian") as any).Menu;
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "重置所有会话卡 (1, 2, 3)" : "Reset all session tabs")
            .setIcon("refresh-cw")
            .onClick(async () => {
              for (const t of this.tabs) {
                await t.client?.destroy();
                t.client = null;
                t.sessionFile = undefined;
                t.sessionId = undefined;
                t.restored = false;
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
            });
      });
      menu.showAtMouseEvent(e);
    });

    const forkBtn = composerActions.createDiv("pi-agent-mini-action");
    setIcon(forkBtn, "square-pen");
    forkBtn.setAttribute("title", isZh ? "新建/重置当前会话" : "New conversation");
    forkBtn.onclick = () => this.newSession();
    // 分支按钮右键：分支或克隆
    forkBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const Menu = (require("obsidian") as any).Menu;
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "分支当前会话..." : "Fork current conversation...")
            .setIcon("git-fork")
            .onClick(() => this.showForkSelector());
      });
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "克隆当前会话分支" : "Clone current branch")
            .setIcon("copy")
            .onClick(() => this.cloneCurrentBranch());
      });
      menu.showAtMouseEvent(e);
    });

    const historyBtn = composerActions.createDiv("pi-agent-mini-action");
    setIcon(historyBtn, "history");
    historyBtn.setAttribute("title", isZh ? "恢复会话/历史" : "History sessions");
    historyBtn.onclick = () => this.toggleHistoryPanel();
    // 历史按钮右键：在系统管理器中打开历史目录
    historyBtn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const Menu = (require("obsidian") as any).Menu;
      const menu = new Menu();
      menu.addItem((item: any) => {
        item.setTitle(isZh ? "打开历史会话保存目录" : "Open history sessions directory")
            .setIcon("folder")
            .onClick(() => {
              try {
                const path = require("path");
                const os = require("os");
                const historyDir = path.join(os.homedir(), ".pi", "sessions");
                const { shell } = require("electron");
                shell.openPath(historyDir);
              } catch (err) {
                new Notice(isZh ? `无法打开目录: ${(err as Error).message}` : `Cannot open dir: ${(err as Error).message}`);
              }
            });
      });
      menu.showAtMouseEvent(e);
    });

    const inputArea = container.createDiv("pi-agent-input-area");
    this.contextRowEl = inputArea.createDiv("pi-agent-context-row");

    this.inputEl = inputArea.createEl("textarea", {
      cls: "pi-agent-input",
      attr: {
        placeholder: "How can I help you today?",
        rows: "4",
      },
    });

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
          this.insertCommandSelection();
          return;
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.closeCommandDropdown();
          return;
        }
      }

      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendMessage();
      } else if (e.key === "/" && this.inputEl?.selectionStart === 0 && !this.inputEl.value) {
        window.setTimeout(() => this.showCommandSelector(), 0);
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        this.showCommandSelector();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        this.newSession();
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
      this.handlePaste(e);
    });
    this.inputEl.addEventListener("dragover", (e: DragEvent) => {
      e.preventDefault();
      this.inputEl?.addClass("is-drag-over");
    });
    this.inputEl.addEventListener("dragleave", () => {
      this.inputEl?.removeClass("is-drag-over");
    });
    this.inputEl.addEventListener("drop", (e: DragEvent) => {
      this.handleDrop(e);
    });
    this.inputEl.addEventListener("input", () => {
      this.updateInputModeState();
      this.handleMentionInput();
      this.handleCommandInput();
      this.resizeInputEl();
    });

    const footer = inputArea.createDiv("pi-agent-input-footer");
    const footerLeft = footer.createDiv("pi-agent-input-footer-left");
    
    // 1. Model Selector Container (Compat with Claudian)
    const modelSelector = footerLeft.createDiv("pi-agent-model-selector");
    const footerModelBtn = modelSelector.createDiv("pi-agent-model-btn");
    this.footerModelLabel = footerModelBtn.createSpan("pi-agent-model-label");
    this.footerModelLabel.setText(this.getModelShortName(this.plugin.settings.modelId || "Sonnet"));
    this.footerModelLabel.setAttribute("title", `${this.plugin.settings.provider || ""}/${this.plugin.settings.modelId || ""}`);
    
    // 点击模型按钮，在按钮正上方弹起局部的模型选择浮层
    footerModelBtn.onclick = (e) => {
      e.stopPropagation();
      this.toggleModelPopup(footerModelBtn);
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
        this.toggleEffortPopup(this.effortGearsEl);
      }
    };

    // 3. Folder Context Button
    const folderBtn = footerLeft.createSpan({
      cls: "pi-agent-footer-folder-btn",
      attr: { title: isZh ? "选择文件上下文" : "Select file context" },
    });
    setIcon(folderBtn, "folder");
    folderBtn.onclick = () => this.addFileContext();

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

    // 4. YOLO Switch Toggle (Compat with Claudian)
    const permissionToggle = footerRight.createDiv("pi-agent-permission-toggle");
    const yoloLabelEl = permissionToggle.createSpan("pi-agent-permission-label");
    yoloLabelEl.setText("YOLO");
    this.yoloLabelEl = yoloLabelEl;

    const yoloToggleEl = permissionToggle.createDiv({
      cls: `pi-agent-toggle-switch ${!this.plugin.settings.safeMode ? "active" : ""}`,
      attr: { title: isZh ? "切换 YOLO 自动运行模式" : "Toggle YOLO auto-run mode" },
    });
    this.yoloToggleEl = yoloToggleEl;

    yoloToggleEl.onclick = async () => {
      const currentSafe = this.plugin.settings.safeMode;
      this.plugin.settings.safeMode = !currentSafe;
      await this.plugin.saveSettings();
      yoloToggleEl.toggleClass("active", currentSafe);
      new Notice(
        currentSafe
          ? (isZh ? "YOLO 自动执行模式已开启" : "YOLO auto-run mode enabled")
          : (isZh ? "安全确认模式已开启" : "Safe confirmation mode enabled")
      );
    };

    this.abortBtn = footerRight.createEl("button", {
      text: "×",
      cls: "pi-agent-footer-btn pi-agent-abort-btn",
      attr: { title: "Abort" },
    });
    this.abortBtn.style.display = "none";
    this.abortBtn.onclick = () => this.abortAgent();

    // ─── Start real Pi session tabs ───────────────────────────────────
    await this.restoreOrCreateInitialTab();
  }

  // ─── Client Management ────────────────────────────────────────────────

  private get activeTab(): ChatTab | null {
    return this.tabs.find((tab) => tab.id === this.activeTabId) ?? null;
  }

  private async restoreOrCreateInitialTab(): Promise<void> {
    const maxTabs = this.plugin.settings.maxTabs || 3;
    const persisted = this.plugin.settings.sessionTabs || [];

    this.tabs = [];
    // 有历史缓存时按历史缓存的卡片数还原（保持关闭某些卡片后的数量），初次无缓存时直接满额开满 maxTabs 个
    const count = persisted.length > 0 ? Math.min(persisted.length, maxTabs) : maxTabs;

    for (let i = 1; i <= count; i++) {
      const pTab = persisted[i - 1];
      this.tabs.push({
        id: `tab-static-${i}`,
        label: String(i),
        client: null,
        isStreaming: false,
        sessionFile: pTab?.sessionFile,
        sessionId: pTab?.sessionId,
        restored: !!pTab?.sessionFile,
      });
    }

    const active =
      this.tabs.find((tab) => tab.sessionFile?.toLowerCase() === this.plugin.settings.activeSessionFile?.toLowerCase()) ||
      this.tabs[0];
    this.activeTabId = active?.id || null;
    this.renderTabs();
    if (active) await this.switchToTab(active.id);
  }

  private async createAndSwitchTab(): Promise<void> {
    const tab: ChatTab = {
      id: `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      label: "",
      client: null,
      isStreaming: false,
    };
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
      tabEl.onclick = () => this.switchToTab(tab.id);
      
      // 选项卡右键功能：直接关闭，无需二级菜单
      tabEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.closeTab(tab.id);
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
    tab.label = tab.id.split("-").pop() || "Tab";
    
    if (tab.id === this.activeTabId) {
      if (this.chatContainer) this.chatContainer.empty();
      this.renderedMessages = [];
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
    this.activeTabId = tab.id;
    this.client = tab.client;
    this.isStreaming = tab.isStreaming;
    this.renderTabs();
    this.resetActiveRenderState();
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];
    this.renderEmptyState();
    this.updateWidget("tasks", undefined);
    await this.ensureTabClient(tab);
    this.client = tab.client;
    await this.refreshStateDisplay();
    await this.loadAvailableCommands();
    await this.loadMessages();
    this.updateButtons();
    await this.persistSessionTabs();
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

  private async ensureTabClient(tab: ChatTab): Promise<void> {
    if (tab.sessionFile && !this.isSessionFileInCurrentWorkspace(tab.sessionFile)) {
      console.log(`[pi-agent] SessionFile ${tab.sessionFile} belongs to another workspace, unbinding to start fresh.`);
      tab.sessionFile = undefined;
      tab.sessionId = undefined;
      tab.restored = false;
    }

    if (tab.client?.isRunning()) return;

    const client = this.createClient();
    tab.client = client;

    client.on("event", (event: RpcEvent) => {
      if (this.activeTabId !== tab.id) return;
      this.handleEvent(event);
    });

    client.on("error", (err: Error) => {
      if (this.activeTabId === tab.id) this.setStatus(`❌ Error: ${err.message}`, "error");
    });

    client.on("close", () => {
      tab.isStreaming = false;
      if (this.activeTabId === tab.id) {
        this.setStatus("⚠️ Pi process disconnected", "warning");
        this.isStreaming = false;
        this.updateButtons();
      }
    });

    try {
      await client.start();
      if (tab.sessionFile) {
        const result = await client.switchSession(tab.sessionFile);
        if (!result.success || (result.data as any)?.cancelled) {
          new Notice(`Failed to restore session: ${tab.label}`);
        }
      }
      if (this.activeTabId === tab.id) {
        this.setStatus("Ready", "ok");
        this.loadAvailableCommands();
      }
    } catch (err) {
      if (this.activeTabId === tab.id) {
        this.setStatus(
          `❌ Failed to start pi: ${(err as Error).message}`,
          "error"
        );
      }
    }
  }

  private createClient(): PiAgentClient {
    const settings = this.plugin.settings;
    const adapter = this.app.vault.adapter;
    const vaultBasePath =
      adapter instanceof FileSystemAdapter ? adapter.getBasePath() : undefined;

    return new PiAgentClient({
      piPath: settings.piPath,
      provider: settings.provider,
      modelId: settings.modelId,
      thinkingLevel: settings.thinkingLevel,
      apiKey: settings.apiKey,
      cwd: vaultBasePath,
      noSession: false,
      tools: settings.safeMode ? ["read", "grep", "find", "ls"] : undefined,
    });
  }

  private resetActiveRenderState(): void {
    this.currentAssistantMsg = null;
    this.currentTextBlock = null;
    this.currentThinkingBlock = null;
    this.currentThinkingContent = null;
    this.currentBlockRawText = "";
  }

  // ─── Event Handling ───────────────────────────────────────────────────

  private handleEvent(event: RpcEvent): void {
    switch (event.type) {
      case "agent_start":
        this.isStreaming = true;
        if (this.activeTab) this.activeTab.isStreaming = true;
        this.updateButtons();
        this.setStatus("🤔 Thinking...", "thinking");
        break;

      case "agent_end":
        this.isStreaming = false;
        if (this.activeTab) this.activeTab.isStreaming = false;
        this.currentAssistantMsg = null;
        this.currentTextBlock = null;
        this.currentThinkingBlock = null;
        this.currentThinkingContent = null;
        this.updateButtons();
        this.setStatus("✅ Ready", "ok");
        this.refreshStateDisplay();
        break;

      case "message_start":
        this.handleMessageStart(event);
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
        this.setStatus("✅ Turn complete", "ok");
        break;

      case "queue_update":
        this.handleQueueUpdate(event);
        break;

      case "compaction_start":
        this.setStatus("📦 Compacting context...", "thinking");
        break;

      case "compaction_end":
        this.compactedContextActive = !event.aborted;
        this.setStatus("✅ Compaction complete", "ok");
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

  private handleMessageStart(event: RpcEvent): void {
    const message = event.message as {
      role: string;
      content?: string | MessageContent[];
    };
    if (!message) return;

    if (message.role === "user") {
      const content =
        typeof message.content === "string"
          ? message.content
          : message.content
              ?.map((c) => c.text || c.thinking || "")
              .join("") || "";
      this.addMessage("user", content);
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

      case "text_delta":
        if (this.currentAssistantMsg) {
          if (!this.currentTextBlock) {
            const usePretty = this.shouldUsePrettyStreaming(0);
            this.currentTextBlock =
              this.currentAssistantMsg.contentEl.createDiv(
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
          this.currentBlockRawText += delta.delta || "";
          this.currentRawText += delta.delta || "";
          this.currentTextBlock.setAttribute("data-stream-raw", this.currentBlockRawText);

          const usePretty = this.shouldUsePrettyStreaming(this.currentBlockRawText.length);
          if (usePretty) {
            this.throttleRender(this.currentBlockRawText, this.currentTextBlock);
          } else {
            if (!this.currentTextBlock.classList.contains("pi-agent-streaming-block")) {
              this.convertCurrentTextBlockToFastStreaming();
            }
            this.appendStreamingDelta(this.currentBlockRawText);
          }
        }
        break;

      case "thinking_start":
        if (
          this.plugin.settings.showThinking &&
          this.currentAssistantMsg
        ) {
          this.thinkingStartedAt = Date.now();
          this.currentThinkingBlock =
            this.currentAssistantMsg.contentEl.createDiv(
              "pi-agent-thinking-block is-collapsed"
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
          this.currentThinkingContent.appendText(delta.delta || "");
          this.scrollToBottom();
        }
        break;

      case "thinking_end":
        if (this.thinkingTimer) {
          window.clearInterval(this.thinkingTimer);
          this.thinkingTimer = null;
        }
        if (this.currentThinkingBlock) {
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

      case "error":
        if (this.currentAssistantMsg) {
          this.currentAssistantMsg.contentEl.createDiv(
            "pi-agent-error-block"
          ).textContent = `⚠️ Error: ${delta.reason || "Unknown error"}`;
        }
        break;
    }
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
          MarkdownRenderer.render(
            this.app,
            raw,
            textBlock as HTMLElement,
            "",
            this
          );
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

      this.scrollToBottom();
    } else {
      this.scrollToBottom();
    }
  }

  private parseOptionsFromMessage(
    text: string
  ): { options: string[]; isQuestion: boolean } | null {
    if (!text) return null;
    const lines = text.split("\n").map((l) => l.trim());
    let current: string[] = [];
    let best: string[] = [];
    const optionRe = /^(?:\d+[.)]|[一二三四五六七八九十]+[、.)]|[a-zA-Z][.)]|[-*•])\s+(.+)$/;
    for (const line of lines) {
      if (line === "") {
        if (current.length > best.length) best = current;
        current = [];
        continue;
      }
      const m = line.match(optionRe);
      if (m) {
        current.push(m[2].trim());
      } else {
        if (current.length > best.length) best = current;
        current = [];
      }
    }
    if (current.length > best.length) best = current;
    if (best.length < 2) return null;
    // Optional: verify the assistant also asked a question in the message
    // somewhere — this is just a label hint, not a hard requirement.
    const asksQuestion = lines.some(
      (l) => /[?？]\s*$/.test(l) || /要.{0,6}[吗？]/.test(l) || /请选择|请告诉我/.test(l)
    );
    return { options: best.slice(0, 8), isQuestion: asksQuestion };
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
          ? "多选（点击问题里的选项）："
          : "Multi-select (options from the question):"
        : isZh
          ? "多选："
          : "Multi-select:"
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
      this.sendMessage();
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
        const path = (typeof args.path === "string" ? args.path : "") ||
                     (typeof args.TargetFile === "string" ? args.TargetFile : "") ||
                     (typeof args.target === "string" ? args.target : "");
        if (path) {
          argsEl.addClass("is-clickable");
          argsEl.setAttribute("title", `${path} (Click to open)`);
          argsEl.onclick = async (event) => {
            event.stopPropagation();
            const file = this.app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) await this.app.workspace.getLeaf(false).openFile(file);
          };
        } else if (toolName === "bash" && args.command) {
          argsEl.addClass("is-clickable");
          const fullCmd = args.command as string;
          const isZh = this.plugin.settings.language === "zh";
          argsEl.setAttribute("title", `${fullCmd} (Click to copy)`);
          argsEl.onclick = async (event) => {
            event.stopPropagation();
            try {
              await navigator.clipboard.writeText(fullCmd);
              new Notice(isZh ? "命令已复制到剪贴板" : "Command copied to clipboard");
            } catch (err) {
              new Notice(`Failed to copy: ${err}`);
            }
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
        const statEl = document.createElement("span");
        statEl.className = "pi-agent-tool-diff";
        const addedEl = document.createElement("span");
        addedEl.className = "pi-agent-tool-add";
        addedEl.textContent = `+${stats.added}`;
        const removedEl = document.createElement("span");
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
        } else if (diffText && ["edit", "write"].includes(event.toolName as string)) {
          this.renderDiffOutput(outputEl, diffText);
        } else if (text && ["bash", "grep", "find", "ls"].includes(event.toolName as string)) {
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

  private handleQueueUpdate(event: RpcEvent): void {
    const steering = event.steering as string[] | undefined;
    const followUp = event.followUp as string[] | undefined;
    const total = (steering?.length || 0) + (followUp?.length || 0);
    if (total > 0) {
      this.setStatus(`📋 ${total} queued message(s)`, "thinking");
    }
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
      // Simple prompt-based selection
      const choice = window.prompt(
        `${title}\nOptions: ${options.join(", ")}`,
        options[0]
      );
      if (choice && options.includes(choice)) {
        this.client?.sendUIResponse(id, { value: choice });
      } else {
        this.client?.sendUIResponse(id, { cancelled: true });
      }
    } else if (method === "input") {
      const title = event.title as string;
      const placeholder = event.placeholder as string;
      const value = window.prompt(title, placeholder || "");
      if (value !== null) {
        this.client?.sendUIResponse(id, { value });
      } else {
        this.client?.sendUIResponse(id, { cancelled: true });
      }
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
        console.log("[pisidian] setWidget event received:", event);
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

  private addMessage(role: string, content: string): RenderedMessage {
    if (!this.chatContainer) {
      throw new Error("Chat container not initialized");
    }

    this.clearEmptyState();
    const msgEl = this.chatContainer.createDiv(
      `pi-agent-message pi-agent-message-${role}`
    );

    // Role badge
    const badge = msgEl.createDiv("pi-agent-message-badge");
    switch (role) {
      case "user":
        badge.setText("👤 You");
        break;
      case "assistant":
        badge.setText("🤖 Pi");
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
      contentEl.createSpan({ text: content });
      msgEl.setAttribute("data-raw-content", content);
    }

    // Add floating hover actions
    if (role === "user" || role === "assistant") {
      const actionsEl = msgEl.createDiv("pi-agent-msg-actions");

      // 1. Copy button
      const copyBtn = actionsEl.createEl("button", {
        cls: "pi-agent-action-btn",
        attr: { title: "Copy message" },
      });
      copyBtn.setText("📋");
      copyBtn.onclick = async (e) => {
        e.stopPropagation();
        const rawContent = msgEl.getAttribute("data-raw-content") || msgEl.textContent || "";
        await navigator.clipboard.writeText(rawContent);
        new Notice("Copied to clipboard");
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

      // 3. Edit / Reuse (user only)
      if (role === "user") {
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
      role,
      el: msgEl,
      contentEl,
    };

    this.renderedMessages.push(rendered);

    // Limit displayed messages
    const maxDisplay = this.plugin.settings.maxHistoryDisplay;
    while (this.renderedMessages.length > maxDisplay) {
      const oldest = this.renderedMessages.shift();
      if (oldest) oldest.el.remove();
    }

    this.scrollToBottom(true, true);
    return rendered;
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
    title = "Context compacted"
  ): void {
    if (!this.chatContainer) return;
    this.clearEmptyState();
    const wrap = this.chatContainer.createDiv("pi-agent-compaction-summary");
    const header = wrap.createDiv("pi-agent-compaction-header");
    header.setText(
      tokensBefore
        ? `📦 ${title} · ${tokensBefore.toLocaleString()} tokens summarized`
        : `📦 ${title}`
    );
    if (summary && summary.trim()) {
      const body = wrap.createDiv("pi-agent-compaction-body markdown-preview-view markdown-rendered");
      MarkdownRenderer.render(this.app, summary, body, "", this);
    }
    this.scrollToBottom(true, true);
  }

  private renderEmptyState(): void {
    if (!this.chatContainer || this.chatContainer.querySelector(".pi-agent-empty-state")) return;
    const empty = this.chatContainer.createDiv("pi-agent-empty-state");
    empty.createDiv({ text: "π", cls: "pi-agent-empty-logo" });
    empty.createDiv({ text: "Pisidian", cls: "pi-agent-empty-title" });
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
    setTimeout(() => {
      if (this.chatContainer) {
        if (!force) {
          const scrollOffset = this.chatContainer.scrollHeight - this.chatContainer.scrollTop - this.chatContainer.clientHeight;
          if (scrollOffset >= 50) return;
        }
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
      }
    }, 50);
    setTimeout(() => {
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
    const messages = Array.from(this.chatContainer?.querySelectorAll(".pi-agent-message") || []) as HTMLElement[];
    if (messages.length === 0) return;
    const center = (this.chatContainer?.scrollTop || 0) + (this.chatContainer?.clientHeight || 0) / 2;
    let index = messages.findIndex((message) => message.offsetTop + message.offsetHeight / 2 > center);
    if (index === -1) index = messages.length - 1;
    const nextIndex = Math.max(0, Math.min(messages.length - 1, index + direction));
    messages[nextIndex]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

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
      const chipsContainer = document.createElement("div");
      chipsContainer.className = "pi-agent-detected-files";
      chipsContainer.createSpan({ text: "Detected files: ", cls: "pi-agent-detected-label" });
      uniqueFiles.forEach((file) => {
        const chip = chipsContainer.createSpan({
          text: file.name,
          cls: "pi-agent-file-chip is-clickable",
          attr: { title: `${file.path} (Click to open)` }
        });
        chip.onclick = async (e) => {
          e.stopPropagation();
          await this.app.workspace.getLeaf(false).openFile(file);
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
        this.widgetEl.style.display = "none";
        return;
      }

      this.widgetEl.empty();
      this.widgetEl.style.display = "block";
      this.widgetEl.className = `pi-agent-widget pi-agent-widget-${widgetKey}`;

      const titleLine = lines[0];
      const contentLines = lines.slice(1);

      const header = this.widgetEl.createDiv("pi-agent-widget-header");
      const icon = header.createSpan("pi-agent-widget-icon");
      try {
        setIcon(icon, "list-todo");
      } catch (e) {
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
      console.error("[pisidian] updateWidget error:", err);
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
        .onClick(() => this.showCommandSelector())
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
    menu.addSeparator();
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "压缩上下文" : "Compact context")
        .setIcon("archive")
        .onClick(() => this.compactSession())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "导出 HTML" : "Export HTML")
        .setIcon("download")
        .onClick(() => this.exportSessionHtml())
    );
    menu.addItem((item) =>
      item
        .setTitle(isZh ? "会话统计" : "Session stats")
        .setIcon("bar-chart-2")
        .onClick(() => this.showStats())
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
    this.inputEl.setAttribute("placeholder", isBash ? "Bash mode — command will run locally" : "How can I help you today?");
    this.statusBar?.toggleClass("is-bash-mode", isBash);
    if (isBash && this.statusBar) this.statusBar.setText("Bash mode");
  }

  private async sendMessage(): Promise<void> {
    if (!this.client || !this.inputEl) return;
    const rawMessage = this.inputEl.value.trim();
    const contextPrefix = this.buildContextPrefix() + this.buildRecentContextGuard(rawMessage);
    const images = this.getImagePayloads();
    const userMessage = rawMessage || (images.length ? "Please analyze the attached image(s)." : "");
    const baseMessage = `${contextPrefix}${userMessage}`.trim();
    if (!baseMessage && images.length === 0) return;
    const message = this.applySystemPrompt(baseMessage);

    this.maybeTitleActiveTab(rawMessage || message);

    // Pi RPC emits the accepted user message via message_start.
    // Do not render optimistically here, otherwise the message appears twice.

    // Clear input
    this.inputEl.value = "";
    this.inputEl.style.height = "auto";
    this.updateInputModeState();
    this.clearContextItems();

    try {
      if (message.startsWith("!")) {
        await this.runBashMode(message);
      } else if (this.isStreaming) {
        // Queue as steer message
        await this.client.steer(message, { images });
      } else {
        await this.client.prompt(message, { images });
      }
    } catch (err) {
      this.addSystemMessage(
        `❌ Failed to send: ${(err as Error).message}`
      );
    }
  }

  private applySystemPrompt(message: string): string {
    const systemPrompt = (this.plugin.settings.systemPrompt || "").trim();
    if (!systemPrompt || message.startsWith("!")) return message;
    return [
      "System instruction for this Pisidian turn:",
      systemPrompt,
      "",
      "User request:",
      message,
    ].join("\n");
  }

  private maybeTitleActiveTab(seed: string): void {
    const tab = this.activeTab;
    if (!tab || !/^\d+$/.test(tab.label)) return;
    const title = seed
      .replace(/@\S+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 16);
    if (title) {
      tab.label = title;
      this.renderTabs();
      this.persistSessionTabs();
    }
  }

  private abortAgent(): void {
    this.client?.abort();
    this.isStreaming = false;
    this.updateButtons();
    this.setStatus("⏹ Aborted", "warning");
  }

  private async newSession(): Promise<void> {
    const tab = this.activeTab;
    if (!tab) return;
    
    // 清空当前 Tab 绑定的会话参数
    tab.sessionFile = undefined;
    tab.sessionId = undefined;
    tab.restored = false;
    tab.client = null;
    tab.isStreaming = false;

    // 清除聊天框 DOM 状态
    if (this.chatContainer) this.chatContainer.empty();
    this.renderedMessages = [];
    this.renderEmptyState();
    this.updateWidget("tasks", undefined);

    // 重新实例化并同步空白客户端
    await this.ensureTabClient(tab);
    this.client = tab.client;
    await this.refreshStateDisplay();
    await this.loadAvailableCommands();
    this.updateButtons();
    await this.persistSessionTabs();

    const isZh = this.plugin.settings.language === "zh";
    new Notice(isZh ? "已重置并开启新会话" : "Session reset and new chat started");
  }

  private async compactSession(): Promise<void> {
    if (!this.client) return;
    const isZh = this.plugin.settings.language === "zh";
    try {
      const result = await this.client.compact();
      if (result.success) {
        this.compactedContextActive = true;
        const summary = (result.data as any)?.summary || "";
        this.addCompactionSummaryMessage(summary, (result.data as any)?.tokensBefore);
        new Notice(isZh ? "上下文已压缩；可见对话已保留" : "Context compacted; visible chat preserved");
      } else {
        new Notice(isZh ? "上下文压缩失败" : "Compaction failed");
      }
    } catch (err) {
      new Notice(`Compaction failed: ${(err as Error).message}`);
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
        const info = [
          `Messages: ${data.totalMessages || 0}`,
          `Tokens: ${tokens.total || 0} (in: ${tokens.input || 0}, out: ${tokens.output || 0})`,
          `Cost: $${(data.cost || 0).toFixed(4)}`,
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
    const directory = this.getSessionDirectory();
    if (!directory) {
      new Notice("No session directory known yet. Send one message first.");
      return;
    }
    try {
      const sessions = this.listResumeSessions(directory);
      if (sessions.length === 0) {
        new Notice("No previous sessions found");
        return;
      }
      new ResumeSessionSuggestModal(this.app, sessions, async (session) => {
        new ResumeActionModal(this.app, session, async (action) => {
          if (action === "open") await this.openResumeSession(session);
          if (action === "delete") await this.deleteResumeSession(session);
        }).open();
      }).open();
    } catch (err) {
      new Notice(`Resume failed: ${(err as Error).message}`);
    }
  }

  private async openResumeSession(session: ResumeSessionItem): Promise<void> {
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

        this.resetActiveRenderState();
        if (this.chatContainer) this.chatContainer.empty();
        this.renderedMessages = [];

        await this.loadMessages();
        await this.refreshStateDisplay();
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

  private async toggleModelPopup(anchorEl: HTMLElement): Promise<void> {
    if (this.modelPopupEl) {
      this.closeModelPopup();
      return;
    }
    this.closeEffortPopup();

    if (!this.client) return;
    const isZh = this.plugin.settings.language === "zh";

    // 1. 如果有缓存，立即瞬间弹出渲染，实现“零延迟秒开”！
    if (this.availableModelsCache && this.availableModelsCache.length > 0) {
      this.renderModelPopup(anchorEl, this.availableModelsCache);
      // 同时在后台静默抓取最新模型列表并更新缓存
      this.client.getAvailableModels().then(result => {
        if (result.success && result.data) {
          const models = ((result.data as any).models || []) as PiModel[];
          if (models.length > 0) {
            this.availableModelsCache = models;
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
        document.addEventListener("pointerdown", this.modelOutsideClickHandler!);
      }, 0);
    }

    try {
      const result = await this.client.getAvailableModels();
      if (!result.success || !result.data) {
        if (!this.availableModelsCache) this.closeModelPopup();
        return;
      }

      const models = ((result.data as any).models || []) as PiModel[];
      if (models.length === 0) {
        new Notice(isZh ? "没有可用的模型" : "No models available");
        this.closeModelPopup();
        return;
      }

      this.availableModelsCache = models;
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
      document.removeEventListener("pointerdown", this.modelOutsideClickHandler);
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

    for (const [groupName, groupModels] of groups.entries()) {
      const titleEl = this.modelPopupEl.createDiv("pi-agent-model-popup-group-title");
      titleEl.setText(groupName);

      for (const model of groupModels) {
        const isCurrent = this.plugin.settings.modelId === model.id;
        const itemEl = this.modelPopupEl.createDiv({
          cls: `pi-agent-model-popup-item ${isCurrent ? "is-active" : ""}`
        });

        const iconEl = itemEl.createDiv("pi-agent-model-popup-item-icon");
        iconEl.innerHTML = this.getProviderIconSvg(model.provider, model.id);

        const shortName = model.name || this.getModelShortName(model.id);
        itemEl.createSpan({ text: shortName, cls: "pi-agent-model-popup-item-name" });

        itemEl.onclick = async (e) => {
          e.stopPropagation();
          this.plugin.settings.provider = model.provider;
          this.plugin.settings.modelId = model.id;
          await this.plugin.saveSettings();
          await this.client?.setModel(model.provider, model.id);
          this.updateModelDisplay(model.provider, model.id);
          new Notice(isZh ? `模型已切换为 ${shortName}` : `Model set to ${shortName}`);
          this.closeModelPopup();
        };
      }
    }

    this.modelOutsideClickHandler = (e: MouseEvent) => {
      if (this.modelPopupEl && !this.modelPopupEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
        this.closeModelPopup();
      }
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", this.modelOutsideClickHandler!);
    }, 0);
  }

  private toggleEffortPopup(anchorEl: HTMLElement): void {
    if (this.effortPopupEl) {
      this.closeEffortPopup();
      return;
    }
    this.closeModelPopup();

    this.renderEffortPopup(anchorEl);
  }

  private closeEffortPopup(): void {
    if (this.effortPopupEl) {
      this.effortPopupEl.remove();
      this.effortPopupEl = null;
    }
    if (this.effortOutsideClickHandler) {
      document.removeEventListener("pointerdown", this.effortOutsideClickHandler);
      this.effortOutsideClickHandler = null;
    }
  }

  private renderEffortPopup(anchorEl: HTMLElement): void {
    const parent = anchorEl.parentElement;
    if (!parent) return;

    const isZh = this.plugin.settings.language === "zh";

    this.effortPopupEl = parent.createDiv({ cls: "pi-agent-effort-popup" });

    const options = [
      { id: "", name: "auto", desc: isZh ? "沿用 pi 默认设置" : "Pi Default" },
      { id: "off", name: "off", desc: isZh ? "关闭推理" : "Reasoning Off" },
      { id: "minimal", name: "low (minimal)", desc: isZh ? "最少推理" : "Minimal Reasoning" },
      { id: "low", name: "low", desc: isZh ? "低强度推理" : "Low Reasoning" },
      { id: "medium", name: "medium", desc: isZh ? "中等推理" : "Medium Reasoning" },
      { id: "high", name: "high", desc: isZh ? "高强度推理" : "High Reasoning" },
      { id: "xhigh", name: "xhigh", desc: isZh ? "最高强度推理" : "Max Reasoning" }
    ];

    let currentLevel = this.plugin.settings.thinkingLevel || "";
    if (currentLevel === "auto") currentLevel = "";

    for (const option of options) {
      const isCurrent = currentLevel === option.id;
      const itemEl = this.effortPopupEl.createDiv({
        cls: `pi-agent-effort-popup-item ${isCurrent ? "is-active" : ""}`
      });

      // Left area: check mark + English name
      const leftEl = itemEl.createSpan({ cls: "pi-agent-effort-popup-left" });
      const checkEl = leftEl.createSpan({ cls: "pi-agent-effort-popup-item-check" });
      checkEl.setText("✓");

      leftEl.createSpan({ text: option.name, cls: "pi-agent-effort-popup-item-name" });

      // Right area: description
      itemEl.createSpan({ text: option.desc, cls: "pi-agent-effort-popup-item-desc" });

      itemEl.onclick = async (e) => {
        e.stopPropagation();
        this.plugin.settings.thinkingLevel = option.id;
        await this.plugin.saveSettings();
        if (this.client) {
          await this.client.setThinkingLevel(option.id);
        }
        if (this.footerEffortCurrent) {
          this.footerEffortCurrent.setText(this.getThinkingLevelLabel(option.id));
        }
        new Notice(isZh ? `思考强度已设为 ${option.name}` : `Thinking level set to ${option.name}`);
        this.closeEffortPopup();
      };
    }

    this.effortOutsideClickHandler = (e: MouseEvent) => {
      if (this.effortPopupEl && !this.effortPopupEl.contains(e.target as Node) && !anchorEl.contains(e.target as Node)) {
        this.closeEffortPopup();
      }
    };
    window.setTimeout(() => {
      document.addEventListener("pointerdown", this.effortOutsideClickHandler!);
    }, 0);
  }

  private async toggleHistoryPanel(): Promise<void> {
    const isZh = this.plugin.settings.language === "zh";
    this.isHistoryOpen = !this.isHistoryOpen;
    
    const historyBtn = this.containerEl.querySelector(".pi-agent-mini-action:has(svg.svg-icon[class*='history'])") || 
                       this.containerEl.querySelector(".pi-agent-mini-action svg[class*='history']")?.parentElement;
    if (historyBtn) {
      historyBtn.toggleClass("is-active", this.isHistoryOpen);
    }

    if (this.isHistoryOpen) {
      if (this.chatContainer) this.chatContainer.style.display = "none";
      if (this.historyPanelEl) {
        this.historyPanelEl.style.display = "flex";
        await this.renderHistoryPanel();
      }
    } else {
      if (this.chatContainer) this.chatContainer.style.display = "flex";
      if (this.historyPanelEl) this.historyPanelEl.style.display = "none";
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
    const os = require("os");
    const home = os.homedir().replace(/\\/g, "/");
    const sessionsBaseDir = `${home}/.pi/agent/sessions`;
    const { existsSync, readdirSync, statSync } = require("fs");
    
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
      // Keep the custom History UI, but use exactly the same data source as
      // Resume session...: current resume directory + listResumeSessions().
      const directory = this.getSessionDirectory();
      if (!directory) {
        this.historyPanelEl.createDiv({
          text: isZh ? "暂无会话历史" : "No conversation history",
          cls: "pi-agent-history-empty",
        });
        return;
      }

      const sessions = this.listResumeSessions(directory);
      if (sessions.length === 0) {
        this.historyPanelEl.createDiv({
          text: isZh ? "暂无会话历史" : "No conversation history",
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
              const haystack = [session.label, session.preview, session.path]
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

        for (const session of filtered) {
          const itemEl = listContainer.createDiv("pi-agent-history-item");
          const iconEl = itemEl.createDiv("pi-agent-history-item-icon");
          setIcon(iconEl, "message-square");

          const contentEl = itemEl.createDiv("pi-agent-history-item-content");
          const nameText = session.label || (isZh ? "未命名对话" : "Untitled Session");
          contentEl.createDiv({ text: nameText, cls: "pi-agent-history-item-name" });
          const timeText = this.formatHistoryTime(session.mtime);
          contentEl.createDiv({ text: timeText, cls: "pi-agent-history-item-time" });

          itemEl.onclick = async () => {
            await this.openResumeSession(session);
            this.isHistoryOpen = false;
            if (this.chatContainer) this.chatContainer.style.display = "flex";
            this.historyPanelEl!.style.display = "none";
            const historyBtn = this.containerEl.querySelector(".pi-agent-mini-action.is-active");
            historyBtn?.removeClass("is-active");
          };

          itemEl.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const Menu = (require("obsidian") as any).Menu;
            const menu = new Menu();
            menu.addItem((item: any) => {
              item
                .setTitle(isZh ? "重命名" : "Rename")
                .setIcon("pencil")
                .onClick(async () => {
                  await this.renameResumeSession(session);
                  await this.renderHistoryPanel();
                });
            });
            menu.addItem((item: any) => {
              item
                .setTitle(isZh ? "删除此会话" : "Delete session")
                .setIcon("trash-2")
                .onClick(async () => {
                  await this.deleteResumeSession(session);
                  await this.renderHistoryPanel();
                });
            });
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
    const current = this.plugin.settings.sessionTitles?.[session.path] || session.label || "";
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
      this.plugin.settings.sessionTitles[session.path] = title;
      session.label = title;
    } else {
      delete this.plugin.settings.sessionTitles[session.path];
    }
    await this.plugin.saveSettings();
    new Notice(isZh ? "会话已重命名" : "Session renamed");
  }

  private async deleteResumeSession(session: ResumeSessionItem): Promise<void> {
    const confirmed = await new Promise<boolean>((resolve) => {
      new PiAgentConfirmModal(
        this.app,
        "Delete Pisidian session?",
        `Delete this session file?\n\n${session.path}\n\nThis cannot be undone from Pisidian.`,
        resolve
      ).open();
    });
    if (!confirmed) return;
    const tab = this.tabs.find((item) => item.sessionFile?.toLowerCase() === session.path?.toLowerCase());
    if (tab) await this.closeTab(tab.id);
    try {
      unlinkSync(session.path);
      if (this.plugin.settings.sessionTitles?.[session.path]) {
        delete this.plugin.settings.sessionTitles[session.path];
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
        const os = require("os");
        const home = os.homedir().replace(/\\/g, "/");
        const sessionsBaseDir = `${home}/.pi/agent/sessions`;
        const { existsSync, readdirSync } = require("fs");

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
    return readdirSync(directory)
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => {
        const path = `${directory}/${name}`;
        const stat = statSync(path);
        const preview = this.readSessionPreview(path);
        const customTitle = this.plugin.settings.sessionTitles?.[path];
        return {
          path,
          label: customTitle || (preview ? preview.slice(0, 24) : basename(name, ".jsonl").slice(0, 12)),
          mtime: stat.mtimeMs,
          preview,
        };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 200);
  }

  private readSessionPreview(path: string): string {
    try {
      const text = readFileSync(path, "utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line) as any;
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
    }
    return "";
  }

  private async showForkSelector(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.getForkMessages();
      const messages = (((result.data as any)?.messages || []) as ForkMessage[]).filter(
        (item) => item.entryId && item.text
      );
      if (!result.success || messages.length === 0) {
        new Notice("No previous user prompts available to fork");
        return;
      }
      new ForkMessageSuggestModal(this.app, messages, async (message) => {
        const forked = await this.client?.fork(message.entryId);
        if (!forked?.success || (forked.data as any)?.cancelled) {
          new Notice("Fork cancelled");
          return;
        }
        this.setInputText(((forked.data as any)?.text || message.text).trim());
        this.resetActiveRenderState();
        if (this.chatContainer) this.chatContainer.empty();
        this.renderedMessages = [];
        await this.loadMessages();
        new Notice("Fork created");
      }).open();
    } catch (err) {
      new Notice(`Fork failed: ${(err as Error).message}`);
    }
  }

  private async cloneCurrentBranch(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.clone();
      if (!result.success || (result.data as any)?.cancelled) {
        new Notice("Clone cancelled");
        return;
      }
      this.resetActiveRenderState();
      if (this.chatContainer) this.chatContainer.empty();
      this.renderedMessages = [];
      await this.loadMessages();
      new Notice("Current branch cloned");
    } catch (err) {
      new Notice(`Clone failed: ${(err as Error).message}`);
    }
  }

  private async runBashMode(message: string): Promise<void> {
    if (!this.client) return;
    if (this.plugin.settings.safeMode) {
      this.addSystemMessage("Bash mode is blocked while Safe mode is enabled");
      return;
    }

    const command = message.replace(/^!+/, "").trim();
    if (!command) return;

    if (this.isDangerousBashCommand(command)) {
      const allowed = await new Promise<boolean>((resolve) => {
        new PiAgentConfirmModal(
          this.app,
          "Dangerous bash command",
          `Pisidian is about to run:\n\n${command}\n\nThis looks destructive. Allow it?`,
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
      const result = await this.client.bash(command);
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
      if (!result.success || !result.data) return;
      const commands = ((result.data as any).commands || []) as PiCommand[];
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
        this.plugin.settings.provider = model.provider;
        this.plugin.settings.modelId = model.id;
        await this.plugin.saveSettings();
        await this.client?.setModel(model.provider, model.id);
        this.updateModelDisplay(model.provider, model.id);
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
          new Notice("Pisidian returned an empty replacement");
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
        new Notice("Selection edited by Pisidian");
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
   * Files that Pisidian considers attachable to chat context.
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

  private addContextItem(item: ContextItem): void {
    if (this.contextItems.some((existing) => existing.value === item.value)) return;
    this.contextItems.push(item);
    this.renderContextItems();
  }

  private removeContextItem(id: string): void {
    this.contextItems = this.contextItems.filter((item) => item.id !== id);
    this.renderContextItems();
  }

  private clearContextItems(): void {
    this.contextItems = [];
    this.renderContextItems();
  }

  private renderContextItems(): void {
    if (!this.contextRowEl) return;
    this.contextRowEl.empty();
    this.contextRowEl.toggleClass("has-content", this.contextItems.length > 0);
    for (const item of this.contextItems) {
      const chip = this.contextRowEl.createSpan({ cls: "pi-agent-file-chip" });
      if (item.type === "image") {
        chip.createEl("img", {
          cls: "pi-agent-file-chip-thumb",
          attr: { src: `data:${item.mimeType || "image/png"};base64,${item.value}` },
        });
      } else {
        chip.createSpan({
          text: item.type === "selection" ? "▤" : item.type === "folder" ? "▦" : "▣",
          cls: "pi-agent-file-chip-icon",
        });
      }
      chip.createSpan({ text: item.label, cls: "pi-agent-file-chip-name" });
      const remove = chip.createSpan({ text: "×", cls: "pi-agent-file-chip-remove" });
      remove.onclick = (event) => {
        event.stopPropagation();
        this.removeContextItem(item.id);
      };
      chip.onclick = async () => {
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
              this.app.workspace.revealLeaf(fileExplorer);
            }
          }
        } else {
          new ContextPreviewModal(this.app, item).open();
        }
      };
    }
  }

  private buildRecentContextGuard(rawMessage: string): string {
    // Pi's backend compaction should preserve summary + recent tail, but very
    // terse follow-ups ("A", "选第二个", "yes") can become ambiguous if the
    // compaction summary omitted the immediately preceding choice/question.
    // Keep the visible transcript intact, and only add a small guard after a
    // compaction for short replies.
    if (!this.compactedContextActive) return "";
    const trimmed = rawMessage.trim();
    if (!trimmed || trimmed.length > 40) return "";
    const lastAssistant = [...this.renderedMessages]
      .reverse()
      .find((m) => m.role === "assistant")
      ?.el.getAttribute("data-raw-content")
      ?.trim();
    if (!lastAssistant) return "";
    return [
      "<recent_context_guard>",
      "The user's short reply may refer to the immediately preceding assistant message. Use this previous assistant message to resolve pronouns/options, but answer the user's latest request directly.",
      lastAssistant.slice(-3000),
      "</recent_context_guard>",
      "",
    ].join("\n");
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

  private async toggleSafeMode(): Promise<void> {
    this.plugin.settings.safeMode = !this.plugin.settings.safeMode;
    await this.plugin.saveSettings();
    this.updateSafeToggle();
    this.addSystemMessage(
      this.plugin.settings.safeMode
        ? "Safe mode enabled: read-only tools only"
        : "Full mode enabled: bash/write/edit tools available"
    );
    const tab = this.activeTab;
    if (tab?.client) {
      await tab.client.destroy();
      tab.client = null;
    }
    if (tab) {
      await this.ensureTabClient(tab);
      this.client = tab.client;
      await this.refreshStateDisplay();
    }
  }

  private async refreshStateDisplay(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.getState();
      if (!result.success || !result.data) return;
      const state = result.data as any;
      if (state.model) {
        this.updateModelDisplay(state.model.provider, state.model.id);
      }
      if (this.footerEffortCurrent) {
        this.footerEffortCurrent.setText(this.getThinkingLevelLabel(state.thinkingLevel));
      }

      await this.refreshContextUsageDisplay();
      this.updateSafeToggle();
      
      // 预热可用模型列表缓存，确保点击弹出时能“秒开”且不阻塞用户
      this.client.getAvailableModels().then(res => {
        if (res.success && res.data) {
          this.availableModelsCache = ((res.data as any).models || []) as PiModel[];
        }
      }).catch(() => {});
    } catch {
      // Non-fatal; UI can still function without state display.
    }
  }

  private async refreshContextUsageDisplay(): Promise<void> {
    if (!this.client || !this.footerContextEl) return;
    try {
      const result = await this.client.getSessionStats();
      if (result.success) {
        this.updateActiveTabSessionInfo(result.data as any);
        await this.persistSessionTabs();
      }
      const usage = (result.data as any)?.contextUsage;
      if (result.success && usage?.percent != null) {
        this.updateContextMeter(Number(usage.percent), `Context: ${usage.tokens ?? "?"}/${usage.contextWindow ?? "?"}`);
      } else {
        this.updateContextMeter(null, "Context usage");
      }
    } catch {
      this.updateContextMeter(null, "Context usage");
    }
  }

  private updateContextMeter(percent: number | null, title: string): void {
    if (!this.footerContextEl || !this.footerContextFillEl || !this.footerContextPercentEl) return;
    const circumference = 2 * Math.PI * 8;
    this.footerContextFillEl.style.strokeDasharray = `${circumference}`;
    if (percent == null || Number.isNaN(percent)) {
      this.footerContextPercentEl.setText("");
      this.footerContextFillEl.style.strokeDashoffset = `${circumference}`;
      this.footerContextEl.removeClass("warning");
      this.footerContextEl.removeClass("danger");
      this.footerContextEl.setAttribute("title", title);
      return;
    }
    const clamped = Math.max(0, Math.min(100, percent));
    this.footerContextFillEl.style.strokeDashoffset = `${circumference * (1 - clamped / 100)}`;
    this.footerContextPercentEl.setText(`${Math.round(clamped)}%`);
    this.footerContextEl.toggleClass("warning", clamped >= 70 && clamped < 85);
    this.footerContextEl.toggleClass("danger", clamped >= 85);
    this.footerContextEl.setAttribute("title", title);
  }

  private updateActiveTabSessionInfo(data: any): void {
    const tab = this.activeTab;
    if (!tab || !data) return;
    if (typeof data.sessionFile === "string") tab.sessionFile = data.sessionFile;
    if (typeof data.sessionId === "string") tab.sessionId = data.sessionId;
    const maybeName = data.name || data.sessionName || data.title;
    if (typeof maybeName === "string" && maybeName.trim()) {
      tab.label = maybeName.trim().slice(0, 24);
      this.renderTabs();
    }
  }

  private async persistSessionTabs(): Promise<void> {
    this.plugin.settings.sessionTabs = this.tabs
      .filter((tab) => tab.sessionFile)
      .map((tab) => ({
        label: tab.label,
        sessionFile: tab.sessionFile,
        sessionId: tab.sessionId,
      }));
    this.plugin.settings.activeSessionFile = this.activeTab?.sessionFile || "";
    await this.plugin.saveSettings();
  }

  private updateModelDisplay(provider: string, modelId: string): void {
    if (!this.footerModelLabel) return;
    const shortName = modelId
      .replace(/^claude-/, "")
      .replace(/^gpt-/, "GPT-")
      .replace(/^deepseek-/, "DeepSeek ")
      .slice(0, 18);
    this.footerModelLabel.setText(shortName || provider);
    this.footerModelLabel.setAttribute("title", `${provider}/${modelId}`);
  }

  private updateSafeToggle(): void {
    if (!this.yoloToggleEl) return;
    const isYolo = !this.plugin.settings.safeMode;
    this.yoloToggleEl.toggleClass("active", isYolo);
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
        new Notice("No Pisidian response to insert");
        return;
      }
      editor.replaceSelection(text);
      new Notice("Inserted last Pisidian response");
    } catch (err) {
      new Notice(`Insert failed: ${(err as Error).message}`);
    }
  }

  private async reloadMessagesFromClient(): Promise<void> {
    if (this.chatContainer) {
      this.chatContainer.empty();
    }
    this.renderedMessages = [];
    this.renderEmptyState();
    await this.loadMessages();
  }

  private async loadMessages(): Promise<void> {
    if (!this.client) return;
    try {
      const result = await this.client.getMessages();
      if (result.success && result.data) {
        const messages = (result.data as any).messages || [];
        for (const msg of messages) {
          if (msg.role === "user") {
            const content =
              typeof msg.content === "string"
                ? msg.content
                : Array.isArray(msg.content)
                ? msg.content
                    .map((c: any) => c.text || "")
                    .join("")
                : "";
            this.addMessage("user", content);
          } else if (msg.role === "compactionSummary") {
            this.addCompactionSummaryMessage(msg.summary || "", msg.tokensBefore);
          } else if (msg.role === "branchSummary") {
            this.addCompactionSummaryMessage(msg.summary || "", undefined, "Branch summary");
          } else if (msg.role === "assistant") {
            const rendered = this.addMessage("assistant", "");
            this.currentAssistantMsg = rendered;
            if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "text" && block.text) {
                  rendered.el.setAttribute("data-raw-content", block.text);
                  const textBlock =
                    rendered.contentEl.createDiv("pi-agent-text-block markdown-preview-view markdown-rendered");
                  MarkdownRenderer.render(
                    this.app,
                    block.text,
                    textBlock,
                    "",
                    this
                  );
                } else if (
                  block.type === "thinking" &&
                  this.plugin.settings.showThinking
                ) {
                  const tb = rendered.contentEl.createDiv(
                    "pi-agent-thinking-block is-collapsed"
                  );
                  const header = tb.createDiv("pi-agent-thinking-header");
                  const iconSpan = header.createSpan("pi-agent-thinking-icon");
                  setIcon(iconSpan, "brain");
                  const textSpan = header.createSpan("pi-agent-thinking-text");
                  textSpan.setText(" Thought");
                  tb.createDiv("pi-agent-thinking-content").textContent =
                    block.thinking || "";

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
            this.currentAssistantMsg = null;
          } else if (msg.role === "toolResult") {
            this.handleToolEnd({
              type: "tool_execution_end",
              toolName: msg.toolName,
              toolCallId: msg.toolCallId,
              isError: msg.isError,
              result: {
                content: msg.content,
                isError: msg.isError,
                details: msg.details
              }
            });
          }
        }
        this.scrollToBottom(true, true);
      }
    } catch (err) {
      // It's okay if there are no messages
      console.log("[pi-agent] No existing messages to load");
    }
  }

  private updateButtons(): void {
    if (this.abortBtn) {
      if (this.isStreaming) {
        this.abortBtn.style.display = "";
      } else {
        this.abortBtn.style.display = "none";
      }
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
      case "read": {
        const path = (args.path as string) || (args.TargetFile as string) || (args.target as string) || "";
        const base = this.getBasename(path);
        return `${base}${args.offset ? ` (offset: ${args.offset})` : ""}`;
      }
      case "bash": {
        const cmd = (args.command as string) || "";
        return cmd.length > 35 ? cmd.slice(0, 35) + "..." : cmd;
      }
      case "write": {
        const path = (args.path as string) || (args.TargetFile as string) || (args.target as string) || "";
        return this.getBasename(path);
      }
      case "edit": {
        const path = (args.path as string) || (args.TargetFile as string) || (args.target as string) || "";
        return this.getBasename(path);
      }
      case "grep":
        return `${args.pattern || ""}`;
      case "find":
        return `${args.pattern || ""}`;
      case "ls": {
        return this.getBasename((args.path as string) || ".");
      }
      default:
        return JSON.stringify(args).slice(0, 100);
    }
  }

  private getToolIcon(toolName: string): string {
    switch (toolName) {
      case "read":
        return "◇";
      case "write":
        return "⊞";
      case "edit":
        return "✎";
      case "bash":
        return "⌘";
      case "grep":
      case "find":
        return "⌕";
      case "ls":
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
    copy.onclick = async (event) => {
      event.stopPropagation();
      await navigator.clipboard.writeText(diffText);
      new Notice("Diff copied");
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
    // Auto: preserve the original pretty Markdown feel for short replies, then
    // switch to cheap plain streaming before long M3 outputs start janking.
    return rawLength <= 1500;
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

    const now = Date.now();
    const delay = 80;
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
  private appendStreamingDelta(rawText: string): void {
    if (this.renderTimeout) {
      window.clearTimeout(this.renderTimeout);
      this.renderTimeout = null;
    }
    const now = Date.now();
    const delay = 50;
    const apply = () => {
      if (this.streamingTextEl) {
        this.streamingTextEl.textContent = rawText;
      }
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
  }

  private renderMarkdownWithCursor(rawText: string, targetEl: HTMLElement): void {
    targetEl.empty();

    const lines = rawText.split("\n");
    let inCodeblock = false;
    for (const line of lines) {
      if (line.trimStart().startsWith("```")) {
        inCodeblock = !inCodeblock;
      }
    }

    const cursor = inCodeblock ? " ▊" : ' <span class="pi-agent-typing-cursor">▊</span>';
    const textWithCursor = rawText + cursor;
    const finalRenderText = inCodeblock ? textWithCursor + "\n```" : textWithCursor;

    MarkdownRenderer.render(
      this.app,
      finalRenderText,
      targetEl,
      "",
      this
    );
    this.scrollToBottom();
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
      .filter(
        (f) =>
          f.basename.toLowerCase().includes(q) ||
          f.path.toLowerCase().includes(q)
      )
      .map((f) => ({ kind: "file" as const, file: f }));
    const folderEntries = folders
      .filter(
        (folder) =>
          (folder.name || "").toLowerCase().includes(q) ||
          folder.path.toLowerCase().includes(q)
      )
      .map((f) => ({ kind: "folder" as const, folder: f }));

    this.filteredMentionFiles = [...folderEntries, ...fileEntries].slice(
      0,
      12
    ) as any;

    this.renderMentionDropdownItems();
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

    (this.filteredMentionFiles as any[]).forEach((entry: any, index: number) => {
      const itemEl = this.mentionDropdown!.createDiv({
        cls: `pi-agent-mention-item ${index === this.activeMentionIndex ? "is-active" : ""}`,
      });
      const icon =
        entry.kind === "folder"
          ? "📁"
          : this.getFileTypeIcon(entry.file.extension);
      const label =
        entry.kind === "folder"
          ? entry.folder.path || "/"
          : entry.file.basename;
      itemEl.createSpan({ text: icon + " ", cls: "pi-agent-mention-item-icon" });
      itemEl.createSpan({ text: label, cls: "pi-agent-mention-item-name" });

      itemEl.onclick = (e) => {
        e.stopPropagation();
        this.activeMentionIndex = index;
        this.insertMentionSelection();
      };
    });
  }

  private insertMentionSelection(): void {
    if (!this.inputEl || this.mentionQueryStart === -1) return;
    const entry: any = this.filteredMentionFiles[this.activeMentionIndex];
    if (!entry) return;

    const value = this.inputEl.value;
    const caretPos = this.inputEl.selectionStart;

    const before = value.slice(0, this.mentionQueryStart);
    const after = value.slice(caretPos);

    let mentionText: string;
    if (entry.kind === "folder") {
      const folder: TFolder = entry.folder;
      mentionText = `[[${(folder.path || "/")}/]]`;
      this.addFolderContextItem(folder, false);
    } else {
      const file = entry.file;
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

  private async loadAvailableCommands(): Promise<void> {
    if (!this.client) return;
    try {
      const res = await this.client.getCommands();
      if (res.success && res.data) {
        this.availableCommands = ((res.data as any).commands || []) as PiCommand[];
      }
    } catch {}
  }

  private handleCommandInput(): void {
    if (!this.inputEl) return;
    const value = this.inputEl.value;
    const caretPos = this.inputEl.selectionStart;

    if (value.startsWith("/") && caretPos > 0 && !value.slice(0, caretPos).includes(" ")) {
      const query = value.slice(1, caretPos).toLowerCase();
      this.commandQueryStart = 0;
      this.showCommandDropdown(query);
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
    switch (level?.toLowerCase() || "") {
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
      default:
        return "Auto";
    }
  }

  private showThinkingLevelSelector(): void {
    const isZh = this.plugin.settings.language === "zh";
    const options: ThinkingLevelOption[] = [
      { id: "", name: isZh ? "沿用 pi 默认设置 (auto)" : "Pi Default (auto)", desc: isZh ? "使用 Pi 配置文件中的默认思考强度" : "Use default thinking level from Pi configuration" },
      { id: "off", name: isZh ? "关闭推理 (off)" : "Off (off)", desc: isZh ? "不启用推理/思考过程" : "Do not enable reasoning/thinking" },
      { id: "minimal", name: isZh ? "最少推理 (low (minimal))" : "Minimal (low (minimal))", desc: isZh ? "极少的推理量" : "Minimal reasoning effort" },
      { id: "low", name: isZh ? "低强度推理 (low)" : "Low (low)", desc: isZh ? "较低的推理量" : "Low reasoning effort" },
      { id: "medium", name: isZh ? "中等推理 (medium)" : "Medium (medium)", desc: isZh ? "中等推理量" : "Medium reasoning effort" },
      { id: "high", name: isZh ? "高强度推理 (high)" : "High (high)", desc: isZh ? "较高的推理量" : "High reasoning effort" },
      { id: "xhigh", name: isZh ? "最高强度推理 (xhigh)" : "X-High (xhigh)", desc: isZh ? "最大的推理量" : "Maximum reasoning effort" }
    ];

    new ThinkingLevelSuggestModal(this.app, options, isZh, async (option) => {
      this.plugin.settings.thinkingLevel = option.id;
      await this.plugin.saveSettings();
      if (this.client) {
        await this.client.setThinkingLevel(option.id);
      }
      if (this.footerEffortCurrent) {
        this.footerEffortCurrent.setText(this.getThinkingLevelLabel(option.id));
      }

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
        this.tabs.push({
          id: `tab-static-${i}`,
          label: String(i),
          client: null,
          isStreaming: false,
        });
      }
    }
    if (!this.tabs.some((t) => t.id === this.activeTabId)) {
      this.activeTabId = this.tabs[0]?.id || null;
    }
    this.renderTabs();
    if (this.activeTabId) {
      await this.switchToTab(this.activeTabId);
    }
  }

  private activeDropdown: "model" | "effort" | null = null;
  private activeDropdownEl: HTMLElement | null = null;
  private availableModelsCache: PiModel[] | null = null;
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

  private getProviderIconSvg(provider: string, modelId: string): string {
    const p = provider.toLowerCase();
    const m = modelId.toLowerCase();

    // 0. Xiaomi / 小米
    if (p.includes("xiaomi") || p.includes("小米") || m.includes("xiaomi") || m.includes("milm")) {
      return `<svg viewBox="0 0 24 24" fill="none" class="svg-icon" style="color: #ff6700;"><path d="M12,2C17.5,2 22,6.5 22,12C22,17.5 17.5,22 12,22C6.5,22 2,17.5 2,12C2,6.5 6.5,2 12,2Z" fill="currentColor"/><path d="M6.5,16V10.5a1.8,1.8 0 0,1 3.6,0V16 M10.1,16V10.5a1.8,1.8 0 0,1 3.6,0V16 M17.5,16V8.5" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="round"/></svg>`;
    }

    // 1. OpenAI / GPT
    if (p.includes("openai") || p.includes("gpt") || m.includes("gpt")) {
      return `<svg viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" class="svg-icon" style="color: #10a37f;"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>`;
    }

    // 2. Claude / Anthropic
    if (p.includes("anthropic") || p.includes("claude") || m.includes("claude")) {
      return `<svg viewBox="0 0 16 16" fill="currentColor" class="svg-icon" style="color: #cc5a37;"><path d="M9.218 2h2.402L16 12.987h-2.402zM4.379 2h2.512l4.38 10.987H8.82l-.895-2.308h-4.58l-.896 2.307H0L4.38 2.001zm2.755 6.64L5.635 4.777 4.137 8.64z"/></svg>`;
    }

    // 3. DeepSeek
    if (p.includes("deepseek") || m.includes("deepseek")) {
      return `<svg viewBox="0 0 512 509.64" fill="currentColor" class="svg-icon" style="color: #0066ff;"><path fill-rule="nonzero" d="M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z"/></svg>`;
    }

    // 4. MiniMax
    if (p.includes("minimax") || m.includes("minimax")) {
      return `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #ff4d4f;"><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"/></svg>`;
    }

    // 5. SiliconFlow (硅基流动/轨迹流动)
    if (p.includes("siliconflow") || m.includes("siliconflow") || p.includes("siliconcloud") || m.includes("siliconcloud")) {
      return `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #00a3ff;"><path clip-rule="evenodd" d="M22.956 6.521H12.522c-.577 0-1.044.468-1.044 1.044v3.13c0 .577-.466 1.044-1.043 1.044H1.044c-.577 0-1.044.467-1.044 1.044v4.174C0 17.533.467 18 1.044 18h10.434c.577 0 1.044-.467 1.044-1.043v-3.13c0-.578.466-1.044 1.043-1.044h9.391c.577 0 1.044-.467 1.044-1.044V7.565c0-.576-.467-1.044-1.044-1.044z"/></svg>`;
    }

    // 6. Doubao / Volcengine / Seed (火山引擎/豆包)
    if (p.includes("volcengine") || p.includes("doubao") || p.includes("seed") || m.includes("doubao") || m.includes("seed")) {
      return `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #1664ff;"><path d="M5.31 15.756c.172-3.75 1.883-5.999 2.549-6.739-3.26 2.058-5.425 5.658-6.358 8.308v1.12C1.501 21.513 4.226 24 7.59 24a6.59 6.59 0 002.2-.375c.353-.12.7-.248 1.039-.378.913-.899 1.65-1.91 2.243-2.992-4.877 2.431-7.974.072-7.763-4.5l.002.001z" fill-opacity=".5"></path><path d="M22.57 10.283c-1.212-.901-4.109-2.404-7.397-2.8.295 3.792.093 8.766-2.1 12.773a12.782 12.782 0 01-2.244 2.992c3.764-1.448 6.746-3.457 8.596-5.219 2.82-2.683 3.353-5.178 3.361-6.66a2.737 2.737 0 00-.216-1.084v-.002zM14.303 1.867C12.955.7 11.248 0 9.39 0 7.532 0 5.883.677 4.545 1.807 2.791 3.29 1.627 5.557 1.5 8.125v9.201c.932-2.65 3.097-6.25 6.357-8.307.5-.318 1.025-.595 1.569-.829 1.883-.801 3.878-.932 5.746-.706-.222-2.83-.718-5.002-.87-5.617h.001z"></path><path d="M17.305 4.961a199.47 199.47 0 01-1.08-1.094c-.202-.213-.398-.419-.586-.622l-1.333-1.378c.151.615.648 2.786.869 5.617 3.288.395 6.185 1.898 7.396 2.8-1.306-1.275-3.475-3.487-5.266-5.323z" fill-opacity=".5"></path></svg>`;
    }

    // 7. Gemini / Google
    if (p.includes("google") || p.includes("gemini") || m.includes("gemini")) {
      return `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #7c3aed;"><path d="M12 2l1.8 5.4L19.2 9.2 13.8 11 12 16.4 10.2 11 4.8 9.2l5.4-1.8L12 2zm6 12l.9 2.7L21.6 17.6l-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7z"/></svg>`;
    }

    // Default Fallback: Sparkle SVG
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon"><path d="M12 3v18M3 12h18M12 3l3 3M12 21l-3-3M3 12l3 3M21 12l-3-3"/></svg>`;
  }


}

class CommandSuggestModal extends SuggestModal<PiCommand> {
  constructor(
    app: App,
    private readonly commands: PiCommand[],
    private readonly onChoose: (command: PiCommand) => void
  ) {
    super(app);
    this.setPlaceholder("Search commands and skills...");
  }

  getSuggestions(query: string): PiCommand[] {
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

  renderSuggestion(command: PiCommand, el: HTMLElement): void {
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

  onChooseSuggestion(command: PiCommand): void {
    this.onChoose(command);
  }
}

class ResumeSessionSuggestModal extends SuggestModal<ResumeSessionItem> {
  constructor(
    app: App,
    private readonly sessions: ResumeSessionItem[],
    private readonly onChoose: (session: ResumeSessionItem) => void | Promise<void>
  ) {
    super(app);
    this.setPlaceholder("Resume which Pi session?");
  }

  getSuggestions(query: string): ResumeSessionItem[] {
    const q = query.toLowerCase().trim();
    if (!q) return this.sessions.slice(0, 80);
    return this.sessions
      .filter((session) => `${session.label} ${session.preview || ""} ${session.path}`.toLowerCase().includes(q))
      .slice(0, 80);
  }

  renderSuggestion(session: ResumeSessionItem, el: HTMLElement): void {
    el.addClass("pi-agent-suggestion");
    el.createDiv({
      text: session.label || basename(session.path),
      cls: "pi-agent-suggestion-title",
    });
    const date = new Date(session.mtime).toLocaleString();
    el.createDiv({
      text: `${date} · ${session.preview || session.path}`,
      cls: "pi-agent-suggestion-note",
    });
  }

  async onChooseSuggestion(session: ResumeSessionItem): Promise<void> {
    await this.onChoose(session);
  }
}

class ResumeActionModal extends Modal {
  constructor(
    app: App,
    private readonly session: ResumeSessionItem,
    private readonly done: (action: "open" | "delete" | "cancel") => void | Promise<void>
  ) {
    super(app);
    this.titleEl.setText("Pisidian session");
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
      this.done("cancel");
      this.close();
    };
    del.onclick = () => {
      this.done("delete");
      this.close();
    };
    open.onclick = () => {
      this.done("open");
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
    private readonly onChoose: (message: ForkMessage) => void | Promise<void>
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

  async onChooseSuggestion(message: ForkMessage): Promise<void> {
    await this.onChoose(message);
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

  async onChooseSuggestion(model: PiModel): Promise<void> {
    await this.onChoose(model);
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

class PiAgentConfirmModal extends Modal {
  private answered = false;

  constructor(
    app: App,
    title: string,
    private readonly message: string,
    private readonly done: (confirmed: boolean) => void
  ) {
    super(app);
    this.titleEl.setText(title || "Pisidian confirmation");
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
    this.titleEl.setText("Inline edit with Pisidian");
    this.done = done;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-editor-modal");

    contentEl.createDiv({
      text: "Describe how Pisidian should rewrite the selected text.",
      cls: "pi-agent-suggestion-note",
    });

    const textarea = contentEl.createEl("textarea", {
      cls: "pi-agent-editor-modal-textarea",
      attr: { placeholder: "Make it clearer, shorter, more direct..." },
    });
    textarea.style.minHeight = "120px";
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
    this.titleEl.setText("Review Pisidian inline edit");
    this.done = done;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  private computeSimpleDiff(original: string, replacement: string): string {
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
    const result: string[] = [];

    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && origLines[i - 1] === replLines[j - 1]) {
        result.unshift(this.escapeHtml(origLines[i - 1]));
        i--;
        j--;
      } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
        result.unshift(`<ins class="pi-diff-ins">+ ${this.escapeHtml(replLines[j - 1])}</ins>`);
        j--;
      } else {
        result.unshift(`<del class="pi-diff-del">- ${this.escapeHtml(origLines[i - 1])}</del>`);
        i--;
      }
    }

    return result.join("\n");
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
    diffContainer.innerHTML = this.computeSimpleDiff(this.original, this.replacement);

    contentEl.createDiv({
      text: "Edit Replacement (可选：微调修改文)",
      cls: "pi-agent-suggestion-title",
    });
    const replacementBox = contentEl.createEl("textarea", {
      cls: "pi-agent-editor-modal-textarea",
    });
    replacementBox.value = this.replacement;
    replacementBox.style.minHeight = "120px";
    replacementBox.focus();

    // Live update diff view when editing replacement text
    replacementBox.addEventListener("input", () => {
      diffContainer.innerHTML = this.computeSimpleDiff(this.original, replacementBox.value);
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

  async onChooseSuggestion(option: ThinkingLevelOption): Promise<void> {
    await this.onChoose(option);
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
  cacheRead: number;
  cacheWrite: number;
  cacheTotal: number;
  totalTokens: number;
  cost: number;
  hitRate: number | null;
  firstUsed: number | null;
  lastUsed: number | null;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheTotal: number;
  totalTokens: number;
  cost: number;
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
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function computeHitRate(input: number, cacheRead: number): number | null {
  const denom = input + cacheRead;
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

function scanUsageRange(
  sessionsBaseDir: string,
  from: number | null,
  to: number | null
): UsageResult {
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const byModel = new Map<string, UsageModelRow>();
  const totals: UsageTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheTotal: 0,
    totalTokens: 0,
    cost: 0,
    messageCount: 0,
  };
  let sessionCount = 0;
  if (!fs.existsSync(sessionsBaseDir)) {
    return { from, to, sessionCount, byModel: [], totals };
  }
  const workspaceDirs = fs
    .readdirSync(sessionsBaseDir)
    .filter((n) => n.startsWith("--") && n.endsWith("--"))
    .map((n) => path.join(sessionsBaseDir, n));
  for (const wsDir of workspaceDirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(wsDir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const fullPath = path.join(wsDir, f);
      let lines: string[] = [];
      try {
        const content = fs.readFileSync(fullPath, "utf8");
        lines = content.split(/\r?\n/);
      } catch {
        continue;
      }
      let sessionTouched = false;
      for (const line of lines) {
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
        const ts = typeof evt.timestamp === "string" ? Date.parse(evt.timestamp) : 0;
        if (ts && ((from != null && ts < from) || (to != null && ts > to))) {
          continue;
        }
        const usage = msg.usage;
        if (!usage) continue;
        // provider / model 位于 evt.message 内部（不在事件顶层），
        // 同时保留顶层 fallback 以兼容早期会话。
        const provider =
          (msg.provider as string) ||
          (evt.provider as string) ||
          "unknown";
        const model =
          (msg.model as string) ||
          (evt.model as string) ||
          "unknown";
        const key = `${provider}::${model}`;
        let row = byModel.get(key);
        if (!row) {
          row = {
            provider,
            model,
            messageCount: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            cacheTotal: 0,
            totalTokens: 0,
            cost: 0,
            hitRate: null,
            firstUsed: null,
            lastUsed: null,
          };
          byModel.set(key, row);
        }
        const input = Number(usage.input) || 0;
        const output = Number(usage.output) || 0;
        const cacheRead = Number(usage.cacheRead) || 0;
        const cacheWrite = Number(usage.cacheWrite) || 0;
        const total = Number(usage.totalTokens) || input + output + cacheRead + cacheWrite;
        const cost = Number(usage.cost?.total) || 0;
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
        totals.cacheRead += cacheRead;
        totals.cacheWrite += cacheWrite;
        totals.totalTokens += total;
        totals.cost += cost;
        totals.messageCount += 1;
        sessionTouched = true;
      }
      if (sessionTouched) sessionCount += 1;
    }
  }
  // Compute hit rates and cache totals.
  for (const row of byModel.values()) {
    row.hitRate = computeHitRate(row.input, row.cacheRead);
  }
  totals.cacheTotal = totals.cacheRead + totals.cacheWrite;
  // Sort by total tokens desc.
  const list = Array.from(byModel.values()).sort(
    (a, b) => b.totalTokens - a.totalTokens
  );
  return { from, to, sessionCount, byModel: list, totals };
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
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pi-agent-usage-modal");
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    const isZh = this.lang === "zh";
    const range = buildRange(this.preset, this.customFrom, this.customTo);
    // Header
    const header = contentEl.createDiv("pi-agent-usage-header");
    const titleWrap = header.createDiv("pi-agent-usage-title");
    titleWrap.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`;
    const titleText = titleWrap.createSpan({ text: isZh ? "Token 用量" : "Token Usage" });
    titleText.style.marginLeft = "6px";
    this.rangeLabelEl = titleWrap.createSpan({ text: " · " + range.label, cls: "pi-agent-usage-range-label" });
    const refreshBtn = header.createEl("button", { cls: "pi-agent-usage-btn-icon", attr: { title: isZh ? "刷新" : "Refresh", "aria-label": "Refresh" } });
    refreshBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 16h5v5"/></svg>`;
    refreshBtn.onclick = () => this.scan();
    const closeBtn = header.createEl("button", { cls: "pi-agent-usage-btn-icon", attr: { title: isZh ? "关闭" : "Close", "aria-label": "Close" } });
    closeBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
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
        this.scan();
      };
    }
    if (this.preset === "custom") {
      const wrap = rangeBar.createDiv("pi-agent-usage-custom-range");
      const fromInp = wrap.createEl("input", {
        attr: { type: "datetime-local", value: this.customFrom },
      });
      const arrow = wrap.createSpan({ text: "→" });
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
    this.tableEl.style.flex = "1";
    this.tableEl.style.overflow = "auto";
    this.tableEl.style.minHeight = "0";
    // Footer
    const footer = contentEl.createDiv("pi-agent-usage-footer");
    footer.createSpan({
      text: isZh ? "点击列标题排序 · 数据源：~/.pi/agent/sessions" : "Click a column to sort · Data source: ~/.pi/agent/sessions",
    });
    footer.createSpan({ text: "Esc", cls: "pi-agent-usage-foot-hint" });
    this.scan();
  }

  private scan(): void {
    const reqId = ++this.reqId;
    this.loading = true;
    this.error = null;
    this.updateStatus();
    setTimeout(() => {
      if (reqId !== this.reqId) return;
      try {
        const os = require("os") as typeof import("os");
        const home = os.homedir().replace(/\\/g, "/");
        const sessionsBaseDir = `${home}/.pi/agent/sessions`;
        const range = buildRange(this.preset, this.customFrom, this.customTo);
        const result = scanUsageRange(sessionsBaseDir, range.from, range.to);
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
      this.statusEl.style.color = "#ef4444";
      return;
    }
    if (this.loading) {
      this.statusEl.setText(isZh ? "扫描中…" : "Scanning…");
      this.statusEl.style.color = "var(--text-muted)";
      return;
    }
    if (this.data) {
      this.statusEl.setText(
        `${isZh ? "已扫描" : "scanned"} ${this.data.sessionCount} ${isZh ? "个会话" : "session" + (this.data.sessionCount === 1 ? "" : "s")}`
      );
      this.statusEl.style.color = "var(--text-muted)";
    }
  }

  private renderSummary(): void {
    if (!this.summaryEl) return;
    this.summaryEl.empty();
    if (!this.data) return;
    const isZh = this.lang === "zh";
    const t = this.data.totals;
    const hr = computeHitRate(t.input, t.cacheRead);
    const cards = [
      { label: isZh ? "总 Token" : "Total tokens", value: fmtNum(t.totalTokens), sub: t.totalTokens.toLocaleString() },
      { label: isZh ? "输入" : "Input", value: fmtNum(t.input), sub: t.input.toLocaleString() },
      { label: isZh ? "输出" : "Output", value: fmtNum(t.output), sub: t.output.toLocaleString() },
      {
        label: isZh ? "缓存 Σ" : "Cache Σ",
        value: fmtNum(t.cacheTotal),
        sub: hr === null ? "—" : `${isZh ? "命中率" : "hit"} ${(hr * 100).toFixed(1)}%`,
        subColor: hitRateColor(hr),
      },
      {
        label: isZh ? "费用" : "Cost",
        value: fmtCost(t.cost),
        sub: `${t.messageCount.toLocaleString()} ${isZh ? "条消息" : "msgs"}`,
      },
    ];
    for (const c of cards) {
      const card = this.summaryEl.createDiv("pi-agent-usage-card");
      card.createDiv({ text: c.label, cls: "pi-agent-usage-card-label" });
      card.createDiv({ text: c.value, cls: "pi-agent-usage-card-value" });
      const sub = card.createDiv({ text: c.sub, cls: "pi-agent-usage-card-sub" });
      if (c.subColor) sub.style.color = c.subColor;
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
      }).style.color = "#ef4444";
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
      th.style.textAlign = c.align;
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
      tdModel.style.textAlign = "left";
      const modelName = tdModel.createDiv({ cls: "pi-agent-usage-model-name", text: m.model });
      const modelTime = tdModel.createDiv({ cls: "pi-agent-usage-model-time", text: `${fmtDate(m.firstUsed ? new Date(m.firstUsed).toISOString() : null)} → ${fmtDate(m.lastUsed ? new Date(m.lastUsed).toISOString() : null)}` });
      // Provider
      const tdProv = tr.createEl("td", { text: m.provider });
      tdProv.style.textAlign = "left";
      tdProv.style.color = "var(--text-muted)";
      // Numeric cells
      const cells: Array<[string, "right" | "left", string?]> = [
        [m.messageCount.toLocaleString(), "right"],
        [fmtNum(m.input), "right"],
        [fmtNum(m.output), "right"],
        [fmtNum(m.cacheRead), "right"],
        [fmtNum(m.cacheWrite), "right"],
        [fmtNum(m.totalTokens), "right"],
        [hitRateLabel(m.hitRate), "right", hitRateColor(m.hitRate)],
        [fmtCost(m.cost), "right"],
      ];
      for (const [val, align, color] of cells) {
        const td = tr.createEl("td", { text: val });
        td.style.textAlign = align;
        td.style.fontVariantNumeric = "tabular-nums";
        if (color) td.style.color = color;
      }
      // Share bar
      const tdShare = tr.createEl("td");
      tdShare.style.textAlign = "left";
      tdShare.style.minWidth = "120px";
      const pct = totalAll > 0 ? (m.totalTokens / totalAll) * 100 : 0;
      const barW = maxTotal > 0 ? (m.totalTokens / maxTotal) * 100 : 0;
      const barWrap = tdShare.createDiv({ cls: "pi-agent-usage-bar" });
      const bar = barWrap.createDiv({ cls: "pi-agent-usage-bar-fill" });
      bar.style.width = `${barW}%`;
      const pctText = tdShare.createSpan({ text: `${pct.toFixed(1)}%`, cls: "pi-agent-usage-pct" });
    }
  }
}
