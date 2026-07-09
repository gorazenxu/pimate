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

## 📦 v1.0.42 (unreleased)

- 新：智能审核（Smart Review）—— Agent 长任务自检与自动继续
  - 设置页新增开关 + 最大自动继续次数（1-10，默认 3）；footer 栏「审/Review」按钮一键切换
  - `message_end` 后插件用规则自检最后一条 assistant 文本：done markers（已完成/测试通过/LGTM 等）放行；continue markers（未完成/我将/还需要/failed 等）触发自动继续
  - `getSmartReviewPrompt()` 在 system prompt 注入「完成后请明确回复 Done」指令
  - `buildSmartReviewContinuePrompt()` 构造续接指令：提醒原始目标 + 要求立刻执行而非复述
  - 最多自动继续 N 轮后停止，中止时清空状态；`abort()` 时也重置
  - 中英文 prompt 模板

---

## 📦 v1.0.41 (unreleased)

- 优：@ 提及弹窗改为评分排序
  - 引入 `MentionEntry` 统一类型（替代之前 `TFile[] as any`）
  - `scoreMentionMatch`：精确 1000 / 名前缀 800 / 路径前缀 700 / 名字包含 600 / 路径包含 400
  - 加分：当前打开文件 +100、文件夹 +20
  - 二级排序：分数 → 路径短优先 → 字典序
  - 结果数 12 → 20
  - 文件项新增完整路径副标题（文件夹不显示避免重复）
  - 入口 `insertMentionSelection` 显式 narrow `entry.file` / `entry.folder`，去除 `!` non-null 断言

---

## 📦 v1.0.40 (unreleased)

- 优：Token Usage 统计加入增量缓存
  - 拆 `scanUsageRange` 为 `scanUsageIncremental` + `aggregateUsage`：先按文件 mtime/size 复用缓存，只解析新增行；按时间范围过滤在内存里做
  - 缓存写到 `~/.pi/agent/usage-cache.json`，按文件记录 `processedLines`，下次启动接着追加；文件截断/轮转（size 变小）触发全量重建
  - 删除过的 session 文件不清理 records（历史保留参与统计）
  - 切时间预设只调 `render()`，避免重复扫盘

---

## 📦 v1.0.39 (unreleased)

- 修：思考过程状态丢失与显示缺陷
  - **症状**：切换 Tab 或热切换历史会话后，支持 thinking 的模型（如 MiniMax-M3）思考状态莫名变回 `off`；流式思考过程默认折叠收起不可见
  - **根因**：
    - `ensureTabClient` 在 Tab 进程已运行时直接 return，跳过 preferences 对齐，导致切换后前后端状态脱节
    - `switchSession` 成功后未重新灌入 preferences，后端重放历史后状态变默认值
    - `thinking_start` 写死 `is-collapsed` 类名，CSS 默认 `display: none`，流式过程被隐藏
  - **修法**：
    - `ensureTabClient` 快速返回前先调用 `applyTabRuntimePreferences(tab)` 强对齐
    - `switchSession` 成功后立即 `applyTabRuntimePreferences(active)` 覆盖重放后的默认状态
    - `thinking_start` 移除 `is-collapsed` → 默认展开流式思维
    - `thinking_end` 自动添加 `is-collapsed` → 正文输出时自动折叠
    - 顺手：`persistSessionTabs` 简化过滤（不再要求必须持久化有值的 tab）；`onClose` 清理所有 timer 防泄漏

---

## 📦 v1.0.38 (unreleased)

- 修：添加内置 provider 后焦点跳到自定义 model 列表最后一个 input
  - 原因：`containerEl.querySelectorAll("input[type='password']")` 拿到所有 tab 里的密码框，`.at(-1)` 选中页面上**最后一个**
  - 自定义 provider 区在内置区之后，它的 password input 被误中
  - 修：记录刚添加的 id `justAddedBuiltinId`，渲染时给该行 `settingEl` 加 `data-just-added="true"` 标记，display() 后用该选择器精确定位
  - 兑底：若该 provider 是 OAuth（无 password input），focus 到行内任意 input
- 修：MiniMax 国内 provider 的 env 映射错误导致模型 picker 出现国际 MINIMAX
  - Pi 官方映射是 `minimax -> MINIMAX_API_KEY`、`minimax-cn -> MINIMAX_CN_API_KEY`
  - Pimate 原来把 `minimax-cn` 也映射到 `MINIMAX_API_KEY`，使 Pi 子进程误判国际 `minimax` 已配置
  - 改为 `minimax-cn -> MINIMAX_CN_API_KEY`，对齐 pi-web / pi-ai 行为
