# Pimate Changelog

开发日志 / 变更记录。

- 🛠 **Working / Uncommitted** — 当前 working tree 有但还没 commit 的修改
- 📦 **Released** — 已经发版的版本，每个版本下列出本次发版的修改项

每次改代码时，往 🛠 Working 加一条；
commit 时把对应条目挪到对应版本的 📦 Released 下。

---

## 🛠 Working / Uncommitted

_当前没有未提交的修改。_

---

## 📦 v1.0.33 (2026-06-17)

- 优：新建 / 重启 tab 直接使用全局 settings 的 provider / modelId / thinkingLevel
  - 之前会在 `createAndSwitchTab()` 里继承当前 active tab 的状态，导致 provider 切换后新建 tab 仍跑旧 provider

---

## 📦 v1.0.32 (2026-06-17)

- 修：Obsidian 在 macOS / Linux 上启动 Pi 时提示 `process not running`
  - `~/.local/bin/pi` 是带 `#!/usr/bin/env node` shebang 的 JS shim，Obsidian GUI 环境 `PATH` 没有 Node，导致子进程立刻退出
  - 新增 POSIX 解析：找到 `node`（PATH / Homebrew / `/usr/local/bin`）并把 `pi` 解析到真实 `cli.js`，用 `node cli.js --mode rpc ...` 启动
  - 完整路径的 `piPath`（如 `/Users/.../.local/bin/pi`）也走同一解析逻辑
- 配：新增 `.gitattributes` 固定跨平台换行符
  - 统一 Windows / macOS / Linux 下生成文件与发布关键文件的 LF 行尾
  - 避免 `main.js` / `styles.css` / `manifest.json` 等文件在不同系统 checkout 或 build 后出现无意义 diff
  - 不影响插件运行逻辑

---

## 📦 v1.0.31 (2026-06-11)

- 修：避免模型选择时 provider / modelId 串台
  - 选择模型时同步更新 active tab 与全局 settings，避免出现 `openai-codex + MiniMax-M3` 这类错误组合
  - 新建 tab 会继承当前 tab / 全局的 provider、model、thinking level
  - 启动 Pi client 时优先使用 tab 自己保存的 provider / model / thinking level，而不是只读全局 settings
- 配：MiniMax-M3 国内 provider 改走 Anthropic-compatible 端点
  - `minimax-cn` 改为 `https://api.minimaxi.com/anthropic` + `anthropic-messages`，让 Pi 原生接收 `thinking_start` / `thinking_delta` / `thinking_end`
  - 旧 OpenAI-compatible 端点保留为 `minimax-cn-openai` fallback

---

## 📦 v1.0.30 (2026-06-11)

- 修：pretty / auto 渲染时 fenced code block 边界识别误判
  - 新增 `isInsideUnclosedFence()`，要求 fence 行只有 fence 标记 + 可选语言名，避免 inline ```` ``` ```` / ` ~~~ ` 被误识别
  - 同时支持 ```` ``` ```` 和 `~~~` 两种 fence
  - `renderMarkdownWithCursor()` 改用同一检测，光标与临时闭合 `\n```` ` 补齐基于正确状态
  - auto 模式换行触发 pretty 走同一逻辑，行为一致

---

## 📦 v1.0.29 (2026-06-10)

- 优：auto 模式重写为按行符触发 pretty
  - 文本输出中以 fast（`textContent`）跟手
  - 遇到 `text_delta` 含 `\n` 时立即调一次 `MarkdownRenderer.render`，使段落 / 列表项 / 表格行等 markdown 边界成型为 pretty
  - 停顿 idle 触发作为补充，避免单行长句、表格内不换行等场景不 pretty
  - message_end 仍走原 pretty 收尾，结果一致性不变
- 优：pretty 模式节流频率 80ms → 150ms，给主线程留更多余量
  - 纯 pretty 模式下重渲次数减少约一半，长回复闪烁与卡顿明显改善
  - auto 模式不受影响
  - fast 模式不受影响

---

## 📦 v1.0.28 (2026-06-10)

- 修：切走 tab 时正在流式回复的对话看不见（错过 message_start）
  - 新增 `ensureAssistantStreamMessage()`：遇到 `text_delta` / `thinking_start` / `error` 但当前没有 assistant 卡片时现场创建，继续接流
- 修：切到 streaming tab 时 jsonl 写盘可能滞后，丢失最新 in-flight 消息
  - `loadMessages()` 在 `tab.isStreaming` 时优先走 RPC `getMessages()`，非 streaming 走文件直读
- 优：header 速度 pill 隐藏时不再用 `display:none` 顶开右侧按钮位置
  - 改用 title 自身 `margin-inline-end: auto` 顶 right actions
  - speed pill 只负责内容，layout 不再受隐藏影响
- 修：model / effort 弹窗又写回全局 settings
  - 统一封装 `updateActiveTabModel` / `updateActiveTabThinkingLevel`
  - footer 弹窗、命令面板入口（`showModelSelector` / `showThinkingLevelSelector`）改为只写 `activeTab` + 调用该 tab 自己的 client
  - 启动 / 恢复 tab client 时执行 `applyTabRuntimePreferences(tab)`，把 tab 保存的 model / effort 应用到该 client
