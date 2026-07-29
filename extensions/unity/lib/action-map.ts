/**
 * action-map — 把 unity_agent 的抽象 action 翻译成 eval 可执行的 C# 代码。
 *
 * Phase 3 验证（2026-07-29, CourseProject Unity 2019.4.36f1, 旧 Input Manager）：
 *   - keybd_event 注入 WASD/E/Space 等 → Input.GetAxisRaw/GetKeyDown 真实接收 ✅
 *     （W 键 keydown 2 秒后玩家 X 轴移动 44.6 单位）
 *   - mouse_event 注入鼠标移动 → FollowCamera 的 yaw 真实改变 ✅
 *   - keydown 不 keyup = 持续按住；keyup 释放 ✅
 *
 * 关键约束（eval 特性）：
 *   1. 每次 eval 独立编译，DllImport 声明不跨调用保留 → 每段代码自带 P/Invoke 声明
 *   2. keybd_event 是 OS 级瞬时注入，Unity 在下一帧 Update 才轮询到 →
 *      持续按住动作（move/turn）需 keydown 和 keyup 分两次 eval，中间让游戏跑帧
 *   3. 代码写成 trailing-return 模式：末尾是裸表达式字符串，RoslynEval 会提升为返回值
 *   4. P/Invoke 声明 + 调用必须在同一个代码块里
 *
 * 输入系统适配：
 *   - 本模块用 Win32 API（方案二），适用于旧 Input Manager + Windows
 *   - New Input System 项目应改用 InputSystem.QueueStateEvent（方案一，未实现）
 *   - macOS 不支持 Win32，需方案三 AgentInput 脚本（未实现）
 */

import type { AgentAction } from "./vision-client.ts";

// Win32 virtual key codes
const VK: Record<string, number> = {
	// 移动（WASD）
	w: 0x57,
	a: 0x41,
	s: 0x53,
	d: 0x44,
	// 功能键
	e: 0x45, // 交互
	space: 0x20, // 跳跃/对话推进
	b: 0x42, // 背包
	c: 0x43, // 衣柜
	escape: 0x1b, // 关闭/退出
	left_shift: 0xa0, // 冲刺（按住）
	left_ctrl: 0xa2, // dash
};

// mouse_event flags
const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_ABSOLUTE = 0x8000;

/**
 * 生成 keybd_event 的 P/Invoke 声明 + 一次 keydown/keyup。
 * 代码末尾是裸字符串表达式（trailing-return 模式）。
 */
function keyEventCode(vk: number, down: boolean): string {
	const flags = down ? 0 : 2; // 0=keydown, 2=keyup
	return (
		`[System.Runtime.InteropServices.DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\n` +
		`keybd_event(${vk}, 0, ${flags}, System.UIntPtr.Zero);\n` +
		`"${down ? "keydown" : "keyup"} vk=${vk}"`
	);
}

/**
 * 生成 keybd_event 的 P/Invoke 声明 + 一次完整的按键（keydown + keyup）。
 * 用于 GetKeyDown 类动作（interact/jump），单次 eval 完成。
 * 只声明一次 DllImport，避免重复声明编译错误。
 */
function keyPressCode(vk: number): string {
	return (
		`[System.Runtime.InteropServices.DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\n` +
		`keybd_event(${vk}, 0, 0, System.UIntPtr.Zero);\n` +
		`keybd_event(${vk}, 0, 2, System.UIntPtr.Zero);\n` +
		`"key vk=${vk}"`
	);
}

/**
 * 生成 mouse_event 的 P/Invoke 声明 + 鼠标移动。
 * dx/dy 是相对移动量（像素级，mouse_event 的 MOVE 是相对量）。
 */
function mouseMoveCode(dx: number, dy: number): string {
	return (
		`[System.Runtime.InteropServices.DllImport("user32.dll")] static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);\n` +
		`mouse_event(${MOUSEEVENTF_MOVE}, ${Math.round(dx)}, ${Math.round(dy)}, 0, System.UIntPtr.Zero);\n` +
		`"mouse move dx=${Math.round(dx)} dy=${Math.round(dy)}"`
	);
}

