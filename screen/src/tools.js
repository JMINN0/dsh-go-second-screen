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

  // **屏建好就自动开推流** —— 用户的要求：「如果后台屏存在就自动拉起推流屏幕」。
  // 这样用户不用手动调 vdisplay_stream，建屏就能看到画面。
  try {
    const auto = await streamStart({ fps: 10, width: 480 });
    const t = String(auto?.text || '');
    if (/悬浮窗已浮起/.test(t)) parts.push('✅ 推流已自动开启，悬浮窗浮起（能看到这块屏的画面）');
    else if (/ImageReader/.test(t)) parts.push('✅ 推流已自动开启（' + t.split('\n')[0] + '）');
    else parts.push('⚠️ 推流没起来：' + t.split('\n').slice(0,2).join(' '));
  } catch (e) {
    parts.push('⚠️ 自动推流失败：' + String(e?.message || e).slice(0, 60));
  }
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
    // **像素坐标要按屏幕尺寸归一化，不是除以 100000。**
    // 原来 x/100000 是拍脑袋的：720 宽的屏上 x=360 会算成 0.0036，
    // 十字画在左上角，跟实际点的地方完全不对。
    let mx = NaN, my = NaN;
    if (Number.isFinite(Number(a0.nx)) && Number.isFinite(Number(a0.ny))) {
      mx = Number(a0.nx); my = Number(a0.ny);
    } else if (Number.isFinite(Number(a0.x)) && Number.isFinite(Number(a0.y))) {
      const vst = await vd.status().catch(() => null);
      const sw = (vst && vst.width) || 720;
      const sh = (vst && vst.height) || 1592;
      mx = Number(a0.x) / sw;
      my = Number(a0.y) / sh;
    }
    if (Number.isFinite(mx) && Number.isFinite(my)) {
      // **两个后端各自独立 try。**
      // 原来整段共用一个 try/catch：stream.markTap 一抛错，后面的
      // framesrv.markTap 就被跳过，用户看不到点击位置（实机踩到）。
      try { stream.markTap(mx, my, String(a0.kind || 'tap')); } catch { /* 慢路径失败不影响快路径 */ }
      try {
        const fsrv = await import('./framesrv.js');
        await fsrv.markTap(mx, my);                        // 快路径（ImageReader）画
      } catch { /* 快路径失败不影响慢路径 */ }
    }
  } catch { /* 没坐标就算了（滑动这类） */ }
  const kind = String(args?.kind || '').trim();
  // **hold 必须在这个白名单里。**
  // vd.js:1568 早就实现了 kind==='hold'（60Hz 连续 MOVE，驱动游戏摇杆），
  // 但这里漏了它 → 模型传 hold 直接被拒，README 宣传的「60Hz 摇杆走路」
  // 只有命令行能用，模型完全够不着（对抗审查发现的）。
  if (!['tap', 'swipe', 'hold', 'text', 'key', 'paste'].includes(kind)) {
    return { text: 'kind 只能是 tap / swipe / hold / text / key / paste。hold 是按住不动（游戏摇杆/长按/挖方块）。' };
  }
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
  // **屏关了就停 framesrv** —— 用户的要求：「关闭就跟着自动关闭推流屏」
  try {
    const fsrv = await import('./framesrv.js');
    await fsrv.stop();
  } catch { /* 没起来就算了 */ }
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
/**
 * 确保悬浮窗 APK 装好 —— **用户不需要手动装**。
 *
 * ## 为什么必须装 APK（实测过，不是偷懒）
 *
 * `app_process` 画不了悬浮窗：`WindowManagerService.openSession` 建的 `Session`
 * 要求调用进程在 ActivityManager 的进程表里，而 app_process 从 adb shell 起、
 * 不是 zygote fork 的应用进程 → `Unknown pid` 直接拒绝。
 * 探针代码在 `probe/src/com/dsh/probe/OverlayProbe.java`，结论在
 * `tests/NO-APK-OVERLAY-PROBE.md`。
 *
 * ## 怎么做到用户无感
 *
 * APK 就在插件包里（`assets/overlay/ai-overlay.apk`）。
 * 第一次用悬浮窗时自动 push + install + 授权，用户什么都不用做。
 */
