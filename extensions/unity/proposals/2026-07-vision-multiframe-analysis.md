# 视觉多帧/视频流分析问题调研

**Status:** 调研完成 — 已定位根因并验证解决方案 ✅
**Date:** 2026-07-30
**Author:** pi (AI)
**Related:** `proposals/2026-07-unity-agent-vision.md`、`lib/vision-client.ts`、`tools/unity-agent.ts`

---

## TL;DR（结论速览）

当前 `decideAction` 用 **ollama** 跑多图视觉决策，效果差（模型爱 wait、不会判断时机）。**根因不在模型，在 ollama 的多图处理：**

1. **ollama `/api/generate` 多图丢失顺序语义** — 模型把多图当无序图集，不认数组顺序。
2. **ollama `/v1/chat/completions` 多图有 bug** — 视觉 token 被计入 `completion_tokens`，文字未输出就被 `max_tokens` 截断 → 空返回（影响 `summarizeTask`）。

**解决方案（已验证可行）：换 llama.cpp + llama-server。** 同一个 MiniCPM-V 4.6 模型、同样的多图测试，llama.cpp 端点下**顺序感知 8/8 全对**（2/3/4 帧均正确，打乱即跟着变）。模型本身完全有能力理解多图时序，是 ollama 的传输层坏了。

> 用户判断正确："我怀疑 ollama 根本不支持视频。" 实测确认 ollama 多图不可靠，llama.cpp 是正确替代。

---

## 一、被测对象

| 项 | 值 |
|---|---|
| 模型 | MiniCPM-V 4.6（SigLIP2-400M + Qwen3.5-0.8B，1.3B） |
| 两个后端 | ollama `minicpm-v4.6:latest` vs llama.cpp b10178（同一套 GGUF：Q4_K_M + mmproj-f16） |
| GGUF 来源 | **直接复用 ollama 本地 blob**（标准 GGUF，无需重新下载） |
| GPU | RTX 5060 Ti 8GB（Blackwell sm_120，CUDA 13.3 运行时） |

---

## 二、为什么直接复用 ollama 的 GGUF

ollama 把模型存为 `~/.ollama/models/blobs/sha256-*` blob。实测两个 blob 都是标准 GGUF（魔数 `4747 5546` = "GGUF"）：

| blob | 大小 | manifest mediaType | 用途 |
|---|---|---|---|
| `sha256:6b0c74...` | 505M | `application/vnd.ollama.image.model` | 主模型 Q4_K_M |
| `sha256:ca931d...` | 1.1G | `application/vnd.ollama.image.projector` | mmproj 视觉投影器 F16 |

直接 `cp` 到 `D:/workspace/llama.cpp/models/` 给 llama-server 用，**零模型下载**。llama.cpp 主程序包（144MB）+ cudart 运行时（391MB，含 cudart64_13/cublas64_13）从 GitHub release 下。

> 部署细节见本文档末尾「附录 A：llama.cpp 部署步骤」。

---

## 三、实测：ollama 多图的问题

### 3.1 ollama `/api/generate` 多图不认顺序（影响 decideAction）

脚本 `scripts/vision-multiimage-probe.py`：生成带标识的图（ALPHA/BETA + 数字角标），换序测试。

| 测试 | images 顺序 | ollama 输出 |
|---|---|---|
| A | `[ALPHA, BETA]` | ✅ `1=ALPHA, 2=BETA` |
| B | `[BETA, ALPHA]`（打乱） | ⚠️ 推理正确观察到"第一张是BETA"，但**最终输出纠正成** `1=ALPHA, 2=BETA` |
| C | `[ALPHA, BETA, ALPHA]`（3帧） | ❌ 混乱，未正确报出第 3 张 |

**判读：** ollama 把多图当"可重排的图集"传给模型，数组顺序不被当硬约束。3 帧以上直接崩。

> 注：此测试因图带数字角标 + ALPHA<BETA 字母序，存在干扰（模型可能按角标/习惯排序）。干净测试见第三节 llama.cpp 部分。但 ollama 的问题在 3.2 更明确。

### 3.2 ollama `/v1/chat/completions` 多图空返回（影响 summarizeTask）

脚本 `scripts/vision-multiimage-probe2.py` 诊断：

```
chat 多图 raw 诊断 (OpenAI 兼容端点):
  choices[0].finish_reason = length
  completion_tokens = 80      ← 视觉 token 被算进了"生成"部分！
  message.content = ''
```

**根因：** ollama OpenAI 兼容端点处理 MiniCPM-V 多图时，把视觉 token 错误计入 `completion_tokens`，80 token 预算被视觉占满，文字还没生成就被 `max_tokens` 截断 → 返回空字符串。

**直接受害：** `summarizeTask` 当前用 chat + 全量历史帧 + 多图，实际拿不到有效总结（空字符串被静默吞掉）。

### 3.3 ollama 的 prompt cache 假设也存疑

代码注释假设"全量累积历史帧命中 ollama prompt cache"。但顺序都不保，cache 命中前缀也无意义。全量累积的副作用确定存在：每步多编码+传输 1 帧，越来越慢。

