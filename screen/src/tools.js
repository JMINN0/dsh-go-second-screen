/** 工具的执行体。全部返回 { text }，失败给原因和下一步，不抛异常。 */
import * as vd from './vd.js';
import * as stream from './stream.js';
import * as timeline from './timeline.js';
import { adbTarget } from './target.js';

export async function modes() {
  return {
    text: [
      '可用操作方式（都保证不动主屏）：',
      '',
      '| 方式 | 用什么 | 适用 | 代价 |',
      '| shell | adb_shell 那套 | 装包、看日志、查状态、改设置 | 零打扰，最快 |',
      '| browser | web_* 那套（CDP） | 网页交互、填表、读页面 | 需要浏览器在跑 |',
      '| vdisplay | vdisplay_* | 需要"看界面再点"的 App | 多占约 0.28 核 |',
      '| watch | vdisplay_shot | 用户想看你操作时的证据 | 一次截图 |',
      '',
      '选择顺序：能用 shell 就别开屏；能读文本就别截图；必须操作 App 界面时才用 vdisplay。',
    ].join('\n'),
  };
}

export async function start(args) {
  const r = await vd.start({
    width: Number(args?.width) || 0,       // 0 = 自动按物理屏比例
    height: Number(args?.height) || 0,
    dpi: Number(args?.dpi) || 320,
    systemDecorations: args?.systemDecorations === true,   // 默认 false：屏上不带二级桌面/导航栏
    orientation: args?.orientation,                        // portrait / landscape
    hwc: args?.hwc || 'auto',                              // 3D 游戏需要 HWC 参与合成
    // 帧率上限。以前没传过 = 无限，实测 MC 跑起来 145fps 白烧 CPU/带宽。
    // 默认 60；传 0 表示不限。
    maxFps: args?.maxFps === 0 ? 0 : (Number(args?.maxFps) || 60),
  });
  if (!r.ok) return { text: `建屏失败：${r.hint}` };
  // HWC 状态以真实属性为准（复用分支以前不返回 hwc，开着 HWC 的屏会被报成「会黑屏」）。
  // 配置和请求不一致必须说出来：复用一块活着的屏时不会按新配置重建，
  // 以前悄悄返回「已就绪」，调用方以为拿到了横屏/带装饰的屏，实际还是旧的。
  const parts = [
    `虚拟屏已就绪：displayId=${r.displayId}，SurfaceFlinger id=${r.sfId || '(未取到)'}`,
    `能托管 App：${r.canHost ? '是 ✅' : '否（缺 OWN_CONTENT_ONLY 或 OWN_FOCUS）'}`,
    `硬件合成（HWC）：${r.hwc ? '已开启 ✅ 3D 游戏可正常渲染' : '未开启（3D 游戏会黑屏，轻量 App 正常）'}`,
    `标志位：${r.flags || '(无)'}`,
  ];
  if (r.configMismatch) {
    parts.push(`⚠️ 复用了已有的屏，配置和这次请求不一致：${r.configMismatch}。`
      + '要按新配置建屏，请先 vdisplay_stop 再 vdisplay_start。');
  }
  parts.push('这块屏用户看不见，不占主屏焦点。');
  return { text: parts.join('\n') };
}

export async function launch(args) {
  try { stream.setState('acting'); } catch { /* ignore */ }
  const pkg = String(args?.pkg || '').trim();
  if (!/^[a-z][\w.]*$/i.test(pkg)) return { text: 'pkg 看起来不是合法包名。' };
  const act = args?.activity ? String(args.activity).trim() : '';
  const r = await vd.launch(pkg, act);
  if (!r.displayId) return { text: `投屏失败：${r.hint}` };
  const lines = [
    `投到虚拟屏 display=${r.displayId}`,
    `落在虚拟屏上：${r.landedOnVd ? '是 ✅' : '否 ❌'}`,
    `主屏前后：${r.mainFocusBefore || '(未测到)'} → ${r.mainFocusAfter || '(未测到)'}`,
  ];
  // 不再自动还原（见 vd.js 里的说明），所以这里**必须明确告诉调用方**：
  // 主屏被抢了，而且我们没管。以前这行只在 restoredMain 为真时打，而它永远是 false。
  if (r.mainChanged) {
    lines.push('⚠️ 主屏前台变了（这是投屏造成的）。**本插件不会自动还原主屏**，'
      + '要还原请自己 am start 原来那个。');
  }
  if (!r.ok) lines.push(`原始输出：${r.out}`);
  return { text: lines.join('\n') };
}

