# 视觉 agent 决策质量改进方案（press/release 语义混淆）

**Status:** 分析完成，待评审 → 实施
**Date:** 2026-07-30
**Author:** pi (AI)
**Related:** `proposals/2026-07-vision-multiframe-analysis.md`（后端迁移）、`lib/vision-client.ts`、`lib/action-map.ts`、`PiBridge/AgentRuntime/AgentPrompt.txt`、`PiBridge/AgentRuntime/AgentInput.cs`

---

## TL;DR（结论速览）

llama.cpp 迁移解决的是「后端传输层」问题（多图保序、不再空返回），run_task 端到端已能跑通、角色确实会动。**但模型决策质量仍差**：press/release 语义混淆、漏 key、不 release 只 press。

经读码定位，问题不在单一环节，而是 **schema + prompt + 兜底** 三层都给了小模型犯错的空间。按影响排序：

1. **Schema 层（已确认根因）**：`params.key` 当前是可选字段，schema 合法地接受 `press {}`。模型漏 key 不是「违规」而是「被允许」。
2. **Prompt 层**：`AgentPrompt.txt` 全是散文规则，零 JSON 示例。1.3B 小模型对「具体输出格式」的示范远比对「规则描述」敏感。
3. **action-map 兜底层**：`press 漏 key → wait` 是破坏性兜底——把模型「想前进」的意图直接变成空转，且不反馈给模型（模型以为按下了，实际没动，下一步继续错）。
4. **模型层**：1.3B 多步状态追踪弱（忘记按住了哪些键）。`GetAgentState` 已注入 `pressedKeys`，但 prompt 没明确告诉模型「读这个字段、据此决定 press 还是 release」。

**不是某一层能单独解决的**——schema 强制了 key 但模型仍可能填 "None"；prompt 给了示例但小模型仍会漂移；兜底再智能也只是补救。三层要一起改，且接受 1.3B 的能力上限，靠运行时安全网（5s 自动 release + 状态注入）兜住。

---

## 一、问题复现

run_task 5 步验收中观察到的三类决策错误（后端迁移已修复空返回后暴露出来的「真·模型」问题）：

| 编号 | 现象 | 模型实际输出 | 期望 |
|---|---|---|---|
| P1 | press/release 语义混淆 | `action:"press", params:{}` + `reason:"release W"` | 想松开就该是 `release` |
| P2 | 漏 key | `action:"press", params:{}`（无 key） | `params:{key:"W"}` |
| P3 | 不 release 只 press | 连续 `press W` / `press D`，从不 `release` | press 后适时 release |

P2 被 `actionToAgentInputSteps` 的纠错逻辑（`press/release 漏 key → wait`）兜成 wait，导致步骤 3-5 全空转。

---

## 二、根因分析

### 2.1 Schema 层：key 非必填（已确认根因）⭐ 主因

当前 `ACTION_SCHEMA`（`vision-client.ts`）：

```js
const ACTION_SCHEMA = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["press","release","interact","jump","wait"] },
        params: {
            type: "object",
            properties: {
                key: { type: "string", enum: ["W","A","S","D","Shift","TurnLeft","TurnRight"] },
            },
            // ❌ 没有 required: ["key"]
            // ❌ 没有 additionalProperties: false
        },
        status: { type: "string", enum: ["ongoing","success","stuck"] },
        reason: { type: "string" },
    },
    required: ["action", "params", "status", "reason"],
    // ❌ 顶层也没有 additionalProperties: false
};
```

**关键事实**：
- `params.key` 既不在 `params.required` 里，`params` 也没设 `additionalProperties: false`。schema 合法地允许 `params: {}`。
- 模型输出 `press {}` **不是 schema 违规**，是被允许的合法输出。所以「漏 key」本质是 schema 没要求 key。
- 顶层同样缺 `additionalProperties: false`，strict 模式下约束力打折。

**关于 json_schema strict 模式的限制（这是设计约束的核心）**：

