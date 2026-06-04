import {
  App,
  Plugin,
  PluginManifest,
  WorkspaceLeaf,
  Notice,
  TFile,
  TFolder,
  TAbstractFile,
  Menu,
  addIcon,
} from "obsidian";
import {
  PiAgentView,
  PI_AGENT_VIEW_TYPE,
} from "./PiAgentView";
import {
  PiAgentSettings,
  PiAgentSettingTab,
  DEFAULT_SETTINGS,
} from "./PiAgentSettings";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export default class PiAgentPlugin extends Plugin {
  declare settings: PiAgentSettings;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);
  }

  /**
   * Get the multi-selection at the moment of right-click.
   * Multi-selection in Obsidian's file explorer works like this:
   *   - Alt+click a file/folder: add to selection
   *   - Right-click on a selected item: Obsidian's context menu fires
   * For folders, Obsidian doesn't expose a public multi-selection API,
   * so we fall back to just the right-clicked anchor. Users can right-click
   * each folder separately if they want to add multiple.
   */

  async onload(): Promise<void> {
    // 注册自定义的 Pisidian 芯片 logo 图标 (包含 CPU 芯片引脚与核心字母 π)
    addIcon("pisidian-logo", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v14H5zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M8.5 9.5h7M11 9.5Q10.5 13 8.5 15M13.5 9.5L13.5 13.5Q13.5 15 15 15"/></svg>`);

    await this.loadSettings();

    // Register the custom view
    this.registerView(
      PI_AGENT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new PiAgentView(leaf, this)
    );

    // Add ribbon icon to open Pisidian
    this.addRibbonIcon("pisidian-logo", "Open Pisidian", () => {
      const lang = (this.settings?.language as string) === "en" ? "en" : "zh";
      new Notice(lang === "zh" ? "正在启动 Pisidian..." : "Starting Pisidian...");
      this.activateView();
    });

    // Add command to open pi agent
    this.addCommand({
      id: "open-pisidian",
      name: "Open Pisidian Chat",
      callback: () => {
        this.activateView();
      },
    });

    this.addCommand({
      id: "new-pisidian-session",
      name: "New Pisidian session",
      callback: async () => {
        const view = await this.activateView();
        await view?.newChatSession();
      },
    });

    this.addCommand({
      id: "close-active-pisidian-session",
      name: "Close active Pisidian session tab",
      callback: async () => {
        const view = await this.activateView();
        await view?.closeActiveSessionTab();
      },
    });

    this.addCommand({
      id: "focus-pisidian-composer",
      name: "Focus Pisidian composer",
      callback: async () => {
        const view = await this.activateView();
        view?.focusComposer();
      },
    });

    this.addCommand({
      id: "commands-skills-pisidian",
      name: "Open Pisidian commands and skills",
      callback: async () => {
        const view = await this.activateView();
        view?.openCommandsAndSkills();
      },
    });

    this.addCommand({
      id: "pisidian-previous-message",
      name: "Pisidian: jump to previous message",
      callback: async () => {
        const view = await this.activateView();
        view?.scrollToPreviousMessage();
      },
    });

    this.addCommand({
      id: "pisidian-next-message",
      name: "Pisidian: jump to next message",
      callback: async () => {
        const view = await this.activateView();
        view?.scrollToNextMessage();
      },
    });

    this.addCommand({
      id: "pisidian-toggle-last-tool",
      name: "Pisidian: toggle last tool output",
      callback: async () => {
        const view = await this.activateView();
        view?.toggleLastToolBlock();
      },
    });

    this.addCommand({
      id: "pisidian-jump-last-diff",
      name: "Pisidian: jump to last diff",
      callback: async () => {
        const view = await this.activateView();
        view?.scrollToLastDiff();
      },
    });

    this.addCommand({
      id: "resume-pisidian-session",
      name: "Resume previous Pisidian session",
      callback: async () => {
        const view = await this.activateView();
        await view?.resumePreviousSession();
      },
    });

    this.addCommand({
      id: "fork-pisidian-session",
      name: "Fork Pisidian session from previous prompt",
      callback: async () => {
        const view = await this.activateView();
        await view?.forkFromPreviousPrompt();
      },
    });

    this.addCommand({
      id: "clone-pisidian-branch",
      name: "Clone current Pisidian branch",
      callback: async () => {
        const view = await this.activateView();
        await view?.cloneCurrentSessionBranch();
      },
    });

    // Add command to send selected text to pi
    this.addCommand({
      id: "send-selection-to-pisidian",
      name: "Send selection to Pisidian",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("No text selected");
          return;
        }
        const view = await this.activateView();
        view?.addSelectionContext(selection);
      },
    });

    this.addCommand({
      id: "inline-edit-with-pisidian",
      name: "Inline edit selection with Pisidian",
      editorCallback: async (editor) => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("No text selected");
          return;
        }
        const from = editor.getCursor("from");
        const to = editor.getCursor("to");
        const view = await this.activateView();
        await view?.inlineEditSelection(selection, (replacement) => {
          editor.replaceRange(replacement, from, to);
        });
      },
    });

    // Add command to send current file as context
    this.addCommand({
      id: "send-file-to-pisidian",
      name: "Send current file to Pisidian",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file");
          return;
        }
        const view = await this.activateView();
        view?.addActiveFileContext();
      },
    });

    this.addCommand({
      id: "insert-last-pisidian-response",
      name: "Insert last Pisidian response into current note",
      callback: async () => {
        const view = await this.activateView();
        await view?.insertLastAssistantIntoActiveNote();
      },
    });

    // Right-click multi-select support is handled at the file-menu /
    // folder-menu events below — no hotkey, no focus tracking needed.

    // Right-click on file: add to Pisidian context
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return; // skip folder-menu leakage etc.
        menu.addItem((item) =>
          item
            .setTitle("Send to Pisidian")
            .setIcon("pisidian-logo")
            .onClick(async () => {
              const view = await this.activateView();
              view?.addFileContextItem(file);
            })
        );
      })
    );

    // Right-click on folder: add folder (recursive) to Pisidian context.
    // `folder-menu` is supported by Obsidian at runtime but not in the .d.ts.
    const folderMenuHandler = (menu: Menu, folder: TFolder) => {
      menu.addItem((item) =>
        item
          .setTitle("Add folder to Pisidian context")
          .setIcon("pisidian-logo")
          .onClick(async () => {
            const view = await this.activateView();
            view?.addFolderContextItem(folder, true);
          })
      );
    };
    this.registerEvent(
      (this.app.workspace.on as any)("folder-menu", folderMenuHandler)
    );

    // Add settings tab
    this.addSettingTab(new PiAgentSettingTab(this.app, this));

    console.log("Pisidian plugin loaded");
  }

  async onunload(): Promise<void> {
    // Detach all pi agent views
    this.app.workspace.detachLeavesOfType(PI_AGENT_VIEW_TYPE);
    console.log("Pisidian plugin unloaded");
  }

  /**
   * Activate the pi agent view (open or focus)
   */
  async activateView(): Promise<PiAgentView | null> {
    const { workspace } = this.app;

    // Check if view is already open
    let leaf: WorkspaceLeaf | null =
      workspace.getLeavesOfType(PI_AGENT_VIEW_TYPE)[0] ?? null;

    if (!leaf) {
      // Create new leaf in right sidebar
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: PI_AGENT_VIEW_TYPE,
          active: true,
        });
      }
    }

    // Reveal the leaf
    if (leaf) {
      workspace.revealLeaf(leaf);
    }

    return leaf?.view as PiAgentView | null;
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData()
    );
    this.autoDetectDefaultModel();
  }

  autoDetectDefaultModel(): void {
    if (this.settings.provider && this.settings.modelId) {
      return; // 已经配好默认模型，则不覆盖
    }

    const homeDir = os.homedir();
    const filePath = path.join(homeDir, ".pi", "agent", "auth.json");
    if (!fs.existsSync(filePath)) {
      return;
    }
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const data = JSON.parse(content) || {};
      
      const apiProviders = [
        { id: "deepseek", defaultModel: "deepseek-chat" },
        { id: "openai-codex", defaultModel: "gpt-4o" },
        { id: "minimax", defaultModel: "MiniMax-M2.7" },
        { id: "minimax-cn", defaultModel: "MiniMax-M2.7" },
        { id: "siliconflow", defaultModel: "deepseek-ai/DeepSeek-V3" },
        { id: "volcengine", defaultModel: "" },
        { id: "google", defaultModel: "gemini-2.5-flash" },
        { id: "anthropic", defaultModel: "claude-3-5-sonnet-latest" }
      ];
      
      for (const provider of apiProviders) {
        if (data[provider.id] && (data[provider.id].key || data[provider.id].type === "oauth")) {
          this.settings.provider = provider.id;
          this.settings.modelId = provider.defaultModel;
          this.saveSettings();
          console.log(`[Pisidian] 自动检测到已配置凭据的厂商，默认模型设为 ${provider.id}/${provider.defaultModel}`);
          break;
        }
      }
    } catch (e) {
      console.error("[Pisidian] 自动检测已配置模型失败:", e);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
