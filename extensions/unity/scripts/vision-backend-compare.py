"""
ollama vs llama.cpp 多图顺序感知对比测试。

核心问题：decideAction 把 [...历史帧, 当前帧] 塞进 images 数组，
模型是否感知"数组顺序 = 时间序列"？

本脚本对两个后端跑完全相同的测试：
- ollama: /api/generate (decideAction 当前用的) + /v1/chat/completions
- llama.cpp: /v1/chat/completions

测试：生成带标识的图（ALPHA/BETA + 角标），换序看答案是否跟着变。
"""
import base64
import io
import json
import time
import urllib.request
from PIL import Image, ImageDraw, ImageFont

OLLAMA = "http://127.0.0.1:11434"
LLAMACPP = "http://127.0.0.1:18080"
OLLAMA_MODEL = "minicpm-v4.6:latest"
LLAMA_MODEL = "minicpm-v"  # llama.cpp 不校验 model 名
FONT = "C:/Windows/Fonts/arialbd.ttf"


def make_img(word, corner, bg=(255, 255, 255), fg=(0, 0, 0)):
    img = Image.new("RGB", (384, 384), bg)
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(FONT, 90)
    small = ImageFont.truetype(FONT, 40)
    bb = d.textbbox((0, 0), word, font=big)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    d.text(((384 - w) / 2 - bb[0], (384 - h) / 2 - bb[1]), word, font=big, fill=fg)
    d.text((20, 10), corner, font=small, fill=(200, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def call_chat(base_url, model, prompt, images_b64, max_tokens=100):
    """OpenAI 兼容 /v1/chat/completions，多图每张一个 image_url。"""
    content = [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}} for b in images_b64]
    content.append({"type": "text", "text": prompt})
    body = {"model": model, "messages": [{"role": "user", "content": content}],
            "temperature": 0.0, "max_tokens": max_tokens}
    t0 = time.time()
    req = urllib.request.Request(f"{base_url}/v1/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
        dt = time.time() - t0
        ch = data["choices"][0]
        return {"content": ch["message"]["content"], "finish": ch.get("finish_reason"),
                "usage": data.get("usage"), "dt": dt, "ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e), "dt": time.time() - t0}


def call_ollama_generate(prompt, images_b64):
    body = {"model": OLLAMA_MODEL, "prompt": prompt, "images": images_b64,
            "stream": False, "options": {"temperature": 0.0, "num_predict": 100}}
    t0 = time.time()
    req = urllib.request.Request(f"{OLLAMA}/api/generate", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
        return {"content": data.get("response", ""), "finish": data.get("done_reason"),
                "dt": time.time() - t0, "ok": True}
    except Exception as e:
        return {"ok": False, "error": str(e), "dt": time.time() - t0}


PROMPT = ("附图共 {n} 张，按数组顺序排列（第1张到第{n}张）。"
          "请按顺序分别说出每张图中央的大写英文单词。"
          "只输出一行，格式严格为：1=单词, 2=单词, ... 不要解释。")


def main():
    alpha = make_img("ALPHA", "1")
    beta = make_img("BETA", "2")
    cases = [
        ("顺序 [ALPHA,BETA]",      [alpha, beta]),
        ("打乱 [BETA,ALPHA]",       [beta, alpha]),
        ("三帧 [ALPHA,BETA,ALPHA]", [alpha, beta, alpha]),
    ]
    backends = [
        ("ollama generate", lambda p, imgs: call_ollama_generate(p, imgs)),
        ("llama.cpp chat",  lambda p, imgs: call_chat(LLAMACPP, LLAMA_MODEL, p, imgs, max_tokens=200)),
    ]

    print("=" * 72)
    for label, imgs in cases:
        p = PROMPT.format(n=len(imgs))
        print(f"\n### {label}")
        for bname, fn in backends:
            r = fn(p, imgs)
            if r["ok"]:
                content = r["content"].strip().replace("\n", " ")[:180]
                print(f"  [{bname:18s}] ({r['dt']:.1f}s) finish={r.get('finish')} → {content}")
            else:
                print(f"  [{bname:18s}] ERROR: {r['error']}")


if __name__ == "__main__":
    main()
