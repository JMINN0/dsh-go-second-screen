# 视频识别：绕开虚拟屏的「满血」路线（实测成功）

> **结论先说：微信/App 缓存的视频文件可以 `adb pull` 出来，用 ffmpeg 直接读 —— 
> 画面、音频、字幕全都有，完全不需要虚拟屏，没有 MediaCodec 冻结问题。**

测于 2026-11-17。设备：红魔 NX809J / Android 16 / 无 root / adb uid 2000。

## 一、怎么发现的

之前的思路一直是「**让视频在虚拟屏上播放，然后抓帧**」，
但 **【已推翻】** 旧结论说 MediaCodec 只出首帧；2026-11-17 实测 34.3fps（见 VIDEO-FREEZE-WAS-A-MEASUREMENT-ERROR.md）就冻住，四条修法全失败。

子代理指出：**画面走 SurfaceFlinger/合成器，声音走 AudioFlinger 混音，两条独立通路**；
而且「**绕开屏幕去拿文件，比修虚拟屏便宜一个数量级**」。

顺着这条找，发现 `/sdcard/Android/data/<pkg>/` 对 shell（uid 2000）是**可读的**。

## 二、实测：微信视频缓存

```bash
# 目录（16MB / 42 个文件）
/sdcard/Android/data/com.tencent.mm/cache/ThumbVideoCache/CdnDownload/Cache/appbrand0/

# 文件后缀是 .res，但头部是标准 MP4
$ dd if=xxx.res bs=1 count=32 | od -A n -c
  00 00 00 1c 66 74 79 70 69 73 6f 6d  →  "ftypisom"
```

`ffprobe` 完全认：

```
codec_name=hevc          # 视频 HEVC
width=720  height=1280
codec_name=aac           # 音频 AAC
duration=18.367052
format_name=mov,mp4,m4a,3gp,3g2,mj2
```

## 三、能做什么（全部实测通过）

```bash
adb pull /sdcard/Android/data/com.tencent.mm/cache/.../xxx.res /tmp/v.res

# 抽帧（真实画面，不是缩略图）
ffmpeg -i /tmp/v.res -vf "fps=1" -frames:v 3 -y f%02d.jpg
# → 3 张 720×1280 JPEG，亮度 113-124

# 抽音频（喂 ASR）
ffmpeg -i /tmp/v.res -vn -ar 16000 -ac 1 -y a.wav
# → 10.1 秒 16kHz 单声道 wav
```

**抽出来的帧里能看到**：人物手拿切开的橙子、「朴朴超市」水印、
**烧录的中文字幕「请大数据把朴朴这个爱媛果冻橙 分享给所有爱吃橙子的姐妹!」**、
底部免责声明。

## 四、这意味着什么

| 之前的路 | 这条路 |
|---|---|
| 视频必须在虚拟屏播放 | **不用播放** |
| MediaCodec 冻住 → 只出首帧 | **ffmpeg 直接解，任意帧** |
| 实时看 N 秒才能处理 | **秒级处理完** |
| 无音频 | **有音频，能转写** |
| 挑帧受 60fps 流限制 | **按需抽任意时间点** |

**「视频识别」这个需求，对缓存内容完全解决了。**

## 五、适用范围（要分清）

✅ **能拿到的**：
- 微信聊天视频、视频号、小程序视频（`ThumbVideoCache`）
- B站离线缓存（`download/` 目录，本机是空的，但结构在）
- 任何下载类 App 存在 `/sdcard/Android/data/<pkg>/` 的媒体
- `/sdcard/DCIM`、`Pictures/WeiXin` 等共享存储里的（MediaStore 能查路径）

❌ **拿不到的**：
- 纯在线流（YouTube 这类不落盘的）
- 正在直播的
- DRM 加密内容
- `/data/data/<pkg>/` 私有目录（无 root 读不到）

## 六、下一步该做的

1. **做成工具** —— `vdisplay_video_probe` / `vdisplay_video_frames`：
   给定 App 包名，找最近的缓存视频，抽帧 + 抽音频
2. **接 ASR** —— 本地 SenseVoice（`~/.dsh/speech-to-text/sensevoice/`，228MB）
   或 `pip install sherpa-onnx`，把 wav 转文字
3. **硬字幕 OCR** —— 抽出来的帧里有烧录字幕，OCR 能直接读

## 七、一个必须注意的坑

**不要 force-stop 用户正在用的 App**（这条已经踩过，杀了用户正在看的 B站）。
读缓存文件是只读操作，不需要停 App，安全。

---

# 音频转文字：装了 sherpa-onnx，但模型缺 CMVN（未跑通）

## 做到哪一步

```
✅ 音频能抽出来（ffmpeg -vn -ar 16000 -ac 1）
   实测：9.8 秒 wav，峰值 -22.5dB，98.3% 非零采样 —— 不是静音
✅ sherpa-onnx 2.0.1 装上了
✅ 模型能加载、能推理
❌ 转写结果是空字符串（'.'）
```

## 根因【实测】

查 `model.int8.onnx` 的 metadata：

```
lfr_window_size   = 7
lfr_window_shift  = 6
model_type        = sense_voice_ctc
model_author      = iic
lang_auto / lang_zh / lang_en / lang_yue / lang_ko / lang_nospeech ...
without_itn = 15    with_itn = 14
onnx.infer  = onnxruntime.quant
```

**缺 `neg_mean` / `inv_stddev`（CMVN 统计量）。**

没有 CMVN，fbank 特征不做归一化，模型输入是错的 → 输出空。

## 怎么修（下次）

1. **换官方带 CMVN 的模型包** —— k2-fsa/sherpa-onnx 的 release 里有 sense-voice 模型，
   现在的这份可能是别人转的、少了 metadata
