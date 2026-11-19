# OCR 调参实测：三个「看起来该有用」的手段，实测没用甚至反效果

> 2026-11-19。**这是实测，不是估算。** 子代理给的数字是算术推的，实测推翻了其中两个。

## 测试条件

- 图：真实虚拟屏截图 **1592×720**
- 包：`rapidocr_onnxruntime`（**不是 `rapidocr`** —— 两个包 API 不兼容，见下）
- 配置：`det_limit_side_len=320, det_limit_type="min", intra_op_num_threads=6`
- 每组跑 3 次取中位，先预热一次

## 结果

| 配置 | 耗时 | 相对基线 | 子代理估算 | 差异 |
|---|---|---|---|---|
| **基线**（现用）| **961ms** | — | — | — |
| 关 `use_cls` | 935ms | **−3%** | −20~30%（380-770ms）| **差一个数量级** |
| 关cls + `rec_batch_num=16` | 1180ms | **+23%（更慢）** | −15~25% | **方向相反** |

文字内容：关 cls 后 **0 行差异**（11 行全一致）。

## 为什么估算错了

### ① cls 的成本被高估了

子代理按「96 框 × 4-8ms = 380-770ms」算。实测只有 26ms。
可能原因：cls 是**批处理**的，不是逐框跑；而且 cls 模型很小（3×48×192 输入）。

### ② `rec_batch_num=16` 反而慢

子代理自己写了「内存峰值↑；批大易落到小核，实测可能反而慢」——
**实测确实是慢**。这颗 8 核（2 大 + 6 小）的调度下，大 batch 落到小核，反而比 batch=6 慢 23%。

## 两个必须记住的坑

### ① 装了两个 rapidocr 包，API 不兼容

```
rapidocr_onnxruntime  →  RapidOCR(config_path=None, **kwargs)      ✅ 接受 det_limit_side_len 等
rapidocr              →  RapidOCR(config_path=None, params=None)   ❌ 拒绝 kwargs
```

**ocr_helper.py 用的是前者**（`from rapidocr_onnxruntime import RapidOCR`）。
如果测试脚本写 `from rapidocr import RapidOCR`，会报
`TypeError: RapidOCR.__init__() got an unexpected keyword argument 'det_limit_side_len'` ——
**看起来像 OCR 坏了，其实只是 import 错了包**（我这次就踩了）。

### ② 这张测试图只有 11 行，不是 96 框

所以 cls 的绝对成本本来就小。**在 96 框的密集界面（如 B 站首页）上，cls 的收益可能不同** ——
这一条【未验证】，要给密集界面单独测一次才能下结论。

## 结论

| 手段 | 建议 |
|---|---|
| `use_cls=False` | **可以开**（省 3%，文字零差异，无风险）|
| `rec_batch_num=16` | **不要开**（慢 23%）|
| 其他手段 | 需要在自己的图上实测，不要照抄估算 |

## 真正的大头在哪（已实测）

```
tapText 端到端 4.1 秒（优化后，原 6.1 秒）拆解：
  截图         376ms
  OCR          2000-3000ms   ← 大头
  注入         250ms
  后验截图+等待 876ms
```

**OCR 本身占一半以上。** 而减少 OCR 成本唯一有效的路是**缩小识别范围**（ROI），
不是调参 —— 调参空间已经被实测证明很窄（3%）。

ROI 的关键坑（子代理指出，未实测）：`det_limit_type="min"` 会把矮条**放大**，
720×200 的条会变成 1152×320（比全屏还贵 63%）→ ROI 模式必须改 `"max"`。
