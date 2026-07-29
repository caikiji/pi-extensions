/**
 * unity_agent tool — 视觉驱动的 Unity Play Mode 测试工具。
 *
 * 让 AI agent 通过视觉模型（MiniCPM-V）"看见" Unity 游戏画面，并（未来）驱动
 * 多步视觉-操作循环完成游戏内任务。这是 PiBridge 的"眼睛"。
 *
 * 两种模式：
 *   - observe: 截取当前画面 → 送 MiniCPM-V 分析 → 返回文本描述。一次调用，不做操作。
 *   - run_task: 在 Play Mode 中循环 截图→分析→操作 直到任务完成。每步视觉决策走
 *     ollama format schema（强制 JSON），输入注入走 eval 内联 Win32 keybd_event/mouse_event。
 *
 * 截图走 PiBridge eval 内联 RenderTexture（不新增 bridge 命令），视觉分析走
 * ollama /api/generate + format schema 强制 JSON。详见：
 *   - lib/vision-client.ts
 *   - proposals/2026-07-unity-agent-vision.md → Phase 0 验证报告
 *
 * 依赖：PiBridge 0.6.0+（eval）+ 本地 ollama + minicpm-v 模型。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { discoverBridge, sendCommand, waitForBridge, type BridgeInfo } from "../lib/bridge-client.ts";
import { actionToSteps, type ActionStep } from "../lib/action-map.ts";
import {
	askVision,
	captureScreen,
	checkVisionService,
	decideAction,
	type ActionHistory,
	type AgentAction,
	type CaptureResult,
} from "../lib/vision-client.ts";
import { resolveProjectPath } from "../lib/tool-utils.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

export const unityAgentParams = Type.Object({
	mode: StringEnum(["observe", "run_task"]),
	prompt: Type.String({
		description:
			"observe 模式：画面分析指令（如 \"画面上有哪些 UI 元素？\"）。" +
			"run_task 模式：任务描述（如 \"走到红色 checkpoint 触发它\"）。",
	}),
	max_steps: Type.Optional(
		Type.Number({
			description: "run_task 模式专用，最大步数（默认 20）。",
			minimum: 1,
			maximum: 50,
		}),
	),
	projectPath: Type.Optional(
		Type.String({ description: "Path to Unity project root. Defaults to auto-detect from cwd." }),
	),
});

export interface UnityAgentParams {
	mode: "observe" | "run_task";
	prompt: string;
	max_steps?: number;
	projectPath?: string;
}

export interface UnityAgentResult {
	projectPath: string;
	mode: string;
	bridge: BridgeInfo;
	/** ollama 视觉服务是否可用 */
	visionAvailable: boolean;
	visionModel?: string;
	visionError?: string;
	/** observe 模式下模型返回的分析文本 */
	analysis?: string;
	/** 截图信息（不含 base64 本体，避免污染结果） */
	capture?: { width: number; height: number; captureMs: number; isPlaying: boolean };
	/** run_task 模式下每步的记录 */
	steps?: TaskStepRecord[];
	/** run_task 模式的最终状态：ongoing/incomplete/success/stuck/crashed */
	taskStatus?: "ongoing" | "incomplete" | "success" | "stuck" | "crashed";
	/** run_task 模式下执行的步数 */
	stepsTaken?: number;
	/** 总耗时（ms） */
	totalMs: number;
	/** 错误信息（bridge 不可用、ollama 不可用、eval 失败等） */
	error?: string;
}

/** run_task 模式下一步的执行记录 */
export interface TaskStepRecord {
	step: number;
	action: string;
	params: Record<string, unknown>;
	reason: string;
	/** 这步耗时（ms，含注入+等待+截图+视觉） */
	durationMs: number;
}