- 修：显示思考过程开关默认开启但更新后需手动关开一次才生效
  - 加载配置时规范化 `showThinking`：只有明确保存为 `false` 才关闭，其余缺省/旧值都按开启
  - 设置页切换后通知已打开的 Pimate 视图刷新当前会话消息，避免 UI 状态与聊天渲染不同步

---

## 📦 v1.0.37 (unreleased)

- 配：加 commit message 模板 `.gitmessage`
  - 规范：subject 限定 50 字内、type 前缀（新/修/改/配/样式/清/文档）、body 多行 bullet 列明改了什么
  - 已 `git config commit.template .gitmessage`，以后 `git commit` 不带 -m 会进编辑器带模板
  - 后续 commit 都按多段 body 写
- 配：加 Issue 模板 + README 反馈段
  - `.github/ISSUE_TEMPLATE/bug.md` / `feature.md` / `config.yml`
  - bug 模板：复现步骤 / 预期 / 实际 / 环境（插件 / Obsidian / Pi / 模型） / DevTools console log / 截图
  - config.yml 关闭空 issue、加 contact_links 指向 Pi / Obsidian 插件文档避免噪音
  - README 补 "Reporting Issues" 段，列出反馈前要准备的 6 项信息
- 修：选项 chip 解析器过于激进
  - 原 `parseOptionsFromMessage` 把 `[-*•]` 开头的普通 bullet 也当选项，回复里随手列点就跳出"快速选项"
  - 收紧 regex：只识别显式编号（`1.` / `2)` / `a.` / `一、` 等）
  - 跟踪块位置，限制为「最后一个块」后面**紧跟**的下一行必须是问题
  - 问题须以 `?` / `？` 结尾或含"选哪个"类
  - 排除 `要...吗` yes/no 模式

---

---

## 📦 v1.0.36 (unreleased)

- 改：凭证配置区全面重构 —— 以「内置 vs 自定义」两栏区分
  - 新增 `BUILTIN_PROVIDERS` 清单（与 `pi-ai` env-api-keys 对齐），覆盖 Anthropic / OpenAI / Google / Groq / xAI / OpenRouter / Mistral / Together / Fireworks / NVIDIA / DeepSeek / Z.ai / Kimi / Moonshot / Xiaomi 等 19+ provider
  - 「添加服务商凭证」下拉拆成两栏：栏 1 内置（配 key 即用，含 OAuth），栏 2 自定义（来自 `models.json`）
  - 「默认服务商」下拉动态化：内置 ∪ 自定义，供用户一键切到自己的 zhipu / volcengine-ark 等
  - 新增「自定义 Provider 向导」Modal（`pi-agent-wizard-modal`）：表单输入 provider id / 名称 / baseUrl / API key / 模型列表（多条目），确认后写入 `models.json`
  - 凭证行下展开 `pi-agent-custom-model-list`：列出当前 provider 在 models.json 里实际配置的模型 id（`pi-agent-custom-model-id` / `-name` / `-tag` 样式）
- 配：新增 `sync-plugin.sh` 同步脚本
  - 源仓 `obsidian-pi-agent/` 根目录下的 helper：跑 `npm run build` 后 `cp` 到 vault 插件目录，再用 md5 校验一致性
  - 避免手动 `cp` 遗漏
- 样式：`styles.css` 新增 72 行，自定义 provider 凭证行 + 向导 modal 专用样式
- 修：选项 chip 解析器过于激进
  - 原 `parseOptionsFromMessage` 把 `[-*•]` 开头的普通 bullet 也当选项，回复里随手列点就跳出"快速选项"，给用户造成困扰
  - 收紧 regex：只识别显式编号（`1.` / `2)` / `a.` / `一、` 等）
  - `asksQuestion` 由软标签改为硬性条件：必须含 `?` / `吗` / `请选择`，否则不渲染 chip
  - 保留了 AI 真问"选 A/B/C？"的场景