export async function input(args) {
  // **告诉推流「在操作」**：胶囊显示「AI 点按」，用户才知道 AI 在干活
  try { stream.setState('acting'); stream.touch(); } catch { /* 推流没开就算了 */ }
  // **记下坐标**：推流帧上会画出十字，用户能直接看到 AI 点在哪
  try {
    const a0 = args || {};
    const mx = Number.isFinite(Number(a0.nx)) ? Number(a0.nx) : (Number.isFinite(Number(a0.x)) ? Number(a0.x) / 100000 : NaN);
    const my = Number.isFinite(Number(a0.ny)) ? Number(a0.ny) : (Number.isFinite(Number(a0.y)) ? Number(a0.y) / 100000 : NaN);
    if (Number.isFinite(mx) && Number.isFinite(my)) stream.markTap(mx, my, String(a0.kind || 'tap'));
  } catch { /* 没坐标就算了（滑动这类） */ }
  const kind = String(args?.kind || '').trim();
  if (!['tap', 'swipe', 'text', 'key', 'paste'].includes(kind)) return { text: 'kind 只能是 tap / swipe / text / key / paste。' };
  const r = await vd.input(kind, args || {});

  // shotAfter：动作后顺手截一张，省掉「再调一次 vdisplay_shot」的整轮模型往返。
  // 实测一轮往返 6–9 秒，占"点一下看结果"总耗时的绝大部分。
  let shotInfo = '';
  if (r.ok !== false && args?.shotAfter === true) {
    const shot = await vd.shot('/tmp', { width: Number(args?.width) || 540 });
    if (shot.ok) {
      shotInfo = shot.unchanged
        ? `\n画面和上次完全一样（${shot.path}），可以直接复用那张图。`
        : `\n动作后的画面：${shot.path}（${shot.width}x${shot.height}）——用 read_image 打开它。`;
    }
  }

  // changed 必须透传：false 表示"动作发出去了但画面没变"，这是有效信息，
  // 不是"注入失败"。早期把它包成"注入失败"会让调用方以为工具坏了。
  if (r.changed === false && r.hint) return { text: `${r.hint}\n（display=${r.displayId}，${kind} 已发出）${shotInfo}` };
  if (!r.ok && r.hint) return { text: `注入失败：${r.hint}` };
  const tail = r.out ? `（${r.out}）` : '';
  return { text: `已在 display=${r.displayId} 注入 ${kind}${tail}${shotInfo}` };
}

