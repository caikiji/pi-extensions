/**
 * vision-client — MiniCPM-V 视觉模型客户端 + Unity 截图能力。
 *
 * 提供 unity_agent 工具所需的两个核心能力：
 *   1. captureScreen — 通过 PiBridge eval 内联 RenderTexture 截图，返回 base64 PNG
 *   2. 视觉分析 — 调 ollama MiniCPM-V，支持两种模式：
 *      - askVision: 自由文本描述（observe 模式，用 OpenAI 兼容端点）
 *      - decideAction: 结构化 JSON action 决策（run_task 模式，用 ollama 原生 + format schema）
 *
 * 为什么两种端点：
 *   - observe 模式要长文本描述，OpenAI 兼容 /v1/chat/completions 足够且语义清晰
 *   - run_task 的 action 决策要严格 JSON，ollama 原生 /api/generate 的 format 参数
 *     能从语法层面强制 schema（action 枚举、required 字段），实测推理速度还快 5-6 倍
 *     （1.7-2.1s vs prompt 约束的 9-12s）。
 *
 * Phase 0 验证（2026-07-29）：schema 约束下 JSON 100% 合法 + 字段齐全 + action 不越界。
 * 详见 proposals/2026-07-unity-agent-vision.md → Phase 0 验证报告。
 */

import { sendCommand, type BridgeResponse } from "./bridge-client.ts";

// ─── 配置 ──────────────────────────────────────────────────────────────────
// ollama 默认跑在 11434。允许环境变量覆盖，方便未来换 llama-server 或其他后端。
const OLLAMA_BASE_URL = process.env.PI_VISION_BASE_URL ?? "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.PI_VISION_MODEL ?? "minicpm-v4.6:latest";

/** 截图尺寸。MiniCPM-V 内部按 384 分块处理，再大无收益反而费带宽。 */
export const CAPTURE_WIDTH = 384;
export const CAPTURE_HEIGHT = 384;

// ─── 类型 ───────────────────────────────────────────────────────────────────
export interface CaptureResult {
	/** data:image/png;base64,... 形式的 data URL，可直接喂给 vision API */
	dataUrl: string;
	/** 不带前缀的纯 base64（ollama 原生 API 用） */
	base64: string;
	width: number;
	height: number;
	/** 截图耗时（ms） */
	captureMs: number;
	/** 截图时 Unity 是否在 Play Mode（来自 eval 执行时的 EditorApplication.isPlaying） */
	isPlaying: boolean;
}

/** run_task 模式下，模型决定的一个原子动作。 */
export interface AgentAction {
	action:
		| "press"
		| "release"
		| "interact"
		| "jump"
		| "wait";
	params: {
		key?: "W" | "A" | "S" | "D" | "Shift" | "TurnLeft" | "TurnRight";
	};
	status: "ongoing" | "success" | "stuck";
	reason: string;
}

/** 已执行的历史步骤，作为上下文送给模型。 */
export interface ActionHistory {
	action: string;
	result: string; // 简述这步的结果，如 "moved forward" / "no visible change"
}

export interface VisionError extends Error {
	code: "bridge" | "capture" | "ollama" | "parse";
}

function visionError(code: VisionError["code"], message: string): VisionError {
	const e = new Error(message) as VisionError;
	e.code = code;
	return e;
}

// ─── 1. 截图（eval 内联 RenderTexture）──────────────────────────────────────
//
// 不新增 PiBridge capture 命令——eval 内联截图完全够用（Phase 0 验证）。
// 代码写成 trailing-return 模式：最后一个语句是裸表达式，RoslynEval 会提升为返回值。
// 注意：
//   - 不能用 if/else 包裹末尾表达式（RoslynEval 的 ExtractTrailingExpression 只找最外层
//     block 的最后一个 ExpressionStatement，if/else 是 BlockStatement 会识别不到）
//   - 用 `?? throw` 做 null 检查，保持主体平铺
//   - `UnityEngine.Object` 全限定，避免和 `object`（System）歧义
const CAPTURE_EVAL_CODE = `
var cam = Camera.main ?? throw new System.Exception("no Camera.main");
int W = ${CAPTURE_WIDTH}, H = ${CAPTURE_HEIGHT};
var rt = new RenderTexture(W, H, 24, RenderTextureFormat.ARGB32);
cam.targetTexture = rt;
cam.Render();
var prev = RenderTexture.active;
RenderTexture.active = rt;
var tex = new Texture2D(W, H, TextureFormat.RGB24, false);
tex.ReadPixels(new Rect(0, 0, W, H), 0, 0);
tex.Apply();
cam.targetTexture = null;
RenderTexture.active = prev;
var bytes = ImageConversion.EncodeToPNG(tex);
var playing = EditorApplication.isPlaying;
UnityEngine.Object.DestroyImmediate(rt);
UnityEngine.Object.DestroyImmediate(tex);
new { png = System.Convert.ToBase64String(bytes), isPlaying = playing }
`.trim();