- 优：RPC 拉到的消息按 `maxHistoryDisplay` 截最后 N 条，避免大历史切回时一次性渲染过多

---

## 📦 v1.0.27 (2026-06-10)

- 优：实时速度状态按 tab 隔离；切换 tab 后 header 速度面板会按当前 tab 的状态重绘（不再被上一个 tab 残留）
- 修：切回之前生成过的 tab 后看不到速度（之前会再次清空状态）

---

## 📦 v1.0.26 (2026-06-10)

- 修：过滤空 assistant 消息；toolCall-only assistant 只显示工具块，不再显示单独的 `π Pi` 空标签
- 新：header 右侧增加实时输出速度指示（估算 `tok/s`），生成中显示，结束后保留 8 秒

---

## 📦 v1.0.25 (2026-06-10)

- 修：pretty 渲染 / thinking / fast streaming 时自动滚动偶发失效；现在会在内容变高前记录是否贴底，渲染后只对原本贴底的场景强制跟随到底
- 优：assistant 正文 Markdown 渲染前增加轻量容错，只修两类常见格式问题：
  - `文字###标题` → `文字\n\n### 标题`
  - `###A.` / `###第1步` / `###C.暂停` → `### A.` / `### 第1步` / `### C. 暂停`
  - 仅作用于 assistant 正文显示，不修改 session 原文，不处理 tool output，不处理代码块内文本

---

## 📦 v1.0.24 (2026-06-09)

- 改：默认开启“显示思考过程”（`showThinking: true`），保留历史 thinking 块可见
- 改：默认流式渲染模式改为 `pretty`（原版美观体验）

---

## 📦 v1.0.23 (2026-06-09)

### Runtime / tab state

- 修：tab 切换时 model / effort 显示错乱
  - 每个 tab 独立保存 `modelProvider` / `modelId` / `thinkingLevel`
  - 切 tab 只重绘 footer，不下发 `setModel` / `setThinkingLevel`
  - 首次打开插件时从 persisted tabs 恢复 model / effort
- 修：model / effort 弹窗选中项不再使用全局 settings，而是使用当前 active tab 的保存值
- 修：queue 状态（`1 2` 图标）切 tab 后残留
  - 每个 tab 独立保存 `queueCount`
  - 非当前 tab 的 queue 事件只记录状态，不污染当前 UI
  - 切换 tab 时按当前 tab 状态重绘 statusBar

### Conversation UI

- 改：默认开启“显示思考过程”（`showThinking: true`），保留历史 thinking 块可见
- 新：当前会话在历史列表中加高亮标识
  - 紫色竖线
  - `message-square-dot` 图标
  - `Current session` 副标题
  - 位置保持原时间排序，不置顶
- 优：对话区区分 user / assistant
  - user 使用气泡 + 紫色左边 + 右对齐
  - assistant 使用透明通栏 + 灰色细线
  - 隐藏 user 的 `You` 标签
  - assistant 保留 `π Pi` 标签

### Context guard cleanup

- 删：`buildRecentContextGuard()` 不再发送 `<recent_context_guard>` 给后端，避免污染 session 历史
- 新：`stripRecentContextGuard()` 兼容旧历史中的残留显示 / 复制 / 复用

---

## 📦 v1.0.22 (2026-06-08)

- 修：恢复 model popup 中 provider 图标的 brand 色
- 修：queue 清空时 status 没有回到 Ready（per-tab queueCount 跟踪）
- 优：直接读历史 jsonl 文件代替 RPC `get_messages`，大幅提升 5MB+ session 加载速度
- 清：清理 review warnings（safe review / Obsidian scan）
- 修：minAppVersion 兼容的 settings 按钮

## 📦 v1.0.16 (2026-06)

- 修：Obsidian marketplace 自动化 review 反馈的若干问题
- 修：发布版本号去掉 v 前缀（`1.0.16`，不是 `v1.0.16`）

## 📦 v1.0.14

- 新：4 个消息导航按钮（first / prev / next / last），按用户消息维度跳转
- 优：Pi 启动后 `refreshStateDisplay` / `loadAvailableCommands` 改为并行，UI 响应更快
- 修：消息导航按钮的滚动定位改用 `getBoundingClientRect()`，在复杂布局下更稳

## 📦 v1.0.13

- 删：YOLO / Safe Mode 开关（Pi 始终以完整工具集启动，含 git/snapshot 安全网）
- 文档：新增 Security & Permissions 章节，说明 `fs` 与 `child_process` 用途

## 📦 v1.0.12

- 优：Token Usage 弹窗加宽到 `1400px` / `95vw`，单页可看完整统计

## 📦 v1.0.11

- 修：description 文案适配 Obsidian 自动化 review

## 📦 v1.0.10

- 改：从 `Pisidian` 重命名为 `Pimate`（marketplace 校验拒绝 `sidian` 子串）

## 📦 v1.0.9

- 新：More 菜单支持多选
- 优：'current open note' 标签更清晰

## 📦 v1.0.8 (initial release)

- 基础：聊天视图、Pi RPC client、settings、ribbon 图标
- 基础：Pi spawn、OAuth / device-code、history 面板
- 基础：compaction、streaming、inline edit、snippets、`@` mention
- 基础：Token Usage 弹窗
