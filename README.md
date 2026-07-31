# pi-extensions

Personal [pi](https://github.com/earendil-works/pi) extensions.

## 扩展列表

| 扩展 | 说明 |
|------|------|
| handoff | 按目标提取当前会话关键上下文，生成可编辑的提示词并开新会话。相比 compact：针对性强、可审阅、父会话保留可回溯；交接单聚焦未完成状态与下一步，生成语言跟随目标 |
| rules | RULES.md 恒真规则管理器：`/rules show` `/rules init` `/rules reload`；`@import` 精细导入（单文件 / `#标题` / glob / 递归 5 层 / 防环去重），`@rules` 可配置参数，`&lt;!-- --&gt;` 注释剥离，结果注入 system prompt；TUI 下 `show` 以可滚动窗口展示报告 |
| skim | 代码大纲工具（对 agent 的"目录页"）：符号 + 行号 + 行数跨度 + 一句注释，`--read <symbol|行号>` 直达精读，目录模式入口文件优先，支持 glob / filter / json / 按 mtime 缓存；TS / MD / JSON / Python / Go / Rust / Shell 语言支持 |

## 安装

作为 pi package 安装：

```bash
# 本地路径
pi install /path/to/pi-extensions

# git 仓库
pi install git:github.com/caikiji/pi-extensions

# 仅安装到项目
pi install -l git:github.com/caikiji/pi-extensions
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
