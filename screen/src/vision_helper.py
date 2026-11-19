#!/usr/bin/env python3
"""
vision_helper.py —— 常驻的 OpenCV 助手。

## 为什么必须常驻

实测（tests/CV-BENCHMARK-ARM.md）：`import cv2` 冷启 **328ms**。
如果每次工具调用都起新进程，模板匹配从 5.7ms 变成 334ms（慢 58 倍）。

所以复用 ocr.js 已验证的 stdin/stdout JSON 行协议：
  请求：{"id": N, "op": "...", ...}\n
  响应：{"id": N, "ok": true, ...}\n

## 支持的操作

| op | 参数 | 返回 | 实测耗时 |
|---|---|---|---|
| dhash | image | hash(hex 16位) | 7ms |
| diff | image, image2 | mad, maxCell, cells | 2.3ms |
| match | image, template, region?, threshold? | score, x, y, w, h, method | 5.7ms |
| color | image, target(Lab), tolerance, region? | boxes | 6.8ms |
| edges | image, region? | density | 0.7ms |
| probe | image | 运动性/文本密度/颜色可分性 等统计 | ~20ms |

全部基于 **1592×720** 的实测数字。
"""
import sys, json, os, time

try:
    import cv2
    import numpy as np
    READY = True
    ERR = None
except Exception as e:
    READY = False
    ERR = str(e)
    cv2 = None
    np = None


def _load(path):
    img = cv2.imread(path)
    if img is None:
        raise ValueError('读不到图: ' + path)
    if img.ndim == 3 and img.shape[2] == 4:
        img = cv2.cvtColor(img, cv2.COLOR_BGRA2BGR)
    return img


def _region(img, region):
    """region: {x,y,w,h}（可省）。越界自动裁剪。"""
    if not region:
        return img, 0, 0
    h, w = img.shape[:2]
    x = max(0, int(region.get('x', 0)))
    y = max(0, int(region.get('y', 0)))
    rw = min(int(region.get('w', w)), w - x)
    rh = min(int(region.get('h', h)), h - y)
    if rw <= 0 or rh <= 0:
        raise ValueError('region 越界')
    return img[y:y+rh, x:x+rw], x, y


def op_dhash(req):
    """64 位 dHash 指纹（用来判断「是不是同一个界面」）。"""
    img = _load(req['image'])
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(g, (9, 8), interpolation=cv2.INTER_AREA)
    bits = (small[:, 1:] > small[:, :-1]).flatten()
    val = 0
    for b in bits:
        val = (val << 1) | int(b)
    return {'ok': True, 'hash': format(val, '016x'), 'w': img.shape[1], 'h': img.shape[0]}


