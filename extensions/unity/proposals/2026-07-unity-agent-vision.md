# Unity Agent Vision — 视觉驱动的 Unity 自动化测试与调试工具

**Status:** 提案（草稿）  
**Date:** 2026-07-29  
**Author:** pi (AI)  
**Related:** PiBridge.cs、MiniCPM-V 4.6 本地部署、`unity_command` / `unity_events` 现有工具

---

## 动机

当前 PiBridge 已经能让 Agent 通过 `unity_command eval` 操控 Unity Editor，但它是 **盲操作**——Agent 看不到 Play Mode 的画面，只能靠 Console 日志和代码推理来判断游戏状态。

真实场景中很多判断是纯视觉的：
- 玩家是否走到了红色 checkpoint？
- UI 上的提示文字是否正确弹出？
- 某个特效是否播放了？
- 物体的颜色/位置/状态对不对？

我们已经在本地部署了 **MiniCPM-V 4.6**（1.3B 多模态模型，165 tok/s 看图），跑在 `llama-server` 上，通过 HTTP API 调用。把这个视觉能力接入 PiBridge，Agent 就能 **看见 Unity 画面并做出判断**。

另外，这也是为将来接入更强视觉模型（GPT-4V、Qwen2-VL 等）预留接口——视觉模块是可插拔的。

---

## 设计原则

1. **视觉 Agent 是 unity_command 的上层抽象，不是替代品**  
   `unity_command` 是原子操作（eval/play/status），`unity_agent` 是组合操作（截图→看→决策→执行→循环）。

2. **视觉模型只看不说操作**  
   MiniCPM-V 负责分析画面、输出结构化 JSON，不直接操控 Unity。操作由 Agent 通过 `unity_command` 执行。

3. **PiBridge 只需加一个「截图」新命令**  
   当前 roadmap 已有 P0 截图需求，这是视觉闭环中唯一在 C# 侧需要新增的原语。其余全部复用现有 eval/play/log 能力。

4. **可插拔视觉后端**  
   TypeScript 层封装视觉调用，不直接依赖 MiniCPM-V。切换模型只需改 endpoint 和 prompt 模板。

---

## 架构

```
Pi（文本模型）
  │  tool call: unity_agent_run_task / unity_agent_observe
  ▼
PiBridge Extension (TypeScript)
  │
  ├── unity_agent.ts          ← 新工具：视觉循环编排
  │   ├── 调用 PiBridge /screenshot → 拿 base64 截图
  │   ├── 调用视觉模型 API（MiniCPM-V / 其他）
  │   ├── 解析返回的结构化 JSON
  │   └── 通过 PiBridge 执行操作 / 判断完成条件
  │
  ├── unity_command.ts        ← 已有：原子操作
  ├── unity_events.ts         ← 已有：事件订阅
  └── ...                     ← 其他已有工具
        │
        │ HTTP
        ▼
PiBridge C# (Unity Editor)
  │
  ├── screenshot              ← 新增命令（P0）
  ├── eval / play / status    ← 已有命令
  └── manage-subscriptions    ← 已有命令
```

### 数据流

```
一个完整的测试循环:

  Agent 调用 unity_agent_run_task
      │
      ▼
  Extension 进入循环:
      │
      ├─ 1. POST /screenshot → 返回 base64
      ├─ 2. POST 视觉模型 API:
      │      system: "你是 Unity 测试助手。任务: {task}。可选操作: {actions}。"
      │      images: [当前截图(, 上一步截图)]
      │      → 返回: { action, params, status, reason }
      │
      ├─ 3. 如果 status === "success" → 跳出循环，回报结果
      ├─ 4. 如果 status === "stuck" → 跳出循环，回报失败
      ├─ 5. 否则 → POST unity_command eval 执行 action
      ├─ 6. 记录日志
      └─ 回到 1 (直到 max_steps)
      │
      ▼
  返回结果给 Pi:
      { success, steps, log: [...], final_screenshot, task }
```

---

## PiBridge 新增命令: screenshot