llama.cpp 的 `response_format: {type:"json_schema", json_schema:{..., strict:true}}` 遵循 OpenAI Structured Outputs 规范。strict 模式下：
- **`properties` 里列出的字段必须全部进 `required`**——不允许「真可选」字段。
- 顶层不支持 `oneOf`/`anyOf`（无法做「press 时 key 必填、wait 时 key 不必填」的条件约束）。
- 必须显式 `additionalProperties: false`。

**结论**：无法用 schema 表达「key 仅对 press/release 必填」。只能二选一：
- (A) key 始终可选（现状）→ 模型会漏；
- (B) key 始终必填 + 加 `"None"` 哨兵值 → 非 key 动作（interact/jump/wait）填 `"None"`，press/release 填真键，兜底层把 `press + None` 当漏 key 处理。

**(B) 是 strict 模式下唯一能强制 key 出现的做法**，详见 3.1。

### 2.2 Prompt 层：纯散文，零 JSON 示例

`AgentPrompt.txt` 现状（全文）：

```
当前画面见附图。决定下一步动作。规则:
- 每步只选一个原始动作，不能组合
- press: 按住一个键开始持续动作，params.key 指定键：
    W=前进, S=后退, A=左移, D=右移, Shift=冲刺(需配合 WASD),
    TurnLeft=向左转视角, TurnRight=向右转视角
- release: 松开一个键停止该动作，params.key 同上
- interact: 交互（E 键），params 留空 {}
...
```

问题：
1. **零 JSON 示例**。全是散文规则，没有一行「输入这样→输出应该这样」的 concrete 例子。对 1.3B 小模型，**一个 concrete JSON 示例 > 十句规则描述**。小模型的指令遵循高度依赖 pattern matching，看到目标格式的样例才能稳定复刻。
2. **「params.key 指定键」是隐式要求**，没明说「press/release 的 key **必填**，不能省略」。隐式对大模型够用，对小模型不够。
3. **press/release 的区别靠「开始/停止」两个词**，没给对比示例。模型把 press/release 搞混（P1）正是没建立「press=开始持续，release=停止」的稳定映射。
4. **没引导模型用注入的 `pressedKeys` 状态**。`decideAction` 已把 `GetAgentState()`（含 `pressedKeys:[...]`）拼进 prompt，但 prompt 没说「看这个字段决定下一步」。状态追踪（P3）本可借这字段缓解，却没用上。
5. **没给多步序列的完整 JSON 轨迹**。只有一句「典型序列：press W → release W → ...」散文，没展示每步对应的 JSON 对象。

### 2.3 action-map 兜底层：破坏性 + 无反馈

`actionToAgentInputSteps`（`action-map.ts`）的纠错逻辑：

```ts
let effectiveAction = action.action;
if (effectiveAction === "wait" && key) effectiveAction = "press";           // wait 误带 key → press（合理）
if ((effectiveAction === "press" || effectiveAction === "release") && !key) effectiveAction = "wait";  // ❌
```

两个问题：

**(a) 破坏性兜底**：`press 漏 key → wait` 把模型「想前进」的意图直接吞成空转。模型想动，结果没动，浪费一步。更糟的是——

**(b) 无反馈闭环**：模型输出 `press {}`，被兜成 wait，但写回 `history` 的 result 是 `${steps.map(s=>s.label).join(",")} | 当前按住: ...`，对 wait 兜底实际是 `"wait | 当前按住: (无)"`。模型下一步看到「上一步 wait」，**不知道自己上一步的 press 被吞了**，可能再次输出 `press {}`，循环空转。这正是「步骤 3-5 全空转」的机制。

合理的兜底应满足：
- 尽量保留模型意图（能推断出 key 就用，而非直接 wait）；
- 把「你的 action 被纠正了」反馈进 history，让模型知道并修正。

### 2.4 模型层：1.3B 多步状态追踪上限

MiniCPM-V 4.6 = SigLIP2-400M 视觉编码器 + Qwen3.5-0.8B 语言模型（共 1.3B）。视觉理解尚可（单图描述准），但作为 agent 的**多步决策**有先天弱项：