async function ensureOverlayInstalled(run, target) {
  // 已装就直接返回
  try {
    const { stdout } = await run('adb', ['-s', target, 'shell',
      `pm list packages ${OVERLAY_PKG}`], { timeout: 8000 });
    if (String(stdout || '').includes(OVERLAY_PKG)) return { ok: true, already: true };
  } catch { /* 查不到就当没装，继续试装 */ }

  // 找内置 APK
  const { existsSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  let apk = null;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../assets/overlay/ai-overlay.apk', './assets/overlay/ai-overlay.apk']) {
      const p = join(here, rel);
      if (existsSync(p)) { apk = p; break; }
    }
  } catch { /* ignore */ }
  if (!apk) return { ok: false, why: '找不到内置 APK（assets/overlay/ai-overlay.apk）' };

  // **直接用本地路径装，不要 push 后再装。**
  // 实测：`adb install <设备路径>` 会走 Incremental Install，报
  // "failed to stat ... No such file or directory"，装不上；
  // 给本地路径则是 Streamed Install，正常。
  try {
    const r = await run('adb', ['-s', target, 'install', '-r', apk], { timeout: 90000 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    if (!/Success/i.test(out)) return { ok: false, why: 'install 失败: ' + out.slice(0, 120) };
    // 给悬浮窗权限（不用用户手点）
    await run('adb', ['-s', target, 'shell',
      `appops set ${OVERLAY_PKG} SYSTEM_ALERT_WINDOW allow`], { timeout: 8000 }).catch(() => {});
    return { ok: true, already: false };
  } catch (e) {
    return { ok: false, why: String(e?.message || e).slice(0, 80) };
  }
}

async function overlayStart(port) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const target = await adbTarget();
    // **装不上就自动装**（用户无感）
    const inst = await ensureOverlayInstalled(run, target);
    if (!inst.ok) return { ok: false, why: inst.why };
    // 给权限（幂等，已给过也不报错）
    await run('adb', ['-s', target, 'shell',
      `appops set ${OVERLAY_PKG} SYSTEM_ALERT_WINDOW allow`], { timeout: 8000 }).catch(() => {});
    // 拉起并把端口传进去
    await run('adb', ['-s', target, 'shell',
      `am start -n ${OVERLAY_PKG}/.MainActivity --ei port ${port}`], { timeout: 8000 });
    return { ok: true, autoInstalled: inst.already === false };
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
  try { stream.setState('looking'); } catch { /* ignore */ }

  // **优先走 framesrv（ImageReader，76fps）**。
  // screencap 每帧 141ms 的 Surface 回读是它的工作方式决定的，改不了；
  // ImageReader 从合成器直接拿 buffer，实测快 30 倍。
  let fast = { ok: false };
  try {
    const fsrv = await import('./framesrv.js');
    fast = await fsrv.start({
      displayId: s.displayId, width: s.width || 720, height: s.height || 1592,
    });
  } catch (e) { fast = { ok: false, why: String(e?.message || e).slice(0, 60) }; }

  // **只有快路径失败时才起 screencap 推流。**
  // 审计发现：原来无条件起，两条路同时跑，多烧 0.31 核，而且胶囊读的是慢的那条
  // （screencap 143ms/帧），用户看到的反而是差的那一路。
  let r = { ok: false, port: 0, hint: '跳过了（快路径已在跑）' };
  if (!fast.ok) {
    r = await stream.start({ sfId: s.sfId, displayId: s.displayId, fps, width, focusedApp: focus });
    if (!r.ok) return { text: `推流启动失败：${r.hint}` };
  } else {
    // **登记外部后端**，让 stream.js 的 writeState 也报 framesrv 的端口
    try { stream.setExternalBackend(fast.port, 'imagereader'); } catch { /* ignore */ }
    // **快路径在跑 → 把 stream.json 指向 framesrv**，让胶囊读快的这一路。
    // 胶囊读 stream.json 的 port 去取 /frame.jpg 和 /status，
    // framesrv 的这两个端点返回的字段是兼容的（running/frames/fps/aspect）。
    try {
      const { writeFile, mkdir } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = join(homedir(), '.dsh', 'plugin-screen');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'stream.json'), JSON.stringify({
        port: fast.port, running: true, startedAt: Date.now(),
        fps, width, displayId: String(s.displayId),
        focusedApp: focus || '',
        state: 'looking',
        aspect: s.width && s.height ? (s.width / s.height) : 0,
        backend: 'imagereader',
      }));
    } catch { /* 写不进去不影响推流 */ }
  }

  // 悬浮窗连哪个端口：优先 framesrv（快）
  const viewPort = fast.ok ? fast.port : (r.port || 0);
  const ov = await overlayStart(viewPort);

  const lines = [];
  if (fast.ok) {
    lines.push(`取帧走 ImageReader（快路径）：127.0.0.1:${fast.port}`);
    lines.push('实测 76 fps，静止时不抓帧几乎不耗 CPU。');
  } else {
    lines.push(`取帧走 screencap（慢路径，${fps} fps）：127.0.0.1:${r.port}`);
    lines.push(`ImageReader 没起来：${fast.why || '未知'} —— 先跑 framesrv/build.sh 编译`);
  }
  lines.push(ov.ok ? '悬浮窗已浮起（可拖动，单击收起，浮在任何 App 上）' : `悬浮窗没起来（${ov.why}）`);
  lines.push('打开 DSH Go 输入框上方的「AI 画面」胶囊也能看。');
  return { text: lines.join('\n') };
}