### 接口

```
POST /screenshot
Body: { "mode": "game-view" | "scene-view" }
```

### 返回

```json
{
  "ok": true,
  "result": {
    "image": "base64...",
    "width": 1920,
    "height": 1080,
    "format": "png",
    "mode": "game-view",
    "isPlaying": true
  }
}
```

### 实现要点

- mode=game-view：通过 `Camera.main` 或 `Camera.allCameras` 渲染到 RenderTexture
- mode=scene-view：通过 `SceneView.lastActiveSceneView.camera` 截图
- 异步风险：`ScreenCapture.CaptureScreenshotAsTexture` 是协程，建议直接走 RenderTexture 同步路径
- 归入 P0 优先级（roadmap 已有）

---

## 新工具: unity_agent_observe

单次观察工具，不执行操作。用于快速查看当前画面。

### 参数

```typescript
parameters: {
    prompt: {
        type: "string",
        description: "分析指令，如'画面上有哪些UI元素？'、'玩家当前位置在哪？'"
    },
    mode: {
        type: "string",
        enum: ["game-view", "scene-view"],
        default: "game-view"
    },
    frames: {
        type: "number",
        default: 1,
        description: "传入帧数。1=单张截图，>1=连续帧序列（可判断运动）"
    }
}
```

### 返回

```
{
  "image_analysis": "画面描述...",
  "objects": ["player", "checkpoint", "enemy"],
  "status": "观察结果摘要"
}
```

### 实现流程

1. 调 PiBridge `/screenshot` 获取截图
2. 如果 frames > 1，间隔 ~0.5s 连续截图，凑成帧序列
3. 发送到视觉模型 API
4. 返回分析结果

---

## 新工具: unity_agent_run_task

高级任务工具，内部执行截图→看→决策→操作的循环。

### 参数

```typescript
parameters: {
    task: {
        type: "string",
        description: "任务描述，如'走到红色 checkpoint 并触发它'"
    },
    max_steps: {
        type: "number",
        default: 20,
        description: "最大步数，超出则判定为失败"
    },
    actions: {
        type: "string",
        default: "",
        description: "可选动作定义 JSON，为空则让视觉模型自由输出"
    },
    mode: {
        type: "string",
        enum: ["game-view", "scene-view"],
        default: "game-view"
    },
    success_hint: {
        type: "string",
        default: "",
        description: "成功提示，如'画面中央出现 胜利!'文字"
    },
    interval_ms: {
        type: "number",
        default: 1000,
        description: "每步之间的间隔（毫秒），给游戏时间反应"
    }
}
```

### 完整循环实现（伪代码）

```typescript
async function runAgentTask(params, ctx) {
    const { task, max_steps, actions, mode, success_hint, interval_ms } = params;
    const log: AgentStepLog[] = [];
    let previousImage = null;

    for (let step = 1; step <= max_steps; step++) {
        // 1. 截图
        const screenshot = await piBridge.command("screenshot", { mode });
        if (!screenshot.ok) return { success: false, error: "screenshot failed", log };

        // 2. 构建视觉请求
        const images = [screenshot.image];
        if (previousImage) images.push(previousImage);

        const visionPrompt = buildVisionPrompt(task, actions, success_hint, log);

        // 3. 调用视觉模型
        const visionResult = await callVisionModel(images, visionPrompt);
        // 返回: { action: "move_forward" | "turn_left" | ..., params: {...}, status: "in_progress" | "success" | "stuck", reason: "..." }

        // 4. 检查终止条件
        if (visionResult.status === "success") {
            return { success: true, steps: step, log, final_screenshot: screenshot.image };
        }
        if (visionResult.status === "stuck") {
            return { success: false, steps: step, log, final_screenshot: screenshot.image, error: visionResult.reason };
        }

        // 5. 执行操作
        const actionResult = await executeAction(visionResult.action, visionResult.params);
        if (!actionResult.ok) {
            return { success: false, steps: step, log, error: `Action failed: ${actionResult.error}` };
        }

        // 6. 记录日志
        log.push({
            step,
            action: visionResult.action,
            reason: visionResult.reason,
            image_hash: sha256(screenshot.image).slice(0, 8)
        });

        previousImage = screenshot.image;

        // 7. 等待
        await sleep(interval_ms);
    }

    return { success: false, steps: max_steps, log, error: "max_steps reached without completion" };
}
```

