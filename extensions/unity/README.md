# unity — pi extension for Unity Editor integration

让 pi (coding agent) 能方便地**读取 Unity 日志**、**操控运行中的 Unity Editor**、**操作 Unity 项目文件**。

支持 Unity 2019.4 LTS 及之后所有版本(2020.3 / 2021.3 / 2022.3 / Unity 6)。

---

## 设计目标

Unity 开发者用 pi 时,agent 应该能:
1. **看懂 Unity 在干什么** — 读 Editor.log / AssetImportWorker 日志,提取编译错误、导入错误、异常
2. **操控运行中的 Unity** — 通过 PiBridge HTTP bridge 在已打开的 Editor 里执行命令(不用启动第二个实例)
3. **安全操作项目文件** — 读写 YAML/JSON 文本资产,绝不破坏 GUID 引用

核心原则:**单一执行路径** — 通过 PiBridge HTTP bridge 驱动**已打开的** Unity Editor 实例(不新开 batchmode 进程,避免冷启动与实例冲突)。

---

## 关键技术事实(已通过 Unity 官方文档核实)

### 日志定位
- **版本相关的默认位置**(2019.4 与 2021+ 不同):
  - **2019.4 / 2020.x**:默认写**全局** `Editor.log`
    - Windows: `%LOCALAPPDATA%\Unity\Editor\Editor.log`
    - macOS: `~/Library/Logs/Unity/Editor.log`
    - Linux: `~/.config/unity3d/Editor.log`
  - **2021.3+**:默认写**项目级** `<projectPath>/Logs/Editor.log`;全局需 `-useGlobalLog`
- 扩展策略:按版本选主路径,但**总是回退**另一路径(robust)
- `-logFile <path>` 指定自定义路径;`-logFile -` 重定向到 stdout(子进程可实时读)
- `Application.consoleLogPath` 在脚本内返回真实日志路径
- 相关日志:
  - `Logs/AssetImportWorker0.log` / `...Worker1.log`(并行导入,2022+)
  - `Logs/shadercompiler-AssetImportWorker0.log`
  - Player.log: `%USERPROFILE%\AppData\LocalLow\<Company>\<Product>\Player.log`
  - upm.log: `%LOCALAPPDATA%\Unity\Editor\upm.log`
  - Crash: `%TMP%\Unity\Editor\Crashes`
- 日志**追加写入,无滚动**,Windows 下运行时进程独占锁(可读不可覆盖)

### 日志格式(grep 友好)
- 编译错误:`Assets/Scripts/Foo.cs(12,17): error CS0103: ...`(单行,带 file(line,col))
- 运行时异常:`ExceptionType: message` + 多行堆栈
- 模块前缀:`[Compiler]` `[AssetImport]` `[PackageManager]` `[Assembly Updater]` `[Burst]`
- 时间戳:默认无,新版用 `-timestamps`,旧版用 `UNITY_EXT_LOGGING` 环境变量

### 可安全外部读写的文件
- **YAML 文本**(启用 Force Text 序列化):`.unity` `.prefab` `.asset` `.mat` `.anim` `ProjectSettings/*.asset`
- **JSON**:`.asmdef` `Packages/manifest.json`
- **绝不碰**:`Library/` `Temp/`(除清理 lockfile) `.csproj`/`.sln`(Unity 重新生成) `.meta` 的 GUID 字段

### ProjectSettings 字段位置(实测修正)
- **`scriptingBackend`**:在 `ProjectSettings/ProjectSettings.asset`,**按平台分**
  - 格式:`scriptingBackend:\n  Android: 1\n  Standalone: 0`,空 `{}` = 全平台默认 Mono
  - 枚举:0=Mono, 1=IL2CPP, 2=WinRT(已弃用)
- **`m_SerializationMode`**:在 `ProjectSettings/EditorSettings.asset`(**不是** ProjectSettings.asset!)
  - 枚举(源自 UnityCsReference `EditorSettings.bindings.cs`):0=Mixed, 1=ForceBinary, 2=ForceText
  - 文件/字段缺失 = Mixed(Unity 默认)

---

## 扩展架构

