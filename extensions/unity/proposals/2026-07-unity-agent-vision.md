# Unity Agent — 视觉驱动的 Unity 测试工具

**Status:** 提案  
**Date:** 2026-07-29  
**Author:** pi (AI)  
**Related:** PiBridge.cs、MiniCPM-V 4.6

---

## 动机

PiBridge 已经能让 Agent 通过 `unity_command eval` 操控 Unity Editor，但 Agent **看不到画面**，只能靠日志推理。很多判断是纯视觉的：玩家到 checkpoint 了吗？UI 正确弹出了吗？特效播放了吗？

我们在本地部署了 MiniCPM-V 4.6（1.3B 多模态模型，llama-server 提供服务，OpenAI 兼容 API）。把这个视觉能力接进来，Agent 就能看见 Unity 画面了。

---

## 设计

只加 **一个工具**，名字叫 `unity_agent`。

Pi（文本模型）通过这个工具下达指令，工具内部自行完成画面采集→视觉分析→操作 Unity 的闭环。

### 工具定义

```typescript
pi.registerTool({
    name: "unity_agent",
    description: "操控 Unity Play Mode 中的游戏。支持两种模式：\n" +
        "- observe: 截取当前画面并分析，不做操作\n" +
        "- run_task: 在 Play Mode 中执行一个视觉任务，内部循环截取画面→分析→操作直到完成",
    parameters: {
        mode: {
            type: "string",
            enum: ["observe", "run_task"],
            description: "操作模式"
        },
        prompt: {
            type: "string",
            description: "observe 模式下的分析指令，或 run_task 模式下的任务描述"
        },
        max_steps: {
            type: "number",
            description: "run_task 模式专用，最大步数"
        }
    }
});
```

### observe 模式

```
Pi → unity_agent(mode: "observe", prompt: "画面上有哪些 UI 元素？")
  → 截取当前帧 → 送 MiniCPM-V → 返回分析结果
```

一次调用，截图 + 分析，不做操作。

### run_task 模式

```
Pi → unity_agent(mode: "run_task", prompt: "走到红色 checkpoint 触发它")

工具内部循环:
  1. 执行操作（上一步的 action）
  2. 截取当前帧，拼入历史帧队列（保留最近 N 帧）
  3. 将历史帧序列作为"短视频"送 MiniCPM-V 分析
  4. MiniCPM-V 返回 { action, params, status, reason }
  5. 如果 status === "success" → 返回结果
  6. 如果 status === "stuck"   → 返回失败
  7. 否则 → 记录 action，回到 1
```

关键区别：**每次送给视觉模型的是最近 N 帧的序列，而不是单张图。** 这样模型能看到"上一步按了 W 之后画面发生了什么变化"，才能做出正确的下一步判断。

N 默认取 3~5 帧，帧间隔约 200~300ms（取决于操作执行时间），构成一个低帧率的短视频片段。

### 像素定位策略

MiniCPM-V 看到的画面是压缩后的 384×384 分块，无法直接输出绝对像素坐标。
工具层做换算：

```
模型输出: { action: "click", region: [0.75, 0.05, 0.98, 0.2] }
                          ↑ 相对坐标 (0~1)
                          ↓
工具层: x = 0.75 * screen_width, y = 0.05 * screen_height
```

如果是 UI 按钮，优先用名称定位：

```csharp
eval 'GameObject.Find("StartButton").GetComponent<Button>().onClick.Invoke()'
```

### 输入模拟的三种方案

run_task 模式需要向 Unity Play Mode 注入输入。有以下三种方案，按推荐优先级排列：

#### 方案一：Input System API（推荐）

如果项目使用了 New Input System Package，Unity 官方提供了输入模拟 API：

```csharp
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

// 鼠标移动
InputSystem.QueueStateEvent(Mouse.current, new MouseState {
    position = new Vector2(847, 322)
});

// 按下左键
InputSystem.QueueStateEvent(Mouse.current, new MouseState {
    position = new Vector2(847, 322),
    buttons = 1
});

// 拖动（连续发位置事件）
InputSystem.QueueStateEvent(Mouse.current, new MouseState {
    position = new Vector2(900, 350),
    buttons = 1
});

// 松开
InputSystem.QueueStateEvent(Mouse.current, new MouseState {
    position = new Vector2(900, 350),
    buttons = 0
});
```

这套 API 是 Unity 官方为自动化测试设计的，在 Play Mode 下正常工作，
无需反射或私有 API。

#### 方案二：Win32 API（Windows 专属）

如果项目使用旧 Input Manager，或需要最真实的 OS 级输入模拟，可以通过 P/Invoke 调用 Win32：

```csharp
[DllImport("user32.dll")]
static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

// 操作系统层面的鼠标事件——Unity 无法区分是真人还是 Agent
mouse_event(MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE, x, y, 0, UIntPtr.Zero);
```

eval 可以直接执行这些代码。方案一和方案二都走 eval，无需新增命令。

