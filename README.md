# pi-extensions

Personal [pi](https://github.com/earendil-works/pi) extensions。

## 扩展列表

| 扩展 | 说明 |
|------|------|
| handoff | 按目标提取当前会话关键上下文，生成可编辑的提示词并开新会话（相比 compact：针对性强、可审阅、父会话保留可回溯）。基于官方 example 定制：交接单聚焦未完成状态与下一步、生成语言跟随目标（代码/文件名保持原文）、一次性生成请求隔离 provider 缓存、失败明确报错 |
| rules | RULES.md 恒真规则管理器：`/rules list | init | reload`，支持 `@import` 精细导入（单文件 / `#标题` section / `*` `**` `?` glob / 递归 5 层 / 防环去重）与 `@rules` 可配置参数（max_depth / max_glob_files / max_total_bytes），`<!-- -->` 注释剥离，展开结果注入 system prompt |

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
