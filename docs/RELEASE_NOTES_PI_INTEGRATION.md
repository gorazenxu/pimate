# Pimate - Pi 核心原生功能集成更新说明

> **更新日期**: 2026-08-19
> **适用版本**: 1.0.48
> **对接框架**: [Pi Coding Agent (earendil-works/pi)](https://github.com/earendil-works/pi)

本次更新将 **Pi Coding Agent** 原生最强大、最实用的一批核心功能深度整合到了 Obsidian 插件 **Pimate** 中。用户无需离开 Obsidian 界面即可享受 Pi 强大的历史节点分支、实时转向、热重载以及一键导出等功能。

---

## ✨ 新增功能列表

### 1. 🌿 历史节点与分支 Fork (History Forking)
- **消息级 Fork 按钮**：仅 Pi `get_fork_messages` 确认的非空用户提问显示 `🌿` (Fork) 按钮；点击将从该用户提问之前创建新的对话分支。Assistant 回复、思考过程、工具消息与摘要不提供标准 RPC Fork。
- **可 Fork 历史节点列表 Modal**：在 Header 操作菜单中新增 **“可 Fork 的历史节点...”** 入口。点击后展示 Pi 返回的可 Fork 历史节点列表，支持查看 Preview 文本并从指定节点快速创建分支。

### 2. ⚡ 生成中实时转向与追问 (Steering & Follow-up Queue)
- **调整方向 (Hard Steer)**：当 AI 处于 Streaming（回答中）状态时，点击消息卡片或底部的「调整方向」，系统会先中断当前回复，再立即按所选消息重新发起；普通 Enter 发送仍按 Pi follow-up queue 排队。

### 3. 🔄 扩展与技能一键热重载 (`/reload`)
- **免重启热重载**：在 Header 顶部菜单中新增 **“重载扩展与技能 (/reload)”** 项。
- **即时生效**：开发或修改位于 `~/.pi/agent/extensions/` 或 Obsidian Vault 根目录 `.pi/extensions/` 里的自定义 TypeScript 扩展或 Skill 后，只需点击此按钮或在输入框触发 `/reload`，即可直接使新扩展与工具在当前 Pi 进程中生效。

### 4. ⚡ 增强型 Slash Command 选单补全 (`/` Trigger)
- **斜杠智能悬浮窗**：在侧栏聊天输入框中输入 `/` 时，将自动弹出匹配下拉选单。
- **统一指令支持**：统一匹配扩展、Skill 与 Pimate 包装的 Pi 内建 RPC 操作（如 `/model`, `/compact`, `/fork`, `/tree`, `/reload`, `/export` 等），按方向键与 Enter 键即可直接执行。

### 5. 📝 会话一键导出至 Obsidian Vault 笔记
- **Markdown 笔记导出**：在 Header 顶部菜单中点击 **“导出为 Vault 笔记”**，可将当前 Chat Session 的完整记录（包含用户提问、AI 思考链 Thinking Blocks、工具调用 Tool Calls 及回答）格式化输出为排版清晰的 `.md` 笔记。
- **自动保存与打开**：导出的笔记文件将自动保存至当前 Obsidian Vault 根目录（文件名为 `Pimate Export YYYY-MM-DD HH-MM-SS.md`）并自动在新的叶子窗口中打开。

---

## 🛠️ 使用指引与快捷菜单入口

| 功能 | 操作入口 | 快捷键 / 指令 |
| :--- | :--- | :--- |
| **历史节点列表 Modal** | 点击 Header `⋯` 菜单 → `可 Fork 的历史节点...` | `/fork` |
| **消息 Fork** | 悬浮在 Pi 确认可 Fork 的用户提问上 → 点击 `🌿` 按钮 | `/fork` |
| **热重载** | 点击 Header `⋯` 菜单 → `重载扩展与技能 (/reload)` | `/reload` |
| **导出 Vault 笔记** | 点击 Header `⋯` 菜单 → `导出为 Vault 笔记` | `/export` |
| **斜杠补全** | 在聊天输入框首输入 `/` | `Ctrl/Cmd + K` |

---

## 🔧 技术实现与核心代码改动

- **[PiAgentClient.ts](file:///d:/00AIProject/06演示/00mindppt/obsidian-pi-agent/PiAgentClient.ts)**: 新增 `reload()` 方法，向后端 RPC 进程透传 `{ type: "reload" }` 命令。
- **[SessionTreeModal.ts](file:///d:/00AIProject/06演示/00mindppt/obsidian-pi-agent/SessionTreeModal.ts)**: 新建可 Fork 历史节点列表 Modal 组件，展示 `getForkMessages()` 返回的节点。
- **[PiAgentView.ts](file:///d:/00AIProject/06演示/00mindppt/obsidian-pi-agent/PiAgentView.ts)**: 添加历史节点列表弹窗调起、`/reload` 响应、Markdown 格式化导出 (`exportSessionToVaultNote`) 及直接绑定历史节点的消息工具栏 Fork 按钮。
- **[styles.css](file:///d:/00AIProject/06演示/00mindppt/obsidian-pi-agent/styles.css)**: 补充历史节点列表、状态标签与按钮的 Claudian 风格 CSS。
