# Pimate 功能补齐清单（按优先级）

目标：复刻 Claudian 的核心 Obsidian 代理体验，但后端保持 Pi RPC，不做 Claude/Codex/OpenCode 多 runtime、MCP Server 管理、Subagents。

## P0 已完成 / 基础可用

- [x] Pi RPC 子进程集成
- [x] 流式消息渲染
- [x] 工具调用流 UI
- [x] Bash `!` 模式
- [x] Commands / Skills 面板
- [x] 模型选择
- [x] Safe / Full 工具模式
- [x] 多 session tabs 初版
- [x] 文件 context chips
- [x] selection context chips
- [x] 图片粘贴到输入框并随 prompt 发送
- [x] Inline Edit 当前选区初版
- [x] 插入最后回复到当前笔记
- [x] context usage 百分比显示

## P1 下一步必须做

1. **Inline Edit 完善**
   - [ ] 流式预览 replacement
   - [x] Apply / Reject 二次确认
   - [x] Regenerate 重新生成
   - [x] Apply 前手动编辑 replacement
   - [x] 保留选区范围，避免用户切换焦点后替错位置

2. **Diff Viewer**
   - [x] 点击 Edit/Write 工具行展开 unified diff
   - [x] 文件路径点击打开
   - [x] 增删统计与具体 patch 对齐
   - [x] diff 红绿高亮
   - [x] Copy diff

3. **真实 History / Resume / Fork**
   - [x] 接 Pi RPC `get_fork_messages`
   - [x] 接 Pi RPC `fork`
   - [x] 接 Pi RPC `clone`
   - [x] Resume 会话列表 / switch_session 面板
   - [x] Resume 删除 session
   - [x] 尝试读取 session 名称/标题

4. **Context chips 完善**
   - [x] 图片缩略图预览
   - [x] 拖拽文件/图片到输入框
   - [x] 当前笔记 chip
   - [x] 选区 chip 点击预览全文

## P2 体验增强

5. **工具调用展开/折叠**
   - [x] Bash 输出可展开/折叠
   - [x] Read/Grep/Find/工具输出可展开
   - [x] 错误状态更清楚

6. **Permission confirmation**
   - [x] Pi RPC confirm 改为 Obsidian 内确认弹窗
   - [x] Full 模式下 write/edit/危险 bash 工具运行提示
   - [-] 真正的工具执行前拦截确认：暂不做
   - [x] 手动 Bash `!` 危险命令拦截
   - [ ] 记住本次会话允许规则

7. **自动标题 / Tab 持久化**
   - [x] tab 名称从首条用户消息生成
   - [x] Obsidian 重启后恢复 tabs

8. **快捷键 / 命令对齐**
   - [x] 新 tab 命令
   - [x] 关闭 tab
   - [x] 聚焦输入框命令
   - [x] Fork / Clone 命令
   - [x] 打开 Commands / Skills

## P3 可选功能

9. **自定义 system prompt / snippets**
   - [x] 设置页添加 system prompt
   - [x] snippets 管理
   - [x] snippets 从 More 菜单插入输入框
   - [x] snippets 变量：{{selection}}, {{current_file}}, {{current_title}}, {{date}}
   - [x] snippets 命名/分组：Title::Prompt、Group/Title::Prompt

10. **快捷键/导航**
   - [x] 输入框 Ctrl/Cmd+K 打开 Commands / Skills
   - [x] 输入框 Ctrl/Cmd+N 新建会话
   - [x] 输入框 Esc 停止生成
   - [x] 消息上下跳转
   - [x] 工具块展开/折叠快捷键
   - [x] 跳到最后一次 diff

## 明确不做

- [ ] Claude/Codex/OpenCode 多 provider runtime
- [ ] Claudian MCP Servers 管理
- [ ] Claudian Subagents