#### 方案三：AgentInput 脚本（兼容兜底）

在 Unity 项目中挂载一个 AgentInput 脚本，暴露高层操作接口：

```csharp
public class AgentInput : MonoBehaviour {
    public void MoveMouse(float x, float y) {
        // 内部决定用 InputSystem API 还是 Win32
    }
    public void MouseClick() { ... }
    public void Drag(float x1, float y1, float x2, float y2, float duration) {
        StartCoroutine(DragRoutine(x1, y1, x2, y2, duration));
    }
}
```

eval 调这个脚本比直接写底层 API 更简洁：

```csharp
eval 'FindObjectOfType<AgentInput>().MouseClick()'
```

#### 方案选择

| 项目情况 | 推荐方案 |
|---------|--------|
| 已用 New Input System | 方案一 |
| 旧 Input Manager + Windows | 方案二 |
| 旧 Input Manager + macOS | 方案三 |
| 混合/不确定 | 方案三兜底 |

---

## PiBridge 需要新增的命令

现有的 eval / play / status 全部复用。需要新增一个画面采集命令，**不是单纯的截图**，而是支持采集视频片段：

### `capture` 命令

```json
// 请求
POST /capture
{
    "mode": "game-view",           // game-view | scene-view
    "type": "single" | "clip",    // 单帧 或 短视频片段
    "frames": 5,                  // type=clip 时有效，采集帧数
    "interval_ms": 100            // type=clip 时有效，帧间隔
}

// 返回 (type=single)
{
    "ok": true,
    "result": {
        "type": "single",
        "images": ["base64..."],  // 只有一帧
        "width": 1920,
        "height": 1080,
        "format": "png",
        "isPlaying": true
    }
}

// 返回 (type=clip)
{
    "ok": true,
    "result": {
        "type": "clip",
        "images": ["base64...", "base64...", ...],  // 多帧
        "width": 1920,
        "height": 1080,
        "format": "png",
        "fps": 10,                // 根据 interval_ms 推算
        "isPlaying": true
    }
}
```

实现方式：type=single 走 RenderTexture 同步渲染（同截图）。type=clip 在 Unity 主线程上逐帧采集，每帧间隔通过 `EditorApplication.update` 或协程控制，达到指定帧数后一次性返回。

这样工具在 run_task 时调一次 `capture` 就能拿到最近几步的画面变化，不用自己拼。
## 未解决的问题

以下问题在提案阶段尚未定论，待实现时进一步决策：

### 1. run_task 超时与 Pi tool call 的兼容

**方向已定（Phase 0 数据修正）。** 实测每步耗时：截图 Play Mode 下 ~1.2s + schema 约束视觉决策 ~2s ≈ 3.2s/步。20 步 ≈ 64s，接近 Pi tool call 超时。

**采用「循环在工具内 + 超时返回 incomplete」方案，但利用一个关键洞察：Unity 画面本身就是持久状态。** 不需要跨调用的 session 管理——incomplete 时 Pi 用一次新的 `unity_agent run_task` 调用接续，把“上次停在哪、目标是什么”作为 prompt 传进去，工具重新截图就是当前状态。复杂度降为零。

原“工具内部维护状态分次接续”方案不需要。

### 2. MiniCPM-V 输出可靠性

**✅ 已解决（Phase 0 验证）。** 用 ollama 原生 `/api/generate` 的 `format` 参数传 JSON Schema，从语法层面强制约束：action 枚举、required 字段、params 结构。三次实测 100% 合法 + 字段齐全 + action 不越界，且推理耗时从 prompt 约束的 9~12s 降到 **1.7~2.1s**（模型不再思考格式）。

原以为需要的 GBNF grammar / 重试兜底可以省去。代价：必须用 ollama 原生 API（非 OpenAI 兼容端点），`images` 字段吃 base64 数组。若未来换 llama-server 需 fallback。

schema 注意点：`x/y` 坐标字段要加 `{type:"number", minimum:0, maximum:1}`，否则模型会输出 `x:100` 等越界值（不影响 action 决策，工具层执行时按 action 类型决定是否用 params）。

语义错误（画面没路却让往前）仍无法在工具层防，交给 run_task 多步循环容错——走错下一步模型会看到没变化自己纠正。

历史记录（prompt 约束的实测问题，schema 后已消失）：
- 偶发漏 `status`/`reason` 字段
- action 越界（如 `"turn_right then move forward to the right character"` 组合字符串）
### 3. Play Mode 崩溃检测

**方向已定。** run_task 内部用 **capture 返回的 isPlaying** 做崩溃检测，不依赖 SSE 事件。理由：run_task 循环是工具内部同步跑，SSE 事件会通过 `pi.sendUserMessage` 打断 Agent，但此刻 Agent 正在等 unity_agent 工具返回，打断消息会很尴尬。而 capture 返回里已带 `isPlaying` 字段（见 capture schema），每步本来就要 capture，顺带检查零成本。

