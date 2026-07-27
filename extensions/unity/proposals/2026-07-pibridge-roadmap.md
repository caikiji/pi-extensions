# PiBridge 能力补齐路线图 — Roslyn eval / 事件驱动 / 设计哲学

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
| Unity 版本 | Roslyn 版本 | C# 支持 | 备注 |
|-----------|------------|--------|------|
| 2019.4 LTS | **3.11.0** | C# 7.3 | API 兼容级别需 .NET 4.x |
| 2020.3 LTS | **3.11.0** | C# 8.0 | 同左，建议降级到 C# 7.3 语法 |
| 2021.3 LTS | **4.0.1** | C# 9.0 | record、init、pattern matching 可用 |
| 2022.3 LTS | **4.0.1** | C# 9.0 | 同上 |
| Unity 6 | **4.8.0** | C# 10+ | 完整现代 C# 支持 |

---

## 实现要点

### 1. DLL 部署（按版本选择）

在 PiBridge 源码目录下新增 `Roslyn/` 子目录，按 Unity 版本存放不同的 Roslyn 版本：

```
PiBridge/
├── PiBridge.cs           # 修改 eval case
├── BridgeVersion.cs
├── WindowFocus.cs
├── Response.cs
├── SimpleJson.cs
└── Roslyn/
    ├── v3.11.0/           # Unity 2019.4 / 2020.3  (C# 7.3/8.0)
    │   ├── Microsoft.CodeAnalysis.dll
    │   ├── Microsoft.CodeAnalysis.CSharp.dll
    │   ├── Microsoft.CodeAnalysis.CSharp.Scripting.dll
    │   ├── Microsoft.CodeAnalysis.Scripting.dll
    │   └── ...
    ├── v4.0.1/            # Unity 2021.3 / 2022.3  (C# 9.0)
    │   └── ...
    └── v4.8.0/            # Unity 6+  (C# 10+)
        └── ...
```

`unity_install_bridge` 在安装时调用 `readProjectVersion` 判断 Unity 版本，
复制对应版本的 Roslyn DLL 到项目中。

```csharp
// unity_install_bridge 时的版本选择逻辑（伪代码）
string unityVersion = ReadProjectVersion(projectPath);
string roslynDir = unityVersion switch {
    var v when v.StartsWith("2019") || v.StartsWith("2020") => "Roslyn/v3.11.0",
    var v when v.StartsWith("2021") || v.StartsWith("2022") => "Roslyn/v4.0.1",
    _ => "Roslyn/v4.8.0"  // Unity 6+
};
CopyDirectory(roslynDir, targetPath);
```

**安全回退：** 如果 Roslyn 加载失败（DLL 版本不兼容或缺少依赖），
```
PiBridge 自动退回到现有的反射 EvalExpression 逻辑
确保低版本 Unity 用户不丢失 eval 能力。
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


# PiBridge 的独特优势：双向事件驱动（非阻塞订阅）

目前所有 Unity MCP 项目（包括官方 CLI）都是**请求-响应模式**：
Agent 问一句，Unity 答一句，Agent 再问下一句。

PiBridge + pi extension 的组合可以做 **非阻塞事件订阅**——
Agent 订好事件后继续干活，事件来了 pi 主动发消息打断它。

## 架构

```
                       请求（HTTP POST）
Agent / pi extension ──────────────────→ PiBridge (Unity Editor)
      │                                       │
      │  ← /events SSE 长连接（后台）          │
      │  ← compile_done → pi.sendUserMessage() │
      │  ← playmode_exit → 打断 Agent         │
      │  ← error_occurred → 自动诊断          │
```

**只有 PiBridge 是服务端，pi 是客户端。** 没有额外端口，没有双向 HTTP。

## 事件队列 + SSE

PiBridge 维护一个事件队列。SSE 连接建立时先吐出历史积压，然后转实时推送：

```
时间线：

compile_done 发生
  ↓
  PiBridge 存进队列 → [{ type: "compile_done", data: {errors: 2} }]
  ↓
  （Agent 还在思考，还没发起 SSE 连接）
  ↓
