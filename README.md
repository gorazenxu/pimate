# Pisidian — Pi Coding Agent for Obsidian

> **Pisidian** embeds [Pi Coding Agent](https://pi.dev) into Obsidian as an AI collaborator for your vault. Chat directly with AI, read and edit vault files, execute commands — all without leaving Obsidian.

<p align="center">
  <img src="https://img.shields.io/badge/status-active-brightgreen" alt="Active">
  <img src="https://img.shields.io/github/v/release/gorazenxu/obsidian-pisidian" alt="Release">
  <img src="https://img.shields.io/github/license/gorazenxu/obsidian-pisidian" alt="License">
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

Pisidian is a **hybrid plugin** that runs a local [Pi Coding Agent](https://pi.dev) process in the background.

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
2. Search for **Pisidian**
3. Click Install, then Enable

### Manual (BRAT / development)

1. Enable BRAT plugin in Obsidian
2. Add `gorazenxu/obsidian-pisidian`
3. Or clone this repo into `.obsidian/plugins/pisidian/` and run `npm install && npm run build`

## Quick Start

1. Click the **π icon** in the left ribbon, or run **Open Pisidian Chat** from the command palette
2. Wait for the status bar to show **"Ready"**
3. Type your question and press `Enter`
4. Watch the response stream in real time

### Tips

- **Attach files**: Type `@` in the input box to search and attach vault files or folders
- **Current note**: Click `📎` → Attach current note (or `Send current file to Pisidian` command)
- **Selected text**: Highlight text in a note, right-click → **Send selection to Pisidian**
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

Settings are available in Obsidian → Settings → Pisidian:

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

Pisidian launches Pi as a child process in **RPC mode** (`--mode rpc`) and communicates via JSONL messages over stdin/stdout. Pi's full toolset (read, write, edit, bash, grep, find, ls) is available to the model through this interface.

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
git clone https://github.com/gorazenxu/obsidian-pisidian.git
cd obsidian-pisidian
npm install
npm run build     # production build
npm run dev       # watch mode
```

## License

GNU General Public License v3.0
