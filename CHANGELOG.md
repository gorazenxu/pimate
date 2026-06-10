# Pimate Changelog

开发日志 / 变更记录。

- 🛠 **Working / Uncommitted** — 当前 working tree 有但还没 commit 的修改
- 📦 **Released** — 已经发版的版本，每个版本下列出本次发版的修改项

每次改代码时，往 🛠 Working 加一条；
commit 时把对应条目挪到对应版本的 📦 Released 下。

---

## 🛠 Working / Uncommitted

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