---

## 视觉模型 Prompt 模板设计

### System Prompt

```
You are a Unity game testing assistant running inside a Play Mode session.
Your job is to look at the game screen and decide what action to take next.

TASK: {task}

AVAILABLE ACTIONS (output one of these as the "action" field):
{actions_list}

SUCCESS CONDITION: {success_hint}

OUTPUT FORMAT (JSON only, no other text):
{
  "reason": "brief analysis of what you see",
  "action": "action_name",
  "params": { ... },
  "status": "in_progress | success | stuck"
}
```

### 内置默认动作表

当 actions 参数为空时，使用以下默认动作空间：

| 动作 | 参数 | 说明 |
|---|---|---|
| `move_forward` | `{duration: 0.3}` | 前进 |
| `move_backward` | `{duration: 0.3}` | 后退 |
| `turn_left` | `{angle: 15}` | 左转视角 |
| `turn_right` | `{angle: 15}` | 右转视角 |
| `look_up` | `{angle: 15}` | 抬头 |
| `look_down` | `{angle: 15}` | 低头 |
| `interact` | `{}` | 交互/E键 |
| `jump` | `{}` | 跳跃 |
| `wait` | `{duration: 1.0}` | 等待 |
| `done` | `{}` | 任务完成 |

### 动作到 C# eval 的映射

TypeScript 侧将动作名映射为 PiBridge eval 命令：

```typescript
const ACTION_MAP = {
    move_forward:  `Input.GetKey(KeyCode.W);`,
    move_backward: `Input.GetKey(KeyCode.S);`,
    turn_left:     `{ var a = Camera.main.transform; a.Rotate(Vector3.up, -15); }`,
    turn_right:    `{ var a = Camera.main.transform; a.Rotate(Vector3.up, 15); }`,
    interact:      `{ /* 触发交互 */ }`,
    jump:          `Input.GetButtonDown("Jump");`,
    wait:          `/* wait handled by TypeScript timer */`,
    done:          `/* no-op, loop exits */`,
};
```

---

## 与已有 Event 系统的结合

视觉 Agent 可以和 `unity_events` 配合使用：

1. Agent 订阅 `playmode_exited` 事件
2. 启动视觉 Agent 任务（自动进入 Play Mode）
3. 如果 Play Mode 崩溃退出，SSE 推送事件，Agent 能感知到并终止视觉循环

但视觉循环内部**不依赖**事件系统——它是一个自包含的轮询循环。事件系统是补充，不是前置条件。

---

## 视觉模型后端接口

TypeScript 层需要抽象一个 `VisionBackend` 接口，让后续可以切换不同模型：