def op_diff(req):
    """两张图的差异：MAD + 最大格差（maxCell 能抓到 MAD 漏掉的小区域变化）。"""
    a = _load(req['image'])
    b = _load(req['image2'])
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]))
    ga = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY).astype(np.int16)
    gb = cv2.cvtColor(b, cv2.COLOR_BGR2GRAY).astype(np.int16)
    d = np.abs(ga - gb)
    mad = float(d.mean())
    GH, GW = 24, 24
    ch, cw = max(1, d.shape[0] // GH), max(1, d.shape[1] // GW)
    cells = d[:ch*GH, :cw*GW].reshape(GH, ch, GW, cw).mean(axis=(1, 3))
    idx = int(cells.argmax())
    # **归一化到 0-1 再判断。**
    # 原来用 0-255 原始灰度差（mad>0.5、maxCell>8），
    # 而 PERF-AUDIT 标定的是归一化值（mad>0.005、maxCell>0.15）。
    # maxCell>8 等同于归一化 0.031，比标定敏感 5 倍 → 秒数/光标/动画都判「有实质变化」。
    mc = float(cells.max())
    return {
        'ok': True, 'mad': round(mad / 255.0, 5), 'maxCell': round(mc / 255.0, 4),
        'madRaw': round(mad, 3), 'maxCellRaw': round(mc, 2),
        'maxCellAt': {'gx': idx % GW, 'gy': idx // GW},
        'changed': bool((mad / 255.0) > 0.005 or (mc / 255.0) > 0.15),
    }


def op_match(req):
    """
    模板匹配。**必须用金字塔**：全分辨率 129ms，1/4 金字塔 + 精修只要 5.7ms。

    返回最佳匹配的 score 和坐标（引擎坐标系，已加回 region 偏移）。
    """
    img0 = _load(req['image'])
    # **必须先记原始尺寸。**
    # _region 之后 img 已经是被裁剪的块，用它的 shape 当分母算出来的 cx/cy
    # 是「region 内占比」，但调用方当成整屏 nx/ny 用 → 点歪到屏幕中间。
    H0, W0 = img0.shape[:2]
    img, ox, oy = _region(img0, req.get('region'))
    tpl = _load(req['template'])
    H, W = img.shape[:2]
    th, tw = tpl.shape[:2]
    if th > H or tw > W:
        return {'ok': False, 'hint': '模板比搜索区域大'}
    thr = float(req.get('threshold', 0.75))

    # **纯色/低方差模板不能用 TM_CCOEFF_NORMED。**
    # 它内部除以标准差，模板没有内部变化时 std≈0 → 结果恒为 0 或 NaN，
    # 实测：从同一张图裁一块纯红矩形当模板，score=0.0、found=false。
    # 这种模板改用 TM_SQDIFF_NORMED（越小越好），再把分数反转成「越大越好」。
    tplStd = float(cv2.cvtColor(tpl, cv2.COLOR_BGR2GRAY).std())
    # **纯黑模板会永远匹配失败**：SQDIFF_NORMED 的分母趋零，OpenCV 直接置 1，
    # 1-1=0 → score 恒 0。提前拒绝，给可操作的提示。
    if tplStd < 0.5:
        return {'ok': False, 'hint': '模板几乎是单一颜色（含全黑），匹配不可靠。换一块有纹理的模板，或用 vdisplay_find_color'}
    lowVar = tplStd < 6.0
    method = cv2.TM_SQDIFF_NORMED if lowVar else cv2.TM_CCOEFF_NORMED

    def scoreOf(r):
        # **minMaxLoc 返回 (minVal, maxVal, minLoc, maxLoc)** —— 顺序别搞错。
        # 我第一版写成 `_, _, mn, mnloc`，拿到的 mn 是 minLoc（tuple），
        # 于是 1.0 - tuple 抛 TypeError。
        mnv, mxv, mnloc, mxloc = cv2.minMaxLoc(r)
        # SQDIFF 越小越好 → 转成越大越好
        if lowVar:
            return (1.0 - mnv), mnloc
        return mxv, mxloc

    # **多尺度是刚需，不是优化。**
    # 文档教用户「用 vdisplay_shot 截图，裁出目标存成 PNG」，
    # 但 vdisplay_shot 默认 540 宽 JPEG，而 find_image 走 PNG 分支拿原生 720 —
    # 模板是 0.75 倍，尺寸差 33%，单尺度 CCOEFF 直接掉到 0.4-0.6 → 报「没找到」。
    # 这是用户最会踩的坑（对抗审查 S3）。
    scales = req.get('scales') or [1.0]
    best = (-1.0, 0, 0, 1.0)     # (score, x, y, scale)
    q = 4
    small = cv2.resize(img, (max(8, W // q), max(8, H // q)), interpolation=cv2.INTER_AREA)
    for sc_ratio in scales:
        s2 = float(sc_ratio)
        if s2 <= 0:
            continue
        t2 = tpl if abs(s2 - 1.0) < 1e-6 else cv2.resize(
            tpl, (max(4, int(round(tw * s2))), max(4, int(round(th * s2)))),
            interpolation=cv2.INTER_AREA)
        t2h, t2w = t2.shape[:2]
        if t2h > H or t2w > W:
            continue
        st2 = cv2.resize(t2, (max(4, t2w // q), max(4, t2h // q)), interpolation=cv2.INTER_AREA)
        if st2.shape[0] <= small.shape[0] and st2.shape[1] <= small.shape[1]:
            r = cv2.matchTemplate(small, st2, method)
            sc, loc = scoreOf(r)
            cand = (sc, loc[0] * q, loc[1] * q, s2)
        else:
            r = cv2.matchTemplate(img, t2, method)
            sc, loc = scoreOf(r)
            cand = (sc, loc[0], loc[1], s2)
        if cand[0] > best[0]:
            best = cand

    # ② 在粗位置周围 ±16px 全分辨率精修（用最佳尺度对应的模板）
    bestScale = best[3]
    tpl = tpl if abs(bestScale - 1.0) < 1e-6 else cv2.resize(
        tpl, (max(4, int(round(tw * bestScale))), max(4, int(round(th * bestScale)))),
        interpolation=cv2.INTER_AREA)
    th2, tw2 = tpl.shape[:2]
    cx, cy = int(best[1]), int(best[2])
    pad = 16
    x0, y0 = max(0, cx - pad), max(0, cy - pad)
    x1, y1 = min(W, cx + tw2 + pad), min(H, cy + th2 + pad)
    roi = img[y0:y1, x0:x1]
    if roi.shape[0] >= th2 and roi.shape[1] >= tw2:
        r2 = cv2.matchTemplate(roi, tpl, method)
        sc2, loc2 = scoreOf(r2)
        score, fx, fy = sc2, x0 + loc2[0], y0 + loc2[1]
    else:
        score, fx, fy = best[0], best[1], best[2]

    found = score >= thr
    return {
        'ok': True, 'found': bool(found), 'score': round(float(score), 4),
        'x': int(fx + ox), 'y': int(fy + oy), 'w': int(tw2), 'h': int(th2),
        'cx': round((fx + ox + tw2 / 2.0) / W0, 4),
        'cy': round((fy + oy + th2 / 2.0) / H0, 4),
        'scale': round(float(bestScale), 3),
        'threshold': thr,
        'method': 'SQDIFF' if lowVar else 'CCOEFF',
        'tplStd': round(tplStd, 1),
    }


def op_color(req):
    """
    颜色阈值 + 连通域。
    **必须用 Lab 的 a/b 通道**，不能用绝对 RGB —— HDR/色偏会让 RGB 阈值失效。
    """
    img0 = _load(req['image'])
    H0, W0 = img0.shape[:2]        # 同上：归一化必须用原始尺寸
    img, ox, oy = _region(img0, req.get('region'))
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    tol = int(req.get('tolerance', 20))
    tgt = req.get('target')          # {a: 128, b: 128, l: 128} 或 {r,g,b}
    # **兼容 b2**：旧 schema 里 Lab 的 b 被写成 b2（怕和 RGB 的 b 撞名），
    # 但实现读的是 'b' → KeyError。这里两个都认。
    if tgt and 'b2' in tgt and 'b' not in tgt:
        tgt = dict(tgt); tgt['b'] = tgt['b2']
    if tgt and 'a' in tgt:
        a, b, l = int(tgt['a']), int(tgt['b']), int(tgt.get('l', 128))
        lo = np.array([max(0, l - tol), max(0, a - tol), max(0, b - tol)])
        hi = np.array([min(255, l + tol), min(255, a + tol), min(255, b + tol)])
    elif tgt and 'r' in tgt:
        bgr = np.uint8([[[tgt['b'], tgt['g'], tgt['r']]]])
        l, a, b = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)[0][0]
        lo = np.array([max(0, int(l) - tol), max(0, int(a) - tol), max(0, int(b) - tol)])
        hi = np.array([min(255, int(l) + tol), min(255, int(a) + tol), min(255, int(b) + tol)])
    else:
        return {'ok': False, 'hint': 'target 要给 {l,a,b} 或 {r,g,b}'}

    mask = cv2.inRange(lab, lo, hi)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, _, stats, cents = cv2.connectedComponentsWithStats(mask, 8)
    minArea = int(req.get('minArea', 200))
    boxes = []
    H, W = mask.shape[:2]
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if area < minArea:
            continue
        boxes.append({
            'x': int(x + ox), 'y': int(y + oy), 'w': int(w), 'h': int(h), 'area': int(area),
            'cx': round((x + ox + w / 2.0) / W0, 4), 'cy': round((y + oy + h / 2.0) / H0, 4),
        })
    boxes.sort(key=lambda b: -b['area'])
    return {'ok': True, 'count': len(boxes), 'boxes': boxes[:int(req.get('max', 20))]}


def op_edges(req):
    """边缘密度 —— 判断「这个界面适不适合用形状检测」。"""
    img = _load(req['image'])
    img, _, _ = _region(img, req.get('region'))
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    e = cv2.Canny(g, 50, 150)
    return {'ok': True, 'density': round(float((e > 0).mean()), 4)}


def op_probe(req):
    """一次采集多个统计量，供「选哪个识别方法」打分用。"""
    img = _load(req['image'])
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    H, W = g.shape[:2]
    # ① 边缘密度
    e = cv2.Canny(g, 50, 150)
    ed = float((e > 0).mean())
    # ② 颜色可分性：8³ 量化直方图，top5 占比 + 色数
    q = (img // 32).astype(np.int16)
    codes = q[:, :, 0] * 64 + q[:, :, 1] * 8 + q[:, :, 2]
    hist = np.bincount(codes.flatten(), minlength=512).astype(np.float32)
    hist /= max(1.0, hist.sum())
    top5 = float(np.sort(hist)[-5:].sum())
    ncolors = int((hist > 0.0005).sum())
    # ③ 亮度/对比
    mean = float(g.mean())
    std = float(g.std())
    return {
        'ok': True, 'w': W, 'h': H,
        'edgeDensity': round(ed, 4),
        'colorTop5': round(top5, 4),
        'colorCount': ncolors,
        'brightness': round(mean, 1),
        'contrast': round(std, 1),
        'canTemplate': bool(ed < 0.30 and std > 8),
        'canColor': bool(top5 > 0.35 and ncolors < 260),
        'looksBlank': bool(std < 3),
    }


OPS = {
    'dhash': op_dhash, 'diff': op_diff, 'match': op_match,
    'color': op_color, 'edges': op_edges, 'probe': op_probe,
}


def main():
    out = sys.stdout
    if not READY:
        out.write(json.dumps({'ready': False, 'error': ERR}) + '\n')
        out.flush()
        return
    out.write(json.dumps({'ready': True, 'cv2': cv2.__version__}) + '\n')
    out.flush()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = None
        try:
            req = json.loads(line)
            op = req.get('op')
            fn = OPS.get(op)
            if not fn:
                resp = {'ok': False, 'hint': '不认识的 op: ' + str(op)}
            else:
                t0 = time.time()
                resp = fn(req)
                resp['elapsedMs'] = round((time.time() - t0) * 1000, 2)
        except Exception as e:
            resp = {'ok': False, 'hint': '%s: %s' % (type(e).__name__, e)}
        resp['id'] = req.get('id') if isinstance(req, dict) else None
        out.write(json.dumps(resp) + '\n')
        out.flush()


if __name__ == '__main__':
    main()
