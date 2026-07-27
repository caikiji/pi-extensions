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


# 设计哲学：极简工具集 + 强 eval

分析了主流 Unity MCP 项目（IvanMurzak/Unity-MCP、CoplayDev/unity-mcp、jlceaser/Unity-MCP-Vibe）的源码后，
发现它们 70+ 工具中很多是同一个工具的不同 action 分支。

**PiBridge 选择不同的路线：**

不追求工具数量，而是让 eval 足够强（Roslyn），一个 eval 就能覆盖 MCP 项目 80% 的功能。

| 操作 | MCP 项目需要 | PiBridge Roslyn eval 后 |
|------|------------|------------------------|
| 创建 GameObject | `manage_gameobject action=create` | `eval 'new GameObject("Cube").AddComponent<Rigidbody>()'` |
| 改组件属性 | `manage_gameobject action=modify ...` | `eval 'go.GetComponent<Renderer>().material.color = Color.red'` |
| 场景查询 | `find_gameobjects searchTerm=...` | `eval 'GameObject.FindObjectsOfType<Transform>().Length'` |
| 批量操作 | 多次 round-trip 或 batch_execute | `eval 'for(...){...}' 一次 round-trip` |
| 包管理 | `manage_packages action=add` | `eval 'PackageManager.Client.Add("com.unity.addressables")'` |
| 测试 | `run_tests` | `eval 'TestRunner.RunAll()'` |

Roslyn eval 做不到的，才加专用工具（目前只有截图）。


# PiBridge 未来可补充的能力

## P0 — Roslyn eval（核心主菜，已提案）

见上文 Roslyn 方案。一个 eval 打天下。

## P0 — Play Mode 控制（10 行 C#）

**当前：** `status` 只读 `isPlaying`，没有控制命令
**加：**
```
unity_command play --mode enter   # EditorApplication.EnterPlayMode()
unity_command play --mode exit    # ExitPlayMode()
unity_command play --mode pause   # isPaused = true
```
Agent 能自己跑 Play Mode 测试 → 看结果 → 修 bug → 再跑，全自动闭环。

## P0 — 截图（eval 做不到的事）

**当前：** PiBridge 无法返回图像给 Agent
**加：** `unity_command screenshot` 返回 base64 图片

```
unity_command screenshot --mode game-view   # 返回 base64
unity_command screenshot --mode scene-view  # SceneView 截图
```

这是 eval **唯一做不到的事**，因为需要把 RenderTexture 编码为图片传回。其他所有操作 eval 都能做。


## P1 — 自定义命令注册 + 反射自动发现

**当前：** 命令写死在 PiBridge.cs 的 `switch` 里，用户不能扩展
**加：** 参考 MCP 项目的 `[McpForUnityTool]` 属性模式

```csharp
// 用户在自己的 Editor 脚本里写，PiBridge 启动时自动发现
[PiCommand("count_scenes", "Count scenes in build settings")]
public static string CountScenes()
{
    return $"Scenes in build: {EditorBuildSettings.scenes.Length}";
}
```

PiBridge 启动时扫描所有程序集，收集 `[PiCommand]` 标记的方法，
通过 `unity_command list-commands` 暴露给 Agent。


## P2 — MCP 包装（跨 Agent）

**当前：** PiBridge 是 pi extension，只能在 pi 里用
**加：** 在现有 TypeScript 层旁加一个 MCP server（~100 行）

```typescript
// mcp-server.ts 复用 bridge-client.ts 已有逻辑
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
// ...
```

核心逻辑全在 PiBridge.cs 的 C# 侧，TypeScript 层只是薄薄的 HTTP 客户端。
做 MCP 包装只需要适配协议层，C# 侧一行不改。


## 不做（eval 替代）

| MCP 项目有 | 为什么 PiBridge 不做 |
|-----------|-------------------|
| GameObject 创建/修改/删除 | eval 能做 `new GameObject()` + 反射/组件操作 |
| 场景层级树 | eval 能做 `GetComponentsInChildren` 转 JSON |
| 包管理 | eval 能调 `PackageManager.Client.Add()` |
| Profiler 快照 | eval 能读 `ProfilerDriver` API |
| 批量/编排 | eval 本身就是批量，for 循环比 round-trip 快 |
| 多重实例 | 个人使用场景极少 |


## Build 安全说明

PiBridge 的所有 `.cs` 文件放在 `Assets/Editor/` 下，
Unity 的 Build 过程**完全跳过 `Editor/` 文件夹**，不会打进发布的游戏/应用中。


---

# 优先级建议（更新版）

| 优先级 | 方向 | 工作量 | 理由 |
|--------|------|--------|------|
| 🔴 P0 | **Roslyn eval**（已提案） | ~半天 | 核心能力，覆盖 80% 场景 |
| 🔴 P0 | **Play Mode 控制** | ~10 行 C# | Agent 能自测闭环 |
| 🔴 P0 | **截图** | ~30 行 C# + 管道 | eval 做不到的事 |
| 🟡 P1 | **反射自动发现 + 自定义命令** | ~2h | 可扩展性，用户能自己加工具 |
| 🟢 P2 | **MCP 包装** | ~2h | 跨 Agent 可用 |
| ⚪ 不做 | GameObject / 场景/ 包管理 / Profiler ... | — | eval 已覆盖 |

**核心理念：** 5-6 个精心设计的工具 + 强 eval，胜过 70 个细分工具。