```typescript
interface VisionBackend {
    analyze(images: string[], prompt: string): Promise<VisionResult>;
}

// MiniCPM-V 实现
class MiniCPMVBackend implements VisionBackend {
    constructor(private endpoint: string) {}

    async analyze(images: string[], prompt: string): Promise<VisionResult> {
        const content = images.map(b64 => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${b64}` }
        }));
        content.push({ type: "text", text: prompt });

        const res = await fetch(`${this.endpoint}/v1/chat/completions`, {
            method: "POST",
            body: JSON.stringify({
                messages: [{ role: "user", content }],
                max_tokens: 500,
                temperature: 0.1,
            })
        });
        // ... parse structured JSON from response
    }
}
```

这样即使将来换用 GPT-4V、Qwen2-VL、或者其他本地模型，只需要新增一个 Backend 实现类。

---

## 当前不做的事

| 功能 | 原因 |
|------|------|
| **实时视频流（>10fps）** | MiniCPM-V 做不到，架构上也不是设计目标 |
| **鼠标精确操控** | eval 模拟鼠标精度有限，建议用 Input 事件 |
| **多 Unity 实例** | 使用场景极少 |
| **录屏回放** | 超出作用范围，属于录制工具 |
| **移动端/Console 远程操控** | PiBridge 定位是本地 Editor |

---

## 后续可能的演进

- **Stuck 检测自动回退**：视觉模型连续输出相同动作时，自动调整策略或上报
- **成功条件由视觉模型自主判断**：当前 success 由视觉模型输出字段决定，可改为允许多种判断来源（断言回调、日志匹配等）
- **多模型协作**：MiniCPM-V 负责快速画面分析，决策交给更强模型
- **动作空间自定义**：允许通过参数传入自定义动作映射表

---

## 时间线估计

| 步骤 | 工作量 |
|------|--------|
| PiBridge C# `screenshot` 命令 | ~30 行 C# |
| TypeScript `unity_agent.ts` 工具 | ~200 行 TS |
| `index.ts` 注册 + formatter | ~30 行 TS |
| 视觉后端抽象 + MiniCPM-V 实现 | ~80 行 TS |
| 测试端到端 | ~1h |
| **总计** | **~半天** |

---

## 视觉模型部署要求

本工具依赖一个运行在本地的多模态视觉模型服务。当前选用 **MiniCPM-V 4.6**
（1.3B 参数，SigLIP2 视觉编码器 + Qwen3.5 语言模型），通过 llama.cpp 部署，
提供 OpenAI 兼容的 HTTP API。

### 开发与目标平台

| 环境 | 说明 |
|------|------|
| **开发验证** | macOS Apple Silicon（M4, 16GB） |
| **目标平台** | Windows（用户实际 Unity 开发环境） |
| **Linux** | 也完全兼容，llama.cpp 全平台支持 |

> 当前在 macOS 上完成概念验证，正式开发在 Windows 上进行。
> 两个平台在部署方式上无实质差异。

### 模型部署方式

**推荐：llama.cpp + llama-server**（跨平台，OpenAI 兼容 API）

```bash
# 下载模型（平台无关）
pip install huggingface-hub
python3 -c "from huggingface_hub import hf_hub_download; hf_hub_download('openbmb/MiniCPM-V-4.6-gguf', 'MiniCPM-V-4_6-Q4_K_M.gguf', local_dir='.'); hf_hub_download('openbmb/MiniCPM-V-4.6-gguf', 'mmproj-model-f16.gguf', local_dir='.')"

# 启动服务
llama-server \
  -m MiniCPM-V-4_6-Q4_K_M.gguf \
  --mmproj mmproj-model-f16.gguf \
  -ngl 99 \
  --host 127.0.0.1 \
  --port 18080
```

**合计约 1.5 GB** 磁盘空间，GPU 显存需求约 2~3 GB。
macOS 用户可通过 `brew install llama.cpp` 安装；Windows 用户
可从 [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) 下载预编译包。

### 所需文件

| 文件 | 大小 | 说明 |
|------|------|------|
| `MiniCPM-V-4_6-Q4_K_M.gguf` | ~505 MB | 主模型（Q4_K_M 量化，推荐） |
| `mmproj-model-f16.gguf` | ~1.0 GB | 视觉编码器投影矩阵 |

低显存场景可选用 `Q4_0`（478 MB）或开启 16× Token 压缩模式。

### 视觉后端 API

TypeScript 层通过标准 OpenAI Chat Completions 接口调用：

```
POST http://localhost:18080/v1/chat/completions
Content-Type: application/json

{"messages":[{"role":"user","content":[
  {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}},
  {"type":"text","text":"Describe this image"}
]]}
```

其他兼容 OpenAI API 的视觉模型（GPT-4V、Qwen2-VL 等）只需修改 endpoint 即可接入。

---

## 参考

- [PiBridge Roadmap](../proposals/2026-07-pibridge-roadmap.md)
- [MiniCPM-V 4.6 HuggingFace](https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
