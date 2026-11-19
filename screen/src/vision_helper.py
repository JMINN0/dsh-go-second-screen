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
    return {
        'ok': True, 'mad': round(mad, 4), 'maxCell': round(float(cells.max()), 4),
        'maxCellAt': {'gx': idx % GW, 'gy': idx // GW},
        'changed': bool(mad > 0.5 or cells.max() > 8),
    }


def op_match(req):
    """
    模板匹配。**必须用金字塔**：全分辨率 129ms，1/4 金字塔 + 精修只要 5.7ms。

    返回最佳匹配的 score 和坐标（引擎坐标系，已加回 region 偏移）。
    """
    img = _load(req['image'])
    img, ox, oy = _region(img, req.get('region'))
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

    # ① 1/4 金字塔粗搜
    q = 4
    small = cv2.resize(img, (max(8, W // q), max(8, H // q)), interpolation=cv2.INTER_AREA)
    stpl = cv2.resize(tpl, (max(4, tw // q), max(4, th // q)), interpolation=cv2.INTER_AREA)
    best = (-1.0, 0, 0)
    if stpl.shape[0] <= small.shape[0] and stpl.shape[1] <= small.shape[1]:
        r = cv2.matchTemplate(small, stpl, method)
        sc, loc = scoreOf(r)
        best = (sc, loc[0] * q, loc[1] * q)
    else:
        # 模板太小，直接全分辨率
        r = cv2.matchTemplate(img, tpl, method)
        sc, loc = scoreOf(r)
        best = (sc, loc[0], loc[1])

    # ② 在粗位置周围 ±16px 全分辨率精修
    cx, cy = int(best[1]), int(best[2])
    pad = 16
    x0, y0 = max(0, cx - pad), max(0, cy - pad)
    x1, y1 = min(W, cx + tw + pad), min(H, cy + th + pad)
    roi = img[y0:y1, x0:x1]
    if roi.shape[0] >= th and roi.shape[1] >= tw:
        r2 = cv2.matchTemplate(roi, tpl, method)
        sc2, loc2 = scoreOf(r2)
        score, fx, fy = sc2, x0 + loc2[0], y0 + loc2[1]
    else:
        score, fx, fy = best

    found = score >= thr
    return {
        'ok': True, 'found': bool(found), 'score': round(float(score), 4),
        'x': int(fx + ox), 'y': int(fy + oy), 'w': int(tw), 'h': int(th),
        'cx': round((fx + ox + tw / 2.0) / img.shape[1], 4),
        'cy': round((fy + oy + th / 2.0) / img.shape[0], 4),
        'threshold': thr,
        'method': 'SQDIFF' if lowVar else 'CCOEFF',
        'tplStd': round(tplStd, 1),
    }


def op_color(req):
    """
    颜色阈值 + 连通域。
    **必须用 Lab 的 a/b 通道**，不能用绝对 RGB —— HDR/色偏会让 RGB 阈值失效。
    """
    img = _load(req['image'])
    img, ox, oy = _region(img, req.get('region'))
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    tol = int(req.get('tolerance', 20))
    tgt = req.get('target')          # {a: 128, b: 128, l: 128} 或 {r,g,b}
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
            'cx': round((x + ox + w / 2.0) / W, 4), 'cy': round((y + oy + h / 2.0) / H, 4),
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
