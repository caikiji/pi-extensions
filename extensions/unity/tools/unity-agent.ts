/**
 * unity_agent tool — 视觉驱动的 Unity Play Mode 测试工具。
 *
 * 让 AI agent 通过视觉模型（MiniCPM-V）"看见" Unity 游戏画面，并（未来）驱动
 * 多步视觉-操作循环完成游戏内任务。这是 PiBridge 的"眼睛"。
 *
 * 两种模式：
 *   - observe: 截取当前画面 → 送 MiniCPM-V 分析 → 返回文本描述。一次调用，不做操作。
 *   - run_task: （v2 待实现）在 Play Mode 中循环 截图→分析→操作 直到任务完成。
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
import { discoverBridge, waitForBridge, type BridgeInfo } from "../lib/bridge-client.ts";
import {
	askVision,
	captureScreen,
	checkVisionService,
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
	/** 总耗时（ms） */
	totalMs: number;
	/** 错误信息（bridge 不可用、ollama 不可用、eval 失败等） */
	error?: string;
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

// ─── run_task 模式（v2，待实现输入模拟后启用）─────────────────────────────
//
// 循环：执行 action → 等待画面稳定 → 截图 → decideAction → 判断 status。
// 依赖输入模拟能力（eval 内联 Input System / Win32 代码），下一阶段实现。
// 现在返回明确的 "not yet implemented" 而非静默失败。
async function runTask(
	projectPath: string,
	bridge: BridgeInfo,
	model: string,
	prompt: string,
	maxSteps: number,
	totalStart: number,
): Promise<UnityAgentResult> {
	return {
		projectPath,
		mode: "run_task",
		bridge,
		visionAvailable: true,
		visionModel: model,
		totalMs: Date.now() - totalStart,
		error:
			"run_task 模式尚未实现（v2）。当前可用 observe 模式：截取画面并让 MiniCPM-V 分析。\n" +
			"run_task 需要 eval 内联输入模拟（Input System / Win32），下一阶段开发。\n" +
			`参数已收到: prompt="${prompt.slice(0, 60)}", max_steps=${maxSteps}。`,
	};
}
