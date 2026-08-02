<!-- ============================================================
  RULES.md — user-maintained ground truth for AI agents
  RULES.md —— 用户维护的恒真规则文件

  This file is authoritative and stable: it changes ONLY when you
  edit it. Agents must follow it; if a rule conflicts with the
  code they observe, they should ask you to clarify — never modify
  this file themselves.
  本文件权威且稳定：只在你主动修改时变更。Agent 必须遵守；
  若规则与代码现实冲突，应向用户求证，而不是自行修改本文件。

  Syntax / 语法（示例都在注释内，加载时剥离，不进提示词）：
    &lt;!-- comment --&gt;                HTML comment; stripped at load
                                          注释；加载时剥离，不进提示词
    @import docs/x.md                     import a whole file (path relative to THIS file's directory)
                                          导入整文件（路径相对本文件所在目录）
    @import docs/x.md#section             import one heading section (heading line included)
                                          只导入该标题的 section（含标题行）
    @import docs/*.md                     glob import: * = one level, ** = recursive, ? = one char
                                          glob 导入：* 单层、** 递归、? 单字符
    \@import literal                      escaped: shown literally, not expanded
                                          转义，原样显示、不展开
    @rules max_depth 5                    set limits (affects rest of this file + its imports):
                                          设置参数（影响本文件其余部分及其导入）
    @rules max_glob_files 50              max_depth / max_glob_files / max_total_bytes (b/kb/mb)
    @rules max_total_bytes 50kb           defaults: depth 5 · glob 50 files · 50 KB
                                          默认值：深度 5 · glob 50 个文件 · 总量 50 KB
    Imported files may import further (cycles detected, files deduped)
    被导入文件可继续导入（自动防环、按路径去重）
============================================================ -->

<!-- ===== Decisions & rationale (why, not how) ===== -->
<!-- ===== 决策与理由（为什么这么做，而不是怎么做） ===== -->

<!-- Example / 示例：
- Package manager is pnpm: workspace support is more reliable than npm
- 包管理用 pnpm：workspace 支持比 npm 更稳
-->

<!-- ===== Constraints & traps (not visible in the code) ===== -->
<!-- ===== 约束与陷阱（代码里看不出来的红线） ===== -->

<!-- Example / 示例：
- dist/ is generated output; never edit it by hand
- dist/ 是构建产物，永远不要手改
-->

<!-- ===== Intent (layout changes, intent does not) ===== -->
<!-- ===== 意图（布局会变，意图不会） ===== -->

<!-- Example / 示例：
- This repo's end goal is to be split into independent npm packages
- 本仓库的最终目标是拆成独立 npm 包
-->

<!-- ===== Imports (stable pointers to curated documents) ===== -->
<!-- ===== 导入（指向你选定维护的文档的稳定指针） ===== -->

<!-- Example / 示例：
@import docs/conventions.md
@import docs/architecture.md#data-flow
@import docs/patterns/*.md
-->

<!-- ============================================================
  以下是本项目的实际规则（注释以上是语法速查）
  Actual rules below — the comments above are the syntax cheat-sheet
============================================================ -->

## 决策与理由 (why, not how)

- 扩展用零第三方依赖单文件 TS：只允许 @earendil-works/*（pi 自带包，jiti alias 解析到 pi 安装目录）运行时 import；第三方 npm 包不建议（git package 里解析脆弱），确有必要时用动态 import 并 catch 降级；被 tests/*.test.mjs 直接 import 的 .ts 顶层不得静态 import pi 运行时包（纯 Node 解析不到），需要时用动态 import 或结构化组件
- 代码、注释、以及 agent 可见的输出（tool/command 返回文本、notify、错误消息）一律纯英文 ASCII：注释和输出是给 agent/代码看的；中文只允许出现在用户文档（模板/README/RULES.md）
- 测试放 tests/*.test.mjs，用 Node ≥22.18 原生类型剥离直接 import .ts：零 npm install 就能跑
- 新增扩展必须同时注册到 package.json 的 pi.extensions 和 README 表格

## 约束与陷阱 (not visible in the code)

- 扩展代码只用 erasable TS 语法（无 enum / namespace / 构造器参数属性）——否则 tests 直接 import .ts 会崩
- 动态 import("@earendil-works/pi-tui") 只在 TUI 命令路径执行；纯 Node 测试环境解析必败，必须 catch 降级（notify 错误提示），不能抛到 handler 外
- catch 降级只处理预期失败（非零退出码、ENOENT、动态 import 解析失败等）；代码自身的错误（ReferenceError / TypeError）不得被吞掉——降级路径要区分错误类型或记录原因，避免把 bug 伪装成正常降级
- 改了 rules.ts 必须跑 `npm test`（覆盖注释剥离/导入/防环/@rules/缓存/show 命令）
- 模板头注释内禁止出现字面 <!-- -->（CommonMark 在第一个 --> 截断，会泄漏到预览）——示例一律用 &lt;!-- 实体
- 不要把 tests/.work 提交进 git
- agent 可见文本（skim/checkpoint 等工具与 / 命令的返回、错误、notify）必须纯 ASCII：无中文，也不用 ├─ · … — 等非 ASCII 装饰符号（树形用 |-，分隔用 | 或 -）

- .pi/settings.json 是本仓库的自引用配置（打开项目自动加载 extensions/ 全部扩展），勿删；新增扩展放进 extensions/ 目录即自动生效，同时注册到 package.json 的 pi.extensions
- 提交的代码与配置文件不得含机器特定的绝对路径（用户目录、nvm、npm 全局安装目录、盘符等）；本机所需的机器相关配置（如 tsconfig 的 `paths`）只作为未提交的本地改动保留——由 `tests/portable.test.mjs` 机械检查

## 意图 (layout changes, intent does not)

- 保持"clone 即跑"：无构建步骤、无 npm install、任何机器可测
- 每个扩展解决一个具体痛点，不过度设计
- 本仓库是个人工具，但代码质量按开源标准

## 提交规范 (commit style)

- 提交信息一律英文（summary 和 body 都是）
- 格式：`type(scope): summary`，如 `feat(rules): add @rules directive`
- type 只用：feat / fix / refactor / docs / test / chore / style
- summary 用祈使句（Add / Fix / Update / Remove...），不超过 72 字符
- 一个提交只做一件事；`npm test` 和 `npm run lint` 都通过后才提交
- 不提交 tests/.work、node_modules 等运行时产物

## 版本号规则 (versioning)

- 提交前检查 package.json 的 version，需要 bump 时与改动同一提交推送
- feat → minor 递增（0.0.2 → 0.1.0）
- fix / refactor / style / test → patch 递增（0.0.2 → 0.0.3）
- docs / chore → 不改版本号（仅文档或杂务时无需 bump）
- 版本号只增不减；发布用 git tag 标记（如 v0.0.2）