```
extensions/unity/
├── index.ts                    # 入口,注册 5 个 tool
├── package.json                # pi 扩展声明
├── PiBridge/                   # C# HTTP bridge(装到项目 Assets/Editor/ 用)
│   ├── PiBridge.cs             # 主类:HttpListener + 命令派发 + ExecuteCommand
│   ├── BridgeVersion.cs        # 版本号(单一来源,ping 校验)
│   ├── WindowFocus.cs          # Win32 聚焦逻辑(绕过失焦节流)
│   ├── Response.cs             # 响应结构
│   └── SimpleJson.cs           # 极简 JSON 序列化/解析
├── lib/
│   ├── paths.ts                # 项目根探测、日志路径定位、lockfile 检测
│   ├── project-version.ts      # 读 ProjectVersion.txt,版本比较
│   ├── editor-log.ts           # 日志读取(项目级/全局回退,Windows 独占锁处理)
│   ├── log-parser.ts           # 解析 CSxxxx 编译错误/异常/导入错误为结构化条目
│   ├── bridge-client.ts        # PiBridge HTTP 客户端(端口发现+版本校验+超时)
│   └── tool-utils.ts           # 共享 helper(项目根探测)
└── tools/
    ├── unity-log.ts            # tool: 读/解析 Unity 日志
    ├── unity-status.ts         # tool: 检测 Unity 运行/编译/导入状态
    ├── unity-project.ts        # tool: 读项目元信息(版本/asmdef/包)
    ├── unity-command.ts        # tool: 通过 PiBridge 操控运行中的 Editor
    └── unity-install-bridge.ts # tool: 自动安装 PiBridge.cs 到项目
```

---

## Tool 设计

### 0. `unity_command` — 操控运行中的 Unity(通过 PiBridge)
让 AI 在**已打开的** Unity Editor 里执行命令,不用启动第二个实例。

**前提**:项目 `Assets/Editor/` 下有 `PiBridge.cs`(见下文「PiBridge 安装」)。扩展会校验 bridge 版本,过旧时报错并提示用 `unity_install_bridge` 更新。

**参数**:
- `command`: `ping` | `config` | `refresh` | `compile` | `status` | `run-menu` | `asset-info` | `log` | `eval`
- `projectPath?`:项目根,默认 cwd 自动探测
- `args?`:命令参数对象(`run-menu` 需 `{ menuPath }`,`asset-info` 需 `{ path }`,`config` 需 `{ autoFocus }` 等)
- `timeout?`:秒,默认 60(`run-menu` 默认 15)

**流程**:
1. `bridge-client.ts` 读 `Temp/pi-bridge-port` 发现端口(回退探测 17841+)
2. `ping` 校验 bridge 版本 ≥ `MIN_BRIDGE_VERSION`,过旧则返回 `versionMismatch` 错误
3. HTTP POST `http://127.0.0.1:{port}/{command}`,body 是 args 的 JSON
4. PiBridge 后台线程收到 → `EditorApplication.delayCall` 派发主线程(失焦时先自动聚焦,见下)→ 执行 → 返回 JSON
5. 返回 `{ ok, result?, error?, durationMs }`

**失焦自动聚焦**(v0.2.0+):Editor 失焦时 `delayCall` 被节流到 ~1Hz,bridge 会在派发前用 Win32 `SetForegroundWindow` 把 Unity 置前(仅 Windows),让主循环全速。可用 `config { autoFocus: false }` 关闭。

**节流注意**:即使自动聚焦,触发 `compile`/`refresh` 后仍应轮询 `status` 直到 `isCompiling: false`。

**安全**:
- 只监听 `127.0.0.1`(不暴露局域网)
- 命令白名单,无任意代码执行
- `eval` 命令需在 Unity 启动前设 `PI_BRIDGE_ALLOW_EVAL=1` 环境变量

---

### 1. `unity_log` — 读取 Unity 日志
让 AI 看 Unity 在干什么。

**参数**:
- `projectPath?: string` — 默认 cwd
- `kind?: "editor" | "import" | "package" | "player" | "all"` — 默认 `editor`
- `filter?: "errors" | "warnings" | "compile" | "exceptions" | "all"` — 默认 `errors`
- `tail?: number` — 最后 N 行(默认 200)
- `since?: string` — ISO 时间戳,只看之后的内容

**流程**:
1. `paths.ts` 定位日志(项目级优先,全局回退)
2. 读文件(Windows 下用 share-read 绕过独占锁)
3. `log-parser.ts` 按 filter 提取,结构化为 `{severity, file, line, col, code, message, stack?}[]`
4. 返回 JSON + 可读文本

**返回示例**:
```json
{
  "logPath": "D:/MyGame/Logs/Editor.log",
  "entries": [
    {
      "severity": "error",
      "code": "CS0103",
      "file": "Assets/Scripts/Player.cs",
      "line": 12, "col": 17,
      "message": "The name 'foo' does not exist in the current context"
    }
  ]
}
```

### 2. `unity_status` — 检测 Unity 状态

### 3. `unity_project` — 读项目元信息
---

## PiBridge 安装(启用 unity_command 的前提)

`PiBridge.cs` 是一个 C# 文件,放在 Unity 项目的 `Assets/Editor/` 下,自动随项目加载启动一个 HTTP bridge,让外部进程(AI)能操控运行中的 Editor。

