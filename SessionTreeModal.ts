import { App, Modal, Notice, setIcon } from "obsidian";
import type { ForkMessage } from "./PiAgentClient";
import type { AgentClient } from "./PiAgentView";
import { getPimateUiText, type PimateLanguage } from "./PimateUiText";

export class SessionTreeModal extends Modal {
  private client: AgentClient;
  private language: PimateLanguage;
  private onSelectForkNode: (node: ForkMessage) => Promise<boolean>;

  constructor(
    app: App,
    client: AgentClient,
    language: PimateLanguage,
    onSelectForkNode: (node: ForkMessage) => Promise<boolean>
  ) {
    super(app);
    this.client = client;
    this.language = language;
    this.onSelectForkNode = onSelectForkNode;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("pimate-session-tree-modal");

    const header = contentEl.createEl("div", { cls: "pimate-modal-header" });
    header.createEl("h3", {
      text: getPimateUiText(this.language, "sessionTreeTitle"),
    });

    contentEl.createEl("p", {
      cls: "pimate-modal-desc",
      text: getPimateUiText(this.language, "sessionTreeDescription"),
    });

    const listContainer = contentEl.createEl("div", {
      cls: "pimate-tree-list-container",
    });
    listContainer.setText(getPimateUiText(this.language, "sessionTreeLoading"));

    try {
      const result = await this.client.getForkMessages();
      if (!result.success || !result.data) {
        listContainer.setText(
          getPimateUiText(this.language, "sessionTreeLoadFailed")
        );
        return;
      }
      const messages = result.data.messages.filter(
        (item) => item.entryId && item.text
      );

      listContainer.empty();

      if (messages.length === 0) {
        listContainer.createEl("div", {
          cls: "pimate-empty-tree-state",
          text: getPimateUiText(this.language, "sessionTreeEmpty"),
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
          text: getPimateUiText(this.language, "forkFromHere"),
        });

        actionBtn.addEventListener("click", async () => {
          actionBtn.disabled = true;
          actionBtn.setText(getPimateUiText(this.language, "forking"));
          try {
            if (await this.onSelectForkNode(node)) {
              this.close();
              return;
            }
          } catch (err) {
            new Notice(
              getPimateUiText(this.language, "forkFailed", {
                error: (err as Error).message,
              })
            );
          }
          actionBtn.disabled = false;
          actionBtn.setText(getPimateUiText(this.language, "forkFromHere"));
        });
      });
    } catch (err) {
      listContainer.setText(
        getPimateUiText(this.language, "forkNodesFailed", {
          error: (err as Error).message,
        })
      );
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
