# pi-extensions

Personal [pi](https://github.com/earendil-works/pi) extensions.

## 扩展列表

| 扩展 | 说明 |
|------|------|
| handoff | 按目标提取当前会话关键上下文，生成可编辑的提示词并开新会话。相比 compact：针对性强、可审阅、父会话保留可回溯；交接单聚焦未完成状态与下一步，生成语言跟随目标。`/handoff`（无参）弹目标编辑框，回车执行；每次生成静默存档到 `.pi/handoffs/`（front matter 记目标/标题/时间/来源会话/模型），审阅取消即留档；`/handoff list` 打开草案选择器（输入即过滤 + 元信息面板，Enter 弹 Load / Edit / Delete，**左方向键退回上一级**，删除确认默认焦点在 Cancel，Esc 整体退出）；新会话自动命名（生成末尾的 `Title:` 行，严格约束单行 ≤60 字符，goal 兜底） |
| rules | RULES.md 恒真规则管理器：`/rules show` `/rules init` `/rules reload`；`@import` 精细导入（单文件 / `#标题` / glob / 递归 5 层 / 防环去重），`@import-if` 条件导入（os: 平台 / env: 变量 / env: 变量=值 / has: 路径存在，`!` 取反，不满足静默跳过记为 [skip]），项目 RULES.md 从工作目录向上逐级查找（全部生效，就近优先），`@rules` 可配置参数，`&lt;!-- --&gt;` 注释剥离，结果注入 system prompt；TUI 下 `show` 以可折叠规则树展示（↑↓ 选择，← 折叠 / → 展开 / Enter 切换，叶子为具体规则行，imports / Settings / Diagnostics 默认折叠） |
| checkpoint | git 存档点：`/checkpoint <msg>` 快照、`/restore <id|latest>` 只还原快照涉及文件（不碰无关改动）、`drop` 清理；冲突保护（你之后改过的文件需 `--force`）；还原前自动存 pre-restore 档可反悔；每轮对话自动存档（保留最近 20 个）；会话不在仓库内时 `checkpoint_list` / `checkpoint_restore` 可用 `repo` 参数指定仓库；`promptSnippet`（Available tools 各一行）+ `promptGuidelines`（改动前建议存档 / 失败后 restore / 先 list 再选 id 等三条）接入系统提示词，引导模型主动调用 |
| skim | 代码大纲工具（对 agent 的"目录页"）：符号 + 行号 + 行数跨度 + 一句注释（无注释时取签名），TS re-export（`export { } from` / `export * from` / `export * as ns from`）识别，git 未提交改动自动标 `[changed +N/-M]`，低置信度大纲显式标注防误导，`--read <symbol|行号>` 直达精读，目录模式入口文件优先（depth 越界目录折叠为 `dir/` 条目），支持 glob / filter / json / 按 mtime 缓存；TS / MD / JSON / Python / Go / Rust / Shell 语言支持；`promptSnippet`（Available tools 一行）+ `promptGuidelines`（读大文件前先 skim 等三条）接入系统提示词，引导模型主动调用 |

## 安装

作为 pi package 安装：

```bash
# 本地路径
pi install /path/to/pi-extensions

# git 仓库
pi install git:github.com/caikiji/pi-extensions@main

# 仅安装到项目
pi install -l git:github.com/caikiji/pi-extensions@main
```

临时测试单个扩展：

```bash
pi -e ./extensions/handoff.ts
pi -e ./extensions/rules.ts
```

## 测试

一键跑 `tests/` 下所有 `*.test.mjs`（每个测试独立子进程，互不干扰）：

```bash
npm test
# 或直接：
node tests/run-all.mjs
# 按文件名过滤：
node tests/run-all.mjs rules
```

## 开发：类型检查

`npm test` 用 Node 原生类型剥离直接跑，不需要 node_modules；tsconfig 只服务于编辑器/tsc 的静态检查。扩展里的 `@earendil-works/*` / `typebox` 在运行时由 pi 自身的加载器解析（jiti alias / virtual modules），不走 node_modules；类型层面由 package.json 的 peerDependencies / devDependencies 声明（npm 7+ 自动安装 peer）。

需要完整 IDE 类型提示或 `tsc --noEmit` 时，装一次依赖即可（node_modules 已 gitignore，不提交）：

```bash
npm install
```

之后 `moduleResolution: NodeNext` 走标准 node_modules 查找，`@earendil-works/*` 和 `typebox` 全部可解析，无需任何机器相关的 `paths` 配置。
