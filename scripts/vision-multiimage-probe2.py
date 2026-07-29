"""
实测补充：箭头方向序列 + chat 多图诊断。

箭头方向没有 ALPHA<BETA 那种天然的"逻辑先后"（左/右对称），
若模型仍不按数组顺序输出，则更强证明：images 数组顺序对模型不是硬约束。

同时打印 chat 多图的完整 raw 响应，诊断为何返回空。
"""
import base64
import io
import json
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont

OLLAMA = "http://127.0.0.1:11434"
MODEL = "minicpm-v4.6:latest"
FONT_PATH = "C:/Windows/Fonts/arialbd.ttf"


def make_arrow_img(direction: str, corner: str) -> str:
    """画 384x384 白底图，中央大箭头（direction='left'/'right'），左上角标。"""
    img = Image.new("RGB", (384, 384), (255, 255, 255))
    d = ImageDraw.Draw(img)
    cy = 192
    # 箭头杆
    d.rectangle([150, cy - 24, 234, cy + 24], fill=(0, 0, 0))
    if direction == "left":
        head = [(150, cy), (200, cy - 50), (200, cy + 50)]
    else:
        head = [(234, cy), (184, cy - 50), (184, cy + 50)]
    d.polygon(head, fill=(0, 0, 0))
    d.text((20, 10), corner, font=ImageFont.truetype(FONT_PATH, 40), fill=(200, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def call_generate(prompt, images_b64, num_predict=80):
    body = {
        "model": MODEL, "prompt": prompt, "images": images_b64,
        "stream": False, "options": {"temperature": 0.0, "num_predict": num_predict},
    }
    t0 = time.time()
    req = urllib.request.Request(f"{OLLAMA}/api/generate", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    return data.get("response", ""), time.time() - t0, data


def call_chat_raw(prompt, images_b64):
    content = [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}} for b in images_b64]
    content.append({"type": "text", "text": prompt})
    body = {"model": MODEL, "messages": [{"role": "user", "content": content}],
            "temperature": 0.0, "max_tokens": 80}
    t0 = time.time()
    req = urllib.request.Request(f"{OLLAMA}/v1/chat/completions", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    return data, time.time() - t0


PROMPT = (
    "附图共 {n} 张，按数组顺序排列。每张图中央有一个箭头（朝左或朝右）。"
    "请按顺序说出每张图箭头的方向。只输出一行：1=左/右, 2=左/右, ... 不要解释。"
)

if __name__ == "__main__":
    left = make_arrow_img("left", "t1")
    right = make_arrow_img("right", "t2")

    print(f"模型: {MODEL}\n{'='*70}")

    for label, imgs in [
        ("generate [LEFT,RIGHT]",  [left, right]),
        ("generate [RIGHT,LEFT]",  [right, left]),
        ("generate [LEFT,RIGHT,LEFT]", [left, right, left]),
    ]:
        p = PROMPT.format(n=len(imgs))
        try:
            ans, dt, _ = call_generate(p, imgs)
            print(f"\n[{label}]  ({dt:.1f}s)")
            print(f"  → {ans.strip().replace(chr(10),' ')[:200]}")
        except Exception as e:
            print(f"\n[{label}]  ERROR: {e}")

    print(f"\n{'='*70}\nchat 多图 raw 诊断 (OpenAI 兼容端点):")
    p = PROMPT.format(n=2)
    try:
        data, dt = call_chat_raw(p, [left, right])
        print(f"  耗时 {dt:.1f}s")
        print(f"  choices[0].finish_reason = {data['choices'][0].get('finish_reason')}")
        msg = data["choices"][0].get("message", {})
        print(f"  message.content = {msg.get('content')!r}")
        print(f"  usage = {data.get('usage')}")
    except Exception as e:
        print(f"  ERROR: {e}")

    # 对照：chat 单图
    print(f"\nchat 单图对照:")
    try:
        data, dt = call_chat_raw("图中央的箭头朝左还是朝右？只输出'左'或'右'。", [left])
        msg = data["choices"][0].get("message", {})
        print(f"  ({dt:.1f}s) content = {msg.get('content')!r}  finish={data['choices'][0].get('finish_reason')}")
    except Exception as e:
        print(f"  ERROR: {e}")