export async function shot(args) {
  try { stream.setState('looking'); } catch { /* ignore */ }
  const frames = Number(args?.frames) || 1;

  // frames=1 → 单张截图（读字用）
  if (frames <= 1) {
    const region = (args?.region && typeof args.region === 'object') ? args.region : null;
    // **不做自动裁剪浏览器壳了**（原来的 crop:'content' 已移除）。
    //
    // 原因是经过对抗审查和实测，这个功能有三个拿不到的假设：
    //   ① 壳在底部 —— 实测这台 Edge 顶部还会有翻译条，clientHeight 从 1372 变 1276，
    //      只从底部切会把顶部壳留下、同时切掉 96px 真实内容；
    //   ② 单位不变 —— layoutViewport 是 deprecated 字段（可能是 DP 也可能是 CSS px），
    //      那个 flag 一翻，裁剪量从 220 变 906，直接切掉一半画面；
    //   ③ 前台真是浏览器 —— 不校验时虚拟屏上开着设置页也会被切掉底部。
    // 而它只省 13%，region 已经能更好地解决"想看清"这个需求（2 倍细节、更便宜、不用猜）。
    // 所以宁可多花 13% 的 token，也不留三个静默出错的口子。
    //
    // 需要跳过浏览器壳时，用 region 显式选内容区，坐标自己给 —— 明确比自动猜可靠。
    const cropPx = 0;
    let cropNote = args?.crop === 'content'
      ? '\nℹ️ crop 已废弃：浏览器壳的上下分布拿不到可靠信号，自动裁会切错内容。想看细节请用 region。'
      : '';

    // region 时默认宽度不能超过 region 本身，否则是上采样（信息不增加，只花 token）。
    // 比如 region 只有 200 宽却交付到 540，放大 2.7 倍，图更贵但更清楚不了一分。
    const reqW = Number(args?.width) || 0;
    const defaultW = region ? Math.min(540, Math.max(240, Math.round(Number(region.w) || 540))) : 540;
    const outW = reqW || defaultW;
    const r = await vd.shot(String(args?.dir || '/tmp'), {
      width: outW,
      format: args?.format === 'png' ? 'png' : 'jpeg',
      cropPx,
      region,
    });
    if (!r.ok) return { text: `截图失败：${r.hint}` };
    const lines = [`虚拟屏截图：${r.path}（displayId=${r.displayId}，屏 ${r.width}x${r.height}）`];
    if (r.unchanged) lines.push('画面和上次完全一样，可以直接复用这张，不用再看一次。');
    else lines.push('用 read_image 打开它就能看到界面。');
    lines.push('点坐标时可以用 nx/ny（0..1 归一化）代替 x/y，不用自己算像素。');
    // **裁剪后 nx/ny 的基准变了**：ny 按整屏算会落到壳里，偏一个裁剪量。
    // 对抗审查指出的第 4 条 —— 这里必须说清楚，否则模型照着推荐用 nx/ny 就会点歪。
    if (cropPx > 0) {
      lines.push(`⚠️ 已裁掉底部 ${cropPx}px 浏览器壳。这张图的 ny=0..1 对应的是「内容区」，不是整屏；`
        + `若要用整屏归一化坐标，请改用 x/y（按图片像素给）。`);
    }
    if (region) lines.push('这是一张局部放大图，坐标请按这张图自己的像素给 x/y。');
    if (cropNote) lines.push(cropNote);
    lines.push('');
    lines.push('想看"在动吗、往哪动"就传 frames=9 再调一次。');
    return { text: lines.join('\n') };
  }

  // frames>1 → 连拍拼网格（看运动用）
  const st = await vd.status();
  if (!st.running) return { text: '虚拟屏没在运行。先 vdisplay_start 建屏、vdisplay_launch 投 App。' };
  if (!st.sfId) return { text: '没拿到 SurfaceFlinger id，先 vdisplay_status 确认屏状态。' };

  const r = await timeline.capture({
    sfId: st.sfId,
    frames,
    intervalMs: args?.intervalMs === undefined ? 300 : Math.max(0, Number(args.intervalMs) || 0),
    cellWidth: Number(args?.width) || 262,
    dir: String(args?.dir || '/tmp'),
    // 网格也不自动裁壳了，理由同上（壳的上下分布不可靠）。
    crop: 'none',
  });
  if (!r.ok) return { text: `抓时间线失败：${r.hint}` };

  // **报真实采样情况，不要拿公式糊弄。**
  // 上一版写 `(cells-1)*intervalMs`，固定说"2.4 秒、间隔 300ms"——
  // 但采样已经改成自适应了，静止画面实际只采了 1.2 秒、只拿到 1 个不同帧，
  // 模型看到 9 个一样的格子 + "2.4 秒"会以为这段时间画面一直在变。
  const shape = r.canvasW > r.canvasH ? '横屏' : '竖屏';
  const distinct = r.distinct ?? r.captured;
  const sampled = (r.sampledElapsedMs || 0) / 1000;
  const lines = [
    `时间线拼图：${r.path}`,
    `${r.cols}×${r.rows} = ${r.cells} 格，每格 ${r.cellW}×${r.cellH}，画布 ${r.canvasW}×${r.canvasH}（${shape}）`,
  ];
  if (distinct <= 1) {
    lines.push('**画面基本没动**：只采到 1 个不同帧，其余是重复帧填满网格。'
      + `实际采样约 ${sampled.toFixed(1)} 秒 —— 不代表这段时间有变化。`);
  } else if (distinct < r.cells) {
    lines.push(`**采到 ${distinct} 个不同帧**（其余 ${r.cells - distinct} 格是重复填充），`
      + `实际采样约 ${sampled.toFixed(1)} 秒。画面变化不多。`);
  } else {
    lines.push(`**${distinct} 个帧各不相同**，按画面变化自适应采样，实际采样约 ${sampled.toFixed(1)} 秒。`);
  }
  lines.push(
    '用 read_image 打开它，从左到右、从上到下就是时间顺序。',
    '',
    '这个尺寸只能看「结构、位置、有没有动」，读不出屏幕上的小字和数字。要读数字请用 frames=1 单帧，或用 vdisplay_text。',
  );
  return { text: lines.join('\n') };
}