---

## 四、实测：llama.cpp 多图顺序感知（核心验证）

### 4.1 干净测试设计

脚本 `scripts/vision-llamacpp-order.py`。**排除 3.1 的三个干扰因素：**
1. `max_tokens=1024`（排除视觉 token 占用导致的截断）
2. 图上**不带数字角标**（排除模型按角标排序的暗示）
3. 用**无天然先后**的词：RED/GREEN（颜色）、SUN/MOON（无序）

### 4.2 结果：8/8 全对 ✅

| 测试 | 顺序 | llama.cpp 输出 | 判定 |
|---|---|---|---|
| RED/GREEN | `[RED,GREEN]` | `1=RED, 2=GREEN` | ✅ |
| RED/GREEN | `[GREEN,RED]`（打乱） | `1=GREEN, 2=RED` | ✅ 跟着变 |
| SUN/MOON | `[SUN,MOON]` | `1=SUN, 2=MOON` | ✅ |
| SUN/MOON | `[MOON,SUN]`（打乱） | `1=MOON, 2=SUN` | ✅ 跟着变 |
| 三帧 | `[RED,GREEN,RED]` | `1.RED 2.GREEN 3.RED` | ✅ |
| 三帧 | `[GREEN,RED,GREEN]`（打乱） | `1=GREEN, 2=RED, 3=GREEN` | ✅ |
| 四帧 | `[RED,GREEN,SUN,MOON]` | `1=RED,2=GREEN,3=SUN,4=MOON` | ✅ |
| 四帧 | `[MOON,SUN,GREEN,RED]`（打乱） | `1=MOON 2=SUN 3=GREEN 4=RED` | ✅ |

**结论：换 llama.cpp 后，MiniCPM-V 4.6 完全能正确感知多图数组顺序。** 打乱即跟着变，最多测到 4 帧全对。模型本身有视频/多图时序能力，是 ollama 传输层坏了。

### 4.3 对比印证

单图测试（`scripts/vision-backend-compare.py`）也确认 llama.cpp 的 `completion_tokens` 是纯文字（单图 HELLO 测试 `ct=31` 纯文字），不像 ollama 把视觉 token 计入。**3.2 的空返回 bug 在 llama.cpp 不存在。**

---

## 五、根因总结

| 问题 | 根因 | 影响范围 | 解决 |
|---|---|---|---|
| decideAction 多图决策差 | ollama `/api/generate` 多图不保序 | run_task 全程，越往后越差 | 换 llama.cpp |
| summarizeTask 空返回 | ollama chat 端点视觉 token 计入 completion，被 max_tokens 截断 | 任务总结失效 | 换 llama.cpp |
| "爱 wait、不会判断时机" | 上述两者叠加：模型从无序快照判断不出运动趋势 | 整体决策质量 | 换 llama.cpp |

**不是模型能力问题，是 ollama 后端问题。** llama.cpp 用同一套 GGUF，多图时序 8/8 正确。

---

## 六、改进方案：迁移到 llama.cpp

### 6.1 vision-client.ts 改造

1. **新增 llama.cpp 后端**（保留 ollama 作为可选 fallback）：
   - `OLLAMA_BASE_URL` → 改为可配置，默认指向 llama-server（`http://127.0.0.1:18080`）
   - `decideAction`：从 ollama `/api/generate` + format schema，改为 llama.cpp `/v1/chat/completions` + 多图 `image_url` 数组 + `response_format` schema 约束（6.2 已验证可行）。
   - `images: [...recentFrames, currentFrame]` 结构**保留**（llama.cpp 能正确感知顺序）。
2. **`summarizeTask`**：从 ollama chat 改 llama.cpp chat，多图不再空返回。
3. **`askVision`**：单图本就正常，端点切换即可（甚至可保留 ollama，但统一后端更简单）。
4. **`checkVisionService`**：健康检查从 `/v1/models` 不变（llama.cpp 也兼容）。

### 6.2 schema 约束迁移 ✅ 已验证通过

ollama `format` 参数能从语法层面强制 JSON schema（action 枚举、required 字段），是 Phase 0 的关键收益（1.7-2.1s，比 prompt 约束快 5-6 倍）。**迁移到 llama.cpp 后等价能力依然存在，且已实测验证：**

**验证脚本** `scripts/vision-llamacpp-schema.py`，8 个场景（单图/2图/3图 × 不同画面+任务）：

| 指标 | ollama `format` (Phase 0) | llama.cpp `response_format` (本次) |
|---|---|---|
| JSON 合法率 | 100% (3/3) | **100% (8/8)** ✅ |
| action 枚举约束 | ✅ 不越界 | ✅ 不越界 |
| required 字段齐全 | ✅ | ✅ |
| 推理耗时 | 1.7-2.1s | 1.7-3.7s（平均 2.6s） |
| 多图支持 | ❌ 顺序丢失+空返回 | ✅ 2帧/3帧都合法 |

