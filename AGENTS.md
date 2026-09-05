# Pimate 项目规则

这份文件是 Pimate 的编码和发布检查清单，适用于后续人工或 Agent 修改代码。

## Obsidian 审核红线

### 动态样式

- 禁止在 TypeScript 源码中直接赋值 `element.style.*` 或整体写入 `style` 属性。
- 动态样式使用 Obsidian 推荐的 `setCssProps()` / `setCssStyles()`；状态切换优先使用 CSS class 和 `toggleClass()`。
- 发布前执行以下检查，结果应为空（生成的 `main.js` 不作为源码检查对象）：

  ```bash
  rg -n '(\.style\.[A-Za-z]|setAttribute\([^)]*style)' --glob '*.ts' .
  ```

### 外部能力与数据边界

- 不新增读取主机名、用户信息、网卡信息或身份相关环境变量的逻辑；确有必要时必须说明目的并最小化读取范围。
- `fs` 和 `child_process` 仅用于 Pi/AGY 集成所需的窄范围操作。命令、路径和超时必须经过边界校验，不得借错误处理偷偷改写用户文件或切换到其他应用执行。
- 读取 Vault 文件、枚举 Vault、访问剪贴板时，必须有明确的产品功能需要，并限定在当前 Vault/当前操作范围内；避免静默收集与任务无关的数据。

### CSS 与性能

- 大范围列表和消息流中避免使用 `:has`；优先使用明确的状态 class，减少选择器失效范围。
- 工具调用、思考内容等高频 UI 更新应复用已有节点，避免不必要的整棵 DOM 重建。

## 发布前检查

每次发布前至少执行：

```bash
npm run build
node --test tests/*.test.mjs
git diff --check
```

另外确认：

- `manifest.json`、`versions.json`、`package.json` 的版本号一致。
- 发布包中的 `main.js`、`styles.css` 与当前源码构建结果一致。
- 不把真实 Vault 内容、个人信息或本地绝对路径放入 README、SVG、截图和示例数据。
- 若 Obsidian Community 审核页面出现 Error，先修复 Error，再处理 Warning/Recommendation；发布新版本，不覆盖已发布版本。

## 1.1.3 审核记录

1.1.3（commit `c115d3b`）的审核中，发布制品、网络请求、依赖安全和构建复现均通过。源码唯一明确的阻断错误是 `obsidianmd/no-static-styles-assignment`，涉及设置页和引擎选择器的直接样式赋值；后续代码统一遵守本文件的动态样式规则。

审核同时提示了系统身份读取、直接文件系统访问、Shell 执行、Vault 枚举和剪贴板访问。这些是当前集成功能的审查边界，不代表可以继续扩大权限；任何新增或扩大范围的使用都要单独评估。
