#!/usr/bin/env node
/**
 * Phase 0 关键验证：MiniCPM-V 的 action 决策能力（run_task 闭环核心）
 *
 * 给模型一个任务目标 + 当前画面，让它输出下一步 action JSON。
 * 模拟 run_task 循环的第一步决策。
 */
const BRIDGE_HOST = "http://127.0.0.1:17841";
const OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_MODEL = "minicpm-v4.6:latest";

const CAPTURE_EVAL = `
var cam = Camera.main ?? throw new System.Exception("no Camera.main");
int W = 384, H = 384;
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
UnityEngine.Object.DestroyImmediate(rt);
UnityEngine.Object.DestroyImmediate(tex);
"data:image/png;base64," + System.Convert.ToBase64String(bytes)
`.trim();

async function capture() {
	const res = await fetch(`${BRIDGE_HOST}/eval`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code: CAPTURE_EVAL }),
	});
	const json = await res.json();
	if (!json.ok) throw new Error("截图失败: " + json.error);
	return json.result.value;
}

async function decideAction(imageDataUrl, taskGoal, history) {
	const historyText = history.length === 0
		? "（这是任务第一步，无历史）"
		: history.map((h, i) => `  步骤${i + 1}: action=${h.action}, result=${h.result}`).join("\n");

	const prompt = `你是一个游戏 AI agent。当前在 Unity Play Mode 中运行一个游戏。

任务目标: ${taskGoal}

已执行的历史步骤:
${historyText}

当前画面见附图。请决定下一步动作，输出严格 JSON：
{
  "action": "move_forward|move_backward|turn_left|turn_right|click|interact|wait|jump",
  "params": { "duration_ms": 500 },
  "status": "ongoing|success|stuck",
  "reason": "简短中文说明当前观察和为什么选这个动作"
}

规则:
- action 必须是上面 8 个之一
- click 时 params 用 {"x": 0.5, "y": 0.5}（相对坐标 0~1）
- move/turn 时 params 用 {"duration_ms": 数字}
- wait 时 params 用 {"duration_ms": 数字}
- interact/jump 时 params 留空 {}
- status: 任务完成用 success，无法推进用 stuck，否则 ongoing
- 只输出 JSON，不要其他文字`;

	const res = await fetch(OLLAMA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: OLLAMA_MODEL,
			messages: [{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: imageDataUrl } },
					{ type: "text", text: prompt },
				],
			}],
			temperature: 0.2,
		}),
	});
	if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
	const json = await res.json();
	return json.choices?.[0]?.message?.content ?? "";
}

async function main() {
	const taskGoal = process.argv[2] ?? "探索这个场景，找到可以交互的物体或 NPC";

	console.log("=== action 决策测试 ===");
	console.log(`任务目标: ${taskGoal}\n`);

	console.log("[1/2] 截取当前 Play Mode 画面...");
	const img = await capture();
	console.log("  ✓ 截图完成\n");

	console.log("[2/2] 让模型决定下一步 action...");
	const t0 = Date.now();
	const answer = await decideAction(img, taskGoal, []);
	const ms = Date.now() - t0;
	console.log(`  ✓ 模型返回 (${ms}ms)\n`);

	console.log("模型输出:");
	console.log("─".repeat(60));
	console.log(answer);
	console.log("─".repeat(60));

	// 解析校验
	console.log("\n--- 校验 ---");
	try {
		const match = answer.match(/\{[\s\S]*\}/);
		const parsed = JSON.parse(match ? match[0] : answer);
		console.log("✓ 合法 JSON");
		const validActions = ["move_forward", "move_backward", "turn_left", "turn_right", "click", "interact", "wait", "jump"];
		if (validActions.includes(parsed.action)) {
			console.log(`✓ action 合法: ${parsed.action}`);
		} else {
			console.log(`✗ action 越界: ${parsed.action}`);
		}
		const validStatus = ["ongoing", "success", "stuck"];
		if (validStatus.includes(parsed.status)) {
			console.log(`✓ status 合法: ${parsed.status}`);
		} else {
			console.log(`✗ status 越界: ${parsed.status}`);
		}
		console.log(`  params: ${JSON.stringify(parsed.params)}`);
		console.log(`  reason: ${parsed.reason}`);
	} catch (e) {
		console.log("✗ JSON 解析失败:", e.message);
	}
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
