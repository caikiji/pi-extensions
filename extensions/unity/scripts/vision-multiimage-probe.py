"""
实测 ollama /api/generate 的 images 数组多图行为。

核心问题：decideAction 把 [...历史帧, 当前帧] 全塞进 images 数组，
模型（MiniCPM-V 4.6）是否真的感知"数组顺序 = 时间序列"？

实验：生成两张自带标识的图（大写英文单词 + 数字角标），换序测试。
- 顺序 A: [img1=ALPHA, img2=BETA] → 期望 "1=ALPHA, 2=BETA"
- 顺序 B: [img2=BETA,  img1=ALPHA] → 期望 "1=BETA,  2=ALPHA"
- 顺序 C: [img1, img2, img1] → 期望 "1=ALPHA, 2=BETA, 3=ALPHA"

若换序后答案不变（仍按图自身内容报 ALPHA/BETA），说明模型只把多图当独立集合，
不感知数组顺序 —— 这就是视频流分析效果差的根因。

同时对比 chat 端点（/v1/chat/completions，content 数组多 image_url）。
"""
import base64
import io
import json
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFont

OLLAMA = "http://127.0.0.1:11434"
MODEL = "minicpm-v4.6:latest"

FONT_PATH = "C:/Windows/Fonts/arialbd.ttf"  # Arial Bold


def make_img(word: str, corner: str, bg=(255, 255, 255), fg=(0, 0, 0)) -> str:
    """生成一张 384x384 白底图，中央大写 word，左上角小角标 corner。返回纯 base64。"""
    img = Image.new("RGB", (384, 384), bg)
    d = ImageDraw.Draw(img)
    big = ImageFont.truetype(FONT_PATH, 90)
    small = ImageFont.truetype(FONT_PATH, 40)
    # 中央大字
    bb = d.textbbox((0, 0), word, font=big)
    w, h = bb[2] - bb[0], bb[3] - bb[1]
    d.text(((384 - w) / 2 - bb[0], (384 - h) / 2 - bb[1]), word, font=big, fill=fg)
    # 左上角标
    d.text((20, 10), corner, font=small, fill=(200, 0, 0))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def call_generate(prompt: str, images_b64: list[str]) -> tuple[str, float]:
    body = {
        "model": MODEL,
        "prompt": prompt,
        "images": images_b64,
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": 120},
    }
    t0 = time.time()
    req = urllib.request.Request(
        f"{OLLAMA}/api/generate",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    return data.get("response", ""), time.time() - t0


def call_chat(prompt: str, images_b64: list[str]) -> tuple[str, float]:
    """OpenAI 兼容端点：每张图一个 image_url + 末尾 text。"""
    content = [{"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b}"}} for b in images_b64]
    content.append({"type": "text", "text": prompt})
    body = {
        "model": MODEL,
        "messages": [{"role": "user", "content": content}],
        "temperature": 0.0,
        "max_tokens": 120,
    }
    t0 = time.time()
    req = urllib.request.Request(
        f"{OLLAMA}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as r:
        data = json.loads(r.read())
    return data["choices"][0]["message"]["content"], time.time() - t0


PROMPT = (
    "附图共 {n} 张，按数组顺序排列（第1张到第{n}张）。"
    "请按顺序分别说出每张图中央的大写英文单词。"
    "只输出一行，格式严格为：1=单词, 2=单词, ... 不要解释。"
)


def run():
    alpha = make_img("ALPHA", "1")
    beta = make_img("BETA", "2")

    tests = [
        ("generate [ALPHA,BETA]",      "generate", [alpha, beta]),
        ("generate [BETA,ALPHA]",       "generate", [beta, alpha]),
        ("generate [ALPHA,BETA,ALPHA]", "generate", [alpha, beta, alpha]),
        ("chat     [ALPHA,BETA]",       "chat",     [alpha, beta]),
        ("chat     [BETA,ALPHA]",       "chat",     [beta, alpha]),
    ]

    print(f"模型: {MODEL}\n{'='*70}")
    for label, mode, imgs in tests:
        prompt = PROMPT.format(n=len(imgs))
        try:
            if mode == "generate":
                ans, dt = call_generate(prompt, imgs)
            else:
                ans, dt = call_chat(prompt, imgs)
            ans = ans.strip().replace("\n", " ")[:160]
            print(f"\n[{label}]  ({dt:.1f}s)")
            print(f"  → {ans}")
        except Exception as e:
            print(f"\n[{label}]  ERROR: {e}")


if __name__ == "__main__":
    run()
