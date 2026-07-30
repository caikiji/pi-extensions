"""
llama.cpp 多图顺序感知 — 排除干扰因素后的干净测试。

排除三个干扰：
1. max_tokens 调到 1024，排除视觉 token 占用导致的截断
2. 图上不带数字角标（排除模型按角标排序的暗示）
3. 用没有天然先后顺序的词（RED/GREEN、SUN/MOON），排除模型按字母序/习惯排序

判定标准：
- 若换序后答案跟着变（[RED,GREEN]→"1=RED,2=GREEN"；[GREEN,RED]→"1=GREEN,2=RED"）
  → 模型感知数组顺序，视频流方案可行
- 若换序后答案不变 → 模型不认顺序，是模型层面问题，需改文本状态轨迹方案
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


def make_img(word, color=(0, 0, 0)):
    img = Image.new("RGB", (384, 384), "white")
    d = ImageDraw.Draw(img)
    f = ImageFont.truetype(FONT, 95)
    bb = d.textbbox((0, 0), word, font=f)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    d.text(((384 - w) / 2 - bb[0], (384 - h) / 2 - bb[1]), word, font=f, fill=color)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def call_chat(prompt, images_b64, max_tokens=1024):
    content = [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}} for b in images_b64]
    content.append({"type": "text", "text": prompt})
    body = {"model": LLAMA_MODEL, "messages": [{"role": "user", "content": content}],
            "temperature": 0.0, "max_tokens": max_tokens}
    t0 = time.time()
    req = urllib.request.Request(f"{LLAMACPP}/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read())
    return {"content": data["choices"][0]["message"]["content"],
            "finish": data["choices"][0].get("finish_reason"),
            "usage": data.get("usage"), "dt": time.time() - t0}


PROMPT = ("下面有 {n} 张图片，它们以特定顺序传入。"
          "请严格按照传入顺序，依次说出每张图中的英文单词。"
          "输出格式：1=单词, 2=单词, ... 只输出这一行。")


def run_case(label, imgs):
    p = PROMPT.format(n=len(imgs))
    r = call_chat(p, imgs)
    content = r["content"].strip().replace("\n", " ")[:200]
    print(f"  [{label:22s}] ({r['dt']:.1f}s) finish={r['finish']} ct={r['usage']['completion_tokens']}")
    print(f"    → {content}")


def main():
    red = make_img("RED", (220, 0, 0))
    green = make_img("GREEN", (0, 160, 0))
    sun = make_img("SUN", (200, 150, 0))
    moon = make_img("MOON", (0, 0, 0))

    print("=" * 72)
    print("测试1: RED/GREEN (颜色词，无天然先后)")
    run_case("[RED,GREEN]", [red, green])
    run_case("[GREEN,RED]", [green, red])

    print("\n测试2: SUN/MOON (无天然先后)")
    run_case("[SUN,MOON]", [sun, moon])
    run_case("[MOON,SUN]", [moon, sun])

    print("\n测试3: 三帧 (同图重复，测顺序记忆)")
    run_case("[RED,GREEN,RED]", [red, green, red])
    run_case("[GREEN,RED,GREEN]", [green, red, green])

    print("\n测试4: 四帧 (更接近 run_task 实际帧数)")
    run_case("[RED,GREEN,SUN,MOON]", [red, green, sun, moon])
    run_case("[MOON,SUN,GREEN,RED]", [moon, sun, green, red])


if __name__ == "__main__":
    main()