| 能力 | 1.3B 表现 | 对应问题 |
|---|---|---|
| 单帧画面理解 | ✅ 可用（observe 验证） | — |
| 多帧时序理解 | ✅ llama.cpp 保序后可用 | — |
| 单步动作选择 | ⚠️ 概念对、标签易混（press vs release） | P1 |
| 严格按 schema 填字段 | ⚠️ 会漏可选字段 | P2 |
| 跨步状态追踪（记住按住了哪些键） | ❌ 弱，容易忘 release | P3 |

**1.3B 能力内可行的改进**：
- ✅ schema 强制字段（消除 P2 的漏 key——不是靠模型自觉，靠 schema 硬约束）
- ✅ concrete JSON 示例（pattern matching，稳定输出格式，缓解 P1 标签混淆）
- ✅ 显式引导读 `pressedKeys`（把「记忆」外部化到 prompt 上下文，缓解 P3）
- ⚠️ 复杂时序规划（「先走 3 步再转身」）仍不可靠——靠运行时安全网（5s 自动 release + 逐步重判）兜，不指望模型一次规划对

**不在 1.3B 能力内的**：
- ❌ 长时程自主任务规划（需更大模型或外部状态机）
- ❌ 完美的 press/release 时序（必有小概率漏 release，靠 `MAX_KEY_HOLD=5s` 自动 release 兜底）

---

## 三、改进方案

### 3.1 Schema：key 必填 + "None" 哨兵（解决 P2）

保持 `params` 结构（最小改动，不破坏 `action.params.key` 访问模式），但：
- `key` 枚举加 `"None"`；
- `params` 设 `required:["key"]` + `additionalProperties:false`；
- 顶层设 `additionalProperties:false`。

```js
const ACTION_SCHEMA = {
    type: "object",
    properties: {
        action: { type: "string", enum: ["press","release","interact","jump","wait"] },
        params: {
            type: "object",
            properties: {
                key: { type: "string", enum: ["W","A","S","D","Shift","TurnLeft","TurnRight","None"] },
            },
            required: ["key"],
            additionalProperties: false,
        },
        status: { type: "string", enum: ["ongoing","success","stuck"] },
        reason: { type: "string" },
    },
    required: ["action", "params", "status", "reason"],
    additionalProperties: false,
};
```

**效果**：strict 模式强制每次都输出 `params.key`。`press {key:"None"}` 仍可能发生（模型对非 key 动作误填 None 到 press），但兜底层处理（见 3.3）。

**类型侧**（`AgentAction`）：
```ts
params: {
    key: "W" | "A" | "S" | "D" | "Shift" | "TurnLeft" | "TurnRight" | "None";
    // 去掉 ?，key 必填
};
```

**权衡**：
- (A) 保持 params 嵌套（本方案）：改动最小，模型已在输出 params 对象。
- (B) 扁平化到顶层 `key`：对小模型更友好（少一层嵌套），但要改 `action.params.key`→`action.key` 访问点 + 类型。**作为备选**——若 (A) 实测模型仍频繁把 None 填到 press，再上 (B)。

### 3.2 Prompt：加 concrete JSON 示例 + 状态追踪指引（解决 P1、P3）

重写 `AgentPrompt.txt`，核心改动：
1. **明示 key 必填**：`press 和 release 的 params.key 必填，不能为 {}。`
2. **给 2-3 个完整 JSON 示例**（含 press / release / wait 三种，展示 key 填法）。
3. **对比 press vs release**：一句话 + 示例讲清「press=开始持续，release=停止」。
4. **引导读 pressedKeys**：明示「先看当前 agent 状态的 pressedKeys，据此决定 press 新键 / release 已按键 / 继续」。
5. **保持精简**：小模型对长 prompt 注意力衰减，示例 + 关键规则即可，砍冗余散文。

草案（节选）：