export async function mainShot(args) {
  const focus = await vd.mainFocus();
  const r = await vd.mainShot(String(args?.dir || '/tmp'), {
    width: Number(args?.width) || 540,
    format: args?.format === 'png' ? 'png' : 'jpeg',
  });
  if (!r.ok) return { text: `主屏截图失败：${r.hint}` };
  return { text: `主屏截图：${r.path}\n主屏当前焦点：${focus || '(未测到)'}` };
}

export async function status() {
  const st = await vd.status();
  const focus = await vd.mainFocus();
  return {
    text: st.running
      ? `虚拟屏运行中：displayId=${st.displayId}，SF id=${st.sfId}，已运行 ${st.uptimeSec} 秒\n上面的 App：${st.focusedApp || '(未知)'}\n主屏焦点：${focus || '(未测到)'}\n所有屏：${Array.isArray(st.allDisplays) && st.allDisplays.length ? st.allDisplays.join(', ') : '(查询失败)'}`
      : `虚拟屏没有在运行。\n主屏焦点：${focus || '(未测到)'}\n所有屏：${Array.isArray(st.allDisplays) && st.allDisplays.length ? st.allDisplays.join(', ') : '(查询失败)'}`,
  };
}

export async function stop(args) {
  // 先停推流和悬浮窗：否则胶囊会永远显示"AI 正在操作"+ 冻在最后一帧（复核实测）。
  await overlayStop().catch(() => {});
  await stream.stop().catch(() => {});
  const r = await vd.stop({ forceStopApps: args?.forceStopApps === true });
  const lines = ['虚拟屏已销毁。'];
  if (r.killed?.length) lines.push(`已清理后台 App：${r.killed.join('、')}`);
  if (r.hint) lines.push(r.hint);
  return { text: lines.join('\n') };
}

/** 悬浮窗 APK 的包名。装了就能把画面浮在任何 App 上。 */
const OVERLAY_PKG = 'com.dsh.overlay';

/**
 * 拉起 / 关掉悬浮窗 APK。
 *
 * **为什么要自动做**：手动敲三条 adb 命令太麻烦，而且容易忘。
 * 起推流时自动把端口传给它，停推流时自动关掉 —— 用户只要调 vdisplay_stream 就够。
 *
 * APK 不在就静默跳过：胶囊仍然能用，只是没有跨 App 的悬浮窗。
 */
