# Roslyn Eval + 其他增强方向 — PiBridge 能力补齐提案

**Status:** 提案  
**Date:** 2026-07-26  
**Author:** pi (AI)  
**Related:** PiBridge.cs 中现有的 `eval` 命令（基于反射的 `Type.Method(args)` 调用）

---

## 动机

当前 PiBridge 的 `eval` 命令只能通过反射调用静态方法：

```
unity_command eval 'MyClass.MyMethod("hello")'
```

这限制了 Agent 能做的事情。对比 2026 年 7 月 Unity 发布的官方 CLI，其 `unity command eval` 基于 Roslyn 编译，可执行**任意 C# 代码片段**，无需域重载。

而 PiBridge 的定位正是"在已打开的 Editor 内执行命令"，evaluate 任意 C# 是补齐这个短板的关键一步。

---

## 方案

在 PiBridge 中集成 `Microsoft.CodeAnalysis.CSharp`（Roslyn），将 `eval` 从反射调用升级为完整的 C# 脚本编译执行。

### 架构变化

```
eval 命令流程（增强后）:

Agent → POST /eval { code: "..." }
  → PiBridge HttpListener 接收（后台线程）
  → DispatchToMainThread（delayCall）
  → Roslyn CSharpScript.RunAsync(code)
    → 编译（含语法/类型检查）
    → 执行（在 Editor 主线程）
    → 返回结果 + 诊断信息
  → JSON 响应
```

### 依赖

- `Microsoft.CodeAnalysis.CSharp` v3.11.0（Unity 下最稳定版本）
- 配套依赖：`Microsoft.CodeAnalysis.dll`、`System.Collections.Immutable.dll`、`System.Reflection.Metadata.dll` 等
- 部署方式：随 `unity_install_bridge` 一起复制到 `Assets/Editor/PiBridge/Roslyn/` 下

### 兼容性

| Unity 版本 | Roslyn 支持 | 备注 |
|-----------|------------|------|
| 2019.4 LTS | ✅ v3.11.0 可用 | API 兼容级别需 .NET 4.x |
| 2020.3 LTS | ✅ | 同左 |
| 2021.3 LTS | ✅ | 同左 |
| 2022.3 LTS | ✅ | 同左 |
| Unity 6 | ✅ | 同左 |

---

## 实现要点

### 1. DLL 部署

在 PiBridge 源码目录下新增 `Roslyn/` 子目录，存放所需 DLL。`unity_install_bridge` 会一并复制。

```
PiBridge/
├── PiBridge.cs           # 修改 eval case
├── BridgeVersion.cs
├── WindowFocus.cs
├── Response.cs
├── SimpleJson.cs
└── Roslyn/               # 新增
    ├── Microsoft.CodeAnalysis.dll
    ├── Microsoft.CodeAnalysis.CSharp.dll
    ├── Microsoft.CodeAnalysis.CSharp.Scripting.dll
    ├── Microsoft.CodeAnalysis.Scripting.dll
    ├── System.Collections.Immutable.dll
    ├── System.Reflection.Metadata.dll
    ├── System.Threading.Tasks.Extensions.dll
    └── ...
```

### 2. PiBridge.cs eval case 替换

**当前实现** (`EvalExpression`)：反射解析方法名和参数，调用静态方法。

**新实现**：用 `CSharpScript.Create` + `RunAsync`，支持任意 C# 表达式和语句。

关键点：
- `ScriptOptions` 需从 `AppDomain.CurrentDomain.GetAssemblies()` 收集引用（Editor 域已加载所有 Unity 程序集）
- 默认 import：`System`、`System.Linq`、`System.Collections.Generic`、`UnityEngine`、`UnityEditor` 等
- 编译错误返回到 JSON 响应中，供 Agent 诊断
- 需要处理 async：当前 `ExecuteCommand` 是同步的，`DispatchToMainThread` 需要支持 async Task

### 3. async 支持

PiBridge 当前 dispatch 用 `ManualResetEventSlim` 同步等待。Roslyn 的 `RunAsync` 是异步的。

方案：在 `ExecuteCommand` / `DispatchToMainThread` 中增加对 `eval` 命令的特殊处理：

```csharp
case "eval":
    var evalTask = EvalWithRoslyn(code);
    while (!evalTask.IsCompleted && !done.Wait(100)) { }
    if (evalTask.IsCompleted)
        response = evalTask.Result;
    else
        response = new Response { ok = false, error = "eval timed out" };
    break;
```