```
当前画面见附图。已执行步骤见上文。决定下一步动作。

【输出格式】每步输出一个 JSON：
  press   按住某键开始持续动作。params.key 必填（W/A/S/D/Shift/TurnLeft/TurnRight）。
  release 松开某键停止该动作。params.key 必填，同上。
  interact 交互(E)。params.key 填 "None"。
  jump    跳跃(空格)。params.key 填 "None"。
  wait    原地观察不动。params.key 填 "None"。
键含义：W前 S后 A左 D右 Shift冲刺 TurnLeft左转 TurnRight右转

【press vs release】press=开始按住(角色开始动)，release=松开(角色停)。
  要前进：press W → 走 → release W 停。
  不是 press W 再 press W，而是 press W 后等到了再 release W。

【示例】
  {"action":"press","params":{"key":"W"},"status":"ongoing","reason":"目标在前方，开始前进"}
  {"action":"release","params":{"key":"W"},"status":"ongoing","reason":"已接近目标，停下观察"}
  {"action":"wait","params":{"key":"None"},"status":"ongoing","reason":"观察四周找路"}

【状态追踪】先看"当前 agent 状态"里的 pressedKeys：
  - 若 W 在 pressedKeys 里 → 还在走，要么继续走(不再 press W)，要么 release W 停下。
  - 不要重复 press 已在 pressedKeys 里的键。
  - 要转向就 press TurnLeft/TurnRight，转够 release。

【主动移动】任务要移动时必须 press WASD，不要连续 wait。看不到目标就 press TurnLeft/TurnRight 环顾。

【status】达成目标→success；确实无路(反复撞墙/不动)→stuck；其余→ongoing。首步必 ongoing。
  不要轻易 stuck。单键超 5 秒会自动 release。
```

### 3.3 action-map：智能兜底 + 反馈闭环（缓解 P2 残留 + 修闭环）

替换「press 漏 key → wait」为分级兜底：

```ts
export function actionToAgentInputSteps(action: AgentAction): ActionStep[] {
    const steps: ActionStep[] = [];
    let key = action.params.key;
    const KEY_ENUM = ["W","A","S","D","Shift","TurnLeft","TurnRight"];

    // None / 缺失 → 视为漏 key
    const hasKey = key && key !== "None";

    // 兜底 1：wait 误带真 key → press（保留，合理）
    let effectiveAction = action.action;
    if (effectiveAction === "wait" && hasKey) effectiveAction = "press";

    // 兜底 2：press/release 漏 key → 从 reason 推断
    if ((effectiveAction === "press" || effectiveAction === "release") && !hasKey) {
        const inferred = inferKeyFromReason(action.reason);
        if (inferred) {
            key = inferred;
            // 标记被纠正，供 run_task 写回 history 反馈模型
            (action as any).__corrected = `从 reason 推断 key=${inferred}`;
        } else {
            // 兜底 3：release 无 key 且有按键按住 → release 最近按下的（"stop everything" 语义）
            //        press 无 key 且无法推断 → wait（破坏性，但反馈给模型）
            if (effectiveAction === "release") {
                // 由 run_task 传入 pressedKeys 处理（见下）
                effectiveAction = "wait"; // 占位，实际由 run_task 用 GetPressedKeys 兜
            } else {
                effectiveAction = "wait";
            }
        }
    }
    // ... 其余 switch 不变
}

// 从 reason 文本里捞 key 名。顺序：长串先匹配（TurnLeft/TurnRight/Shift 先于单字母）。
function inferKeyFromReason(reason: string): string | undefined {
    const ordered = ["TurnLeft","TurnRight","Shift","W","A","S","D"];
    for (const k of ordered) if (reason.includes(k)) return k;
    return undefined;
}
```

**关键改动**：
- **从 reason 推断 key**：模型常在 reason 里写「release W」却漏 params.key（P1 的典型表现）。捞出来用，保留意图。
- **release 无 key → release 最近按键**：`run_task` 已查 `GetPressedKeys()`，可传入 `actionToAgentInputSteps`，若 release 无 key 且有按键按住，release 最后按下的那个（「停掉一切」语义，比 wait 有用）。
- **反馈闭环**：被纠正的 action 打 `__corrected` 标记，`run_task` 写 history 时带上，如 `result: "press W (纠正：原漏 key，从 reason 推断) | 当前按住: W"`。模型下一步看到「我上步漏了 key 被纠正」，形成修正闭环。