async function overlayStart(port) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const target = await adbTarget();
    // 先看装没装
    const { stdout } = await run('adb', ['-s', target, 'shell',
      `pm list packages ${OVERLAY_PKG}`], { timeout: 8000 });
    if (!String(stdout || '').includes(OVERLAY_PKG)) return { ok: false, why: '没装' };
    // 给权限（幂等，已给过也不报错）
    await run('adb', ['-s', target, 'shell',
      `appops set ${OVERLAY_PKG} SYSTEM_ALERT_WINDOW allow`], { timeout: 8000 }).catch(() => {});
    // 拉起并把端口传进去
    await run('adb', ['-s', target, 'shell',
      `am start -n ${OVERLAY_PKG}/.MainActivity --ei port ${port}`], { timeout: 8000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, why: String(e?.message || e).slice(0, 60) };
  }
}

async function overlayStop() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const target = await adbTarget();
    await run('adb', ['-s', target, 'shell',
      `am start -n ${OVERLAY_PKG}/.MainActivity --ez stop true`], { timeout: 8000 });
    return { ok: true };
  } catch { return { ok: false }; }
}

/** 开始把虚拟屏画面推给原生胶囊插件（装了悬浮窗 APK 的话一起拉起来）。 */
export async function streamStart(args) {
  const s = await vd.start();
  if (!s.ok) return { text: `建屏失败：${s.hint}` };
  const fps = Math.min(Math.max(Number(args?.fps) || 2, 1), 15);   // 上限 15（原来 4 是桥接遗留）
  const width = Math.min(Math.max(Number(args?.width) || 360, 240), 720);
  // 传真实的 focusedApp：以前这里写死空串，导致胶囊永远只显示"操作中 12s"。
  const focus = await vd.focusedApp();
  const r = await stream.start({ sfId: s.sfId, displayId: s.displayId, fps, width, focusedApp: focus });
  try { stream.setState('looking'); } catch { /* ignore */ }
  if (!r.ok) return { text: `推流启动失败：${r.hint}` };
  // **自动拉起悬浮窗**：装了就能浮在任何 App 上，没装就只用胶囊
  const ov = await overlayStart(r.port);
  return {
    text: `推流已开启：127.0.0.1:${r.port}，${fps} fps，宽度 ${width}\n`
      + (ov.ok
        ? '悬浮窗已浮起（可拖动，单击收起，浮在任何 App 上）\n'
        : `胶囊可用；悬浮窗没起来（${ov.why}）\n`)
      + '打开 DSH Go 输入框上方的「AI 画面」胶囊，点它也能看。\n'
      + '实测这个档位约 0.30 核、29 KB/s，不写任何文件。',
  };
}

export async function streamStop() {
  await overlayStop();       // 先关悬浮窗，否则它会自己发现推流没了才关（多留一会儿）
  await stream.stop();
  return { text: '推流已停止（胶囊和悬浮窗都不再显示画面）。' };
}

export async function closeAll() {
  await stream.shutdown();
  // **OCR 的 Python 常驻进程必须在这里关掉。**
  // 不关的话：用过一次 vdisplay_text 之后，插件卸载/引擎重启/daemon 闲置自杀
  // 都会留下一个带着 15MB 模型的 python3 孤儿进程，重载一次多一个。
  try { const ocr = await import('./ocr.js'); ocr.shutdown(); } catch { /* 没装 OCR 就算了 */ }
  await vd.stop();
  return { text: '虚拟屏与推流都已关闭。' };
}

