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

Pi（文本模型）通过这个工具下达指令，工具内部自行完成截图→视觉分析→操作 Unity 的闭环。

### 工具定义

```typescript
pi.registerTool({
    name: "unity_agent",
    description: "操控 Unity Play Mode 中的游戏。支持两种模式：\n" +
        "- observe: 截取当前画面并分析，不做操作\n" +
        "- run_task: 在 Play Mode 中执行一个视觉任务，内部循环截图→分析→操作直到完成",
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
  → 截图 → 送 MiniCPM-V → 返回分析结果
```

一次调用，截图 + 分析，不做操作。

### run_task 模式

```
Pi → unity_agent(mode: "run_task", prompt: "走到红色 checkpoint 触发它")

工具内部循环:
  1. 截图
  2. 送 MiniCPM-V 分析，返回 { action, params, status, reason }
  3. 如果 status === "success" → 返回结果
  4. 如果 status === "stuck"   → 返回失败
  5. 否则 → 通过 unity_command eval 执行操作（预定义动作映射）
  6. 回到 1
```

工具内部封装了动作映射，不暴露给调用方：

```typescript
// 预定义动作 → C# eval 代码，run_task 内部使用
const ACTIONS = {
    move_forward:  "Input.GetKey(KeyCode.W);",
    turn_left:     "Camera.main.transform.Rotate(Vector3.up, -15);",
    interact:      "/* 触发交互 */",
    // ...
};
```

### PiBridge 需要加的

**只加一个命令：`screenshot`**（返回 game-view / scene-view 截图 base64）。eval / play / status 都已存在，全部复用。

### 视觉模型部署

本地需要跑一个 MiniCPM-V 4.6 服务（llama.cpp + llama-server，OpenAI 兼容 API）：

```
llama-server -m MiniCPM-V-4_6-Q4_K_M.gguf --mmproj mmproj-model-f16.gguf -ngl 99 --port 18080
```

约 1.5 GB 磁盘，2~3 GB 显存。开发在 macOS 上验证，目标平台 Windows，llama.cpp 全平台支持。

---

## 不做的事

- 不加其他新工具/新命令。一个 `unity_agent` 涵盖所有场景。
- 不加视频流、鼠标精确操控、多实例等复杂功能。

---

## 参考

- [PiBridge Roadmap](../proposals/2026-07-pibridge-roadmap.md)
- [MiniCPM-V 4.6 HuggingFace](https://huggingface.co/openbmb/MiniCPM-V-4.6-gguf)
- [llama.cpp](https://github.com/ggml-org/llama.cpp)
