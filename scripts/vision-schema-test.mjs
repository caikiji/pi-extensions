#!/usr/bin/env node
/**
 * Phase 0 验证：ollama 原生 API + format schema 约束 JSON 输出
 *
 * ollama /api/generate 支持 format 参数传 JSON schema，强制输出符合 schema。
 * 这是比 prompt 约束更强的方案：从语法层面杜绝 action 越界、字段缺失。
 */
const BRIDGE_HOST = "http://127.0.0.1:17841";
const OLLAMA_URL = "http://127.0.0.1:11434/api/generate";
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

// JSON Schema 强制约束：action/status 枚举，必需字段，params 结构
const ACTION_SCHEMA = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["move_forward", "move_backward", "turn_left", "turn_right", "click", "interact", "wait", "jump"],
		},
		params: {
			type: "object",
			properties: {
				duration_ms: { type: "number" },
				x: { type: "number" },
				y: { type: "number" },
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

async function decideWithSchema(imageDataUrl, taskGoal) {
	const prompt = `你是游戏 AI agent。任务目标: ${taskGoal}

看当前画面，决定下一步动作。每步只能选一个原子动作（不能组合）。
- move_forward / move_backward: 前后移动，params 用 duration_ms
- turn_left / turn_right: 转向，params 用 duration_ms
- click: 点击，params 用 x,y (相对坐标 0~1)
- interact / jump: params 留空
- wait: params 用 duration_ms`;

	// ollama 原生 /api/generate，images 是 base64 数组（不带 data: 前缀）
	const b64 = imageDataUrl.replace(/^data:image\/png;base64,/, "");

	const res = await fetch(OLLAMA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			model: OLLAMA_MODEL,
			prompt: prompt,
			images: [b64],
			format: ACTION_SCHEMA,
			stream: false,
			options: { temperature: 0.2 },
		}),
	});
	if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
	const json = await res.json();
	return json.response ?? "";
}

async function main() {
	const taskGoal = process.argv[2] ?? "画面里有两个角色，走向右边那个角色并靠近他";

	console.log("=== ollama format schema 约束测试 ===");
	console.log(`任务目标: ${taskGoal}\n`);

	console.log("[1/2] 截图...");
	const img = await capture();
	console.log("  ✓\n");

	console.log("[2/2] schema 约束生成...");
	const t0 = Date.now();
	const answer = await decideWithSchema(img, taskGoal);
	const ms = Date.now() - t0;
	console.log(`  ✓ (${ms}ms)\n`);

	console.log("模型输出:");
	console.log("─".repeat(60));
	console.log(answer);
	console.log("─".repeat(60));

	console.log("\n--- 校验 ---");
	try {
		const parsed = JSON.parse(answer);
		console.log("✓ 合法 JSON");
		const validActions = ["move_forward", "move_backward", "turn_left", "turn_right", "click", "interact", "wait", "jump"];
		console.log(`  action: ${parsed.action} ${validActions.includes(parsed.action) ? "✓" : "✗"}`);
		console.log(`  params: ${JSON.stringify(parsed.params)}`);
		console.log(`  status: ${parsed.status}`);
		console.log(`  reason: ${parsed.reason}`);
		console.log(`\n必需字段: action=${!!parsed.action}, params=${!!parsed.params}, status=${!!parsed.status}, reason=${!!parsed.reason}`);
	} catch (e) {
		console.log("✗ JSON 解析失败:", e.message);
	}
}

main().catch((e) => { console.error("✗", e.message); process.exit(1); });
