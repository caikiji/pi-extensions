/**
 * 集成测试：验证改后的 vision-client.ts 逻辑对接 llama-server 是否工作。
 * 复刻 askVision / decideAction / checkVisionService 的请求结构，
 * 不 import ts（项目无 node 环境），直接 fetch。
 */
const BASE = "http://127.0.0.1:18080";
const MODEL = "minicpm-v";
const MAX_TOKENS = 600;

const ACTION_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["press", "release", "interact", "jump", "wait"] },
    params: {
      type: "object",
      properties: { key: { type: "string", enum: ["W", "A", "S", "D", "Shift", "TurnLeft", "TurnRight"] } },
    },
    status: { type: "string", enum: ["ongoing", "success", "stuck"] },
    reason: { type: "string" },
  },
  required: ["action", "params", "status", "reason"],
};

// 生成一张简易游戏画面 PNG base64
function gameImg() {
  // 用 canvas 太重，这里直接用一张已知好的 base64：复用 schema 测试里的近目标场景
  // 为独立，用纯 node 生成最小 PNG 太繁琐，改为复用 Python 生成方式——这里直接 fetch 一个测试图
  // 其实更简单：直接用 llama.cpp 内置的测试图 URL？不行，要本地图。
  // 退而求其次：用 node 内置 zlib 手搓一个 1x1 PNG 不够（模型看不清）。
  // 方案：调 python 生成图，把 base64 读进来。
  const { execSync } = require("child_process");
  const b64 = execSync(
    `python -c "import base64,io;from PIL import Image,ImageDraw,ImageFont;img=Image.new('RGB',(384,384),(60,90,60));d=ImageDraw.Draw(img);d.ellipse([230,180,270,220],fill=(40,80,220));d.rectangle([290,190,310,210],fill=(220,40,40));b=io.BytesIO();img.save(b,format='PNG');import sys;sys.stdout.buffer.write(base64.b64encode(b.getvalue()))"`,
    { encoding: "buffer" }
  );
  return b64.toString();
}

async function checkVisionService() {
  const res = await fetch(`${BASE}/v1/models`);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
  const json = await res.json();
  const models = (json.data || []).map((m) => m.id);
  if (models.length === 0) return { ok: false, error: "空模型列表" };
  return { ok: true, model: models[0], models };
}

async function askVision(imageDataUrl, prompt) {
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: imageDataUrl } },
        { type: "text", text: prompt },
      ] }],
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
    }),
  });
  const json = await res.json();
  return json.choices?.[0]?.message?.content;
}

async function decideAction(base64, taskGoal, history, recentFrames, decisionPrompt, agentState) {
  const historyText = history.length === 0 ? "（这是任务第一步）"
    : history.map((h, i) => `步骤${i + 1}: ${h.action} | ${h.result}`).join("\n");
  const rules = decisionPrompt ?? "决定下一步动作。";
  const prompt = `你是游戏 AI agent，在 Unity Play Mode 中操控角色。

任务目标: ${taskGoal}

${rules}

已执行步骤:
${historyText}

当前 agent 状态: ${agentState ?? "(未知)"}`;

  const t0 = Date.now();
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: [
        ...recentFrames.map((b64) => ({ type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } })),
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
        { type: "text", text: prompt },
      ] }],
      temperature: 0.2,
      max_tokens: MAX_TOKENS,
      response_format: { type: "json_schema", json_schema: { name: "agent_action", schema: ACTION_SCHEMA, strict: true } },
    }),
  });
  const durationMs = Date.now() - t0;
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content;
  return { raw, durationMs, finish: json.choices?.[0]?.finish_reason };
}

(async () => {
  console.log("=== 1. checkVisionService ===");
  const svc = await checkVisionService();
  console.log("  ", svc.ok ? `✅ ok, model=${svc.model}` : `❌ ${svc.error}`);
  if (!svc.ok) process.exit(1);

  const b64 = gameImg();
  const dataUrl = `data:image/png;base64,${b64}`;

  console.log("\n=== 2. askVision (单图自由描述) ===");
  const desc = await askVision(dataUrl, "画面里有什么？简短描述。");
  console.log("  →", (desc || "(空)").slice(0, 150));

  console.log("\n=== 3. decideAction (单图 + schema) ===");
  const r1 = await decideAction(b64, "走到红色目标处", [], [], undefined, "(未知)");
  console.log(`  (${r1.durationMs}ms) finish=${r1.finish}`);
  console.log("  →", (r1.raw || "(空)").slice(0, 200));
  try { const o = JSON.parse(r1.raw); console.log("  parsed:", o.action, o.params, o.status); } catch (e) { console.log("  ❌ parse fail"); }

  console.log("\n=== 4. decideAction (3帧多图 + schema + 历史) ===");
  const r2 = await decideAction(
    b64, "走到红色目标处",
    [{ action: "press", result: "W 按住，前进" }],
    [b64, b64],  // 2 历史帧 + 当前 = 3帧
    "每步选一个动作", "press W (前进中)"
  );
  console.log(`  (${r2.durationMs}ms) finish=${r2.finish}`);
  console.log("  →", (r2.raw || "(空)").slice(0, 200));
  try { const o = JSON.parse(r2.raw); console.log("  parsed:", o.action, o.params, o.status); } catch (e) { console.log("  ❌ parse fail"); }
})().catch((e) => { console.error("ERROR:", e); process.exit(1); });
