# Pimate — Pi Coding Agent for Obsidian

> **Pimate** embeds [Pi Coding Agent](https://pi.dev) into Obsidian as an AI collaborator for your vault. Chat directly with AI, read and edit vault files, execute commands — all without leaving Obsidian.

<p align="center">
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="Active">
  <img src="https://img.shields.io/github/v/release/gorazenxu/pimate" alt="Release">
  <img src="https://img.shields.io/github/license/gorazenxu/pimate" alt="License">
</p>

## Features

- 🤖 **Built-in chat** — AI assistant in the right panel, streaming output
- 📝 **Vault-aware** — `@`-mention any file or folder for context
- 🔧 **Full toolset** — Read, write, edit, grep, find, bash — all inside your vault
- 🎨 **Inline edit** — Send editor selections to AI, preview and apply diffs
- 💭 **Thinking blocks** — Optional model reasoning display
- 📊 **Session stats** — Token usage, cost, and context meter
- 🎛️ **Multi-provider** — Claude, GPT, Gemini, DeepSeek, MiniMax, and more
- 🖼️ **Image support** — Paste or drag-drop images for multimodal models
- 📦 **Snippets** — Reusable prompt templates with variables
- 🏷️ **Session tabs** — Multiple conversations side by side
- 📋 **Context compaction** — Summarize long sessions to save tokens
- 🌐 **Bilingual UI** — Chinese / English

## Prerequisites

Pimate is a **hybrid plugin** that runs a local [Pi Coding Agent](https://pi.dev) process in the background.

1. **Install Node.js 18+** (if not already installed)
2. **Install Pi globally:**
   ```bash
   npm install -g --ignore-scripts @earendil-works/pi-coding-agent
   ```
3. **Configure an API key** (choose one):
   ```bash
   # Claude (subscription or API key)
   export ANTHROPIC_API_KEY=sk-ant-...

   # Or use Pi's built-in login flow:
   pi
   /login  # Then select provider
   ```
4. **Verify Pi works:**
   ```bash
   pi --version
   ```

## Installation

### From Obsidian Community Plugins (once approved)

1. Open Obsidian → Settings → Community plugins
2. Search for **Pimate**
3. Click Install, then Enable

### Manual (BRAT / development)

1. Enable BRAT plugin in Obsidian
2. Add `gorazenxu/pimate`
3. Or clone this repo into `.obsidian/plugins/pimate/` and run `npm install && npm run build`

## Quick Start

1. Click the **π icon** in the left ribbon, or run **Open Pimate Chat** from the command palette
2. Wait for the status bar to show **"Ready"**
3. Type your question and press `Enter`
4. Watch the response stream in real time

### Tips

- **Attach files**: Type `@` in the input box to search and attach vault files or folders
- **Current note**: Click `📎` → Attach current note (or `Send current file to Pimate` command)
- **Selected text**: Highlight text in a note, right-click → **Send selection to Pimate**
- **Quick actions**: Click `⋯` in the header for the action menu
- **Switch model**: Click the model name in the footer bar
- **History panel**: Click the `🕘` icon to browse past conversations

## Screenshots

*(Add screenshots here)*

## Supported Providers

| Provider | Auth |
|----------|------|
| Anthropic (Claude) | API key or subscription |
| OpenAI (GPT / Codex) | API key or subscription |
| Google Gemini | API key |
| DeepSeek | API key |
| MiniMax | API key |
| SiliconFlow | API key |
| Volcengine / Doubao | Endpoint ID |
| Others supported by Pi | API key |

## Configuration

Settings are available in Obsidian → Settings → Pimate:

| Setting | Description |
|---------|-------------|
| Pi executable path | Path to `pi` CLI (default: `pi`) |
| Default Provider | LLM provider for new sessions |
| Default Model | Model ID (e.g., `claude-sonnet-4-20250514`) |
| Thinking level | Reasoning intensity (off/minimal/low/medium/high/xhigh) |
| System prompt | Prefix added to every user message |
| Snippets | Reusable prompt templates |
| API keys | Configure per-provider via the settings tab |
| Language | Chinese or English UI |

## How It Works

```
Obsidian Plugin (TypeScript)
  ├── main.ts              — Plugin entry, commands, views
  ├── PiAgentView.ts       — Chat UI, streaming, events
  ├── PiAgentClient.ts     — Pi RPC client (JSONL over stdio)
  ├── PiAgentSettings.ts   — Settings and OAuth flows
  └── styles.css           — Claudian-inspired chat styles
```

Pimate launches Pi as a child process in **RPC mode** (`--mode rpc`) and communicates via JSONL messages over stdin/stdout. Pi's full toolset (read, write, edit, bash, grep, find, ls) is available to the model through this interface.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Esc` | Abort streaming |
| `Ctrl/Cmd+K` | Commands / Skills |
| `Ctrl/Cmd+N` | New session |
| `Ctrl/Cmd+Shift+E` | Toggle last tool output |
| `Ctrl/Cmd+Shift+D` | Jump to last diff |
| `Alt+↑` / `Alt+↓` | Previous / Next message |

## Building from Source

```bash
git clone https://github.com/gorazenxu/pimate.git
cd pimate
npm install
npm run build     # production build
npm run dev       # watch mode
```

## Security & Permissions

Pimate uses a few sensitive capabilities so it can act as a local coding/writing agent:

- **Direct file-system access (`fs`)** — used to read local Pi configuration/session files, inspect skill folders, and read files you attach as context. Pimate is desktop-only and runs locally.

- **Command execution (`child_process`)** — used to spawn the `pi` CLI in RPC mode and to run explicit skill-management commands from the settings page. The Pi agent may use shell tools such as `bash`, `grep`, and `find` when you ask it to work on files.

- **Vault enumeration** — used to find Markdown files/folders for context pickers, history/session helpers, and folder attachment features.

- **Clipboard access** — used only for explicit copy actions, such as copying generated commands, diffs, authentication codes, or modal content.

Because Pimate embeds a local agent, review commands and edits before approving them. Your API keys and vault content are handled locally by the plugin/Pi CLI except for requests you intentionally send to your selected AI provider.

## Reporting Issues

Found a bug or have a feature request? Open an issue:

👉 **[github.com/gorazenxu/pimate/issues](https://github.com/gorazenxu/pimate/issues)**

**Before opening a bug report**, please collect the following:

- **Pimate version** — Settings → About, or the tag in the [releases list](https://github.com/gorazenxu/pimate/releases)
- **Obsidian version** — Settings → About
- **OS** — Windows / macOS / Linux + version
- **Pi version** — run `pi --version` in your terminal
- **Provider + model** — e.g. `minimax-cn / MiniMax-M3`
- **Reproduction steps** — minimal example that triggers the bug
- **Console logs** — open DevTools (`Ctrl+Shift+I` / `Cmd+Option+I`) → Console tab; copy errors and the red stack traces

For Pi-backend / RPC / model-related problems, check the [Pi Coding Agent repo](https://github.com/earendil-works/pi-coding-agent) first — they may already be tracked there.

## License

GNU General Public License v3.0