SSE 事件订阅的价值在非 run_task 场景（Agent 单独 enter play mode 后干别的活）。run_task 内部用不上。

崩溃时返回 `status: "crashed"` + 最后画面 + 最后异常日志（调 `unity_command log`）。

### 4. 对 Roslyn eval 的前置依赖

**✅ 已解决。** Roslyn eval 已合并到 main（PiBridge 0.6.0，commit `230815d`），trailing-return / enum / UnityEngine.Object 序列化三个 bug 已修。实测在 Unity 2019.4.36f1 上 eval 稳定运行，截图代码、Camera 查询、后续输入模拟均走 eval。
### 5. 基本动作集

目前只提到了 move_forward 和 turn_left。实际 Play Mode 中需要的最小动作集是什么？
初步猜测：

| 动作 | 说明 |
|------|------|
| move_forward / backward | 前后移动 |
| turn_left / right | 视角旋转 |
| move_mouse | 鼠标移动到屏幕位置 |
| click | 鼠标点击 |
| drag | 鼠标拖拽 |
| interact | 交互/E键 |
| jump | 跳跃 |
| wait | 等待 N 毫秒 |

---

## 视觉模型部署

本地需要跑 MiniCPM-V 4.6 服务（llama.cpp + llama-server，OpenAI 兼容 API）：

```bash
llama-server -m MiniCPM-V-4_6-Q4_K_M.gguf --mmproj mmproj-model-f16.gguf -ngl 99 --port 18080
```

约 1.5 GB 磁盘，2~3 GB 显存。llama.cpp 全平台支持（macOS 验证 / Windows 目标平台）。

---

## 不做的事

- 不加其他新工具/新命令。一个 `unity_agent` 涵盖所有场景。
- 不加高帧率实时视频流（>15fps）。N 帧/步的低帧率片段足矣，且 MiniCPM-V 也处理不了更快的输入。

---

## Phase 0 验证报告（2026-07-29）

在 `D:\workspace\CourseProject`（Unity 2019.4.36f1, URP）上，用 PiBridge 0.6.0 + ollama `minicpm-v4.6:latest` 完成端到端验证。**所有核心假设成立。**

### 截图能力（eval 内联，无需新增 capture 命令）

eval 内联 RenderTexture 截图完全可行，返回 base64 字符串经 SimpleJson passthrough 无损传输。提案里计划的 `capture` 命令**降级为可选**——只有需要多帧 clip、独立相机选择时才值得固化。MVP 可用 TS 层多次调 eval 截图模拟 clip。

| 场景 | 耗时 | 体积 |
|------|------|------|
| Editor 模式 | 404-448ms | 86KB (384×384 PNG) |
| Play Mode | 1248ms | 90KB |

Play Mode 比 Editor 慢约 3 倍（游戏在跑、渲染更重），run_task 循环要计入。

### 视觉理解能力

MiniCPM-V 4.6 准确识别：角色数量/位置（左/右）/朝向（背对/面向）/是否持武器/场景类型（战斗/探索）/环境元素（树木/树桩/岩石）/3D Text 标记（“敌”字）。

### Action 决策 + schema 约束（最大收获）

对比两种 JSON 输出约束：

| 维度 | prompt 约束 | ollama `format` schema |
|------|------------|----------------------|
| JSON 合法率 | 100%（3/3）| 100%（3/3）|
| action 枚举合法 | ❌ 偶发越界（组合字符串）| ✅ 100% |
| 必需字段齐全 | ❌ 偶发漏 status/reason | ✅ 100% |
| 推理耗时 | 9-12s | **1.7-2.1s** ⚡ |
| API | OpenAI 兼容 `/v1/chat/completions` | ollama 原生 `/api/generate` |

**schema 约束让推理速度提升 5-6 倍**，且彻底消灭 Q2 风险。提案里建议的“GBNF grammar + 重试兜底”大幅简化——直接用 ollama `format` 即可。

### observe 模式端到端

总耗时 3.7-7s（截图 + 描述），可接受。observe 模式已可交付价值。

### 验证脚本

位于 `scripts/`：
- `vision-probe.mjs` — observe 模式（截图+描述）
- `vision-json-test.mjs` — prompt 约束 JSON 测试
- `vision-action-test.mjs` — prompt 约束 action 决策
- `vision-schema-test.mjs` — **schema 约束 action 决策（推荐方案）**

### 对实现优先级的影响

1. **vision-client 直接用 ollama `/api/generate` + format schema**，不用 OpenAI 兼容端点
2. **capture 命令降级为可选**，observe 模式直接用 eval 内联截图
3. **run_task 每步 ~3.2s**（截图 1.2s + 视觉 2s），20 步 ~64s，必须支持 incomplete 续跑
4. **schema 要给 x/y 加 `minimum:0, maximum:1`**
5. 实现顺序：vision-client.ts → unity_agent observe → 输入模拟 eval 验证 → run_task 循环
