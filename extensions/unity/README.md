# unity — pi extension for Unity Editor integration

让 pi (coding agent) 能方便地**读取 Unity 日志**、**操控运行中的 Unity Editor**、**执行 Unity 脚本**、**操作 Unity 项目文件**。

支持 Unity 2019.4 LTS 及之后所有版本(2020.3 / 2021.3 / 2022.3 / Unity 6)。

---

## 设计目标

Unity 开发者用 pi 时,agent 应该能:
1. **看懂 Unity 在干什么** — 读 Editor.log / AssetImportWorker 日志,提取编译错误、导入错误、异常
2. **操控运行中的 Unity** — 通过 PiBridge HTTP bridge 在已打开的 Editor 里执行命令(不用启动第二个实例)
3. **让 Unity 干活(独立模式)** — Unity 没开时,通过 batchmode + `-executeMethod` 调用 Editor 脚本
4. **安全操作项目文件** — 读写 YAML/JSON 文本资产,绝不破坏 GUID 引用

核心原则:**两种执行路径共存** — Unity 开着用 `unity_command`(快,驱动当前实例);Unity 没开用 `unity_run`(慢,新开 batchmode 进程)。

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

### batchmode 脚本执行
- `-executeMethod NS.Class.Method`:方法必须 `static`、无参、无返回
- 必须在 Editor assembly(文件夹名 `Editor` 或 asmdef 限定 `Editor` 平台)
- `[MenuItem]` 特性**非必须**(菜单需要,但 `-executeMethod` 直接按全限定名调用)
- 可用 API:`AssetDatabase` `EditorUtility` `SceneManager` `BuildPipeline` `EditorApplication`
- 不可用:UI/渲染/`WaitForEndOfFrame`/依赖帧更新的系统
- 传参:命令行参数,脚本内 `Environment.GetCommandLineArgs()` 读取
- 返回错误:`throw` 异常 → 退出码 1;或 `EditorApplication.Exit(nonzero)`
- `Debug.Log` 内容进 Editor.log

### batchmode 坑(封装必须处理)
1. **退出码不可靠**:Analytics 启用时编译错误也返回 0;upmPack 成功却返回 1 → 必须三重判定
2. **`-nographics` 必须配 `-logFile <path>`**,否则日志被关闭
3. **路径**:Windows `-projectPath` 不能以单反斜杠结尾(用 `\\` 或无尾斜杠);含空格必须引号
4. **并发互斥**:`Temp/UnityLockfile` 独占锁,同项目不能开两个实例 → 封装层加文件锁
5. **取消安全**:kill 进程后**必须清理 `Temp/UnityLockfile`**,否则下次启动报 "another Unity instance"
6. **超时分层**:外部进程超时 > `-quitTimeout`(默认 300s,异步任务必加)
7. **离线许可校验慢**:离线机器 5-6 分钟,CI 多阶段可达 18 分钟

### Unity.exe 路径发现链
1. `UNITY_EDITOR_PATH` 环境变量(直接覆盖)
2. Unity Hub:`%APPDATA%\UnityHub\secondaryInstallPath.json` + 项目 `ProjectSettings/ProjectVersion.txt` 版本号
3. 注册表兜底(仅旧版独立安装):`HKCU\SOFTWARE\Unity Technologies\Installer\Unity\Location x64`

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
├── index.ts                    # 入口,注册 tool/command
├── package.json                # pi 扩展声明
├── lib/
│   ├── paths.ts                # Unity.exe 发现、日志路径定位、项目根探测
│   ├── editor-log.ts           # 定位 + 解析 Editor.log(项目级/全局回退)
│   ├── log-parser.ts           # 提取编译错误/异常/导入错误/包管理错误
│   ├── batchmode.ts            # batchmode 封装:路径处理、文件锁、超时、取消+清理、stdout 实时读
│   └── project-version.ts      # 读 ProjectVersion.txt,版本感知
├── tools/
│   ├── unity-log.ts            # tool: 读取/解析 Unity 日志
│   ├── unity-run.ts            # tool: 执行 batchmode 脚本(核心)
│   ├── unity-status.ts         # tool: 检测 Unity 运行/编译/导入状态
│   └── unity-project.ts        # tool: 读项目元信息(版本、asmdef、manifest)
└── commands/
    └── unity-doctor.ts         # /unity-doctor: 跑全套诊断
```

---

## Tool 设计

### 0. `unity_command` — 操控运行中的 Unity(通过 PiBridge)
让 AI 在**已打开的** Unity Editor 里执行命令,不用启动第二个实例。

**前提**:项目 `Assets/Editor/` 下有 `PiBridge.cs`(见下文「PiBridge 安装」)。

**参数**:
- `command`: `ping` | `refresh` | `compile` | `status` | `run-menu` | `asset-info` | `log` | `eval`
- `projectPath?`:项目根,默认 cwd 自动探测
- `args?`:命令参数对象(`run-menu` 需 `{ menuPath }`,`asset-info` 需 `{ path }` 等)
- `timeout?`:秒,默认 60

**流程**:
1. `bridge-client.ts` 读 `Temp/pi-bridge-port` 发现端口(回退探测 17841+)
2. HTTP POST `http://127.0.0.1:{port}/{command}`,body 是 args 的 JSON
3. PiBridge 后台线程收到 → `EditorApplication.delayCall` 派发主线程 → 执行 → 返回 JSON
4. 返回 `{ ok, result?, error?, durationMs }`

**节流注意**:Editor 失焦时 `delayCall` 有秒级延迟(命令不丢,但执行慢)。触发 `compile`/`refresh` 后应轮询 `status` 直到 `isCompiling: false`。

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