export async function runUnityAgent(params: UnityAgentParams, cwd: string): Promise<UnityAgentResult> {
	const projectPath = resolveProjectPath(params.projectPath, cwd);
	const totalStart = Date.now();

	// 1. 发现 bridge（和 unity_command 一样的 domain-reload 容错）
	let bridge = await discoverBridge(projectPath);
	if (!bridge.available) {
		const portFile = join(projectPath, "Temp", "pi-bridge-port");
		if (existsSync(portFile)) {
			const waited = await waitForBridge(projectPath, { timeoutMs: 25000 });
			bridge = waited.bridge;
		}
	}

	if (!bridge.available) {
		return {
			projectPath,
			mode: params.mode,
			bridge,
			visionAvailable: false,
			totalMs: Date.now() - totalStart,
			error: bridge.reason ?? "PiBridge is not running. Install via unity_install_bridge and open the project.",
		};
	}

	// 2. 检查 ollama 视觉服务（提前失败比截图后失败好）
	const svc = await checkVisionService();
	if (!svc.ok) {
		return {
			projectPath,
			mode: params.mode,
			bridge,
			visionAvailable: false,
			visionModel: svc.model,
			totalMs: Date.now() - totalStart,
			error: `视觉服务不可用: ${svc.error}\n请确保 ollama 在运行且模型已加载（ollama pull ${svc.model}）。`,
		};
	}

	// 3. 分模式处理
	if (params.mode === "observe") {
		return await runObserve(projectPath, bridge, svc.model, params.prompt, totalStart);
	}
	return await runTask(projectPath, bridge, svc.model, params.prompt, params.max_steps ?? 20, totalStart);
}

// ─── observe 模式 ───────────────────────────────────────────────────────────
async function runObserve(
	projectPath: string,
	bridge: BridgeInfo,
	model: string,
	prompt: string,
	totalStart: number,
): Promise<UnityAgentResult> {
	// 截图
	let capture: CaptureResult;
	try {
		capture = await captureScreen(bridge.port!);
	} catch (e) {
		return {
			projectPath,
			mode: "observe",
			bridge,
			visionAvailable: true,
			visionModel: model,
			totalMs: Date.now() - totalStart,
			error: `截图失败: ${(e as Error).message}`,
		};
	}

	// 视觉分析
	try {
		const analysis = await askVision(capture.dataUrl, prompt);
		return {
			projectPath,
			mode: "observe",
			bridge,
			visionAvailable: true,
			visionModel: model,
			analysis,
			capture: {
				width: capture.width,
				height: capture.height,
				captureMs: capture.captureMs,
				isPlaying: capture.isPlaying,
			},
			totalMs: Date.now() - totalStart,
		};
	} catch (e) {
		return {
			projectPath,
			mode: "observe",
			bridge,
			visionAvailable: true,
			visionModel: model,
			capture: {
				width: capture.width,
				height: capture.height,
				captureMs: capture.captureMs,
				isPlaying: capture.isPlaying,
			},
			totalMs: Date.now() - totalStart,
			error: `视觉分析失败: ${(e as Error).message}`,
		};
	}
}