/**
 * 通过 PiBridge eval 截取当前 Game View 画面（Camera.main 视角）。
 *
 * @param port PiBridge 端口（来自 discoverBridge）
 * @param signal 取消信号
 * @returns CaptureResult，含 base64 PNG + isPlaying
 */
export async function captureScreen(
	port: number,
	signal?: AbortSignal,
): Promise<CaptureResult> {
	const t0 = Date.now();
	// eval 截图可能比普通命令慢（Play Mode 下 ~1.2s），给 30s 足够余量。
	const resp: BridgeResponse<{ value: { png: string; isPlaying: boolean } }> = await sendCommand(
		port,
		"eval",
		{ code: CAPTURE_EVAL_CODE },
		30000,
		signal,
	);
	const captureMs = Date.now() - t0;

	if (!resp.ok) {
		throw visionError("capture", `eval 截图失败: ${resp.error ?? "unknown"}`);
	}

	// RoslynEval 对匿名对象会序列化成 dict（{png, isPlaying}）。
	// 注意：result.value 可能是 {png, isPlaying}（如果 RoslynEval 把它当 plain object）
	// 也可能直接就是 dict。两处都兼容。
	const result = resp.result as { value?: { png: string; isPlaying: boolean }; png?: string; isPlaying?: boolean } | undefined;
	const png = result?.value?.png ?? result?.png;
	const isPlaying = result?.value?.isPlaying ?? result?.isPlaying ?? false;

	if (typeof png !== "string" || png.length === 0) {
		throw visionError("capture", `eval 返回的 png 字段无效: ${JSON.stringify(result).slice(0, 200)}`);
	}

	return {
		dataUrl: `data:image/png;base64,${png}`,
		base64: png,
		width: CAPTURE_WIDTH,
		height: CAPTURE_HEIGHT,
		captureMs,
		isPlaying,
	};
}

// ─── 2a. observe 模式：自由文本描述（OpenAI 兼容端点）─────────────────────
/**
 * 让 MiniCPM-V 自由分析当前画面，返回文本描述。
 * 用于 unity_agent observe 模式。
 *
 * @param image data URL（来自 captureScreen.dataUrl）
 * @param prompt 分析指令，如 "画面上有哪些 UI 元素？"
 */
export async function askVision(image: string, prompt: string, signal?: AbortSignal): Promise<string> {
	const url = `${OLLAMA_BASE_URL}/v1/chat/completions`;
	const body = {
		model: OLLAMA_MODEL,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: image } },
					{ type: "text", text: prompt },
				],
			},
		],
		temperature: 0.3,
	};

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		throw visionError("ollama", `ollama /v1/chat/completions HTTP ${res.status}: ${await res.text()}`);
	}
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const content = json.choices?.[0]?.message?.content;
	if (!content) {
		throw visionError("ollama", "ollama 返回的 content 为空");
	}
	return content;
}

/**
 * 任务结束总结：让视觉模型回顾全部历史帧 + 当前画面，总结
 * “我尝试了什么、当前状态、为什么任务完成/未完成”，作为返回给调用方的摘要。
 * 传全量帧命中 ollama prompt cache（与 decideAction 共享前缀）。
 */
export async function summarizeTask(
	recentFrames: string[],
	currentFrame: string,
	taskGoal: string,
	history: ActionHistory[],
	status: string,
	signal?: AbortSignal,
): Promise<string> {
	const historyText = history.length === 0
		? "（无历史步骤）"
		: history.map((h, i) => `  步骤${i + 1}: action=${h.action}, result=${h.result}`).join("\n");
	const frameCount = recentFrames.length + 1;
	const images = [...recentFrames, currentFrame];
	const prompt = `你是游戏 AI agent。任务已完成或中止，请总结。

任务目标: ${taskGoal}

附图是全部历史画面共 ${frameCount} 帧（最早→最近，最后一张是结束时的画面）。

已执行的历史步骤:
${historyText}

任务最终状态: ${status}

请总结：
1. 你尝试了什么（主要动作序列）
2. 当前角色/场景状态（基于最后一张画面）
3. 任务是否达成？如果未达成，说明原因（找不到目标/卡住/超时等）
4. 如果未完成，建议下一步怎么做

用简洁的中文回答，不超过 200 字。`;

	const url = `${OLLAMA_BASE_URL}/v1/chat/completions`;
	const body = {
		model: OLLAMA_MODEL,
		messages: [
			{
				role: "user",
				content: [
					...images.map((b64) => ({
						type: "image_url",
						image_url: { url: `data:image/png;base64,${b64}` },
					})),
					{ type: "text", text: prompt },
					],
				},
			],
		temperature: 0.3,
	};

	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
		signal,
	});
	if (!res.ok) {
		throw visionError("ollama", `ollama summarizeTask HTTP ${res.status}: ${await res.text()}`);
	}
	const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
	const content = json.choices?.[0]?.message?.content;
	if (!content) {
		throw visionError("ollama", "summarizeTask 返回的 content 为空");
	}
	return content;
}