- 修：选项 chip 仍有误判（`要 commit 吗？` 也会跳）—— 进一步收紧
  - 跟踪每个选项块的位置，限制为「最后一个块」后面**紧跟**的下一行必须是问题
  - 如果列表后还有其他段落 / 表格 / 列表，就不是问选哪个
  - 问题需是「选哪个」式：必须以 `?` / `？` 结尾，或含 `请选择` / `选哪个` / `choose` / `pick` / `select`
  - 排除 `要...吗` yes/no 模式：这种是「是/否」问句，不是选项选择

---

## 📦 v1.0.35

- 新：在设置面板添加"智谱 (Zhipu GLM)"服务商
  - 三个下拉（默认服务商 / 添加服务商 / 自动检测默认模型）都加上 `zhipu`
  - `providerDefaults` 默认模型 `glm-5.2`（Z.ai 最新旗舰，1M 上下文）
  - 国内版端点 `https://open.bigmodel.cn/api/coding/paas/v4`（GLM Coding Plan 专属端点，OpenAI 兼容，`compat.thinkingFormat: deepseek`）
  - 列出 `glm-5.2`（后续精简为只列 `glm-5.2`）
  - 新增 `pi-agent-icon-zhipu` 图标 + 映射规则（按 `zhipu` / `智谱` / `glm` 匹配）

- 修：zhipu 等自定义 provider "面板已配置但实际调不通" —— 打通凭证注入链路
  - 根因：面板填的 key 存 `~/.pi/agent/auth.json`，但 `createClient()` 传的是全局 `settings.apiKey`（非 provider 专属），且 `PiAgentClient` 的 env `keyMap` 不含 zhipu，导致 pi 后端 models.json 的 `$ZHIPU_API_KEY` 解析失败、provider 不可用
  - `PiAgentView.createClient()`：`apiKey` 改为按当前 provider 从 auth.json 读（新增 `readProviderApiKey()`，与 `PiAgentSettings.readApiKey` 同源），回退 `settings.apiKey`
  - `PiAgentClient` env `keyMap` 补 minimax / minimax-cn / siliconflow / zhipu，按 provider 注入对应环境变量
  - 受益：所有在 models.json 用 `$XXX_API_KEY` 鉴权的自定义 provider，面板填 key 即生效，不再依赖单独设系统环境变量

- 修：Pimate 渲染带编号/列表项的 AI 回复时崩溃 —— `parseOptionsFromMessage` 捕获组索引笔误
  - 现象：AI 回复含 `1. xxx` / `a. xxx` / `- xxx` 等列表项时，控制台报 `Cannot read properties of undefined (reading 'trim')`，该条消息渲染异常
  - 根因：正则 `^(?:...)\s+(.+)$` 中 `(?:...)` 是非捕获组，唯一捕获组（选项文本）对应 `m[1]`，但代码写了 `m[2].trim()` —— `m[2]` 恒为 undefined
  - 修复：`m[2]` → `m[1]`（`PiAgentView.ts parseOptionsFromMessage`）

- 修：zhipu（智谱 GLM）端点配错 → GLM Coding Plan 套餐不生效、报 429 余额不足
  - 根因：models.json 里 zhipu `baseUrl` 用了通用端点 `https://open.bigmodel.cn/api/paas/v4`；GLM Coding Plan 必须用专属端点 `https://open.bigmodel.cn/api/coding/paas/v4`，用错会按量扣费、套餐不抵扣 → 账户余额耗尽 → 429
  - 证据：智谱官方文档 `docs.bigmodel.cn/cn/coding-plan/quick-start`「需配置专属 Coding API 端点 `/api/coding/paas/v4` 而非通用端点」；官方 FAQ「报余额不足/扣账号余额是未满足套餐使用条件」
  - 修复：models.json zhipu `baseUrl` → `…/api/coding/paas/v4`
  - 同步：`PiAgentSettings.ts` zhipu hint 更新端点说明（提示通用端点会按量扣费报 429）

---

## 📦 v1.0.34 (unreleased)

- 清：从设置面板的下拉 / 默认值列表 / 自动检测列表里移除"火山引擎 / 豆包 (volcengine)"选项
  - Pi Coding Agent 后端并没有 `volcengine` 这个内置 provider，配置后实际不可用
  - 仅保留 icon 注册名（PiAgentView 里 provider 图标映射），不影响功能
- 新：凭证配置区底部增加提示，引导用户通过 Pimate 对话接入列表外模型
  - "💡 需要接入其他模型？" 提示行，告知可通过已配置的模型提供商与 Pimate 对话让 AI 帮完成接入

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
