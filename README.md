# pi-extensions

Personal [pi](https://github.com/earendil-works/pi) extensions.

## 扩展列表

| 扩展 | 说明 |
|------|------|
| handoff | 提取会话上下文生成提示词开新会话；`/handoff` 生成，`/handoff list` 管理草稿 |
| rules | RULES.md 规则管理器：`/rules show\|init\|reload`、`@import` / `@import-if` 导入、注入 system prompt |

## 安装

```bash
pi install /path/to/pi-extensions                  # 本地路径
pi install git:github.com/caikiji/pi-extensions@main  # git 仓库
pi install -l git:github.com/caikiji/pi-extensions@main  # 仅项目
```

临时测试单个扩展：`pi -e ./extensions/handoff.ts`

## 测试

```bash
npm test                      # 跑 tests/*.test.mjs，各测试独立子进程
node tests/run-all.mjs rules  # 或直接跑，支持按文件名过滤
```

`npm test` 用 Node 原生类型剥离直接跑，无需 node_modules。

## 开发：类型检查

扩展里的 `@earendil-works/*` / `typebox` 运行时由 pi 加载器解析，不走 node_modules。需要 IDE 类型提示或 `tsc --noEmit` 时执行一次 `npm install`（node_modules 已 gitignore，不提交）。