export async function text(args) {
  try { stream.setState('looking'); } catch { /* ignore */ }
  const st = await vd.status();
  if (!st.running) return { text: '虚拟屏没在运行。先 vdisplay_start 建屏、vdisplay_launch 投 App。' };

  const ocr = await import('./ocr.js');
  const fresh = args?.fresh === true;

  // 拿一张原生分辨率的截图（OCR 要在原生尺度上跑，缩小会丢小字）
  const shot = await vd.shot(String(args?.dir || '/tmp'), {
    width: Math.min(1080, Math.max(360, st.width || 720)),
    format: 'png',
  });
  if (!shot.ok) return { text: `截图失败：${shot.hint}` };

  const r = await ocr.recognize(shot.path, {
    minConf: args?.minConf === undefined ? 0.45 : Number(args.minConf),
    maxLines: Number(args?.maxLines) || 80,
    hash: fresh ? null : shot.hash,
  });

  if (!r.ok) return { text: r.hint };

  const W = shot.width || 720;
  const H = shot.height || 1280;
  const lines = [
    `识别到 ${r.count} 行文字${r.total > r.count ? `（共 ${r.total}，已截断）` : ''}`
      + `，耗时 ${r.cached ? '0（画面没变，复用上次）' : `${(r.elapsedMs / 1000).toFixed(1)} 秒`}`,
    `屏 ${W}x${H}，下面每行的 nx/ny 是归一化坐标，可直接传给 vdisplay_input。`,
    '',
  ];
  for (const l of r.lines) {
    const nx = ((l.x + l.w / 2) / W).toFixed(3);
    const ny = ((l.y + l.h / 2) / H).toFixed(3);
    lines.push(`  [${l.conf.toFixed(2)}] (${String(l.x).padStart(4)},${String(l.y).padStart(4)}) ${l.w}x${l.h}  nx=${nx} ny=${ny}  ${l.text}`);
  }
  lines.push('');
  lines.push('要读的位置画面对不上？用 vdisplay_shot(frames=1) 看实际画面。');
  lines.push('要看清某个按钮长什么样？用 vdisplay_shot 配合坐标自己判断。');
  return { text: lines.join('\n') };
}

export async function apps() {
  const r = await vd.adb(['shell', 'pm list packages -3 2>/dev/null']);
  if (!r.ok) return { text: `列应用失败：${r.err || 'adb 不可用'}` };
  const pkgs = String(r.out || '')
    .split('\n')
    .map((l) => l.trim().replace(/^package:/, ''))
    .filter(Boolean)
    .sort();
  if (!pkgs.length) return { text: '没读到第三方 App。确认 adb 连着、且设备不是空的。' };
  return {
    text: `第三方 App 共 ${pkgs.length} 个（用包名调 vdisplay_launch）：\n`
      + pkgs.map((p) => `  ${p}`).join('\n'),
  };
}

/* ===== 多屏池 ===== */

export async function poolInfo() {
  const pool = await import('./pool.js');
  const info = pool.info();
  if (!info.count) {
    return { text: '池里还没有屏。用 screen_new 建一块。' };
  }
  const lines = [`共 ${info.count} 块屏，活动屏：${info.active || '(无)'}`, ''];
  for (const s of info.screens) {
    const mark = s.screenId === info.active ? ' ← 活动' : '';
    lines.push(`  ${s.screenId}  displayId=${s.displayId}  dpi=${s.dpi}${mark}`);
  }
  lines.push('');
  lines.push('所有 vdisplay_* 操作都作用在活动屏上。切换用 screen_use。');
  return { text: lines.join('\n') };
}

export async function newScreen(args) {
  const pool = await import('./pool.js');
  const r = await pool.create({
    orientation: args?.orientation,
    hwc: args?.hwc,
  });
  if (!r.ok) return { text: `建屏失败：${r.hint}` };
  return {
    text: `新屏已建好：${r.screenId}（displayId=${r.displayId}，dpi=${r.dpi}）\n`
      + `它现在是活动屏，接下来 vdisplay_launch 会投到它上面。\n`
      + `想切回别的屏用 screen_use。`,
  };
}

export async function useScreen(args) {
  const pool = await import('./pool.js');
  const r = pool.use(String(args?.screenId || ''));
  if (!r.ok) return { text: r.hint };
  return { text: `已切到 ${args.screenId}（displayId=${r.displayId}）。之后的操作都作用在这块屏上。` };
}

export async function closeScreen(args) {
  const pool = await import('./pool.js');
  const id = String(args?.screenId || '');
  const r = await pool.destroy(id, { forceStopApps: args?.forceStopApps === true });
  if (!r.ok) return { text: r.hint };
  return { text: `已销毁 ${id}。池里还剩 ${r.remaining} 块。` };
}