或者把整个 `DispatchToMainThread` 改为支持 `Func<Task<Response>>`。

### 4. eval 能力对比

| 特性 | 当前（反射） | 增强后（Roslyn） |
|------|------------|----------------|
| `Mathf.Sqrt(16)` | ❌ | ✅ |
| `new List<int>{1,2,3}.Where(x=>x>1).Sum()` | ❌ | ✅ |
| 多行代码 | ❌ | ✅ |
| 局部变量 + 状态 | ❌ | ✅ |
| 编译错误诊断 | ❌ | ✅（行号+描述） |
| 调用 Unity API | 仅静态方法 | ✅ 任意 API |
| 创建 GameObject | ❌ `typeof` 反射 | ✅ `new GameObject()` |
| 性能 | 无额外开销 | 首次编译 ~500ms，后续缓存 |
| Agent 使用体验 | 需理解反射限制 | 直接写 C# 即可 |

### 5. 示例

Agent 现在这样调用：
```
unity_command eval 'EditorApplication.isPlaying = !EditorApplication.isPlaying'
```

增强后可以这样：
```
unity_command eval '
    var go = new GameObject("Player");
    go.AddComponent<Rigidbody>();
    go.AddComponent<MeshRenderer>();
    go.transform.position = new Vector3(0, 5, 0);
    return go.name;
'
```

或者更复杂的：
```
unity_command eval '
    var assets = AssetDatabase.FindAssets("t:Prefab")
        .Select(guid => AssetDatabase.GUIDToAssetPath(guid))
        .Where(path => path.Contains("Enemy"))
        .ToList();
    return $"Found {assets.Count} enemy prefabs";
'
```

---

## 需要考虑的问题

### DLL 体积
Roslyn 整套约 5-8MB。对于通过 `unity_install_bridge` 一次性部署到项目中来说可以接受。如果担心，可以把 Roslyn 改为可选功能——有 DLL 时用 Roslyn，没有时退回到现有反射逻辑。

### 兼容性
- 有些 Unity 版本下 `AppDomain.GetAssemblies()` 返回的程序集 Location 可能为空（动态程序集）。需要过滤 `a.IsDynamic && !string.IsNullOrEmpty(a.Location)`。
- Unity 6 的 reference assembly 路径有变化（从 `Contents/NetStandard/` 改到 `Contents/Resources/Scripting/NetStandard/`），但用 `typeof(object).Assembly.Location` 动态获取可以避免硬编码路径。

### async 改造成本
PiBridge 当前 dispatch 模式是同步的。改成 async 的风险不大（`ManualResetEventSlim` 换 `TaskCompletionSource`），但需要仔细测试 `delayCall` 回调中 async 的异常传播。

### 安全性
当前的 `PI_BRIDGE_ALLOW_EVAL=1` 环境变量开关保留。Roslyn 编译执行的代码在 Editor 进程内，拥有完整的 Unity API 访问权限，这本身是设计意图（给 Agent 用的），但如果担心安全问题，后续可加沙箱。

---

## 替代方案

### 方案 B：用 Unity 的 CompilationPipeline API（不引入 Roslyn）
Unity 有 `CompilationPipeline` 类可以触发域重载编译，但代价太大（~10-30s 域重载），不符合"轻量 eval"的设计目标。不推荐。

### 方案 C：改用 C# REPL 库
社区有 `CSI` / `dotnet-script` 等方案，但依赖更重，且与 Unity Editor 集成不如 Roslyn 直接。不推荐。

---

## 时间线估计

如果动手实现：

| 步骤 | 时间 |
|------|------|
| 下载 Roslyn v3.11.0 DLL，放入 PiBridge/Roslyn/ | ~10 min |
| 修改 PiBridge.cs eval case | ~1h |
| async dispatch 改造 | ~1h |
| 测试兼容性（2019.4 ~ Unity 6） | ~2h |
| 更新 `unity_install_bridge` 部署 Roslyn | ~15 min |

---

# 其他增强方向（与官方 CLI 的差距补齐）

以下方向不限于 eval，是 PiBridge 整体能力对齐官方 CLI 可以做的事情。

## 1. Play Mode 控制

**当前：** `status` 只读 `isPlaying`，没有控制命令
**官方：** pipeline 可以控制 Enter/Exit Play Mode

