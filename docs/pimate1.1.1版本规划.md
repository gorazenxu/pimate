# Pimate v1.1.1 版本规划：双引擎（Pi + Antigravity CLI）架构演进设计稿

> **版本定位**：将 Pimate 从单一的 Pi 专用客户端，升级为支持 **双 Agent 引擎（Pi Coding Agent + Antigravity CLI）** 的 Obsidian AI 生产力工作台。

---

## 目录
1. [版本背景与核心目标](#一-版本背景与核心目标)
2. [技术可行性与官方协议实测结论](#二-技术可行性与官方协议实测结论)
3. [系统总体架构设计](#三-系统总体架构设计)
4. [设置页设计规划（Settings UX）](#四-设置页设计规划settings-ux)
5. [聊天交互与引擎切换体验](#五-聊天交互与引擎切换体验)
6. [分阶段落地实施路线](#六-分阶段落地实施路线)

---

## 一、 版本背景与核心目标

### 1. 现状与痛点
- **现状**：当前 Pimate 深度绑定单一后端 `Pi Coding Agent`（`@earendil-works/pi-coding-agent`），通过私有 RPC 运行。
- **痛点**：
  - 用户调用 Google Gemini 等高端模型时，必须自行申请并配置 API Key，无法直接复用已登录的 Google 账号体系。
  - 用户无法直接借助 Google 官方生态专为自主编程打造的 **Antigravity CLI (`agy`)** 终端引擎与原生工具链。

### 2. v1.1.1 核心目标
1. **双引擎自由切换**：用户可在界面中无缝选择由 **Pi** 还是 **Antigravity** 驱动当前会话。
2. **零配置 / Google OAuth 免密认证**：Antigravity 引擎直接复用系统终端已有的 Google OAuth 授权态，无需用户手动寻找或填入 API Key。
3. **保护现有生态**：Pi 的现有功能（如 models.json 自定义 Provider、分叉树、Device Code 登录、技能管理等）100% 完整保留，平滑升级无破坏性变更。

---

## 二、 技术可行性与官方协议实测结论

通过对官方文档调研、本地安装最新 Antigravity CLI（v1.1.22）及流式抓包，技术可行性已 100% 验证通过：

### 1. 通信协议完全同构（NDJSON Stream）
`agy` 官方原生支持非交互式与管道流式协议：
- `--input-format stream-json`：通过标准输入（stdin）逐行传入 NDJSON 消息驱动交互。
- `--output-format stream-json`：通过标准输出（stdout）逐行吐出结构化 NDJSON 事件。
- `--dangerously-skip-permissions`：外部应用调用时自动批准文件编辑与命令执行权限，防止后台被终端弹窗阻塞。
- `--effort <low|medium|high>`：原生支持与 Pimate 界面完全匹配的思考强度档位。

### 2. 事件捕获与字段对齐
实测抓包确认，`agy` 的事件流与 Pimate UI 所需渲染数据高度吻合：

| 官方事件类型 | 关键数据字段 | 对应 Pimate 前端处理 |
| :--- | :--- | :--- |
| **`init`** | `conversation_id`, `tools`, `cwd` | 会话初始化绑定、工具能力检测 |
| **`step_update (agent_response)`** | `text_delta` (增量文本) | 聊天气泡打字机流式追加 |
| **`step_update (tool)`** | `tool_name`, `tool_info.parameters`, `tool_info.output` | 渲染可折叠工具调用卡片与执行结果 |
| **`step_update (done)`** | `usage: {input_tokens, output_tokens, thinking_tokens}` | 耗时与 Token 统计，折叠思考时长 |
| **`result`** | `status: "SUCCESS"`, `num_turns` | 回合结束，重置按钮状态为 Ready |

### 3. 登录与凭据机制
- `agy` 使用系统级 Google OAuth 登录，用户仅需在系统终端执行一次 `agy` 并在浏览器完成授权，凭证即保存在本地（如 `~/.gemini/`）。
- 插件启动子进程调用 `agy` 时，天然继承该认证态，完全无需插件层处理 OAuth 回调或存储敏感 Token。

---

## 三、 系统总体架构设计

采用 **微内核 + 适配器（Adapter Pattern）** 架构，将主界面与具体引擎解耦：

```
                    ┌─────────────────────────┐
                    │    Obsidian 聊天界面     │
                    │ (PiAgentView / Composer) │
                    └────────────┬────────────┘
                                 │
                   ┌─────────────┴─────────────┐
                   │    AgentClient 统一接口    │
                   │ (start, prompt, abort...) │
                   └──────┬─────────────┬──────┘
                          │             │
              ┌───────────┴───┐     ┌───┴───────────┐
              │  Pi Backend   │     │  AGY Backend  │
              │(PiAgentClient)│     │(AgyAgentClient│
              └───────┬───────┘     └───┬───────────┘
                      │                 │
              [pi --mode rpc]     [agy stream-json]
```

### 1. 通用 Agent 接口规范 (`AgentBackendClient`)
```typescript
export interface AgentBackendClient extends EventEmitter {
  start(): Promise<void>;
  destroy(): Promise<void>;
  isRunning(): boolean;
  prompt(text: string, options?: { images?: string[] }): Promise<void>;
  abort(): Promise<void>;
  
  // 统一输出事件：
  // 'text_delta'     (增量字符)
  // 'thinking_delta' (思考字符)
  // 'tool_start'     (工具调用触发)
  // 'tool_end'       (工具执行完毕)
  // 'settled'        (本轮回合完成)
  // 'error'          (执行异常)
}
```

### 2. 双客户端职责划分
- **`PiAgentClient.ts`**：维持现有逻辑不变，管理 `pi --mode rpc`，承载 Pi 的深度定制特性。
- **`AgyAgentClient.ts`（新增）**：封装 `child_process.spawn('agy', ...)`，解析 `stream-json` 行输出并派发给统一事件通道。

---

## 四、 设置页设计规划（Settings UX）

设置页采取 **“全局配置在上、双引擎独立分区、共享交互在下”** 的结构，既突出品质感，又避免不同引擎配置混乱。

```
┌────────────────────────────────────────────────────────┐
│  一、通用与引擎首选项 (General & Engine Preference)       │
│      - 界面语言 (Language: 中文 / English)              │
│      - 默认 Agent 引擎 (Default Engine: Antigravity / Pi)│
├────────────────────────────────────────────────────────┤
│  二、✦ Antigravity CLI 配置 (Google 账号免密生态)       │
│      - 认证与运行状态卡片 (动态检测已登录/未登录状态)   │
│      - agy 可执行路径 (默认 ~/.local/bin/agy)           │
│      - 默认模型选择 (gemini-2.5-flash / pro)           │
│      - 思考强度档位 (Effort: low / medium / high)       │
│      - 工具权限策略 (自动批准 / 提示确认)               │
├────────────────────────────────────────────────────────┤
│  三、π Pi Coding Agent 配置 (保留现有完整能力)          │
│      - Pi 可执行路径                                   │
│      - 内置 Provider 凭据 (Anthropic / OpenAI / DeepSeek)│
│      - OpenAI Codex Device Code 登录弹窗               │
│      - 自定义 Provider (models.json) 与添加向导        │
│      - 技能管理 (Skills)                                │
├────────────────────────────────────────────────────────┤
│  四、界面交互与提示词偏好 (Display & Prompts - 共享)   │
│      - 思考过程显示开关 (Show Thinking)                 │
│      - 流式打字机模式 (Auto / Pretty / Fast)            │
│      - 系统提示词前缀 (System Prompt)                   │
│      - 快捷提示词片段 (Snippets)                        │
└────────────────────────────────────────────────────────┘
```

### 详细交互说明：
1. **Antigravity 状态检测卡片**：
   - 插件打开设置页时，异步执行探针 `agy --version` 检测登录状态。
   - **已登录**：显示绿色徽章 `🟢 Google 账号已授权 (Authenticated)`。
   - **未登录**：显示黄色徽章 `🟡 未授权 Google 账号`，提供“复制登录命令”按钮（`agy`），提示用户仅需在系统终端运行一次完成网页登录。
2. **Pi 配置完整保留**：
   - 现有的 Anthropic、DeepSeek、MiniMax 以及 OpenAI Device Code 弹窗原封不动收纳在 Pi 分区，老用户完全无感知迁移。

---

## 五、 聊天交互与引擎切换体验

1. **Tab 级 / 会话级引擎标识**：
   - 在底部栏模型名称前，展示当前引擎图标：
     - `✦ Antigravity (gemini-2.5-pro)`
     - `π Pi Agent (Claude 3.5 Sonnet)`
2. **无缝引擎切换**：
   - 点击底部栏引擎标签，即可弹出切换菜单：
     - `切换到 Antigravity CLI`
     - `切换到 Pi Coding Agent`
   - 切换后该 Tab 后续对话即由目标引擎处理。
3. **统一的工具渲染**：
   - 无论底层是 `agy` 的 `list_dir` / `read_file`，还是 Pi 的 `read` / `bash`，前端统一以 Pimate 现有的精美折叠块与状态标签渲染。

---

## 六、 分阶段落地实施路线

遵循 **轻量渐进式（MVP）** 原则推进，最大程度降低系统耦合与引入 bug 的风险：

### 阶段 1：核心通信客户端实现（独立测试）
- [ ] 创建 `src/AgyAgentClient.ts`。
- [ ] 实现 `agy --output-format stream-json` 的子进程生命周期管理。
- [ ] 实现 NDJSON 行缓冲解析器，将官方 `step_update` 与 `result` 映射为标准流式事件。
- [ ] 编写独立单元测试/探针，确保输入输出稳定。

### 阶段 2：设置界面与状态感知
- [ ] 在 `PiAgentSettings.ts` 中加入设置项：`defaultEngine`、`agyPath`、`agyModel`、`agyEffort`。
- [ ] 增加 Antigravity 状态探测与登录指示徽章。
- [ ] 调整设置面板的分区分块布局。

### 阶段 3：UI 视图层双引擎适配
- [ ] 在 `PiAgentView.ts` 中增加引擎实例分发逻辑（根据当前 Tab 配置实例化 `PiAgentClient` 或 `AgyAgentClient`）。
- [ ] 底部模型栏支持展示当前引擎并支持快速切换。
- [ ] 适配 `abort`、流式打字与折叠工具卡片渲染。

### 阶段 4：联调与体验优化
- [ ] 测试跨 Vault 文件读取、编辑与多轮对话。
- [ ] 测试长时间任务流式打字机性能。
- [ ] 验证未登录提示与异常捕获。