export async function checkApp(args) {
  const pkg = String(args?.pkg || '').trim();
  if (!/^[a-z][\w.]*$/i.test(pkg)) return { text: 'pkg 看起来不是合法包名。用 vdisplay_apps 查。' };
  const occ = await import('./occupancy.js');
  const pool = await import('./pool.js');
  // 把池里的屏 id 传给检测器，它才能区分「我们的屏」和「外来屏」
  const info = pool.info();
  const ourScreens = new Map(info.screens.map((s) => [Number(s.displayId), s.screenId]));
  const r = await occ.checkApp(pkg, { ourScreens });
  return { text: occ.describe(r) };
}

/* ===== 租约 ===== */

export async function claimApp(args) {
  const lease = await import('./lease.js');
  const pkg = String(args?.pkg || '').trim();
  if (!/^[a-z][\w.]*$/i.test(pkg)) return { text: 'pkg 看起来不是合法包名。用 vdisplay_apps 查。' };
  const pool = await import('./pool.js');
  const info = pool.info();
  if (!info.active) return { text: '还没有活动屏。先 screen_new 建一块。' };

  const r = await lease.claim({
    pkg,
    screenId: info.active,
    owner: String(args?.owner || 'this-session'),
    mode: args?.mode,
    priority: args?.priority,
    preemptible: args?.preemptible,
    nonPreemptibleReason: args?.nonPreemptibleReason,
    onConflict: args?.onConflict || 'fail',
    ttlMs: args?.ttlSec ? Number(args.ttlSec) * 1000 : undefined,
  });

  if (r.ok) {
    const l = r.lease;
    const lines = [`已占用「${l.pkg}」→ ${l.screenId}（${l.leaseId}，还剩 ${l.remainingSec} 秒）`];
    if (!l.preemptible) lines.push(`  标记为不可抢${l.nonPreemptibleReason ? `：${l.nonPreemptibleReason}` : ''}`);
    if (r.preempted) lines.push(`  接管自 ${r.preempted.owner}`);
    if (r.note) lines.push(`  ${r.note}`);
    return { text: lines.join('\n') };
  }
  return {
    text: `${r.hint}\n${r.holder ? `原持有者：${r.holder.owner}（${r.holder.screenId}，还剩 ${r.holder.remainingSec} 秒）` : ''}`
      + (r.next?.action ? `\n建议：${r.next.action}` : ''),
  };
}

export async function releaseApp(args) {
  const lease = await import('./lease.js');
  const id = args?.leaseId ? String(args.leaseId) : '';
  if (id) {
    const r = lease.release(id);
    return { text: r.ok ? `已释放 ${id}` : (r.hint || '释放失败') };
  }
  const r = lease.releaseAll(String(args?.owner || 'this-session'));
  return { text: r.released.length ? `已释放 ${r.released.length} 个租约：${r.released.join(', ')}` : '当前会话没有持有租约。' };
}

export async function leases() {
  const lease = await import('./lease.js');
  return { text: lease.describeList() };
}

/* ============================================================
 * 感知层工具（2026-11-16 新增）
 *
 * 这些能力在 vd.js / video.js 里已经做好并真机验证过，但一直只是模块导出，
 * 工具层没暴露 —— 等于 AI 用不到。这里补齐。
 * ============================================================ */

/**
 * 起/停视频流的常驻解码器，或只看状态。
 *
 * 为什么要单独一个工具：常驻解码器不启动的话，`vdisplay_live_shot` 只能走
 * 按需解码（244ms）；启动之后读帧是内存拷贝（<1ms）。
 */