Agent 调 unity_events subscribe → 连 SSE
  ↓
  PiBridge 收到连接：
    ① 先倒出队列积压 → event: compile_done
    ② 转实时监听 → 挂住，等下个事件
  ↓
  SSE 回调 → pi.sendUserMessage() → Agent 看到消息
```

## 实现

### PiBridge 侧：事件队列 + SSE 端点 + 订阅管理

```csharp
// PiBridge.cs 新增
static ConcurrentQueue<UnityEvent> _eventQueue = new();
static ConcurrentDictionary<string, bool> _subscriptions = new();

// 统一的订阅管理端点
case "manage-subscriptions":
    string action = GetArg<string>(args, "action", "");
    string[] events = GetArg<string[]>(args, "events", Array.Empty<string>());

    switch (action) {
        case "subscribe":
            foreach (var e in events) _subscriptions[e] = true;
            break;
        case "unsubscribe":
            foreach (var e in events) _subscriptions.Remove(e);
            break;
        case "list":
            return new Response { ok = true, result = _subscriptions.Keys.ToList() };
    }
    return new Response { ok = true };

// 在 EditorApplication.update 里检测状态变化
EditorApplication.update += () => {
    if (_wasCompiling && !EditorApplication.isCompiling)
        _eventQueue.Enqueue(new UnityEvent("compile_done", new { errors = ... }));
    _wasCompiling = EditorApplication.isCompiling;
};

// SSE 端点
case "events":
    response.ContentType = "text/event-stream";

    // 先吐积压
    while (_eventQueue.TryDequeue(out var ev)) WriteSSE(response, ev);

    // 转实时
    while (!_cancellation.Token.IsCancellationRequested) {
        if (_eventQueue.TryDequeue(out var ev)) WriteSSE(response, ev);
        else Thread.Sleep(100);
    }
    break;
```

### pi extension 侧：一个 unity_events 工具

```typescript
pi.registerTool({
    name: "unity_events",
    description: "Manage Unity event subscriptions. " +
        "Subscribe to get notified when things happen, " +
        "unsubscribe to stop, list to see active subscriptions.",
    parameters: {
        action: { type: "string", enum: ["subscribe", "unsubscribe", "list"] },
        events: {
            type: "string[]",
            description: "Events: compile, playmode, error. Required for subscribe/unsubscribe."
        }
    },
    async execute(params, ctx) {
        const bridge = await discoverBridge(ctx.cwd);

        if (params.action === "list") {
            return await sendCommand("manage-subscriptions", { action: "list" });
        }

        // subscribe 时启动后台 SSE 连接
        if (params.action === "subscribe" && !sseController) {
            sseController = new AbortController();
            startSseLoop(pi, bridge.port, sseController.signal);
        }

        // unsubscribe 时关闭
        if (params.action === "unsubscribe" && sseController) {
            sseController.abort();
            sseController = null;
        }

        return await sendCommand("manage-subscriptions", {
            action: params.action,
            events: params.events
        });
    }
});
```

### 后台 SSE 循环：事件来临时非阻塞通知 Agent

```typescript
let sseController: AbortController | null = null;

async function startSseLoop(pi, port, signal) {
    const response = await fetch(`http://127.0.0.1:${port}/events`, { signal });
    const reader = response.body.getReader();

    while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        for (const event of parseSSE(value)) {
            // 非阻塞：直接塞给 Agent
            pi.sendUserMessage(
                `[Unity 事件] ${event.type}`,
                { deliverAs: "followUp" }
            );
        }
    }
}
```

**`pi.sendUserMessage()` + SSE 后台连接 = MCP 做不到的实时协作。**

## 与阻塞 wait 对比

| | 阻塞 wait（旧方案，已废弃） | 非阻塞订阅（最终方案） |
|----------|-----------|
| Agent 行为 | 挂着啥也不干 | 继续干活/思考 |
| Unity 编译 30 秒 | Agent 发呆 30 秒 | Agent 写代码/查文档 |
| 生命周期 | 每次都要重新调 | 订一次一直有效，直到取消 |
| MCP 能复制？ | 能（轮询即可） | **不能，pi 独有** |

## 场景一：编译→自动诊断闭环

```
Agent: "帮我修一下这个编译错误"
    ① unity_events subscribe events=compile
    ② unity_command compile（触发编译）
        → Agent 去干别的事了
    ③ Unity 编译完成
        → PiBridge 推 compile_done
        → SSE 回调 → pi.sendUserMessage()
        → Agent 看到消息
    ④ 自动调 unity_log 抓错误
    ⑤ 分析 CS0103 → 缺 using → 自动加
    ⑥ unity_command compile 再试
    ⑦ compile_done 再来 → 编译通过
    ⑧ unity_events unsubscribe events=compile
    ⑨ 通知用户 "已修复"