**可以加的（~10 行 C#）：**
```
unity_command play --mode enter   # EditorApplication.EnterPlayMode()
unity_command play --mode exit    # ExitPlayMode()
unity_command play --mode pause   # isPaused = true
```

加上这个，Agent 就能自己跑 Play Mode 测试 → 看结果 → 修 bug → 再跑，全自动闭环。


## 2. 命令发现机制（Agent 自省）

**当前：** Agent 需要 README 里写死的命令列表
**官方：** Agent 可以运行时查询可用命令

**可以加的（~20 行 C#）：**
```
unity_command list-commands   # 返回所有命令 + 参数签名 + 描述
```
Agent 不用靠 prompt 记住，运行时问就行。


## 3. 自定义命令注册（对标 `[CliCommand]`）

**当前：** 命令写死在 `switch` 里，用户不能扩展
**官方：** 用 `[CliCommand]` 特性标记任意静态方法，Agent 自动发现

**可以加的：**
```csharp
// 用户在项目自己的 Editor 脚本里写：
[PiCommand("count-scenes", "Count scenes in build settings")]
public static string CountScenes()
{
    return $"Scenes in build: {EditorBuildSettings.scenes.Length}";
}
```
Agent 通过 `unity_command list-custom` 发现，通过 `unity_command run-custom count-scenes` 调用。
这样用户项目的工具方法直接暴露给 Agent，不用改 PiBridge 源码。


## 4. MCP 包装（让其他 Agent 也能用 PiBridge）

**当前：** 只能在 pi 里用
**官方：** 内置 MCP 支持，Claude Code / Codex / Cursor 都能用

**可以加的：** 在扩展入口旁加一个 MCP server（基于 `@modelcontextprotocol/sdk`），
把 PiBridge 的 5 个 tool 暴露为 MCP tools。其他 Agent 配置一行就能用。


## 5. 纯文件操作工具（不依赖 Editor）

**当前：** `unity_project` 已经读文件，但还可以扩展写操作
**官方：** 文件级别的操作不依赖 bridge

**可以加的（Agent 直接改文件，Editor 未启动也能用）：**

| 工具 | 说明 |
|------|------|
| `unity_edit_project_settings` | 改 `ProjectSettings.asset` 字段（Company Name、scripting backend 等） |
| `unity_edit_manifest` | 增删 `Packages/manifest.json` 的包依赖 |
| `unity_switch_platform` | 改 BuildTarget（改 `ProjectSettings.asset` 里的字段） |

这些在 Unity 未启动时也能用，对 CI 和初始项目配置很有价值。


## 6. 多实例支持

**当前：** `discoverBridge` 按端口顺序探测，找到第一个就返回
**官方：** 可以管理多个 Editor 实例

**可以加的：**
- `unity_command` 支持按 `projectPath` 精确匹配实例（端口文件已写项目路径）
- 新增 `unity_list_instances` 返回所有运行中的 PiBridge 实例列表


## 7. Workflow 编排

**当前：** Agent 需要自己组合多次 `unity_command` 调用
**官方：** pipeline 提供流程化控制

**可以加的（`bridge-client.ts` 里已有 `waitForCondition`，可再封装一步）：**
```
unity_command run-workflow '{
  "steps": [
    {"command": "compile"},
    {"command": "status", "pollUntil": "isCompiling", "waitFor": false},
    {"command": "play", "args": {"mode": "enter"}},
    {"command": "eval", "code": "Debug.Log(...)"},
    {"command": "play", "args": {"mode": "exit"}}
  ]
}'
```
一次调用完成完整工作流，减少 Agent 的 round-trip。


---

## 优先级建议

| 优先级 | 方向 | 工作量 | 收益 |
|--------|------|--------|------|
| 🔴 P0 | Play Mode 控制 | ~10 行 C# | Agent 能自测闭环 |
| 🔴 P0 | 命令发现 `list-commands` | ~20 行 C# | 减少 prompt 维护 |
| 🟡 P1 | 自定义 `[PiCommand]` 特性 | ~2h | 用户可扩展 |
| 🟡 P1 | 纯文件操作工具 | ~1h/个 | 不依赖 Editor |
| 🟢 P2 | MCP 包装 | ~2h | 其他 Agent 可用 |
| 🟢 P2 | 多实例支持 | ~1h | 更鲁棒 |
| ⚪ P3 | Workflow 编排 | ~3h | 高级自动化 |

Play Mode 控制 + 命令发现这两个**半天就能加上**，Agent 体验提升最明显。