export async function live(args) {
  const action = String(args?.action || 'status');
  if (action === 'start') {
    const r = await vd.startLive({ quality: Number(args?.quality) || 5 });
    const s = await vd.videoStats();
    return {
      ok: Boolean(r.ok),
      hint: r.hint,
      decoder: s.decoder,
      stream: { width: s.width, height: s.height, frames: s.frames, fps: s.fps },
      note: r.ok
        ? '常驻解码器已启动。画面静止时 scrcpy 不发帧，读不到画面是正常的。'
        : undefined,
    };
  }
  if (action === 'stop') {
    const r = await vd.stopLive();
    return { ok: true, ...r };
  }
  const s = await vd.videoStats();
  return {
    ok: Boolean(s.headerDone && !s.headerError),
    width: s.width,
    height: s.height,
    frames: s.frames,
    fps: s.fps,
    hasKeyframe: s.hasKeyframe,
    badSizes: s.badSizes,
    decoder: s.decoder,
    hint: s.headerDone ? undefined : '视频流还没接上（先 vdisplay_start 建屏）',
  };
}

/**
 * 从视频流里取一张**最新帧**（比 vdisplay_shot 快得多）。
 *
 * 前提：必须先 `vdisplay_live action=start`，而且**画面要动** ——
 * scrcpy 只在内容变化时发帧，静止的屏一个包都不发。
 */
export async function liveShot(args) {
  const r = await vd.liveShot({
    dir: String(args?.dir || '/tmp'),
    width: Number(args?.width) || 0,
  });
  if (!r.ok) {
    return {
      ok: false,
      hint: r.hint,
      fallback: '用 vdisplay_shot（走 screencap，静止屏也能截）',
    };
  }
  return {
    ok: true,
    path: r.path,
    width: r.width,
    height: r.height,
    source: r.source,
    frameAgeMs: r.frameAgeMs,
    fps: r.fps,
    displayId: r.displayId,
  };
}

/**
 * 等画面稳定下来再返回（替代固定 sleep）。
 *
 * 实测：滑动后 121-182ms 就稳了，比固定 `sleep(500)` 快 300ms 左右，
 * 而且截图不会撞上转场中间态。
 */
export async function waitStable(args) {
  const r = await vd.waitStable({
    stableMs: Number(args?.stableMs) || 120,
    maxWaitMs: Number(args?.maxWaitMs) || 2500,
    threshold: Number(args?.threshold) || 0.5,
  });
  return {
    ok: r.stable !== false,
    waitedMs: r.waitedMs,
    stable: r.stable,
    tailMad: r.tailMad,
    hint: r.hint,
  };
}

/**
 * 自动挑一块值得看的区域（局部放大）。
 *
 * 同样的 token 预算下，裁剪 1:1 比全屏缩放清晰 2 倍左右。
 * 返回的 `region` 可以直接传给 `vdisplay_shot`。
 */
export async function roi(args) {
  const r = await vd.pickRoi({
    // 544 而不是 420：地板价 169 覆盖到 544²，同价多 68% 面积
    outputWidth: Number(args?.outputWidth) || 544,
    minArea: Number(args?.minArea) || 0.04,
  });
  if (!r) {
    return {
      ok: false,
      hint: '挑不出合适的区域（画面可能完全没有变化，也没有最近的点击位置）。直接 vdisplay_shot 全屏。',
    };
  }
  return {
    ok: true,
    region: { x: r.x, y: r.y, w: r.w, h: r.h },
    src: r.src,
    area: r.area,
    hint: `把 region 传给 vdisplay_shot，同 token 下清晰约 2 倍`,
  };
}

/**
 * 黑屏探针：判断这块屏上的内容是不是抓不到（FLAG_SECURE）。
 *
 * A 正常 / B? 疑似受保护 / C 整屏黑 / A? 误报纠正
 */
export async function probeSecure(args) {
  const r = await vd.probeSecure({ dir: String(args?.dir || '/tmp') });
  if (!r.ok) return { ok: false, hint: r.hint };
  return {
    ok: true,
    verdict: r.verdict,
    confidence: r.confidence,
    why: r.why,
    upperMax: r.upMax,
    lowerMax: r.downMax,
    secureWindows: r.secureWins,
    path: r.path,
    hint: r.hint,
  };
}