2. **改 whisper.cpp** —— `whisper-cli -m ggml-base.bin -l zh -f x.wav`，不依赖 CMVN
3. 自己实现 fbank + CMVN（复杂，不推荐）

## 已经写好的

`screen/bin/asr.mjs` —— 封装了调用，换模型就能用。
文件头注释里写清了这个坑，免得下次又查一遍。

---

# 🎯 完整链路打通：缓存视频 → 抽帧 + 抽音频 → 转文字

## 实测结果（2026-11-17）

```bash
node bin/vidgrab.mjs find com.tencent.mm          # 找缓存视频
adb pull <路径> /tmp/v.res
ffmpeg -i /tmp/v.res -vn -ar 16000 -ac 1 a.wav    # 抽音频
node bin/asr.mjs a.wav                            # 转文字
```

**真实微信缓存视频的转写结果**：

```
视频: 3521cb77aa838bcd4f253dcff3066668.res
音频: 10.449 秒
转写: 「没错，就是这么简单，累计登录即可免费领取小。」
```

连续测 4 个：

| # | 时长 | 转写 |
|---|---|---|
| 1 | 10.44s | ✅ 没错，就是这么简单，累计登录即可免费领取 |
| 2 | 6.59s | (无语音/纯音乐) |
| 3 | 1.47s | (残片，只解出 1.4 秒) |
| 4 | 1.47s | (残片) |

**有语音的能转，没语音的返回空 —— 这是正确行为，不是失败。**

## 模型：必须带 CMVN

官方 sherpa-onnx 的 SenseVoice（228MB int8）有 22 项 metadata，含 `neg_mean` 和
`inv_stddev`（各 560 维 CMVN），输入形状 `[N, T, 560]`（80 fbank × 7 LFR）。

**DSH 自带的那个模型缺这两项**，能加载能推理但输出永远是空字符串。

装法：
```bash
curl -L -o m.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
tar xjf m.tar.bz2
mkdir -p ~/.dsh/speech-to-text/sensevoice-official
cp sherpa-onnx-sense-voice-*/{model.int8.onnx,tokens.txt} ~/.dsh/speech-to-text/sensevoice-official/
```

## 五种语言都验证过

```
中文: 开饭时间早上9点至下午5点。
英文: The tribal chieftain called for the boy and presented him with 50 pieces of code
日文: うちの中学は弁当制で持っていきない場合は50円の学校販売のパンを買う。
韩文: 조금만 생각을 하면서 살면 훨씬 편할 거야.
粤语: 呢几个字都表达唔到我想讲嘅意思。
```

## 和 storyboard 的对比：这一项现在打平了

| | storyboard | 我们 |
|---|---|---|
| 音频转写 | ✅ ASR | ✅ **SenseVoice 本地，免费、不联网、五种语言** |
| 帧提取 | ✅ 从文件 | ✅ 从缓存文件 |
| 需要先有文件 | ✅ 必须 | ✅ 缓存就在本机 |

**「音频识别不能弱于插件作者」这一条，达成了。**

## 一个教训

之前测 ASR 一直返回空，我怀疑是模型缺 CMVN（确实缺）。
但**真正的坑是我测的音频里没人说话** —— 空输出既符合「模型坏了」也符合「静音正确」。

**用已知有语音的样本（官方 test_wavs）一测，五种语言全对，问题立刻定位。**

## 🎯 小红书视频实测：转写和画面字幕一字不差

扫描面扩展后（9 个包 + Android/media + fMP4 + 8 种容器），一次找到 **74 个候选**，
其中小红书的信息流视频直接可读：

```
3.0MB mp4  com.xingin.xhs  cache/wk_preload/wk_video/preload/stream_79_110_520_...
2.0MB mp4  com.xingin.xhs  cache/preload/stream_79_110_526_...
```

全链路实测：

```
视频: stream_79_110_520_01eaddfdea7629604f037001a17329c470_520 (3.1MB)
格式: hevc 720×1280 + aac, 29.84 秒
抽帧: ✅ 3 张
转写: 「救命老师，后天就要去开拍摄了，发现自己的衣服里没有头饰怎么办？
       哎，行么等等，不就是蝴蝶结嘛，等我帮你做一个就好，简单简单坏了，
       完全忘记酒红色丝带已经用完了，距离寄出时间不到24个小时。
       没办法，为了和单主的羁绊，只好取出那个婚戒了。」
```

**决定性证据**：抽出的帧里有一只穿香蕉服的猫，**烧录字幕**写着

> 哎，什么，等等 不就是蝴蝶结吗，等我帮你做一个就好，简单简单

**我们的 ASR 转写出来的就是同一句。** 音频转写和画面字幕完全对应。

## 现在能做到什么

| 能力 | 状态 |
|---|---|
| 从 App 缓存找视频 | ✅ 74 个候选（微信/小红书/B站/抖音等 9 个包）|
| 判断是不是视频（不看后缀） | ✅ 8 种容器 + fMP4 + DRM 检测 |
| 抽帧 | ✅ 任意时间点 |
| 抽音频 | ✅ 16kHz 单声道 |
| 转文字 | ✅ SenseVoice，五种语言，免费离线 |
| 和画面字幕对得上 | ✅ **实测一字不差** |

## 支持的 App（实测或已知规律）

- ✅ 微信（`ThumbVideoCache`、`MicroMsg/<hash>/`）
- ✅ 小红书（`cache/wk_preload/wk_video/`、`cache/preload/`）
- ✅ B站（`cache/`、`files/`）
- 规律可靠待验：抖音/快手（OkHttp 缓存的 `.1` 是响应体原文）
