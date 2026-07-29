"""
验证 llama.cpp /v1/chat/completions 的 response_format JSON schema 约束能力。

对比 ollama format 参数（Phase 0 收益：100% 合法 JSON + action 不越界 + 字段齐全 + 1.7-2.1s）。
llama.cpp 用 OpenAI 兼容的 response_format:
  {type:"json_schema", schema: <ACTION_SCHEMA>}

测试：
1. JSON 合法率（能否直接 JSON.parse）
2. action 枚举约束（不越界到枚举外的值）
3. required 字段齐全（action/params/status/reason）
4. 推理速度（对比 ollama 1.7-2.1s 基线）
5. 多图场景下 schema 约束是否仍生效（run_task 真实场景）

跑 8 次不同 prompt + 画面，统计成功率。
"""
import base64
import io
import json
import time
import urllib.request
from PIL import Image, ImageDraw, ImageFont

LLAMACPP = "http://127.0.0.1:18080"
LLAMA_MODEL = "minicpm-v"
FONT = "C:/Windows/Fonts/arialbd.ttf"

# 与 vision-client.ts ACTION_SCHEMA 完全一致
ACTION_SCHEMA = {
    "type": "object",
    "properties": {
        "action": {"type": "string", "enum": ["press", "release", "interact", "jump", "wait"]},
        "params": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "enum": ["W", "A", "S", "D", "Shift", "TurnLeft", "TurnRight"]},
            },
        },
        "status": {"type": "string", "enum": ["ongoing", "success", "stuck"]},
        "reason": {"type": "string"},
    },
    "required": ["action", "params", "status", "reason"],
}

VALID_ACTIONS = {"press", "release", "interact", "jump", "wait"}
VALID_STATUS = {"ongoing", "success", "stuck"}
VALID_KEYS = {"W", "A", "S", "D", "Shift", "TurnLeft", "TurnRight", None}


def make_game_scene(scene_label, player_pos, target_pos, wall=False):
    """画一个简易俯视游戏画面：角色(蓝圆) + 目标(红方块) + 可选墙壁。返回 base64。"""
    img = Image.new("RGB", (384, 384), (60, 90, 60))  # 绿地
    d = ImageDraw.Draw(img)
    # 角色（蓝圆）
    px, py = player_pos
    d.ellipse([px - 18, py - 18, px + 18, py + 18], fill=(40, 80, 220), outline=(255, 255, 255))
    d.text((px - 12, py - 8), "P", font=ImageFont.truetype(FONT, 22), fill="white")
    # 目标（红方块）
    tx, ty = target_pos
    d.rectangle([tx - 16, ty - 16, tx + 16, ty + 16], fill=(220, 40, 40), outline=(255, 255, 255))
    d.text((tx - 10, ty - 10), "G", font=ImageFont.truetype(FONT, 22), fill="white")
    if wall:
        d.rectangle([180, 120, 210, 280], fill=(120, 100, 80))
    d.text((10, 360), scene_label, font=ImageFont.truetype(FONT, 16), fill="white")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def call_decide(prompt, images_b64, use_schema=True):
    content = [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}} for b in images_b64]
    content.append({"type": "text", "text": prompt})
    body = {
        "model": LLAMA_MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.2,
        "max_tokens": 600,
    }
    if use_schema:
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": "agent_action", "schema": ACTION_SCHEMA, "strict": True}}
    t0 = time.time()
    req = urllib.request.Request(f"{LLAMACPP}/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    dt = time.time() - t0
    ch = data["choices"][0]
    raw = ch["message"]["content"]
    return raw, dt, ch.get("finish_reason"), data.get("usage")


def validate(raw):
    """校验输出是否符合 ACTION_SCHEMA。返回 (ok, errors[])。"""
    errs = []
    try:
        obj = json.loads(raw)
    except Exception as e:
        return False, [f"JSON解析失败: {e}"]
    if obj.get("action") not in VALID_ACTIONS:
        errs.append(f"action越界: {obj.get('action')!r}")
    if obj.get("status") not in VALID_STATUS:
        errs.append(f"status越界: {obj.get('status')!r}")
    for f in ["action", "params", "status", "reason"]:
        if f not in obj:
            errs.append(f"缺字段: {f}")
    key = obj.get("params", {}).get("key")
    if key not in VALID_KEYS:
        errs.append(f"key越界: {key!r}")
    return len(errs) == 0, errs


# 8 个测试场景：不同画面 + 任务
img_near = make_game_scene("near", (250, 200), (300, 200))       # 接近目标
img_far = make_game_scene("far", (80, 320), (320, 80))            # 远离目标
img_at_goal = make_game_scene("at", (290, 200), (300, 200))       # 已到目标
img_wall = make_game_scene("wall", (120, 200), (300, 200), wall=True)  # 有墙
img_turned = make_game_scene("turn", (200, 200), (50, 200))       # 目标在左侧

PROMPT_TMPL = """你是游戏 AI agent，在 Unity Play Mode 中操控角色（蓝色 P）。
任务目标: {goal}
当前画面见附图（红方块 G 是目标）。
{history}
决定下一步动作。只输出 JSON。"""

cases = [
    ("起步前进", img_far, "走到红色目标处", "", [img_far]),
    ("继续前进", img_near, "走到红色目标处", "已执行: press W (前进)", [img_near]),
    ("到达目标", img_at_goal, "走到红色目标处", "已执行: press W", [img_at_goal]),
    ("遇墙转向", img_wall, "走到红色目标处", "已执行: press W", [img_wall]),
    ("目标在左", img_turned, "走到红色目标处", "", [img_turned]),
    ("多图1 起步", img_far, "走到红色目标处", "", [img_far, img_near]),
    ("多图2 到达", img_near, "走到红色目标处", "已执行: press W", [img_near, img_at_goal]),
    ("三帧序列", img_near, "走到红色目标处", "", [img_far, img_near, img_at_goal]),
]


def main():
    print("=" * 76)
    print(f"{'场景':14s} {'图数':5s} {'合法':5s} {'action':18s} {'status':10s} {'耗时':7s}  finish")
    print("-" * 76)
    ok_count = 0
    total_dt = 0
    for label, img, goal, history, imgs in cases:
        prompt = PROMPT_TMPL.format(goal=goal, history=history)
        raw, dt, finish, usage = call_decide(prompt, imgs)
        ok, errs = validate(raw)
        total_dt += dt
        if ok:
            ok_count += 1
        try:
            obj = json.loads(raw) if ok else {}
            act = f"{obj.get('action','?')}({obj.get('params',{}).get('key','')})" if ok else "PARSE_FAIL"
            st = obj.get("status", "?") if ok else "?"
        except Exception:
            act, st = "ERR", "ERR"
        flag = "✅" if ok else "❌"
        print(f"{label:14s} {len(imgs):5d} {flag:5s} {act:18s} {st:10s} {dt:5.1f}s  {finish}")
        if not ok:
            print(f"    错误: {errs}")
            print(f"    原始: {raw[:200]}")
    print("-" * 76)
    print(f"合法率: {ok_count}/{len(cases)}  平均耗时: {total_dt/len(cases):.1f}s")
    print(f"对比 ollama 基线: 100% 合法 + 1.7-2.1s (Phase 0)")


if __name__ == "__main__":
    main()