### 方式 A:用 `unity_install_bridge` 工具自动安装(推荐)

让 AI 调用 `unity_install_bridge` tool,传项目路径即可:
```
unity_install_bridge({ projectPath: "D:/workspace/MyUnityProject" })
```
工具会自动:把 `PiBridge.cs` 复制到 `<projectPath>/Assets/Editor/`(已存在则备份为 `.bak`)、确保目录存在、返回安装路径和后续步骤。若其他 unity 命令出错(版本不匹配/超时/连接错误),AI 会自动重装作为首选排查。

### 方式 B:手动安装
1. 把 `extensions/unity/PiBridge/` 目录下的所有 `.cs` 文件复制到你的 Unity 项目 `Assets/Editor/`(没有 `Editor` 文件夹就新建一个)
2. 在 Unity 里打开该项目(或如果已打开,等它自动编译)
3. 查看 Unity Console,应出现:`[PiBridge] Listening on http://127.0.0.1:17841`
4. 现在 AI 可以用 `unity_command` 了

### 版本校验

扩展和 PiBridge.cs **一起版本化**。扩展声明 `MIN_BRIDGE_VERSION`(当前 `0.2.0`),`ping` 时校验运行中的 bridge 版本。过旧则 `unity_command` 返回 `versionMismatch` 错误,提示用 `unity_install_bridge` 更新。升级扩展后,旧项目里的 PiBridge.cs 会被检测出来并引导更新。

### 工作原理
- `[InitializeOnLoad]` 静态构造函数在项目加载时启动 `HttpListener`(后台线程)
- 端口从 17841 开始找空闲的,写入 `Temp/pi-bridge-port` 供扩展发现
- 外部 POST 请求 → 后台线程接收(即时,不受节流影响)→ `EditorApplication.delayCall` 派发主线程执行(Unity API 主线程限定)→ 返回 JSON
- 域重载(重新编译)时自动重启 bridge

### 失焦节流与自动聚焦

Unity Editor 失焦时,`EditorApplication.delayCall`/`update` 被节流到 ~1Hz(这是 Unity 设计,`Application.runInBackground` 对 Editor 无效,无官方开关)。v0.2.0+ 的 PiBridge 会在派发命令前用 Win32 `SetForegroundWindow` + `AttachThreadInput` 把 Unity 窗口置前,让主循环全速运行(延迟从数秒降到 ~10-50ms)。

- 仅 Windows(`UNITY_EDITOR_WIN`),macOS/Linux no-op(节流本就较轻)
- 默认开启,可用 `config { autoFocus: false }` 关闭
- 建议同时在 Unity `Preferences → General → Interaction Mode` 设为 `No Throttling`,进一步降低前台延迟

### 安全边界
- **只监听 127.0.0.1**,不暴露到局域网
- 命令白名单(`ping`/`config`/`refresh`/`compile`/`status`/`run-menu`/`asset-info`/`log`/`eval`),不接受任意 C#
- `eval` 命令默认关闭,需在 Unity 启动前设环境变量 `PI_BRIDGE_ALLOW_EVAL=1`

### 已知限制
- `run-menu` 调 `EditorApplication.ExecuteMenuItem` 是同步阻塞的,若触发模态对话框会冻结主线程导致 bridge 无响应(15s 超时 + 拒绝在已有对话框时执行)
- 首次安装 PiBridge 后需 Unity 获得焦点触发编译(旧 bridge 无自动聚焦能力,第一次需手动给焦点)

---

## 版本兼容策略

| 版本 | 注意事项 |
|------|---------|
| 2019.4 LTS | Asset DB V2 过渡边界;日志路径行为同新版(项目级默认) |
| 2020.3 / 2021.3 LTS | 稳定;并行导入 worker 日志成熟 |
| 2022.3 LTS | 并行 `AssetImportWorker0/1.log` |
| Unity 6 (6000.x) | 新增 `-useGlobalLog`、`-timestamps`;有 Project Auditor CLI(后续可集成) |

`project-version.ts` 读 `ProjectSettings/ProjectVersion.txt` 拿版本号,日志路径按版本分支处理。

---

## 实现状态

1. ✅ **MVP(纯读取)**:`unity_log` + `unity_status` + `unity_project`
2. ✅ **HTTP bridge**:`unity_command` + PiBridge.cs(操控运行中的 Editor)
3. ✅ **自动安装**:`unity_install_bridge`(AI 给项目路径即可装 bridge)
4. ✅ **失焦优化**:PiBridge v0.2.0 自动聚焦 + `config` 命令 + 版本校验
5. ⏳ **后续**:`/unity-doctor` 命令、Project Auditor 集成