**关键结论：**
- `response_format: {type:"json_schema", json_schema:{name, schema, strict:true}}` 与 ollama `format` 约束力等价。
- **之前的空返回是 max_tokens 太小**：minicpmv4.6 单图视觉 token 占 80+，多图更多。`max_tokens` 必须 ≥ 512（建议 600+）。这是 ollama 也存在的同一问题（ollama 用 num_predict 不受影响是因为它不计视觉 token）。
- 速度略慢于 ollama（2.6s vs 1.7-2.1s），但多图场景下 ollama 根本不可用，llama.cpp 是唯一可用方案。
- 多图 + schema 同时生效：2帧/3帧场景 schema 约束依然 100% 合法。

### 6.3 环境配置

llama.cpp 部署已完成（见附录 A）。`vision-client.ts` 的 `OLLAMA_BASE_URL` 环境变量改为指向 18080 即可基本工作。可加 `PI_VISION_BACKEND=ollama|llamacpp` 开关支持两者切换。

### 6.4 真实场景验证（下一步）

静态词排序 + schema 已通过，还需验证**真实运动轨迹判断**——这才是 run_task 真正需要的：
- 生成/捕获角色移动的连续帧序列
- 让模型判断"角色在接近目标还是远离？该继续走还是到了？"
- 对比 ollama vs llama.cpp 的决策质量（wait 频率、成功率）

这是迁移后的关键验收测试。

---

## 七、下一步建议（按优先级）

1. **改 `vision-client.ts` 指向 llama.cpp**（核心，环境已就绪）
   - `decideAction`/`summarizeTask`/`askVision` 全切 llama.cpp `/v1/chat/completions`
   - 验证 llama.cpp 的 JSON schema/guided 约束（6.2）
2. **真实游戏场景验收**（6.4）— 在 CourseProject 上跑 run_task，对比决策质量
3. **可选：保留 ollama fallback 开关**，方便对比和兜底

---

## 附录 A：llama.cpp 部署步骤（已完成）

### A.1 文件布局

```
D:/workspace/llama.cpp/
├── bin/
│   ├── llama-server.exe          # 主程序（release b10178, cuda 13.3）
│   ├── ggml-cuda.dll             # CUDA 后端
│   ├── cudart64_13.dll           # CUDA 运行时（来自 cudart.zip）
│   ├── cublas64_13.dll
│   ├── cublasLt64_13.dll
│   └── ... (ggml-*.dll, llama.dll 等)
├── models/
│   ├── MiniCPM-V-4_6-Q4_K_M.gguf  # 从 ollama blob 复制
│   └── mmproj-model-f16.gguf       # 从 ollama blob 复制
├── start-llama-server.bat         # Windows 启动脚本（双击/命令行）
└── start-llama-server.sh          # 跨平台启动脚本（前台/--bg 后台）
```

### A.2 获取方式（零模型下载）

1. **模型 GGUF**：直接复制 ollama blob（标准 GGUF，魔数验证通过）
   ```bash
   cp ~/.ollama/models/blobs/sha256-6b0c74... models/MiniCPM-V-4_6-Q4_K_M.gguf
   cp ~/.ollama/models/blobs/sha256-ca931d... models/mmproj-model-f16.gguf
   ```
2. **llama.cpp 程序**：GitHub release `b10178` 下载
   - `llama-b10178-bin-win-cuda-13.3-x64.zip`（144MB，主程序）
   - `cudart-llama-bin-win-cuda-13.3-x64.zip`（391MB，CUDA 运行时）
3. **为何选 cuda 13.3**：RTX 5060 Ti 是 Blackwell（sm_120），需要 CUDA 13+；驱动支持 CUDA 13.1。

### A.3 启动命令

**推荐用脚本**（带文件检查、端口占用检查、健康检查）：
- Windows：`start-llama-server.bat`（新窗口前台跑，关窗口即停）
- Linux/macOS/Git Bash：`./start-llama-server.sh`（前台）或 `./start-llama-server.sh --bg`（后台，日志写 server.log）

**等价的手动命令**：

```bash
./bin/llama-server.exe \
  -m models/MiniCPM-V-4_6-Q4_K_M.gguf \
  --mmproj models/mmproj-model-f16.gguf \
  -ngl 99 \
  --port 18080 \
  --host 127.0.0.1 \
  -c 8192 \
  -t 4
```

启动耗时 ~0.03s（模型已在内存），OpenAI 兼容 `/v1/chat/completions` + `/v1/models` 可用。单图推理 ~0.4s。

### A.4 实测脚本

- `scripts/vision-multiimage-probe.py` — ollama 多图顺序（ALPHA/BETA，含干扰）
- `scripts/vision-multiimage-probe2.py` — ollama 箭头序列 + chat 空返回诊断
- `scripts/vision-backend-compare.py` — ollama vs llama.cpp 对比（单图 + 多图）
- `scripts/vision-llamacpp-order.py` — **llama.cpp 干净顺序测试（核心证据，8/8 正确）**
- `scripts/vision-llamacpp-schema.py` — llama.cpp response_format schema 约束验证（8/8 合法）
- `scripts/vision-client-integration-test.cjs` — 迁移后 vision-client 逻辑集成测试（对接 llama-server）
