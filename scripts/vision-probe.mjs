#!/usr/bin/env node
/**
 * Phase 0 验证脚本：Unity 截图 → ollama MiniCPM-V → 文本分析
 *
 * 用法：
 *   node scripts/vision-probe.mjs "<分析指令>"
 *   node scripts/vision-probe.mjs                           # 默认 prompt
 *
 * 流程：
 *   1. 通过 PiBridge eval 内联 C# 截图代码，拿到 base64 PNG（缩放到 384×384）
 *   2. POST 到 ollama /v1/chat/completions，发图片 + prompt
 *   3. 打印模型返回的文本
 *
 * 这是 unity_agent 工具 observe 模式的最小验证形态。不依赖任何 pi 扩展代码，
 * 纯 Node.js + fetch，验证「MiniCPM-V 能不能看懂 Unity 画面」这个核心假设。
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_PATH = "D:\\workspace\\CourseProject";
const BRIDGE_HOST = "http://127.0.0.1:17841";
const OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_MODEL = "minicpm-v4.6:latest";

// ─── 1. Unity 截图 eval 代码 ───────────────────────────────────────────────
// 在 Editor 主线程渲染 Camera.main 到 RenderTexture，缩放到 384×384，编码 PNG base64。
// 注意：当前不在 Play Mode 时，Camera.main 仍存在但场景是 Editor 视角。
// Play Mode 下才是真正的游戏画面。脚本会先 status 检查。
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
}
return "data:image/png;base64," + System.Convert.ToBase64String(bytes);
`.trim();

// ─── 2. 调 PiBridge eval ───────────────────────────────────────────────────
async function bridgeEval(code) {
	const body = JSON.stringify({ code });
	const res = await fetch(`${BRIDGE_HOST}/eval`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body,
	});
	if (!res.ok) {
		throw new Error(`bridge HTTP ${res.status}: ${await res.text()}`);
	}
	const json = await res.json();
	if (!json.ok) {
		throw new Error(`eval failed: ${json.error}`);
	}
	// result.value 是 base64 字符串（SerializeReturnValue 对 string passthrough）
	return json.result?.value ?? json.result;
}

async function bridgeStatus() {
	const res = await fetch(`${BRIDGE_HOST}/status`);
	const json = await res.json();
	return json.result;
}

// ─── 3. 调 ollama MiniCPM-V ────────────────────────────────────────────────
async function askVision(imageDataUrl, prompt) {
	const body = {
		model: OLLAMA_MODEL,
		messages: [
			{
				role: "user",
				content: [
					{ type: "image_url", image_url: { url: imageDataUrl } },
					{ type: "text", text: prompt },
				],
			},
		],
		// 让模型自由描述，不限制 token
		temperature: 0.3,
	};
	const res = await fetch(OLLAMA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
	}
	const json = await res.json();
	return json.choices?.[0]?.message?.content ?? "(no content)";
}

// ─── main ──────────────────────────────────────────────────────────────────
async function main() {
	const prompt = process.argv[2] ?? "这张截图是 Unity 游戏画面。请描述你看到的内容：场景、UI 元素、角色、物体位置等。简洁回答。";

	console.log("=== Phase 0: Unity 截图 → MiniCPM-V 视觉验证 ===\n");

	// 0. 检查 bridge + Play Mode 状态
	console.log("[1/4] 检查 Unity 状态...");
	const status = await bridgeStatus();
	console.log(`  isPlaying: ${status.isPlaying}`);
	console.log(`  isCompiling: ${status.isCompiling}`);
	if (status.isCompiling) {
		console.error("  ⚠ Unity 正在编译，等编译完再试。");
		process.exit(1);
	}
	if (!status.isPlaying) {
		console.log("  ⚠ 当前不在 Play Mode。截图将是 Editor 模式下的场景视图（Camera.main 视角）。");
		console.log("    若要看游戏画面，请先在 Unity 里进入 Play Mode。继续截图...");
	}

	// 1. 截图
	console.log("\n[2/4] 通过 eval 截图...");
	const t0 = Date.now();
	const imageDataUrl = await bridgeEval(CAPTURE_EVAL);
	const captureMs = Date.now() - t0;
	if (typeof imageDataUrl !== "string" || !imageDataUrl.startsWith("data:image/png;base64,")) {
		console.error("  ✗ 截图失败，eval 返回:", imageDataUrl);
		process.exit(1);
	}
	const b64 = imageDataUrl.slice("data:image/png;base64,".length);
	const sizeKb = Math.round((b64.length * 3) / 4 / 1024);
	console.log(`  ✓ 截图成功 (${captureMs}ms, ${sizeKb}KB, 384×384)`);

	// 2. 调 MiniCPM-V
	console.log("\n[3/4] 发送给 MiniCPM-V 分析...");
	console.log(`  prompt: ${prompt}`);
	const t1 = Date.now();
	const answer = await askVision(imageDataUrl, prompt);
	const visionMs = Date.now() - t1;
	console.log(`  ✓ 模型返回 (${visionMs}ms)`);

	// 3. 输出
	console.log("\n[4/4] 模型回答:");
	console.log("─".repeat(60));
	console.log(answer);
	console.log("─".repeat(60));
	console.log(`\n总耗时: 截图 ${captureMs}ms + 视觉 ${visionMs}ms = ${captureMs + visionMs}ms`);
}

main().catch((e) => {
	console.error("✗ 失败:", e.message);
	process.exit(1);
});