/**
 * 鼠标点击：移动到指定相对坐标 (0~1) → 按下 → 松开。
 * 用绝对坐标定位（MOUSEEVENTF_ABSOLUTE 需 0~65535 归一化）。
 */
function mouseClickCode(x: number, y: number): string {
	// 归一化到 0~65535。Screen.width/height 在 Play Mode 下是游戏视图分辨率。
	const nx = Math.round(Math.max(0, Math.min(1, x)) * 65535);
	const ny = Math.round(Math.max(0, Math.min(1, y)) * 65535);
	return (
		`[System.Runtime.InteropServices.DllImport("user32.dll")] static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, System.UIntPtr dwExtraInfo);\n` +
		`mouse_event(${MOUSEEVENTF_ABSOLUTE}|${MOUSEEVENTF_MOVE}, ${nx}, ${ny}, 0, System.UIntPtr.Zero);\n` +
		`mouse_event(${MOUSEEVENTF_LEFTDOWN}, 0, 0, 0, System.UIntPtr.Zero);\n` +
		`mouse_event(${MOUSEEVENTF_LEFTUP}, 0, 0, 0, System.UIntPtr.Zero);\n` +
		`"click at ${x.toFixed(2)},${y.toFixed(2)}"`
	);
}

/**
 * 把一个抽象 action 翻译成一序列 eval 调用。
 *
 * 返回的步骤按顺序执行：
 *   - move_forward/backward/left/right: keydown → (等游戏跑帧) → keyup
 *   - turn_left/right: mouse_event 移动（一次性，无需 keyup）
 *   - click: 鼠标定位 + 点击（一次性）
 *   - interact/jump: 单次 keydown + keyup（同一 eval）
 *   - wait: 不注入任何输入，纯等待
 *
 * @param action 模型决定的动作
 * @returns eval 步骤数组，每步是 { code, label, waitMs } —— waitMs 是这步执行后等多久让游戏响应
 */
export interface ActionStep {
	/** eval 代码（trailing-return 模式，末尾是裸字符串表达式） */
	code: string;
	/** 人类可读标签，用于历史记录 */
	label: string;
	/** 执行后等待多少毫秒让游戏响应（让 Update 跑帧） */
	waitMs: number;
}

export function actionToSteps(action: AgentAction): ActionStep[] {
	const dur = action.params.duration_ms ?? 800;
	const steps: ActionStep[] = [];

	switch (action.action) {
		case "move_forward":
			steps.push({ code: keyEventCode(VK.w, true), label: "W keydown", waitMs: dur });
			steps.push({ code: keyEventCode(VK.w, false), label: "W keyup", waitMs: 200 });
			break;
		case "move_backward":
			steps.push({ code: keyEventCode(VK.s, true), label: "S keydown", waitMs: dur });
			steps.push({ code: keyEventCode(VK.s, false), label: "S keyup", waitMs: 200 });
			break;
		case "turn_left":
			// 鼠标左移 → FollowCamera 的 yaw 减小（向左转）
			steps.push({ code: mouseMoveCode(-300, 0), label: "mouse left", waitMs: 300 });
			break;
		case "turn_right":
			steps.push({ code: mouseMoveCode(300, 0), label: "mouse right", waitMs: 300 });
			break;
		case "click":
			steps.push({
				code: mouseClickCode(action.params.x ?? 0.5, action.params.y ?? 0.5),
				label: `click ${action.params.x ?? 0.5},${action.params.y ?? 0.5}`,
				waitMs: 400,
			});
			break;
		case "interact":
			steps.push({ code: keyPressCode(VK.e), label: "E press", waitMs: 500 });
			break;
		case "jump":
			steps.push({ code: keyPressCode(VK.space), label: "Space press", waitMs: 500 });
			break;
		case "wait":
			// 不注入输入，纯等待。code 返回一个标记字符串。
			steps.push({ code: `"wait ${dur}ms"`, label: `wait ${dur}ms`, waitMs: dur });
			break;
	}

	return steps;
}