### 3.4 模型层：接受 1.3B 上限，靠运行时安全网

不指望模型完美，靠机制兜：
- ✅ **5s 自动 release**（`AgentInput.MAX_KEY_HOLD`）：模型忘 release 时强制松手（P3 安全网）。已实现。
- ✅ **状态注入**（`GetAgentState` → `pressedKeys`）：把「记忆」外部化进 prompt。已实现，靠 3.2 prompt 引导模型用。
- ✅ **逐步重判**：每步重新截图+决策，不依赖模型长程规划。已实现。
- 🆕 **重复 press 检测**：`run_task` 发现模型 press 了已在 `pressedKeys` 里的键，可跳过注入（`PressKey` 重设 true 无害但浪费步），并在 history 反馈「W 已按住，无需重复 press」。

---

## 四、实施清单

| # | 文件 | 改动 | 解决 |
|---|---|---|---|
| 1 | `lib/vision-client.ts` | `ACTION_SCHEMA` 加 `additionalProperties:false`（顶层+params）、`params.required:["key"]`、key 枚举加 `"None"`；`AgentAction.params.key` 类型去 `?` 加 `"None"` | P2 |
| 2 | `PiBridge/AgentRuntime/AgentPrompt.txt` | 按 3.2 重写：加 JSON 示例、明示 key 必填、引导读 pressedKeys | P1/P3 |
| 3 | `lib/action-map.ts` | `actionToAgentInputSteps` 改分级兜底（reason 推断 key + release-all）；加 `inferKeyFromReason` | P2 残留 |
| 4 | `tools/unity-agent.ts` | `run_task` 把 `GetPressedKeys()` 结果传入 `actionToAgentInputSteps`；history 写回 `__corrected` 反馈；重复 press 检测 | 闭环 |
| 5 | （备选）扁平化 schema | 若 1-4 实测模型仍把 None 填到 press，再上方案 B（key 提到顶层） | — |

改动 1-4 是一组，建议一起实施一起验收。

---

## 五、验收计划

在 CourseProject（Unity 2019.4.36f1，Play Mode 已可用）跑同一个任务对比前后：

**任务**：「走到红色 checkpoint 触发它」（已知可移动的场景）。

**对比指标**：
| 指标 | 改进前（当前） | 期望改进后 |
|---|---|---|
| 漏 key 频率（press/release 无 key） | 步骤 3-5 全漏 | ≤1 次/任务 |
| press/release 标签混淆 | 出现 `press{} reason:"release W"` | 不出现 |
| 连续 wait 步数 | 3+ | ≤1 |
| 重复 press 同一已按按键 | 出现 | 不出现（被反馈纠正） |
| 角色实际位移 | 有但后半程空转 | 全程推进 |
| taskStatus | incomplete | success 或接近 |

**回归**：observe 模式（单图 askVision）不受影响，确认无回归。

---

## 六、风险与备选

- **schema 加 None 哨兵的噪声**：模型可能对 wait 也输出真 key（如 `wait {key:"W"}`）。兜底层对非 key 动作忽略 key，无害但属噪声。可接受。
- **reason 推断 key 的误匹配**：`inferKeyFromReason` 顺序匹配，若 reason 同时含多 key（如「W 和 D」）只取第一个。概率低，且只作为漏 key 的兜底，非主路径。
- **若三层改完仍差**：说明 1.3B 对 press/release 时序确实到顶，考虑：
  - (a) 换更大的 VLM（如 Qwen2-VL-7B / MiniCPM-V 2.6 8B），但推理更慢；
  - (b) 回退到「duration_ms 计时」范式（`Move(x,z,duration)`，AgentInput.cs 仍保留该 API）：模型只选「方向+时长」，无 press/release 时序负担。代价是模型要猜时长（但小模型猜时长比记时序容易）。`actionToSteps`（Win32 版）和 `AgentInput.Move/Turn` 已支持这条路，是现成退路。
