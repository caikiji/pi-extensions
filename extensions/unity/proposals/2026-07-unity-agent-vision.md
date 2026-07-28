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