### 2. `unity_run` — 执行 Unity 脚本(batchmode,独立模式)
让 AI 让 Unity 干活(Unity 没开时用)。

**参数**:
- `method: string` — 全限定名 `NS.Class.Method`
- `projectPath?: string` — 默认 cwd
- `args?: string[]` — 传给脚本的命令行参数(脚本内 `Environment.GetCommandLineArgs()` 读)
- `timeout?: number` — 秒,默认 600
- `extraArgs?: string[]` — 额外 Unity CLI 参数(如 `-buildTarget Android`)
- `resultFile?: string` — 脚本写结果的 JSON 路径(约定 `Temp/pi-result.json`)

**流程**(`batchmode.ts`):
1. `paths.ts` 发现 Unity.exe(按版本)
2. 对 projectPath 加文件锁(防并发)
3. 检查 `Temp/UnityLockfile`,若存在且 Unity 在跑 → 报错(避免冲突)
4. 构造命令:
   ```
   Unity.exe -batchmode -nographics -quit -quitTimeout <timeout>
            -projectPath "<path>" -logFile "<temp-log>"
            -executeMethod <method> [args...]
   ```
5. `pi.exec` 启动子进程,实时读 stdout/log 文件 → `onUpdate` 流式反馈
6. 结束后**三重判定**:
   - 退出码
   - 日志里有无 `error CS`/`Exception:`
   - `resultFile` 是否存在且合法 JSON
7. 取消/超时:SIGTERM → 等 5s → kill → **清理 `Temp/UnityLockfile`**
8. 返回:`{exitCode, success, durationMs, errors[], result?}`

**返回示例**:
```json
{
  "exitCode": 0,
  "success": true,
  "durationMs": 45230,
  "logPath": "Temp/pi-unity-run.log",
  "errors": [],
  "result": { "builtAssets": 42, "outputPath": "Build/Android/" }
}
```

### 3. `unity_status` — 检测 Unity 状态

### 4. `unity_project` — 读项目元信息

---

## PiBridge 安装(启用 unity_command 的前提)

`PiBridge.cs` 是一个 C# 文件,放在 Unity 项目的 `Assets/Editor/` 下,自动随项目加载启动一个 HTTP bridge,让外部进程(AI)能操控运行中的 Editor。

### 步骤
1. 把 `extensions/unity/PiBridge.cs` 复制到你的 Unity 项目 `Assets/Editor/`(没有 `Editor` 文件夹就新建一个)
2. 在 Unity 里打开该项目(或如果已打开,等它自动编译)
3. 查看 Unity Console,应出现:`[PiBridge] Listening on http://127.0.0.1:17841`
4. 现在 AI 可以用 `unity_command` 了

### 工作原理
- `[InitializeOnLoad]` 静态构造函数在项目加载时启动 `HttpListener`(后台线程)
- 端口从 17841 开始找空闲的,写入 `Temp/pi-bridge-port` 供扩展发现
- 外部 POST 请求 → 后台线程接收(即时,不受节流影响)→ `EditorApplication.delayCall` 派发主线程执行(Unity API 主线程限定)→ 返回 JSON
- 域重载(重新编译)时自动重启 bridge

### 安全边界
- **只监听 127.0.0.1**,不暴露到局域网
- 命令白名单(`ping`/`refresh`/`compile`/`status`/`run-menu`/`asset-info`/`log`/`eval`),不接受任意 C#
- `eval` 命令默认关闭,需在 Unity 启动前设环境变量 `PI_BRIDGE_ALLOW_EVAL=1`

### 已知限制
- Editor 失焦/最小化时,主线程 `delayCall` 被节流到约 1Hz,命令执行有秒级延迟(但命令不丢)
- 这是 Unity 的设计(`EditorApplication.update` 失焦节流),无法绕过

---

## 约定:batchmode 脚本结果回传

为了让 AI 可靠拿到脚本执行结果,约定脚本写 JSON 到固定路径:

```csharp
// 用户的 Editor 脚本里
[MenuItem("Tools/My Build")]
public static void BuildMethod() {
    try {
        // ...干活...
        var result = new { builtAssets = 42, outputPath = "Build/Android/" };
        File.WriteAllText("Temp/pi-result.json", JsonUtility.ToJson(result, true));
    } catch (Exception e) {
        File.WriteAllText("Temp/pi-result.json",
            JsonUtility.ToJson(new { error = e.Message, stack = e.StackTrace }, true));
        EditorApplication.Exit(1);
    }
}
```

`unity_run` tool 会自动读 `Temp/pi-result.json` 并解析进返回值。扩展可提供一个 C# helper 包(后续)简化这个约定。

---

## 版本兼容策略

| 版本 | 注意事项 |
|------|---------|
| 2019.4 LTS | Asset DB V2 过渡边界;日志路径行为同新版(项目级默认) |
| 2020.3 / 2021.3 LTS | 稳定;并行导入 worker 日志成熟 |
| 2022.3 LTS | 并行 `AssetImportWorker0/1.log` |
| Unity 6 (6000.x) | 新增 `-useGlobalLog`、`-timestamps`;有 Project Auditor CLI(后续可集成) |

`project-version.ts` 读 `ProjectSettings/ProjectVersion.txt` 拿版本号,日志路径与 batchmode 行为按版本分支处理。

---

## 实现优先级

1. **已完成 MVP**: `unity_log` + `unity_status` + `unity_project`(纯读取,零风险)
2. **已完成核心**: `unity_run`(batchmode 封装,带文件锁/超时/清理/三重判定)
3. **已完成 bridge**: `unity_command` + PiBridge.cs(操控运行中的 Editor)
4. **后续增强**: C# 结果回传 helper 包、`/unity-doctor` 命令、Project Auditor 集成
