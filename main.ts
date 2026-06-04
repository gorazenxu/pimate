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
  ItemView,
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
   * Cached file-explorer multi-selection. Refreshed on every
   * `active-leaf-change` and `click` event. The right-click context menu
   * reads this when the user invokes "Send to Pisidian".
   */
  private explorerSelection: TAbstractFile[] = [];

  /**
   * Try to read the file-explorer selection. The FileExplorer view exposes
   * an internal `selection` Set, and the file items expose `.el` with a
   * CSS class indicating selection. Both sources are undocumented but
   * have been stable across many Obsidian releases.
   */
  private refreshExplorerSelection(): void {
    const view = this.app.workspace.getLeavesOfType("file-explorer")[0]?.view as
      | (ItemView & {
          selection?: Set<TAbstractFile>;
          fileItems?: Map<TAbstractFile, { el?: HTMLElement }> | Record<string, { el?: HTMLElement }>;
        })
      | undefined;
    if (!view) {
      this.explorerSelection = [];
      return;
    }

    const out: TAbstractFile[] = [];
    const seen = new Set<TAbstractFile>();
    const addOne = (af: TAbstractFile | null | undefined) => {
      if (af && !seen.has(af)) {
        seen.add(af);
        out.push(af);
      }
    };

    // Source 1: internal selection Set.
    const sel = view.selection;
    if (sel && sel.size > 0) {
      for (const af of sel) addOne(af);
    }

    // Source 2: walk fileItems and look for the `.is-selected` class.
    // This catches both files and folders, and complements selection Set.
    const fi = view.fileItems;
    if (fi) {
      const items: IterableIterator<[TAbstractFile, { el?: HTMLElement }]> | Array<[string, { el?: HTMLElement }]>
        = fi instanceof Map
          ? fi.entries()
          : (Object.entries(fi) as Array<[string, { el?: HTMLElement }]>);
      for (const [key, item] of items) {
        const el = item?.el as HTMLElement | undefined;
        if (el && el.classList && el.classList.contains("is-selected")) {
          if (key && typeof key === "object") {
            addOne(key);
          } else {
            addOne(this.app.vault.getAbstractFileByPath(String(key)));
          }
        }
      }
    }

    if (out.length > 0) this.explorerSelection = out;
  }

  public getExplorerSelectionForContext(): TAbstractFile[] {
    this.refreshExplorerSelection();
    return [...this.explorerSelection];
  }

  /**
   * Build the multi-selection at the moment of right-click. Combines the
   * cached selection with the anchor (the right-clicked file/folder).
   * Falls back to just the anchor if the cache is empty.
   */
  private getRightClickMultiSelection(anchor: TAbstractFile): TAbstractFile[] {
    if (this.explorerSelection.length === 0) return [anchor];
    const seen = new Set<TAbstractFile>();
    const out: TAbstractFile[] = [];
    for (const f of this.explorerSelection) {
      if (!seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
    if (!seen.has(anchor)) out.push(anchor);
    return out;
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

    // Right-click multi-select support: track selection via active-leaf-change
    // and document click events, then read the cache in the right-click menu.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshExplorerSelection();
      })
    );
    this.registerDomEvent(document, "click", () => {
      this.refreshExplorerSelection();
    }, true);

    // Right-click on file: add to Pisidian context (multi-select aware).
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return; // skip folder-menu leakage etc.
        // Refresh at right-click time so we have the freshest cache.
        this.refreshExplorerSelection();
        const multi = this.getRightClickMultiSelection(file);
        const isMulti = multi.length > 1;
        const title = isMulti
          ? `Add ${multi.length} items to Pisidian context`
          : "Send to Pisidian";
        menu.addItem((item) =>
          item
            .setTitle(title)
            .setIcon("pisidian-logo")
            .onClick(async () => {
              const view = await this.activateView();
              if (!view) return;
              let count = 0;
              for (const it of multi) {
                if (it instanceof TFile) {
                  view.addFileContextItem(it);
                  count++;
                } else if (it instanceof TFolder) {
                  view.addFolderContextItem(it, true);
                  count++;
                }
              }
              new Notice(
                `Pisidian: added ${count} item${count === 1 ? "" : "s"} to context`
              );
            })
        );
      })
    );

    // Right-click on folder: add folder (recursive) to Pisidian context.
    // Multi-select aware (works for both single and multi folder selection).
    // `folder-menu` is supported by Obsidian at runtime but not in the .d.ts.
    const folderMenuHandler = (menu: Menu, folder: TFolder) => {
      this.refreshExplorerSelection();
      const multi = this.getRightClickMultiSelection(folder);
      const isMulti = multi.length > 1;
      const title = isMulti
        ? `Add ${multi.length} items to Pisidian context`
        : "Add folder to Pisidian context";
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon("pisidian-logo")
          .onClick(async () => {
            const view = await this.activateView();
            if (!view) return;
            let count = 0;
            for (const it of multi) {
              if (it instanceof TFile) {
                view.addFileContextItem(it);
                count++;
              } else if (it instanceof TFolder) {
                view.addFolderContextItem(it, true);
                count++;
              }
            }
            new Notice(
              `Pisidian: added ${count} item${count === 1 ? "" : "s"} to context`
            );
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