//
// JSON Schema 强制约束。Phase 0 实测：100% 合法 + action 不越界 + 字段齐全 +
// 推理 1.7-2.1s（比 prompt 约束快 5-6 倍）。
//
// x/y 加 minimum/maximum，否则模型会输出 x:100 等越界值。
const ACTION_SCHEMA = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["press", "release", "interact", "jump", "wait"],
		},
		params: {
			type: "object",
			properties: {
				key: { type: "string", enum: ["W", "A", "S", "D", "Shift", "TurnLeft", "TurnRight"] },
			},
		},
		status: {
			type: "string",
			enum: ["ongoing", "success", "stuck"],
		},
		reason: { type: "string" },
	},
	required: ["action", "params", "status", "reason"],
};

/**
 * 让 MiniCPM-V 基于当前画面 + 任务目标，决定下一步原子动作。
 * 返回严格符合 schema 的 AgentAction。
 *
 * @param base64 不带 data: 前缀的纯 base64 PNG
 * @param taskGoal 任务描述，如 "走到红色 checkpoint 触发它"
 * @param history 已执行步骤（提供上下文，让模型知道之前做了什么）
 * @param recentFrames 最近几帧的 base64 图片（时间顺序，最早→最近），让模型看到运动轨迹
 * @param decisionPrompt 决策规则提示词（从 PiBridge AgentInput.GetDecisionPrompt 取回，项目可自定义）
 */
export async function decideAction(
	base64: string,
	taskGoal: string,
	history: ActionHistory[] = [],
	recentFrames: string[] = [],
	decisionPrompt?: string,
	agentState?: string,
	signal?: AbortSignal,
): Promise<{ action: AgentAction; durationMs: number }> {
	const historyText =
		history.length === 0
			? "（这是任务第一步，无历史）"
			: history.map((h, i) => `  步骤${i + 1}: action=${h.action}, result=${h.result}`).join("\n");

	const frameCount = recentFrames.length + 1;
	const frameDesc = frameCount <= 1
		? "当前画面见附图（1 帧）。"
		: `附图是全部历史画面共 ${frameCount} 帧，按时间顺序排列（最早→最近），最后一张是当前画面。通过对比这些帧你可以看出角色的运动轨迹和视角变化，判断之前的动作是否生效、目标是否在移动，记住目标出现过方位。`;

	const rules = decisionPrompt ?? "当前画面见附图。决定下一步动作。";

	const prompt = `你是游戏 AI agent。当前在 Unity Play Mode 中运行一个游戏。

任务目标: ${taskGoal}

${frameDesc}

当前 agent 状态（重要，据此决定下一步）:
${agentState ?? "(未知)"}

已执行的历史步骤:
${historyText}

${rules}`;

	const url = `${OLLAMA_BASE_URL}/api/generate`;
	const t0 = Date.now();
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: OLLAMA_MODEL,
			prompt,
			images: [...recentFrames, base64],
			format: ACTION_SCHEMA,
			stream: false,
			options: { temperature: 0.2 },
		}),
		signal,
	});
	const durationMs = Date.now() - t0;

	if (!res.ok) {
		throw visionError("ollama", `ollama /api/generate HTTP ${res.status}: ${await res.text()}`);
	}
	const json = (await res.json()) as { response?: string };
	const raw = json.response;
	if (!raw) {
		throw visionError("ollama", "ollama 返回的 response 为空");
	}

	let parsed: AgentAction;
	try {
		parsed = JSON.parse(raw) as AgentAction;
	} catch (e) {
		throw visionError("parse", `JSON 解析失败: ${(e as Error).message}\n原始输出: ${raw.slice(0, 300)}`);
	}

	// schema 已保证枚举合法，这里只做防御性校验
	if (!parsed.action || !parsed.status || typeof parsed.reason !== "string") {
		throw visionError("parse", `schema 校验失败，缺字段: ${JSON.stringify(parsed).slice(0, 300)}`);
	}

	return { action: parsed, durationMs };
}

// ─── 健康检查 ───────────────────────────────────────────────────────────────
/** 检查 ollama 服务是否可用 + 模型是否已加载。 */
export async function checkVisionService(signal?: AbortSignal): Promise<{ ok: boolean; model: string; error?: string }> {
	try {
		const res = await fetch(`${OLLAMA_BASE_URL}/v1/models`, { signal });
		if (!res.ok) {
			return { ok: false, model: OLLAMA_MODEL, error: `HTTP ${res.status}` };
		}
		const json = (await res.json()) as { data?: { id: string }[] };
		const models = json.data?.map((m) => m.id) ?? [];
		if (!models.includes(OLLAMA_MODEL)) {
			return { ok: false, model: OLLAMA_MODEL, error: `模型 ${OLLAMA_MODEL} 未加载。可用模型: ${models.join(", ") || "(无)"}` };
		}
		return { ok: true, model: OLLAMA_MODEL };
	} catch (e) {
		return { ok: false, model: OLLAMA_MODEL, error: `无法连接 ollama (${OLLAMA_BASE_URL}): ${(e as Error).message}` };
	}
}