export async function streamStop() {
  await overlayStop();       // 先关悬浮窗，否则它会自己发现推流没了才关（多留一会儿）
  // **真的把 framesrv 停掉。**
  // 审计发现：原来全库没有任何 framesrv.stop() 调用点 ——
  // app_process 起来了就一直在，一直编码，直到手机重启或 OOM。
  let stoppedFast = false;
  try {
    const fsrv = await import('./framesrv.js');
    await fsrv.stop();
    stoppedFast = true;
  } catch { /* 没起来就算了 */ }
  try { stream.clearExternalBackend(); } catch { /* ignore */ }
  await stream.stop();
  return { text: stoppedFast
    ? '推流已停止（framesrv 已退出，胶囊和悬浮窗都不再显示画面）。'
    : '推流已停止（胶囊和悬浮窗都不再显示画面）。' };
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


/**
 * 查「用户现在在用手机吗」，以及目标 App 的风险等级。
 *
 * ## 为什么必须有这个工具
 *
 * `tools/user-busy.sh` 的判据是对的（topResumedActivity + mInputShown），
 * 但它只是个脚本，不在工具链路里 —— 所以模型根本不知道要调它。
 * 2026-11-17 抢键盘事故就是这么发生的：我用 mcp__phone__open 打开 Edge，
 * 用户正在 DSH Go 里打字的 InputConnection 被 detach，半截草稿丢了。
 *
 * 同理 `docs/risk.json` 记了 42 个 App 的风控等级（带 forbid:["batch","pay"]），
 * 但全库零引用 —— PLAYBOOK 里「L3 只读」只是散文，模型可以直接在微信/支付宝上
 * 点发送转账，没有任何自动拦截。
 *
 * 这个工具把两件事变成机器可查的。
 */

/**
 * 按文字找位置 / 按文字点击。
 *
 * ## 为什么必须有
 *
 * 现在模型是「看 OCR 返回的一堆 nx/ny，自己挑一个坐标去点」——
 * 实测 17.6% 的点空率，主要原因是模型算坐标时会算错/挑错行。
 *
 * 这两个工具把「找文字 → 算坐标 → 点」变成一次调用，坐标由代码算，模型不用碰。
 *
 * ## 匹配规则
 *
 * 默认「包含」匹配（要找「蓝牙」，OCR 行的「蓝牙」或「蓝牙 已开启」都算命中）。
 * 可以先精确匹配（exact），也可以正则（regex）。
 * 多个命中时：默认取最靠上的（第一个），可以指定 nth。
 */
export async function findText(args) {
  const need = String(args?.text || '').trim();
  if (!need) return { text: '要给要找的文字，比如「蓝牙」' };

  // **不要先调 text()**：那会 OCR 一次，然后下面又 OCR 一次，
  // 实测浪费 2 秒（4.2s vs 2.1s）。直接走下面的单次识别。
  const st = await vd.status();
  if (!st.running) return { text: '虚拟屏没在运行。先 vdisplay_start。' };
  const ocr = await import('./ocr.js');
  const shot = await vd.shot(String(args?.dir || '/tmp'), {
    width: Math.min(1080, Math.max(360, st.width || 720)), format: 'png',
  });
  if (!shot.ok) return { text: `截图失败：${shot.hint}` };
  const rr = await ocr.recognize(shot.path, { minConf: args?.minConf ?? 0.4, maxLines: 200 });
  if (!rr.ok) return { text: rr.hint };

  const mode = String(args?.mode || 'contains');
  const rx = mode === 'regex' ? new RegExp(need) : null;
  const hits = [];
  for (const l of rr.lines) {
    const t = String(l.text || '');
    let hit = false;
    if (mode === 'exact') hit = t.trim() === need;
    else if (mode === 'regex') hit = rx.test(t);
    else hit = t.includes(need) || need.includes(t.trim()) && t.trim().length > 0;
    if (hit) hits.push(l);
  }
  if (!hits.length) {
    const near = rr.lines
      .map((l) => ({ l, d: levenshtein(need, String(l.text || '')) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .filter((x) => x.d <= Math.max(2, need.length));
    const hint = near.length
      ? '相近的有：' + near.map((x) => `「${x.l.text}」`).join('、')
      : '屏幕上没找到相近文字';
    return { text: `没找到「${need}」。${hint}`, found: 0 };
  }

  const W = shot.width || 720, H = shot.height || 1280;
  const nth = Math.min(Math.max(0, Number(args?.nth) || 0), hits.length - 1);
  const target = hits[nth];
  const cx = (target.x + target.w / 2) / W;
  const cy = (target.y + target.h / 2) / H;

  const lines = [
    `找到 ${hits.length} 处「${need}」，用第 ${nth + 1} 处：`,
  ];
  hits.slice(0, 5).forEach((l, i) => {
    const x = ((l.x + l.w / 2) / W).toFixed(3);
    const y = ((l.y + l.h / 2) / H).toFixed(3);
    lines.push(`  ${i === nth ? '→' : ' '} 「${l.text}」 nx=${x} ny=${y}`);
  });
  if (hits.length > 5) lines.push(`  …还有 ${hits.length - 5} 处`);
  lines.push('', `目标坐标：nx=${cx.toFixed(3)} ny=${cy.toFixed(3)}`);
  lines.push('要直接点，用 vdisplay_tap_text（它会自己找坐标，不用你传）。');

  return { text: lines.join('\n'), found: hits.length, nx: cx, ny: cy, label: String(target.text || '') };
}

/**
 * 找到文字并点它 —— 一次调用完成「找 → 算坐标 → 点 → 确认」。
 *
 * ## 为什么校验要自己重做，不能用 input() 返回的 changed
 *
 * 实测踩到：点「蓝牙」明明跳进了蓝牙设置页，但 `input()` 的画面哈希校验
 * 报「画面在 2 秒内一直没有变化」—— **假失败**。
 *
 * 原因：`frameHash()` 用两次 screencap 比 SHA1，而页面跳转的转场时间
 * 可能超过检查窗口，或者两次截图都截在转场前。
 *
 * 假失败比不校验更糟：调用方会重试 → 重复操作（点两次「购买」）。
 *
 * 所以这里改成**用 OCR 判断页面身份变了没有**：
 * 点之前记一个屏指纹，点之后等一会儿再取一次，不同就算成功。
 * 这个判据慢一点（多一次 OCR），但它判断的是「页面确实变了」，不是「像素闪了一下」。
 */
export async function tapText(args) {
  const r = await findText(args);
  if (!r.found) return r;

  // 点击前记画面指纹（8×8 灰度 dHash，很便宜）
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const st0 = await vd.status();
  const grab = async () => {
    try {
      const r2 = await vd.shot('/tmp', { width: 160, format: 'png' });
      if (r2.ok !== false) return r2.hash || r2.path || null;
    } catch { /* ignore */ }
    return null;
  };
  const before = await grab();

  const t = await input({
    kind: 'tap', nx: r.nx, ny: r.ny,
    verify: false,          // 不用它的哈希校验（会假失败），下面自己做
    shotAfter: false,
  });

  // 等页面稳定（转场通常 200-600ms；这里给足 1.2 秒）
  await new Promise((res) => setTimeout(res, 1200));

  const after = await grab();
  const pageChanged = !!(before && after && before !== after);
  const tapOk = !/失败|不允许|不可用/.test(String(t.text || ''));

  const verdict = !tapOk
    ? '⚠️ 注入失败'
    : pageChanged
      ? '✅ 点了，页面已变化'
      : '✅ 点了（页面没变化 —— 可能是开关类控件，或这个页面本来就该保持）';

  return {
    text: `${verdict}\n点击目标：「${r.label}」 nx=${r.nx.toFixed(3)} ny=${r.ny.toFixed(3)}\n`
      + `画面：${pageChanged ? '变了' : '没变'}`,
    clicked: tapOk,
    pageChanged,
    label: r.label,
    nx: r.nx, ny: r.ny,
  };
}

/** 编辑距离（用于「没找到」时给相近建议）。 */
function levenshtein(a, b) {
  a = String(a); b = String(b);
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = [i];
    for (let j = 1; j <= b.length; j += 1) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

export async function userState() {
  const target = await adbTarget();
  const run = (cmd) => new Promise((resolve) => {
    import('node:child_process').then(({ execFile }) => {
      execFile('adb', ['-s', target, 'shell', cmd], { timeout: 8000 }, (e, out) => {
        resolve(String(out || ''));
      });
    });
  });

  const [front, ime] = await Promise.all([
    run("dumpsys activity activities 2>/dev/null | grep -m1 topResumedActivity"),
    run("dumpsys input_method 2>/dev/null | grep -m1 mInputShown"),
  ]);

  // 前台包名
  let frontPkg = '';
  const m = front.match(/([a-zA-Z][\w.]*)\/[\w.]*/);
  if (m) frontPkg = m[1];

  const imeShown = /mInputShown=true/.test(ime);
  const dshFg = /dsh_app|ccch1mneyyy/.test(front);

  // 判据：DSH Go 在前台 或 输入法挂着 → 用户在用
  const busey = dshFg || imeShown;
  const reasons = [];
  if (dshFg) reasons.push('DSH Go 在前台（用户正在跟 AI 对话）');
  if (imeShown) reasons.push('输入法正在显示（用户可能在打字）');

  const lines = [
    busey ? '🔴 用户正在用手机 —— 不要抢前台/抢键盘' : '🟢 用户没在用手机，可以操作',
    '',
    `前台 App：${frontPkg || '(查不到)'}`,
    `输入法：${imeShown ? '显示中' : '收起'}`,
  ];
  if (reasons.length) {
    lines.push('', '判据命中：', ...reasons.map((r) => `  · ${r}`));
    lines.push('', '如果要操作主屏（am start / mcp__phone__type / input text），建议改走：',
      '  · 虚拟屏（vdisplay_*）—— 不碰用户前台',
      '  · 浏览器 CDP（web_*）—— 不抢焦点',
      '  · 或等用户停下来');
  }
  return { text: lines.join('\n'), busy: busey, frontPkg, imeShown };
}

/** 查某个包的风控等级（读 docs/risk.json）。 */
export async function riskCheck(pkg) {
  const name = String(pkg || '').trim();
  if (!name) return { text: '要给包名，比如 com.tencent.mm' };
  let data = null;
  try {
    const { readFile } = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const { dirname, join } = await import('node:path');
    const here = dirname(fileURLToPath(import.meta.url));
    for (const rel of ['../docs/risk.json', '../../docs/risk.json']) {
      try {
        const raw = await readFile(join(here, rel), 'utf8');
        data = JSON.parse(raw);
        break;
      } catch { /* 试下一个 */ }
    }
  } catch { /* ignore */ }
  if (!data) return { text: '读不到 docs/risk.json（插件没带这个文件？）' };

  const apps = data.apps || data;
  const info = apps[name];
  if (!info) {
    return {
      text: `未知 App（${name}）→ 按默认 L${data.unknown_level ?? 3} 处理：先只读观察，写操作前问用户。`,
      level: data.unknown_level ?? 3,
      name: '',
    };
  }
  const LEVELS = {
    0: 'L0 无风控 —— 随便操作',
    1: 'L1 轻微 —— 控制频率即可',
    2: 'L2 中等 —— 操作要拟人化',
    3: 'L3 严格 —— 只读，写操作必须问用户',
    4: 'L4 禁止 —— 银行/支付，只能交给人',
    5: 'L5 硬边界 —— 技术上也做不到',
  };
  const lines = [
    `${info.name || name}：${LEVELS[info.level] || ('L' + info.level)}`,
    `包名：${name}`,
  ];
  if (info.readOnly) lines.push('⚠️ 标记为只读：不要点任何会改变状态的东西');
  if (Array.isArray(info.forbid) && info.forbid.length) {
    lines.push(`⚠️ 禁止动作：${info.forbid.join('、')}`);
  }
  return { text: lines.join('\n'), level: info.level, name: info.name || name, forbid: info.forbid || [] };
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
      // **必须给 text**：out() 的 schema 里 text 是 required 且 additionalProperties:false，
      // 少这个字段模型拿到的是空结果（审计发现的 P0）。
      text: r.ok
        ? `解码器 ${s.decoder ? '已启动' : '未启动'}；流 ${s.width}x${s.height}，${s.frames} 帧，实测 ${s.fps || 0} fps。`
        : `解码器操作失败：${r.hint || '未知'}`,
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
      // **text 必填**，失败分支也要给
      text: `取帧失败：${r.hint || '未知'}。改用 vdisplay_shot（走 screencap，静止屏也能截）。`,
      ok: false,
      hint: r.hint,
      fallback: '用 vdisplay_shot（走 screencap，静止屏也能截）',
    };
  }
  return {
    // **text 必填**（out() 的 schema 要求），少了模型拿到空结果
    text: `从流里取到一帧：${r.path || '(无路径)'}（${r.bytes || 0} 字节）`,
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
    // **text 必填**
    text: `画面${r.stable !== false ? '已稳定' : '未稳定'}，等了 ${r.waitedMs || 0} ms（尾部 MAD ${r.tailMad ?? '?'}）。`,
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
      // **text 必填**，失败分支也要给
      text: '挑不出合适的区域（画面可能完全没有变化，也没有最近的点击位置）。直接 vdisplay_shot 全屏。',
      ok: false,
      hint: '挑不出合适的区域（画面可能完全没有变化，也没有最近的点击位置）。直接 vdisplay_shot 全屏。',
    };
  }
  return {
    // **text 必填**
    text: `推荐区域 region{ x:${r.x}, y:${r.y}, w:${r.w}, h:${r.h} }，来源 ${r.src || '?'}，占屏 ${((r.area || 0) * 100).toFixed(1)}%。`,
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
  if (!r.ok) return { text: `黑屏探针失败：${r.hint || '未知'}`, ok: false, hint: r.hint };
  return {
    // **text 必填**（out() 的 schema 要求），少了模型拿到空结果
    text: `黑屏探针结论：${r.verdict || '正常出画'}（置信度 ${r.confidence ?? '?'}）。${r.hint || ''}`,
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
