import { App, Modal, Notice, setIcon } from "obsidian";
import type { ForkMessage, PiAgentClient } from "./PiAgentClient";

export class SessionTreeModal extends Modal {
  private client: PiAgentClient;
  private onSelectForkNode: (node: ForkMessage) => Promise<boolean>;

  constructor(
    app: App,
    client: PiAgentClient,
    onSelectForkNode: (node: ForkMessage) => Promise<boolean>
  ) {
    super(app);
    this.client = client;
    this.onSelectForkNode = onSelectForkNode;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pimate-session-tree-modal");

    const header = contentEl.createEl("div", { cls: "pimate-modal-header" });
    header.createEl("h3", { text: "🌿 可 Fork 的历史节点" });

    contentEl.createEl("p", {
      cls: "pimate-modal-desc",
      text: "选择一个历史节点，即可从该节点创建新的对话分支。",
    });

    const listContainer = contentEl.createEl("div", {
      cls: "pimate-tree-list-container",
    });
    listContainer.setText("加载会话节点数据中...");

    try {
      const result = await this.client.getForkMessages();
      if (!result.success || !result.data) {
        listContainer.setText("未能获取可 Fork 的历史节点。");
        return;
      }
      const messages = result.data.messages.filter(
        (item) => item.entryId && item.text
      );

      listContainer.empty();

      if (messages.length === 0) {
        listContainer.createEl("div", {
          cls: "pimate-empty-tree-state",
          text: "当前会话没有可 Fork 的历史节点。",
        });
        return;
      }

      messages.forEach((node, index) => {
        const itemEl = listContainer.createEl("div", {
          cls: "pimate-tree-node-item",
        });

        const iconEl = itemEl.createEl("div", { cls: "pimate-tree-node-icon" });
        setIcon(iconEl, "git-fork");

        const infoEl = itemEl.createEl("div", { cls: "pimate-tree-node-info" });
        const titleEl = infoEl.createEl("div", { cls: "pimate-tree-node-title" });
        titleEl.setText(`#${index + 1} — ${node.text.slice(0, 80)}${node.text.length > 80 ? "..." : ""}`);

        const metaEl = infoEl.createEl("div", { cls: "pimate-tree-node-meta" });
        metaEl.setText(`Entry ID: ${node.entryId.slice(0, 12)}`);

        const actionBtn = itemEl.createEl("button", {
          cls: "mod-cta pimate-tree-node-btn",
          text: "Fork 从此分支",
        });

        actionBtn.addEventListener("click", async () => {
          actionBtn.disabled = true;
          actionBtn.setText("Forking...");
          try {
            if (await this.onSelectForkNode(node)) {
              this.close();
              return;
            }
          } catch (err) {
            new Notice(`Fork 失败: ${(err as Error).message}`);
          }
          actionBtn.disabled = false;
          actionBtn.setText("Fork 从此分支");
        });
      });
    } catch (err) {
      listContainer.setText(`获取节点失败: ${(err as Error).message}`);
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
