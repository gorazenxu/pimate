# Pimate

> **An autonomous coding & knowledge agent for Obsidian, powered by [Pi Coding Agent](https://pi.dev) and Google Antigravity CLI.**

<p align="center">
  <img src="https://raw.githubusercontent.com/gorazenxu/pimate/main/docs/pimate-real-ui.svg" alt="Pimate running inside Obsidian: real interface map" width="96%" />
</p>

<p align="center">
  <a href="https://github.com/gorazenxu/pimate/releases"><img src="https://img.shields.io/github/v/release/gorazenxu/pimate?color=7057ff&label=Release" alt="Release"></a>
  <img src="https://img.shields.io/badge/Obsidian-Desktop%20%E2%89%A51.5.0-purple?logo=obsidian" alt="Obsidian Version">
  <img src="https://img.shields.io/badge/Engine-Pi%20%7C%20Antigravity-orange" alt="Engines">
  <img src="https://img.shields.io/badge/License-GPL%20v3.0-blue" alt="License">
</p>

Pimate embeds local coding agents directly into your Obsidian workspace. Rather than acting as a standard text-completion chatbot, Pimate acts as a full-fledged agent capable of inspecting vault files, running grep/find searches, drafting precise diffs, executing shell tools, and maintaining multi-turn task state — all within Obsidian.

> The interface map above is based on the current Pimate page in Obsidian: the Vault file tree and active note remain visible on the left, while Pimate runs in the right pane. The history counts and note text are representative and change with the current Vault.

### Actual interface at a glance

1. **Vault context** — Keep the active note and file tree visible while sending a file, folder, or selection to the agent.
2. **Pimate history** — Browse `当前空间` (This vault), `未归属` (Unassigned), or `全部 AGY` (All AGY) conversations and search by title or preview.
3. **Conversation scope** — Move an AGY conversation to `未归属` without deleting its native AGY record; assign it back to the current Vault when needed.
4. **Session cards** — Keep multiple Pi or Antigravity conversations open as numbered tabs.
5. **Composer controls** — Select the engine, model, effort, file context, and send messages from the bottom composer.

---

## 🇨🇳 中文说明 / Chinese Overview

**Pimate** 是一个面向 Obsidian 的本地自主 AI Agent 协作者插件。它不仅支持在侧栏对话，更具备读写笔记、全库检索、局部 Diff 审查、命令执行与会话分支能力。

- **双引擎驱动（Pi 为主，Antigravity 为辅）**：
  - **Pi Coding Agent**：主力后端，聚合全网主流模型（Claude 3.7 Sonnet / Thinking、DeepSeek-R1/V3、OpenAI、MiniMax、SiliconFlow 等），支持自定义 Prompt 与本地 Skills 扩展。
  - **Antigravity CLI**：Google 官方自主 Agent 终端，复用系统 Google 账号 OAuth 授权，无需手动配置 API Key 即可使用 Gemini 旗舰模型。
- **无损局部 Diff 审查**：选中文本一键发送重构，生成红绿增删对比，逐条审查接受或拒绝，避免暴力覆写整篇笔记。
- **Agent 本地工具链**：内置 `read`, `write`, `edit`, `grep`, `find`, `bash`，支持跨笔记检索与资料整合。
- **分支探索 (`🌿 Fork`)**：在任意历史消息节点一键分叉会话，方便多思路对比与回溯。
- **长任务智能自检 (Smart Review)**：可选的规则检测环路，自动识别长任务未完成状态并驱动 Agent 持续执行。

---

## Key Features

- **Dual-Engine Architecture**:
  - **Pi Coding Agent (`pi`)** *(Default)*: Full multi-provider support (Claude 3.7 with extended thinking, DeepSeek-R1/V3, OpenAI, MiniMax, etc.), custom system prompts, and Pi skills.
  - **Antigravity CLI (`agy`)**: Google's autonomous agent CLI. Uses local Google OAuth credentials — **no API keys required**.
- **Vault-Aware Agent Tools**: Built-in `read`, `write`, `edit`, `grep`, `find`, and `bash` execution. The agent can search notes, check cross-references, and gather context autonomously.
- **Precision Inline Diff Review**: Highlight text in any note and send it to Pimate. Review color-coded diffs before applying changes, protecting your existing document structure and backlinks.
- **Visualized Reasoning (Thinking Blocks)**: Streaming visibility into model reasoning chains, with configurable thinking effort levels (*Off / Low / Medium / High / Max*).
- **Session Branching (`🌿 Fork`)**: Branch off from any previous user turn in your conversation history to explore alternative prompts without losing context.
- **Smart Review Loop**: Automatically inspects assistant completions for unfinished markers and sends continuation prompts until multi-step tasks are truly finished.
- **Context Management**: Use `@` to fuzzy-search and attach vault notes/folders, compact long conversations with `/compact`, or export sessions as Markdown notes with `/export`.

---

## Quick Start

Pimate runs as an Obsidian desktop plugin and communicates with your local CLI agent over a background stdio/RPC process.

### Option 1: Pi Coding Agent (Recommended · Multi-Provider & Skills)

1. **Install Pi globally** (requires Node.js 18+):
   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```
2. **Authenticate with your preferred provider**:
   ```bash
   # Run interactive login
   pi
   /login

   # Or export an API key directly in your shell profile:
   # export ANTHROPIC_API_KEY=sk-ant-...
   # export DEEPSEEK_API_KEY=sk-...
   ```
3. **Verify Pi works**:
   ```bash
   pi --version
   ```

### Option 2: Google Antigravity CLI (Keyless · Google OAuth)

1. **Install Antigravity CLI** (`agy`) on your machine.
2. **Authorize Google Account**:
   Run `agy` once in your terminal and complete the browser OAuth sign-in.
3. **Enable in Pimate**:
   Open Obsidian → **Settings** → **Pimate** → **✦ Antigravity (OAuth)**. Verify status shows `🟢 Authenticated`.

---

## Installation

### Via BRAT (Recommended for latest updates)

1. Install and enable the [Obsidian BRAT](https://github.com/TfTHacker/obsidian-42-brat) plugin.
2. Open BRAT settings → click **Add Beta plugin**.
3. Enter repository: `gorazenxu/pimate`
4. Click **Add Plugin**, then enable **Pimate** under Community Plugins.

### Manual Release

1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [GitHub Release](https://github.com/gorazenxu/pimate/releases).
2. Create a folder named `pimate` inside `<vault>/.obsidian/plugins/`.
3. Place the downloaded files into that directory.
4. Reload Obsidian Community Plugins and enable **Pimate**.

---

## Shortcuts & Commands

| Shortcut / Command | Action |
| :--- | :--- |
| `Enter` | Send message (queues follow-up if agent is streaming) |
| `Shift + Enter` | Insert newline in composer |
| `Esc` | Abort current agent response or tool execution |
| `Ctrl/Cmd + K` | Open Slash Command & Skill picker |
| `Ctrl/Cmd + N` | Open a new chat session tab |
| `Ctrl/Cmd + Shift + D` | Jump to the latest diff view |
| `Ctrl/Cmd + Shift + E` | Toggle expand/collapse for tool output |
| `/compact` | Summarize session history to preserve tokens |
| `/export` | Export the current session as a Markdown note |
| `/reload` | Hot-reload extensions and skill templates |

---

## Configuration

Customizable via **Obsidian Settings → Pimate**:

- **Default Engine**: Select whether new sessions default to `Pi Coding Agent` or `Antigravity CLI`.
- **Pi Settings**: Set default provider, model ID, thinking effort level, custom system prompts, and API keys.
- **Antigravity Settings**: Set default Gemini model, effort level, and auto-approve permissions flag.
- **Smart Review**: Toggle the completion-checking heuristic and configure max auto-continuation turns (1–10).
- **Auto-Title**: Automatically summarize and rename new sessions after the first prompt.
- **Language**: Switch UI between English and Simplified Chinese (简体中文).

---

## Security & Permissions

- **Local-Only Execution**: Pimate runs agent processes directly on your local system as child processes. No intermediary cloud servers are used.
- **File System Access (`fs`)**: Used to read/write notes you target, parse `@` attachments, and store local session indices.
- **Subprocess Execution (`child_process`)**: Used to spawn `pi` and `agy` binaries. The agent can use command tools (like `grep`, `bash`) within your workspace only when instructed.
- **API Credentials**: Stored securely in Obsidian's plugin settings or read from your local environment.

---

## Development

```bash
git clone https://github.com/gorazenxu/pimate.git
cd pimate
npm install
npm run dev     # Watch mode
npm run build   # Production build
```

---

## Feedback & License

- Issues & Features: [GitHub Issues](https://github.com/gorazenxu/pimate/issues)
- License: [GNU General Public License v3.0 (GPL-3.0)](LICENSE)

Created by [Gorazen](https://github.com/gorazenxu) & the Pimate Community.
