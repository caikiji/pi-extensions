#!/usr/bin/env node
/**
 * Phase 0 附加验证：MiniCPM-V 结构化 JSON 输出能力
 *
 * 测试模型能否按指定 schema 返回 JSON（run_task 模式 action 决策的基础）。
 * 不截图，纯文本对话，测 JSON 遵循能力。
 */
const OLLAMA_URL = "http://127.0.0.1:11434/v1/chat/completions";
const OLLAMA_MODEL = "minicpm-v4.6:latest";

async function ask(messages, opts = {}) {
	const res = await fetch(OLLAMA_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ model: OLLAMA_MODEL, messages, temperature: 0.1, ...opts }),
	});
	if (!res.ok) throw new Error(`ollama HTTP ${res.status}: ${await res.text()}`);
	const json = await res.json();
	return json.choices?.[0]?.message?.content ?? "(no content)";
}

async function testJsonOutput() {
	console.log("=== 测试 1: 纯文本 JSON schema 遵循 ===\n");
	const schemaPrompt = `你是一个游戏画面分析助手。我会描述一个游戏画面，你要输出一个 JSON 对象，schema 如下：

{
  "characters": [{"position": "left|center|right", "facing": "towards|away|side", "armed": true|false}],
  "ui_elements": ["按钮A", "血条", ...],
  "scene_type": "combat|dialogue|exploration|menu",
  "next_action": "move_forward|attack|interact|wait|click",
  "reason": "简短理由"
}

画面描述：一个低多边形风格的森林场景，两个角色对峙。左侧角色持盾背对镜头，右侧角色面向前方手持武器。画面顶部有一个血条 UI。

只输出 JSON，不要其他文字。`;

	const answer = await ask([{ role: "user", content: schemaPrompt }]);
	console.log("模型输出:");
	console.log(answer);
	console.log("\n--- JSON 解析 ---");
	try {
		// 提取第一个 {...} 块
		const match = answer.match(/\{[\s\S]*\}/);
		const parsed = JSON.parse(match ? match[0] : answer);
		console.log("✓ 合法 JSON:", JSON.stringify(parsed, null, 2));
		return true;
	} catch (e) {
		console.log("✗ JSON 解析失败:", e.message);
		return false;
	}
}

async function testJsonWithImage() {
	console.log("\n=== 测试 2: 图片 + JSON 输出（真实场景）===\n");
	// 复用 vision-probe 的截图能力
	const { existsSync } = await import("node:fs");
	// 直接调 bridge 截图
	const captureEval = `
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

	console.log("[1/2] 截图...");
	const evalRes = await fetch("http://127.0.0.1:17841/eval", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code: captureEval }),
	});
	const evalJson = await evalRes.json();
	if (!evalJson.ok) throw new Error("截图失败: " + evalJson.error);
	const imageDataUrl = evalJson.result.value;
	console.log("  ✓ 截图完成");

	console.log("\n[2/2] 让模型按 schema 输出 JSON...");
	const prompt = `分析这张 Unity 游戏画面，输出 JSON：
{
  "characters": [{"position": "left|center|right", "facing": "towards|away|side", "armed": true|false}],
  "ui_elements": ["..."],
  "scene_type": "combat|dialogue|exploration|menu",
  "next_action": "move_forward|attack|interact|wait|click",
  "reason": "简短理由"
}
只输出 JSON。`;

	const answer = await ask([{
		role: "user",
		content: [
			{ type: "image_url", image_url: { url: imageDataUrl } },
			{ type: "text", text: prompt },
		],
	}]);
	console.log("模型输出:");
	console.log(answer);
	console.log("\n--- JSON 解析 ---");
	try {
		const match = answer.match(/\{[\s\S]*\}/);
		const parsed = JSON.parse(match ? match[0] : answer);
		console.log("✓ 合法 JSON:", JSON.stringify(parsed, null, 2));
		// 校验字段
		const required = ["characters", "ui_elements", "scene_type", "next_action", "reason"];
		const missing = required.filter((k) => !(k in parsed));
		if (missing.length) console.log(`⚠ 缺少字段: ${missing.join(", ")}`);
		else console.log("✓ 所有必需字段齐全");
		// 校验 next_action 在枚举内
		const validActions = ["move_forward", "attack", "interact", "wait", "click"];
		if (!validActions.includes(parsed.next_action)) {
			console.log(`⚠ next_action 越界: ${parsed.next_action}`);
		} else {
			console.log(`✓ next_action 合法: ${parsed.next_action}`);
		}
		return true;
	} catch (e) {
		console.log("✗ JSON 解析失败:", e.message);
		return false;
	}
}

async function main() {
	const r1 = await testJsonOutput();
	const r2 = await testJsonWithImage();
	console.log("\n=== 总结 ===");
	console.log(`纯文本 JSON: ${r1 ? "✓" : "✗"}`);
	console.log(`图片+JSON:   ${r2 ? "✓" : "✗"}`);
}
main().catch((e) => { console.error("✗", e.message); process.exit(1); });
