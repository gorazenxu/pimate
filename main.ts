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
   * reads this when the user invokes "Send to Pimate".
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
    // 注册自定义的 Pimate 芯片 logo 图标 (包含 CPU 芯片引脚与核心字母 π)
    addIcon("pimate-logo", `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5h14v14H5zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3M8.5 9.5h7M11 9.5Q10.5 13 8.5 15M13.5 9.5L13.5 13.5Q13.5 15 15 15"/></svg>`);

    // Provider brand icons (registered once at plugin load). Each one is
    // a custom 24x24 SVG painted in the provider's brand color so the
    // model popup reads as a brand-aware picker without us having to set
    // innerHTML at runtime (which Obsidian's marketplace linter forbids).
    addIcon(
      "pi-agent-icon-openai",
      `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #10a37f;"><path d="M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z"/></svg>`
    );
    addIcon(
      "pi-agent-icon-claude",
      `<svg viewBox="0 0 16 16" fill="currentColor" class="svg-icon" style="color: #cc5a37;"><path d="M9.218 2h2.402L16 12.987h-2.402zM4.379 2h2.512l4.38 10.987H8.82l-.895-2.308h-4.58l-.896 2.307H0L4.38 2.001zm2.755 6.64L5.635 4.777 4.137 8.64z"/></svg>`
    );
    addIcon(
      "pi-agent-icon-deepseek",
      `<svg viewBox="0 0 512 509.64" fill="currentColor" class="svg-icon" style="color: #0066ff;"><path fill-rule="nonzero" d="M440.898 139.167c-4.001-1.961-5.723 1.776-8.062 3.673-.801.612-1.479 1.407-2.154 2.141-5.848 6.246-12.681 10.349-21.607 9.859-13.048-.734-24.192 3.368-34.04 13.348-2.093-12.307-9.048-19.658-19.635-24.37-5.54-2.449-11.141-4.9-15.02-10.227-2.708-3.795-3.447-8.021-4.801-12.185-.861-2.509-1.725-5.082-4.618-5.512-3.139-.49-4.372 2.142-5.601 4.349-4.925 9.002-6.833 18.921-6.647 28.962.432 22.597 9.972 40.597 28.932 53.397 2.154 1.47 2.707 2.939 2.032 5.082-1.293 4.41-2.832 8.695-4.186 13.105-.862 2.817-2.157 3.429-5.172 2.205-10.402-4.346-19.391-10.778-27.332-18.553-13.481-13.044-25.668-27.434-40.873-38.702a177.614 177.614 0 00-10.834-7.409c-15.512-15.063 2.032-27.434 6.094-28.902 4.247-1.532 1.478-6.797-12.251-6.736-13.727.061-26.285 4.653-42.288 10.777-2.34.92-4.801 1.593-7.326 2.142-14.527-2.756-29.608-3.368-45.367-1.593-29.671 3.305-53.368 17.329-70.788 41.272-20.928 28.785-25.854 61.482-19.821 95.59 6.34 35.943 24.683 65.704 52.876 88.974 29.239 24.123 62.911 35.943 101.32 33.677 23.329-1.346 49.307-4.468 78.607-29.27 7.387 3.673 15.142 5.144 28.008 6.246 9.911.92 19.452-.49 26.839-2.019 11.573-2.449 10.773-13.166 6.586-15.124-33.915-15.797-26.47-9.368-33.24-14.573 17.235-20.39 43.213-41.577 53.369-110.222.8-5.448.121-8.877 0-13.287-.061-2.692.553-3.734 3.632-4.041 8.494-.981 16.742-3.305 24.314-7.471 21.975-12.002 30.84-31.719 32.933-55.355.307-3.612-.061-7.348-3.879-9.245v-.003zM249.4 351.89c-32.872-25.838-48.814-34.352-55.4-33.984-6.155.368-5.048 7.41-3.694 12.002 1.415 4.532 3.264 7.654 5.848 11.634 1.785 2.634 3.017 6.551-1.784 9.493-10.587 6.55-28.993-2.205-29.856-2.635-21.421-12.614-39.334-29.269-51.954-52.047-12.187-21.924-19.267-45.435-20.435-70.542-.308-6.061 1.478-8.207 7.509-9.307 7.94-1.471 16.127-1.778 24.068-.615 33.547 4.9 62.108 19.902 86.054 43.66 13.666 13.531 24.007 29.699 34.658 45.496 11.326 16.778 23.514 32.761 39.026 45.865 5.479 4.592 9.848 8.083 14.035 10.656-12.62 1.407-33.673 1.714-48.075-9.676zm15.899-102.519c.521-2.111 2.421-3.658 4.722-3.658a4.74 4.74 0 011.661.305c.678.246 1.293.614 1.786 1.163.861.859 1.354 2.083 1.354 3.368 0 2.695-2.154 4.837-4.862 4.837a4.748 4.748 0 01-4.738-4.034 5.01 5.01 0 01.077-1.981zm47.208 26.915c-2.606.996-5.2 1.778-7.707 1.88-4.679.244-9.787-1.654-12.556-3.981-4.308-3.612-7.386-5.631-8.679-11.941-.554-2.695-.247-6.858.246-9.246 1.108-5.144-.124-8.451-3.754-11.451-2.954-2.449-6.711-3.122-10.834-3.122-1.539 0-2.954-.673-4.001-1.224-1.724-.856-3.139-3-1.785-5.634.432-.856 2.525-2.939 3.018-3.305 5.6-3.185 12.065-2.144 18.034.244 5.54 2.266 9.727 6.429 15.759 12.307 6.155 7.102 7.263 9.063 10.773 14.39 2.771 4.163 5.294 8.451 7.018 13.348.877 2.561.071 4.74-2.341 6.277-.981.625-2.109 1.044-3.191 1.458z"/></svg>`
    );
    addIcon(
      "pi-agent-icon-minimax",
      `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #ff4d4f;"><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"/></svg>`
    );
    addIcon(
      "pi-agent-icon-gemini",
      `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #7c3aed;"><path d="M12 2l1.8 5.4L19.2 9.2 13.8 11 12 16.4 10.2 11 4.8 9.2l5.4-1.8L12 2zm6 12l.9 2.7L21.6 17.6l-2.7.9-.9 2.7-.9-2.7-2.7-.9 2.7-.9.9-2.7z"/></svg>`
    );
    addIcon(
      "pi-agent-icon-xiaomi",
      `<svg viewBox="0 0 24 24" fill="none" class="svg-icon" style="color: #ff6700;"><path d="M12,2C17.5,2 22,6.5 22,12C22,17.5 17.5,22 12,22C6.5,22 2,17.5 2,12C2,6.5 6.5,2 12,2Z" fill="currentColor"/><path d="M6.5,16V10.5a1.8,1.8 0 0,1 3.6,0V16 M10.1,16V10.5a1.8,1.8 0 0,1 3.6,0V16 M17.5,16V8.5" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="butt" stroke-linejoin="round"/></svg>`
    );
    addIcon(
      "pi-agent-icon-volcengine",
      `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #1664ff;"><path d="M5.31 15.756c.172-3.75 1.883-5.999 2.549-6.739-3.26 2.058-5.425 5.658-6.358 8.308v1.12C1.501 21.513 4.226 24 7.59 24a6.59 6.59 0 002.2-.375c.353-.12.7-.248 1.039-.378.913-.899 1.65-1.91 2.243-2.992-4.877 2.431-7.974.072-7.763-4.5l.002.001z" fill-opacity=".5"></path><path d="M22.57 10.283c-1.212-.901-4.109-2.404-7.397-2.8.295 3.792.093 8.766-2.1 12.773a12.782 12.782 0 01-2.244 2.992c3.764-1.448 6.746-3.457 8.596-5.219 2.82-2.683 3.353-5.178 3.361-6.66a2.737 2.737 0 00-.216-1.084v-.002zM14.303 1.867C12.955.7 11.248 0 9.39 0 7.532 0 5.883.677 4.545 1.807 2.791 3.29 1.627 5.557 1.5 8.125v9.201c.932-2.65 3.097-6.25 6.357-8.307.5-.318 1.025-.595 1.569-.829 1.883-.801 3.878-.932 5.746-.706-.222-2.83-.718-5.002-.87-5.617h.001z"></path><path d="M17.305 4.961a199.47 199.47 0 01-1.08-1.094c-.202-.213-.398-.419-.586-.622l-1.333-1.378c.151.615.648 2.786.869 5.617 3.288.395 6.185 1.898 7.396 2.8-1.306-1.275-3.475-3.487-5.266-5.323z" fill-opacity=".5"></path></svg>`
    );
    addIcon(
      "pi-agent-icon-siliconflow",
      `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #00a3ff;"><path clip-rule="evenodd" d="M22.956 6.521H12.522c-.577 0-1.044.468-1.044 1.044v3.13c0 .577-.466 1.044-1.043 1.044H1.044c-.577 0-1.044.467-1.044 1.044v4.174C0 17.533.467 18 1.044 18h10.434c.577 0 1.044-.467 1.044-1.043v-3.13c0-.578.466-1.044 1.043-1.044h9.391c.577 0 1.044-.467 1.044-1.044V7.565c0-.576-.467-1.044-1.044-1.044z"/></svg>`
    );
    addIcon(
      "pi-agent-icon-zhipu",
      `<svg viewBox="0 0 24 24" fill="currentColor" class="svg-icon" style="color: #3b82f6;"><path d="M3 3h7.2L12 5.4 13.8 3H21v7.2L18.6 12 21 13.8V21h-7.2L12 18.6 10.2 21H3v-7.2L5.4 12 3 10.2V3zm2.4 1.8v4.4L8.6 12 5.4 14.8v4.4h4.4L12 15.4l2.2 3.8h4.4v-4.4L15.4 12l3.2-2.8V4.8h-4.4L12 8.6 9.8 4.8H5.4zM12 10.2L13.5 12 12 13.8 10.5 12 12 10.2z"/></svg>`
    );

    await this.loadSettings();

    // Register the custom view
    this.registerView(
      PI_AGENT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new PiAgentView(leaf, this)
    );

    // Add ribbon icon to open Pimate
    this.addRibbonIcon("pimate-logo", "Open Pimate", () => {
      const lang = (this.settings?.language as string) === "en" ? "en" : "zh";
      new Notice(lang === "zh" ? "正在启动 Pimate..." : "Starting Pimate...");
      void this.activateView();
    });

    // Add command to open pi agent
    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "new-session",
      name: "New session",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        await view?.newChatSession();
      }),
    });

    this.addCommand({
      id: "close-active-session",
      name: "Close active session tab",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        await view?.closeActiveSessionTab();
      }),
    });

    this.addCommand({
      id: "focus-composer",
      name: "Focus composer",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        view?.focusComposer();
      }),
    });

    this.addCommand({
      id: "open-actions-and-skills",
      name: "Open actions and skills",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        view?.openCommandsAndSkills();
      }),
    });

    this.addCommand({
      id: "previous-message",
      name: "Jump to previous message",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        view?.scrollToPreviousMessage();
      }),
    });

    this.addCommand({
      id: "next-message",
      name: "Jump to next message",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        view?.scrollToNextMessage();
      }),
    });

    this.addCommand({
      id: "toggle-last-tool",
      name: "Toggle last tool output",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        view?.toggleLastToolBlock();
      }),
    });

    this.addCommand({
      id: "jump-last-diff",
      name: "Jump to last diff",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        view?.scrollToLastDiff();
      }),
    });

    this.addCommand({
      id: "resume-session",
      name: "Resume previous session",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        await view?.resumePreviousSession();
      }),
    });

    this.addCommand({
      id: "fork-session",
      name: "Fork session from previous prompt",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        await view?.forkFromPreviousPrompt();
      }),
    });

    this.addCommand({
      id: "clone-branch",
      name: "Clone current branch",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        await view?.cloneCurrentSessionBranch();
      }),
    });

    // Add command to send selected text to pi
    this.addCommand({
      id: "send-selection",
      name: "Send selection",
      editorCallback: (editor) => this.runAsync(async () => {
        const selection = editor.getSelection();
        if (!selection) {
          new Notice("No text selected");
          return;
        }
        const view = await this.activateView();
        view?.addSelectionContext(selection);
      }),
    });

    this.addCommand({
      id: "inline-edit-selection",
      name: "Inline edit selection",
      editorCallback: (editor) => this.runAsync(async () => {
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
      }),
    });

    // Add command to send current file as context
    this.addCommand({
      id: "send-current-file",
      name: "Send current file",
      callback: () => this.runAsync(async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) {
          new Notice("No active file");
          return;
        }
        const view = await this.activateView();
        view?.addActiveFileContext();
      }),
    });

    this.addCommand({
      id: "insert-last-response",
      name: "Insert last response into current note",
      callback: () => this.runAsync(async () => {
        const view = await this.activateView();
        await view?.insertLastAssistantIntoActiveNote();
      }),
    });

    // Right-click multi-select support: track selection via active-leaf-change
    // and document click events, then read the cache in the right-click menu.
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.refreshExplorerSelection();
      })
    );
    this.registerDomEvent(activeDocument, "click", () => {
      this.refreshExplorerSelection();
    }, true);

    // Right-click on file: add to Pimate context (multi-select aware).
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile)) return; // skip folder-menu leakage etc.
        // Refresh at right-click time so we have the freshest cache.
        this.refreshExplorerSelection();
        const multi = this.getRightClickMultiSelection(file);
        const isMulti = multi.length > 1;
        const title = isMulti
          ? `Add ${multi.length} items to Pimate context`
          : "Send to Pimate";
        menu.addItem((item) =>
          item
            .setTitle(title)
            .setIcon("pimate-logo")
            .onClick(() => this.runAsync(async () => {
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
                `Pimate: added ${count} item${count === 1 ? "" : "s"} to context`
              );
            }))
        );
      })
    );

    // Right-click on folder: add folder (recursive) to Pimate context.
    // Multi-select aware (works for both single and multi folder selection).
    // `folder-menu` is supported by Obsidian at runtime but not in the .d.ts.
    const folderMenuHandler = (menu: Menu, folder: TFolder) => {
      this.refreshExplorerSelection();
      const multi = this.getRightClickMultiSelection(folder);
      const isMulti = multi.length > 1;
      const title = isMulti
        ? `Add ${multi.length} items to Pimate context`
        : "Add folder to Pimate context";
      menu.addItem((item) =>
        item
          .setTitle(title)
          .setIcon("pimate-logo")
          .onClick(() => this.runAsync(async () => {
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
              `Pimate: added ${count} item${count === 1 ? "" : "s"} to context`
            );
          }))
      );
    };
    this.registerEvent(
      (this.app.workspace.on as any)("folder-menu", folderMenuHandler)
    );

    // Add settings tab
    this.addSettingTab(new PiAgentSettingTab(this.app, this));

    console.log("Pimate plugin loaded");
  }

  private runAsync(task: () => Promise<void>): void {
    void task().catch((err: unknown) => {
      console.error("[pimate] command failed", err);
      new Notice(err instanceof Error ? err.message : String(err));
    });
  }

  onunload(): void {
    console.log("Pimate plugin unloaded");
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
      workspace.setActiveLeaf(leaf);
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
        { id: "google", defaultModel: "gemini-2.5-flash" },
        { id: "anthropic", defaultModel: "claude-3-5-sonnet-latest" },
        { id: "zhipu", defaultModel: "glm-5.2" }
      ];
      
      for (const provider of apiProviders) {
        if (data[provider.id] && (data[provider.id].key || data[provider.id].type === "oauth")) {
          this.settings.provider = provider.id;
          this.settings.modelId = provider.defaultModel;
          void this.saveSettings();
          console.log(`[Pimate] 自动检测到已配置凭据的厂商，默认模型设为 ${provider.id}/${provider.defaultModel}`);
          break;
        }
      }
    } catch (e) {
      console.error("[Pimate] 自动检测已配置模型失败:", e);
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