// ─── run_task 模式 ──────────────────────────────────────────────────────
//
// 循环：执行 action（eval Win32 注入）→ 等画面稳定 → 截图 → decideAction
//       （ollama schema）→ 判断 status。
//
// 关键设计（见提案 Phase 0/0.5）：
//   - 超时策略：工具内部跑，超时返回 incomplete。Unity 画面即持久状态，
//     Pi 用新的 unity_agent run_task 调用即可续跑，无需 session 管理。
//   - 崩溃检测：每步 capture 返回的 isPlaying，false 则中止返回 crashed。
//   - 视觉决策走 schema（action 枚举合法），输入注入走 action-map.ts。
//   - 每步含历史上下文，让模型知道之前做了什么。
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runTask(
	projectPath: string,
	bridge: BridgeInfo,
	model: string,
	prompt: string,
	maxSteps: number,
	totalStart: number,
): Promise<UnityAgentResult> {
	const history: ActionHistory[] = [];
	const stepRecords: TaskStepRecord[] = [];
	// 硬超时：留给每步 ~4s（注入+截图+视觉），加缓冲。最多跑到 maxSteps 或 85s。
	const HARD_TIMEOUT_MS = 85000;
	const port = bridge.port!;

	for (let step = 1; step <= maxSteps; step++) {
		const stepStart = Date.now();

			// 检查总超时
			if (Date.now() - totalStart > HARD_TIMEOUT_MS) {
				return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "incomplete",
					`达到硬超时 ${HARD_TIMEOUT_MS}ms，已完成 ${step - 1} 步。可用新的 unity_agent run_task 调用续跑。`, totalStart);
			}

			// 1. 截图 + 视觉决策（首步无 action，直接看当前画面）
			let capture: CaptureResult;
			try {
				capture = await captureScreen(port);
			} catch (e) {
				return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "crashed",
					`截图失败: ${(e as Error).message}`, totalStart);
			}

			// 崩溃检测：Play Mode 退出
			if (!capture.isPlaying) {
				return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "crashed",
					"Play Mode 已退出（崩溃或手动停止）。", totalStart);
			}

			// 视觉决策
			let decision: { action: AgentAction; durationMs: number };
			try {
				decision = await decideAction(capture.base64, prompt, history);
			} catch (e) {
				return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "incomplete",
					`视觉决策失败（第 ${step} 步）: ${(e as Error).message}`, totalStart);
			}

			const act = decision.action;
			stepRecords.push({
				step,
				action: act.action,
				params: act.params as Record<string, unknown>,
				reason: act.reason,
				durationMs: Date.now() - stepStart,
			});

			// 2. 判断状态
			if (act.status === "success") {
				history.push({ action: act.action, result: "任务完成" });
				return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "success",
					act.reason, totalStart);
			}
			if (act.status === "stuck") {
				history.push({ action: act.action, result: "卡住" });
				return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "stuck",
					act.reason, totalStart);
			}

			// 3. 执行 action（可能多步：keydown→等→keyup）
			const steps = actionToSteps(act);
			for (const s of steps) {
				try {
					const resp = await sendCommand(port, "eval", { code: s.code }, 30000);
					if (!resp.ok) {
						history.push({ action: act.action, result: `注入失败: ${resp.error}` });
						return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "incomplete",
							`输入注入失败（第 ${step} 步 ${s.label}）: ${resp.error}`, totalStart);
					}
				} catch (e) {
					history.push({ action: act.action, result: `注入异常: ${(e as Error).message}` });
					return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "incomplete",
						`输入注入异常（第 ${step} 步）: ${(e as Error).message}`, totalStart);
				}
				await sleep(s.waitMs);
			}

			history.push({ action: act.action, result: `执行了 ${steps.map((s) => s.label).join(",")}` });
	}

	// 跑完 maxSteps 还没 success/stuck
	return makeTaskResult(projectPath, bridge, model, prompt, stepRecords, "incomplete",
		`达到最大步数 ${maxSteps}，任务未完成。可用新的 unity_agent run_task 调用续跑。`, totalStart);
}

// 组装 run_task 的返回结果。result 里含完整的步骤记录，方便 Agent 续跑或诊断。
function makeTaskResult(
	projectPath: string,
	bridge: BridgeInfo,
	model: string,
	prompt: string,
	steps: TaskStepRecord[],
	status: "ongoing" | "incomplete" | "success" | "stuck" | "crashed",
	error: string,
	totalStart: number,
): UnityAgentResult {
	const summary = steps.length > 0
		? steps.map((s) => `  ${s.step}. ${s.action} ${JSON.stringify(s.params)} — ${s.reason}`).join("\n")
		: "  (无步骤)";
	return {
		projectPath,
		mode: "run_task",
		bridge,
		visionAvailable: true,
		visionModel: model,
		steps,
		taskStatus: status,
		stepsTaken: steps.length,
		analysis: `任务: ${prompt.slice(0, 100)}\n状态: ${status}\n已执行 ${steps.length} 步:\n${summary}\n\n${error}`,
		totalMs: Date.now() - totalStart,
		error: status === "success" ? undefined : error,
	};
}