```

## 场景二：Play Mode 崩溃自动抓现场

```
Agent: "进入 Play Mode 测试"
    ① unity_events subscribe events=playmode,error
    ② unity_command play --mode enter
        → Agent 去干别的事了
    ③ Play Mode 崩溃
        → PiBridge 推 playmode_exit + error_occurred
        → SSE 回调 → pi.sendUserMessage()
        → Agent 看到消息
    ④ 自动调 screenshot 抓画面
    ⑤ 自动调 unity_log 抓异常
    ⑥ 分析并修复
```

## 与 MCP 的本质区别

| | MCP（官方 CLI 等） | PiBridge（非阻塞订阅） |
|--|-----|-------------|
| **范式** | 请求-响应 | 事件驱动 |
| **实时性** | 靠 Agent 轮询 | PiBridge 主动推 |
| **Play Mode 崩溃** | Agent 不知道，等用户说 | 主动打断 Agent |
| **编译闭环** | Agent 傻等 | Agent 一边干活一边等消息 |
| **跨工具协作** | 不可能 | **pi 独有：extension 后台 + sendUserMessage** |

**PiBridge 不是 MCP 的替代品，也不是 MCP 的包装器。**
它是 pi Agent 和 Unity 之间的**双向通道**——MCP 只做到了一半。


---

# 不做（eval 替代）

| MCP 项目有 | 为什么 PiBridge 不做 |
|-----------|-------------------|
| GameObject 创建/修改/删除 | eval 能做 `new GameObject()` + 反射/组件操作 |
| 场景层级树 | eval 能做 `GetComponentsInChildren` 转 JSON |
| 包管理 | eval 能调 `PackageManager.Client.Add()` |
| Profiler 快照 | eval 能读 `ProfilerDriver` API |
| 批量/编排 | eval 本身就是批量，for 循环比 round-trip 快 |
| 多重实例 | 个人使用场景极少 |


---

# Build 安全说明

PiBridge 的所有 `.cs` 文件放在 `Assets/Editor/` 下，
Unity 的 Build 过程**完全跳过 `Editor/` 文件夹**，不会打进发布的游戏/应用中。

# 优先级建议（更新版）

| 优先级 | 方向 | 工作量 | 理由 |
|--------|------|--------|------|
| 🔴 P0 | **Roslyn eval**（已提案） | ~半天 | 核心能力，覆盖 80% 场景 |
| 🔴 P0 | **Play Mode 控制** | ~10 行 C# | Agent 能自测闭环 |
| 🔴 P0 | **截图** | ~30 行 C# + 管道 | eval 做不到的事 |
| 🔴 P0 | **非阻塞事件订阅** | ~半天（SSE + pi.sendUserMessage） | **MCP 做不到，pi 独有：Agent 不等消息，事件来了主动打断** |
| 🟡 P1 | **反射自动发现 + 自定义命令** | ~2h | 可扩展性，用户能自己加工具 |
| 🟢 P2 | **MCP 包装** | ~2h | 跨 Agent 可用 |
| ⚪ 不做 | GameObject / 场景/ 包管理 / Profiler ... | — | eval 已覆盖 |

**核心理念：** 5-6 个精心设计的工具 + 强 eval + 双向事件驱动，胜过 70 个细分工具。
