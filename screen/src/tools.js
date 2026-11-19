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
  // **AI 可以按任务预估设定空闲超时**：比如「这个任务大概要挂 30 分钟」就传 keepMin:30。
  // 不传就沿用当前设定（默认 5 分钟）。
  if (args?.keepMin != null) {
    const r = setIdleTimeout(args.keepMin);
    if (r.ok) {
      try { console.error('[dsh-screen] 后台屏空闲超时设为 ' + r.minutes + ' 分钟'); } catch { /* ignore */ }
    }
  }
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
  // **multitouch 已通过实测**（2026-11-19 晚）。关键是「不要自己编码 index」——
  // 反编译 scrcpy 的 classes.dex 发现它自己算 index 并 OR 上 5/6，
  // 我们只要发基础 action(0/1/2)。修正后 Inconsistent=0、Dropping=0。
  if (!['tap', 'swipe', 'hold', 'multitouch', 'text', 'key', 'paste'].includes(kind)) {
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
  // **停屏时也把常驻助手关掉。**
  // 原来是「用一次 find_image / vdisplay_text 之后，OpenCV(80-150MB) 和
  // OCR(15MB 模型) 会一直挂到插件卸载」—— 实测确实如此（独立复核指出）。
  // closeAll 里虽然写了 shutdown，但 closeAll 全库没有调用点（死代码）。
  // 这里直接关，让「停屏」真正释放全部资源。
  try { const vis = await import('./vision.js'); vis.shutdown(); } catch { /* ignore */ }
  try { const oc = await import('./ocr.js'); oc.shutdown(); } catch { /* ignore */ }

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
  // **视觉助手也要关。** 和 OCR 当初同款泄漏：OpenCV 常驻进程占 80-150MB，
  // 不关就成孤儿进程（对抗审查发现的 P0）。
  try { const v = await import('./vision.js'); v.shutdown(); } catch { /* ignore */ }
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
  // **必须传 hash**，否则 cacheKey 为 null、缓存对 find/tap_text 完全不生效 ——
  // 而这两个正是循环里最常用的工具（对抗审查 + OCR 专项审查都指出）。
  const rr = await ocr.recognize(shot.path, {
    minConf: args?.minConf ?? 0.4,
    maxLines: 200,
    hash: args?.fresh ? null : shot.hash,
  });
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

  return {
    text: lines.join('\n'), found: hits.length, nx: cx, ny: cy,
    label: String(target.text || ''),
    // **把这张截图传出去给 tapText 复用。**
    // tapText 原来自己又截一张（376ms），纯浪费 —— findText 刚刚才截过同一屏。
    shotPath: shot.path, shotHash: shot.hash,
  };
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

  // **点击前记画面指纹 —— 复用 findText 已经截过的那张图，不再单独截。**
  // 原来这里额外调一次 vd.shot(160 宽)，250-400ms；加上后面的固定 1.2 秒，
  // tap_text 真实墙钟 4.2-6.2 秒（OCR 专项审查指出）。
  const V = await import('./vision.js');
  // **必须用同一种哈希。**
  // findText 返回的 shotHash 是 shot() 算的 SHA1（40 位，整张 PNG 字节），
  // 而下面 after 用的是 vision 的 dHash（16 位，9×8 灰度）—— 两种字符串永远不等，
  // 于是 pageChanged 恒 true，**校验退化成返回常量 true**。
  // 这是「防假成功的代码自己在造假成功」（独立复核发现，最讽刺也最危险的一条）。
  // 正确做法：用同一张图的路径重新算 dHash 当基线。
  let before = null;
  if (r.shotPath) {
    const fp0 = await V.dhash(r.shotPath);
    before = fp0.ok ? fp0.hash : null;
  }

  const t = await input({
    kind: 'tap', nx: r.nx, ny: r.ny,
    verify: false,          // 不用它的哈希校验（会假失败），下面自己做
    shotAfter: false,
  });

  // **等一次就够，不要循环截图。**
  // 我第一版写成「每 150ms 截一张比对」—— 每张截图 376ms，
  // 循环三次就是 1.1 秒，反而比固定 1.2 秒还慢（实测 tapText 5.9 秒）。
  // 改成：等 500ms（覆盖多数转场）→ 截一张 → 比一次。最多再补一次。
  // 只后验一次：多数转场 500ms 内完成，截两次的第二次基本是白等。
  let after = null;
  await new Promise((res) => setTimeout(res, 500));
  const g2 = await grabFullPng();
  if (g2.ok) after = (await V.dhash(g2.path)).hash;
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


/* ═══════════════════════════════════════════════════════════════════════════
 * **空闲看门狗：AI 不干活就把资源全放掉。**
 *
 * ## 为什么必须有
 *
 * 实机实测（2026-11-19）：对话结束后虚拟屏+悬浮窗+framesrv 一直在跑，
 * framesrv 持续 **10.3% CPU**，因为悬浮窗连着 MJPEG 长连接，
 * framesrv 就认为「有人在看」，一直编码。
 *
 * 用户的原话：「dsh 引擎停了 ai 也会停，那还要后台屏一直开着干嘛？」
 *
 * 对。屏和推流唯一的用途是「给 AI 操作 + 给用户看」。AI 不调工具了，
 * 就是没人需要它。留着纯烧电。
 *
 * ## 判据
 *
 * 每次工具调用都刷新 `lastToolCallAt`。看门狗每分钟检查一次：
 *   - 超过 IDLE_STOP_MS 没有任何工具调用 → 停推流（关悬浮窗 + framesrv）
 *   - 再超过 IDLE_DISPLAY_MS → 连虚拟屏一起销毁
 *
 * 为什么分两步：停推流是零风险的（屏还在，随时能再开）；
 * 销毁屏会丢掉屏上的 App 状态，所以多等一会儿。
 *
 * ## 不受影响的场景
 *
 * 用户主动调 vdisplay_stream / vdisplay_start 时也会刷新时间戳，
 * 所以「用户想一直看」不会被打断 —— 只要有人调工具就活着。
 */
// **超时时间由 AI 按任务预估设定**（1~360 分钟）。
// 用户的原话：「让 ai 自己判断这个任务需要使用多久后台屏，在 ai 不操作的情况下才开始计时，
// 一旦操作立刻重置计时」。
//
// 默认 5 分钟：绝大多数交互式任务每几分钟就会有工具调用，不会误关；
// 长任务（挂机/等待/轮询）由 AI 自己调大。
const IDLE_MIN_DEFAULT = 5;
const IDLE_MIN_FLOOR = 1;      // 最少 1 分钟
const IDLE_MIN_CEIL = 360;     // 最多 6 小时
let idleTimeoutMin = IDLE_MIN_DEFAULT;
let lastToolCallAt = Date.now();
let idleTimer = null;
let idleStoppedStream = false;
let idleStoppedDisplay = false;

/** 每次工具调用时调一下，重置空闲计时。 */
export function touchActivity() {
  lastToolCallAt = Date.now();
  idleStoppedStream = false;
  idleStoppedDisplay = false;
}

/** 启动看门狗（插件加载时调一次）。 */
export function startIdleWatchdog() {
  if (idleTimer) return;
  idleTimer = setInterval(async () => {
    const idle = Date.now() - lastToolCallAt;
    const limitMs = idleTimeoutMin * 60 * 1000;
    if (idle <= limitMs) return;
    try {
      // **到点：推流和屏一起关。**
      // 先关推流（关悬浮窗 + framesrv，立刻省掉编码的 CPU），
      // 再销毁屏（释放 ImageReader/镜像屏/端口）。
      if (!idleStoppedStream) {
        idleStoppedStream = true;
        await import('./tools.js').then((m) => m.streamStop()).catch(() => {});
      }
      if (!idleStoppedDisplay) {
        idleStoppedDisplay = true;
        const vdMod = await import('./vd.js');
        const st2 = await vdMod.status();
        if (st2 && st2.running) {
          await vdMod.stop({ forceStopApps: false }).catch(() => {});
        }
      }
      try {
        console.error('[dsh-screen] 空闲 ' + Math.round(idle / 60000) + ' 分钟（上限 ' + idleTimeoutMin + '），已自动关闭后台屏');
      } catch { /* ignore */ }
    } catch { /* 看门狗自己不能崩 */ }
  }, 60 * 1000);   // 每分钟检查一次
  // 不阻止进程退出
  if (idleTimer.unref) idleTimer.unref();
}

/**
 * 设定「AI 停止操作多久后自动关掉后台屏」。
 *
 * @param {number} minutes 1~360 分钟
 * @returns {{ok:boolean, minutes:number, hint?:string}}
 */
export function setIdleTimeout(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n)) return { ok: false, minutes: idleTimeoutMin, hint: '要给分钟数，比如 30' };
  const clamped = Math.min(IDLE_MIN_CEIL, Math.max(IDLE_MIN_FLOOR, Math.round(n)));
  idleTimeoutMin = clamped;
  // 设置完立刻刷新计时，避免「刚设完就被判定空闲」
  lastToolCallAt = Date.now();
  idleStoppedStream = false;
  idleStoppedDisplay = false;
  return { ok: true, minutes: clamped };
}

/** 当前设定（给诊断用）。 */
export function getIdleTimeout() { return idleTimeoutMin; }

/** 停看门狗（插件卸载时用）。 */
export function stopIdleWatchdog() {
  if (idleTimer) { clearInterval(idleTimer); idleTimer = null; }
}


/**
 * 调整「AI 停止操作多久后自动关掉后台屏」。
 *
 * 长任务（挂机、等转盘、轮询消息）需要屏活久一点；
 * 短任务（点几下就完）可以设短，省电更彻底。
 *
 * 任何工具调用都会重置计时，所以只要 AI 一直在操作，屏就不会被关。
 */
export function keepAlive(args) {
  const min = args?.minutes;
  const r = setIdleTimeout(min);
  if (!r.ok) {
    return { text: `设置失败：${r.hint}。当前是 ${getIdleTimeout()} 分钟。` };
  }
  const lines = [
    `✅ 后台屏空闲超时设为 **${r.minutes} 分钟**`,
    '',
    '含义：AI 连续 ' + r.minutes + ' 分钟没有调用任何工具 → 自动关闭推流 + 销毁虚拟屏。',
    '任何工具调用都会重置计时，所以只要还在操作就不会被关。',
    '',
    `范围：1~360 分钟。当前设定：${getIdleTimeout()} 分钟。`,
  ];
  if (r.minutes === 360) lines.push('', '⚠️ 已设为上限 6 小时 —— 期间会持续占 CPU，确认真的需要这么久。');
  return { text: lines.join('\n'), minutes: r.minutes };
}


/* ═══════════════ 视觉方法（OpenCV，常驻助手）═══════════════
 *
 * 这些工具之前完全没有 —— 只有 OCR（文字）和截图（给模型看）。
 * 加了之后，「找没有文字的东西」终于有路了：
 *   图标、开关、技能格、血条、准星、红心、返回箭头 …
 *
 * 实测耗时（tests/CV-BENCHMARK-ARM.md，1592×720）：
 *   模板匹配 5.7ms（温）/ 16-30ms（Node 往返）
 *   指纹 7ms、差分 2.3ms、颜色 6.8ms、边缘 0.7ms
 *
 * 对比 OCR 的 1600ms —— 快 100-280 倍。
 */

/**
 * 截一张原分辨率 PNG 给 CV 用（不缩放，缩放会丢模板精度）。
 *
 * **不要先调 vd.status()** —— 它内部又走一遍 alive()（2 次 dumpsys）+ 一次
 * dumpsys window displays，实测多花 ~250ms。vd.shot() 自己会做必要的检查。
 */
async function grabFullPng() {
  // **零开销守卫：屏没建就直接返回，不能让 vd.shot() 静默建一块。**
  // vd.shot 第一行是 start()，displayId 为空时会完整建屏（1.8 秒）——
  // 一个只读探测工具（fingerprint/probe/diff）顺手建了一块屏还留着，
  // 再截到全黑空屏，用户完全不知道发生了什么（对抗审查 S16）。
  // 用 getActive() 而不是 status()：后者要 3 次 dumpsys（约 250ms）。
  const st = vd.getActive();
  if (!st || !st.displayId) {
    return { ok: false, hint: '虚拟屏没在运行。先 vdisplay_start 建屏，再调这个工具。' };
  }
  const shot = await vd.shot('/tmp', { width: 1080, format: 'png' });
  if (!shot.ok) return { ok: false, hint: `截图失败：${shot.hint}` };
  return { ok: true, path: shot.path, width: shot.width, height: shot.height };
}

/**
 * 模板匹配找图。**这是找「没有文字的东西」的唯一快路。**
 *
 * 用法：先 `vdisplay_shot` 看一眼，把目标图标的位置告诉 AI，
 * 或者 AI 自己截一小块存成模板文件，之后就能反复找。
 */
export async function findImage(args) {
  const tpl = String(args?.template || '').trim();
  if (!tpl) return { text: '要给模板图路径（PNG/JPG）。先用 vdisplay_shot 截图，再裁出目标存成文件。' };
  const { existsSync } = await import('node:fs');
  if (!existsSync(tpl)) return { text: `模板文件不存在：${tpl}` };

  const g = await grabFullPng();
  if (!g.ok) return { text: g.hint };

  const V = await import('./vision.js');
  // **默认多尺度。**
  // 文档教的「vdisplay_shot 截图 → 裁出目标存 PNG」拿到的模板是 540 宽，
  // 而 find_image 走 PNG 原生 720 —— 模板小 25%，单尺度匹配分数从 0.8 掉到 0.45
  // 直接报「没找到」（实测：单尺度 0.454 找不到，多尺度 scale=1.3 得 0.796 找到）。
  // 这不是优化，是让文档教的做法真能用。
  const scales = Array.isArray(args?.scales) && args.scales.length
    ? args.scales.map(Number).filter((x) => x > 0)
    : [0.55, 0.65, 0.75, 0.85, 1.0, 1.15, 1.33, 1.5];
  const thr = Number.isFinite(Number(args?.threshold)) ? Number(args.threshold) : 0.75;
  const r = await V.match(g.path, tpl, {
    region: args?.region || null,
    threshold: thr,
    scales,
  });
  if (!r.ok) return { text: `模板匹配失败：${r.hint}` };

  const lines = [
    r.found
      ? `✅ 找到目标（score ${r.score} ≥ 阈值 ${r.threshold}）`
      : `❌ 没找到（最高分 ${r.score} < 阈值 ${r.threshold}）`,
    `模板：${tpl}（内部标准差 ${r.tplStd}，用 ${r.method}）`,
    `位置：屏幕 (${r.x}, ${r.y}) 大小 ${r.w}×${r.h} → 中心 nx=${r.cx} ny=${r.cy}`,
    `耗时 ${r.elapsedMs}ms`,
  ];
  if (!r.found) {
    lines.push('', '可以试：① 调低 threshold（0.6-0.7）② 模板换成更清晰的一块 ③ 换用 OCR 找文字');
  } else {
    lines.push('', '要直接点它，用 vdisplay_tap_image（它会自己找再点）。');
  }
  return { text: lines.join('\n'), found: r.found, nx: r.cx, ny: r.cy, score: r.score };
}

/**
 * 找到图并点它。
 *
 * **不能无条件报成功。** 原来传 verify:false 然后检查文本里有没有"失败"，
 * 但 verify:false 时 input() 的文本恒为「已在 display=N 注入 tap」，
 * 永远不含"失败" → ok 恒 true。屏死、坐标出屏、控件不可点全报「✅ 已点击」，
 * AI 会以为点了购买/发送其实什么都没发生（对抗审查发现的 P0）。
 *
 * 现在照 tapText 的做法：点前后各取一次画面指纹，如实说变没变。
 */
export async function tapImage(args) {
  const r = await findImage(args);
  if (!r.found) return r;
  const V = await import('./vision.js');
  const g1 = await grabFullPng();
  const before = g1.ok ? (await V.dhash(g1.path)).hash : null;

  const t = await input({ kind: 'tap', nx: r.nx, ny: r.ny, verify: false });
  // **tools.input() 从不返回 ok 字段** —— 它所有返回路径都只有 {text}。
  // 所以 `t.ok !== false` 恒为 true（undefined !== false），注入失败也报 ✅。
  // 改成和 tapText 一致的文本判据。
  const injected = !/失败|不允许|不可用/.test(String(t.text || ''));
  await new Promise((res) => setTimeout(res, 900));

  const g2 = await grabFullPng();
  const after = g2.ok ? (await V.dhash(g2.path)).hash : null;
  const pageChanged = !!(before && after && before !== after);

  const verdict = !injected
    ? '⚠️ 注入失败'
    : pageChanged
      ? '✅ 点击已生效（画面变了）'
      : '✅ 已点击，但画面没变（可能是开关类控件，或这一下没打到可点的地方）';
  return {
    text: `${verdict}\n模板目标 nx=${r.nx} ny=${r.ny}（score ${r.score}）\n画面：${pageChanged ? '变了' : '没变'}`,
    clicked: injected, pageChanged, nx: r.nx, ny: r.ny,
  };
}

/**
 * 界面指纹（64 位 dHash）。
 *
 * 用途：判断「现在是不是那个界面」——比截图比对便宜得多（7ms vs 143ms），
 * 也比 OCR 可靠（不依赖文字）。
 */
export async function fingerprint(args) {
  const g = await grabFullPng();
  if (!g.ok) return { text: g.hint };
  const V = await import('./vision.js');
  const r = await V.dhash(g.path);
  if (!r.ok) return { text: `指纹失败：${r.hint}` };

  // 和上次的比，判断界面变了没
  const { readFile, writeFile } = await import('node:fs/promises');
  // **必须清洗 key**：原来直接用，传 "../../etc/passwd" 会写到 /etc/passwd.json
  // （root 下可写），读侧同样能读任意 .json 并回显内容。
  const key = String(args?.key || 'default').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'default';
  const store = '/tmp/dsh-fp-' + key + '.json';
  let prev = null;
  try { prev = JSON.parse(await readFile(store, 'utf8')); } catch { /* 没有上次 */ }

  let dist = null;
  if (prev && prev.hash && /^[0-9a-f]{16}$/i.test(String(prev.hash))) {
    // 汉明距离（先校验格式，缓存文件被写坏时 BigInt 会抛 SyntaxError 冒到工具层）
    let d = 0;
    const a = BigInt('0x' + prev.hash), b = BigInt('0x' + r.hash);
    let x = a ^ b;
    while (x) { d += Number(x & 1n); x >>= 1n; }
    dist = d;
  }
  try { await writeFile(store, JSON.stringify({ hash: r.hash, at: Date.now() })); } catch { /* ignore */ }

  const lines = [
    `界面指纹：${r.hash}（${r.w}×${r.h}，${r.elapsedMs}ms）`,
    prev ? `上次：${prev.hash} → 汉明距离 ${dist} ${dist === 0 ? '（完全相同的界面）' : dist <= 10 ? '（同一界面，变了点细节）' : '（不同界面）'}` : '（第一次记录）',
  ];
  return { text: lines.join('\n'), hash: r.hash, distance: dist, changed: dist === null ? null : dist > 10 };
}

/**
 * 两张截图的差异（MAD + maxCell）。
 *
 * **maxCell 是关键**：全局 MAD 会被大面积静态背景稀释，
 * 小区域变化（比如一个数字变了）MAD 可能只有 0.0012 但 maxCell 有 0.31。
 */
export async function screenDiff(args) {
  const a = String(args?.before || '').trim();
  const g = await grabFullPng();
  if (!g.ok) return { text: g.hint };
  if (!a) {
    // 没有 before 就和上一张比
    const { readFile, writeFile } = await import('node:fs/promises');
    const store = '/tmp/dsh-lastshot.json';
    let prev = null;
    try { prev = JSON.parse(await readFile(store, 'utf8')); } catch { /* ignore */ }
    try { await writeFile(store, JSON.stringify({ path: g.path, at: Date.now() })); } catch { /* ignore */ }
    if (!prev || !prev.path) {
      return { text: `已记录当前画面（${g.path}）。再调一次就能看差异。`, first: true };
    }
    args = { ...args, before: prev.path };
  }

  const V = await import('./vision.js');
  const r = await V.diff(args.before, g.path);
  if (!r.ok) return { text: `差异计算失败：${r.hint}` };
  return {
    text: [
      `差异：MAD ${r.mad}，最大格 ${r.maxCell}（在 ${r.maxCellAt.gx},${r.maxCellAt.gy} 格）`,
      `判定：${r.changed ? '画面有实质变化' : '画面基本没变'}`,
      `（MAD 会被大片静态背景稀释，小区域变化要看 maxCell）`,
      `耗时 ${r.elapsedMs}ms`,
    ].join('\n'),
    mad: r.mad, maxCell: r.maxCell, changed: r.changed,
  };
}

/**
 * 探测当前界面适合用什么识别方法。
 *
 * 这是「按 App 自动选方法」的第一步：先量，再选。
 * 返回边缘密度、颜色可分性、亮度对比，据此判断：
 *   边缘密度 5-18% 且对比够 → 模板匹配可用
 *   颜色 top5 占比高且色数少 → 颜色/连通域可用
 *   看起来空白 → 可能 FLAG_SECURE 或没加载完
 */
export async function probeScreen(args) {
  const g = await grabFullPng();
  if (!g.ok) return { text: g.hint };
  const V = await import('./vision.js');
  const r = await V.probe(g.path);
  if (!r.ok) return { text: `探测失败：${r.hint}` };

  const recs = [];
  if (r.looksBlank) recs.push('⚠️ 画面接近空白 —— 可能是 FLAG_SECURE 或界面没加载完');
  if (r.canTemplate) recs.push('✅ 模板匹配可用（边缘 5-30%、对比够）');
  else recs.push('⚠️ 模板匹配可能不稳（边缘太密或太少）');
  if (r.canColor) recs.push('✅ 颜色/连通域可用（色块集中）');
  else recs.push('⚠️ 颜色方法可能不稳（颜色太杂）');
  recs.push('ℹ️ OCR 永远可用（文字是另一条路）');

  return {
    text: [
      `界面 ${r.w}×${r.h}，耗时 ${r.elapsedMs}ms`,
      `边缘密度 ${r.edgeDensity}（5-18% 适合形状检测）`,
      `颜色：top5 占比 ${r.colorTop5}，色数 ${r.colorCount}（色数少才好用）`,
      `亮度 ${r.brightness}，对比 ${r.contrast}`,
      '',
      ...recs,
    ].join('\n'),
    data: r,
  };
}


/**
 * 按颜色找色块（颜色阈值 + 连通域）。
 *
 * ## 能干什么
 *
 * 找**固定颜色**的东西：血条（红/绿）、按钮底色、选中状态的边框、
 * 小地图上的敌我点、进度条、生命值/魔法值条。
 *
 * **和模板匹配的分工**：
 *   模板匹配 → 形状固定但颜色会变的（图标）
 *   颜色检测 → 颜色固定但位置会变的（血条长度、小地图点位）
 *
 * ## 为什么必须用 Lab
 *
 * 实测踩过：用绝对 RGB 阈值，HDR 内容/不同色温下全部失效。
 * Lab 的 a/b 通道描述的是「色相」，和亮度解耦，色偏时仍然稳。
 *
 * 耗时：6.8ms（实测，tests/CV-BENCHMARK-ARM.md）。
 */
export async function findColor(args) {
  const tgt = args?.color;
  if (!tgt) {
    return {
      text: '要给目标颜色。两种写法：\n'
        + '  {r:200,g:50,b:50}   RGB（会自动转 Lab）\n'
        + '  {l:128,a:180,b:150} 直接给 Lab\n'
        + '先用 vdisplay_shot 看一眼，从图上取色。',
    };
  }

  const g = await grabFullPng();
  if (!g.ok) return { text: g.hint };

  const V = await import('./vision.js');
  const r = await V.color(g.path, tgt, {
    tolerance: args?.tolerance === undefined ? 20 : Number(args.tolerance),
    minArea: args?.minArea === undefined ? 200 : Number(args.minArea),
    max: args?.max === undefined ? 10 : Number(args.max),
    region: args?.region || null,
  });
  if (!r.ok) return { text: `颜色检测失败：${r.hint}` };

  if (!r.count) {
    return {
      text: `没找到该颜色的色块（容差 ${args?.tolerance ?? 20}）。\n`
        + '可以试：① 调大 tolerance（30-50）② 调小 minArea（50-100）③ 确认颜色值取对了',
      count: 0,
    };
  }

  const lines = [`找到 ${r.count} 个色块（耗时 ${r.elapsedMs}ms）：`];
  r.boxes.slice(0, 8).forEach((b, i) => {
    lines.push(`  ${i + 1}. 位置 (${b.x},${b.y}) 大小 ${b.w}×${b.h} 面积 ${b.area}`
      + ` → 中心 nx=${b.cx} ny=${b.cy}`);
  });
  if (r.count > 8) lines.push(`  …还有 ${r.count - 8} 个`);
  lines.push('', '最大的那个通常是目标（比如血条）。要点它用坐标或 vdisplay_input。');
  return { text: lines.join('\n'), count: r.count, boxes: r.boxes, biggest: r.boxes[0] };
}

/** 找颜色并点最大的那个色块。校验同 tapImage —— 不能无条件报成功。 */
export async function tapColor(args) {
  const r = await findColor(args);
  if (!r.count) return r;
  const b = r.biggest;
  const V = await import('./vision.js');
  const g1 = await grabFullPng();
  const before = g1.ok ? (await V.dhash(g1.path)).hash : null;

  const t = await input({ kind: 'tap', nx: b.cx, ny: b.cy, verify: false });
  const injected = !/失败|不允许|不可用/.test(String(t.text || ''));
  await new Promise((res) => setTimeout(res, 900));

  const g2 = await grabFullPng();
  const after = g2.ok ? (await V.dhash(g2.path)).hash : null;
  const pageChanged = !!(before && after && before !== after);

  const verdict = !injected
    ? '⚠️ 注入失败'
    : pageChanged
      ? '✅ 点击已生效（画面变了）'
      : '✅ 已点击，但画面没变（可能不是可点区域）';
  return {
    text: `${verdict}\n色块 ${b.w}×${b.h} 中心 nx=${b.cx} ny=${b.cy}\n画面：${pageChanged ? '变了' : '没变'}`,
    clicked: injected, pageChanged, nx: b.cx, ny: b.cy,
  };
}

/**
 * 自动判断当前界面该用什么识别方法，并给出建议顺序。
 *
 * ## 为什么需要
 *
 * 现在工具多了（OCR / 模板 / 颜色 / 指纹 / 差分），模型不知道该用哪个。
 * 这个工具**先量再选**，把「用哪个」变成数据驱动的决定，不是猜。
 *
 * ## 判据（都来自实测数据）
 *
 * | 界面特征 | 推荐方法 | 依据 |
 * |---|---|---|
 * | 边缘密度 5-18% + 对比够 | **模板匹配** | 5.7ms，形状清晰 |
 * | 颜色 top5 占比 >35% + 色数 <260 | **颜色检测** | 6.8ms，色块集中 |
 * | 文字多（跑一次 OCR 探）| **OCR / find_text** | 唯一能读文字的 |
 * | 画面接近空白 | **先怀疑 FLAG_SECURE 或没加载完** | std < 3 |
 *
 * ## 结果会缓存
 *
 * 同一个界面（用 dHash 判断）第二次问直接返回缓存，省掉探测的 100ms。
 */
export async function chooseMethod(args) {
  const { readFile, writeFile, mkdir } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const cacheDir = join(homedir(), '.dsh', 'plugin-screen');
  const cacheFile = join(cacheDir, 'method-cache.json');

  const g = await grabFullPng();
  if (!g.ok) return { text: g.hint };

  const V = await import('./vision.js');
  const fp = await V.dhash(g.path);
  const pr = await V.probe(g.path);
  if (!pr.ok) return { text: `探测失败：${pr.hint}` };

  // 读缓存
  let cache = {};
  try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch { /* 没有缓存 */ }

  const key = String(args?.key || 'default') + '|' + fp.hash;
  const cached = cache[key];
  if (cached && !args?.fresh) {
    return {
      text: [
        `✅ 这个界面见过（指纹 ${fp.hash}），直接用上次的结论：`,
        '',
        ...cached.methods.map((m, i) => `  ${i + 1}. ${m.tool} —— ${m.why}`),
        '',
        `（要重新探测传 fresh:true）`,
      ].join('\n'),
      methods: cached.methods, cached: true,
    };
  }

  // 打分
  const methods = [];
  if (pr.looksBlank) {
    methods.push({ tool: 'vdisplay_probe_secure', why: '画面近空白，先确认是不是 FLAG_SECURE', score: 100 });
  }
  if (pr.canTemplate) {
    methods.push({ tool: 'vdisplay_find_image', why: `边缘密度 ${(pr.edgeDensity * 100).toFixed(1)}%、对比 ${pr.contrast}，模板匹配 5.7ms 最划算`, score: 90 });
  }
  if (pr.canColor) {
    methods.push({ tool: 'vdisplay_find_color', why: `颜色 top5 占比 ${(pr.colorTop5 * 100).toFixed(0)}%、色数 ${pr.colorCount}，色块集中适合颜色检测`, score: 85 });
  }
  methods.push({ tool: 'vdisplay_text', why: 'OCR 永远可用 —— 文字是唯一能「读懂内容」的路（1.9-3.3s）', score: 60 });
  methods.push({ tool: 'vdisplay_fingerprint', why: '判断「还是不是同一屏」用指纹，7ms，不依赖内容', score: 50 });
  methods.sort((a, b) => b.score - a.score);

  // 写缓存
  try {
    await mkdir(cacheDir, { recursive: true });
    cache[key] = { methods, at: Date.now(), stats: { edge: pr.edgeDensity, top5: pr.colorTop5, colors: pr.colorCount, contrast: pr.contrast } };
    // 只留最近 100 条
    const keys = Object.keys(cache);
    if (keys.length > 100) for (const k of keys.slice(0, keys.length - 100)) delete cache[k];
    await writeFile(cacheFile, JSON.stringify(cache));
  } catch { /* 写不进去不影响 */ }

  return {
    text: [
      `界面 ${pr.w}×${pr.h}，指纹 ${fp.hash}（新界面，已缓存）`,
      `边缘密度 ${(pr.edgeDensity * 100).toFixed(1)}%　颜色 top5 ${(pr.colorTop5 * 100).toFixed(0)}%　色数 ${pr.colorCount}　对比 ${pr.contrast}`,
      '',
      '推荐的识别方法（按性价比）：',
      ...methods.map((m, i) => `  ${i + 1}. ${m.tool}\n     ${m.why}`),
      '',
      '要点按优先用 vdisplay_tap_text（有文字）或 vdisplay_tap_image（有图标）。',
    ].join('\n'),
    methods, cached: false, fingerprint: fp.hash,
  };
}


/**
 * 条件等待 —— 替代所有「固定等 2 秒再截图」。
 *
 * ## 为什么这是最高价值的一个
 *
 * 现在每个操作之后都是固定 sleep，然后截图。实测：
 *   - 固定等 2 秒 + OCR 2-3 秒 = 每步 4-5 秒
 *   - 门控等待（7ms 指纹先看变没变，变了才 OCR）= 多数 150-400ms
 *
 * `cheapFirst` 是核心：先用 7ms 的 dHash 判断画面变没变，
 * **只有真变了才跑 OCR**。等待类操作的绝大多数时间都省在这里。
 *
 * ## 支持的判据
 *
 *   text_appears   —— 出现某段文字（OCR，慢但准）
 *   text_gone      —— 某段文字消失
 *   fingerprint_is —— 指纹等于某值（7ms，最快）
 *   fingerprint_changes —— 指纹和开始时不同（7ms）
 *   diff_gt        —— 画面变化超过阈值（2.3ms）
 *   color_present  —— 出现某个颜色（6.8ms）
 *   stable         —— 连续 N 次画面不变（转场结束）
 */
export async function waitFor(args) {
  const until = String(args?.until || '').trim();
  const timeoutMs = Math.min(30000, Math.max(200, Number(args?.timeoutMs) || 8000));
  const pollMs = Math.min(2000, Math.max(50, Number(args?.pollMs) || 150));
  const cheapFirst = args?.cheapFirst !== false;
  const text = String(args?.text || '');
  const t0 = Date.now();

  const st = vd.getActive();
  if (!st || !st.displayId) return { text: '虚拟屏没在运行。先 vdisplay_start。' };

  const V = await import('./vision.js');
  const grab = async () => {
    const g = await grabFullPng();
    if (!g.ok) return null;
    return g.path;
  };

  // 基线指纹
  let baseHash = null;
  const p0 = await grab();
  if (p0) baseHash = (await V.dhash(p0)).hash;

  const targetHash = String(args?.hash || '') || null;
  let stableCount = 0;
  let lastHash = null;
  let polls = 0;
  let ocrRuns = 0;

  while (Date.now() - t0 < timeoutMs) {
    polls += 1;
    const path = await grab();
    if (!path) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
    const h = (await V.dhash(path)).hash;

    // ── 便宜判据，先用 ──
    if (until === 'fingerprint_is' && targetHash) {
      if (h === targetHash) return ok('指纹已匹配');
    } else if (until === 'fingerprint_changes') {
      if (baseHash && h !== baseHash) return ok('画面已变化（指纹变了）');
    } else if (until === 'stable') {
      if (h === lastHash) { stableCount += 1; } else { stableCount = 0; lastHash = h; }
      if (stableCount >= (Number(args?.stableTimes) || 2)) return ok('画面已稳定');
    } else if (until === 'diff_gt') {
      const d = await V.diff(path, path);   // 占位，下面用 baseHash 判
      if (baseHash && h !== baseHash) {
        const d2 = await V.diff(p0, path);
        if (d2.ok && (d2.maxCell >= (Number(args?.threshold) || 0.15))) return ok(`变化 ${d2.maxCell} 超过阈值`);
      }
    } else if (until === 'color_present') {
      const c = await V.color(path, args?.color || { r: 255, g: 0, b: 0 }, {
        tolerance: Number(args?.tolerance) || 30,
        minArea: Number(args?.minArea) || 300,
        region: args?.region || null,
      });
      if (c.ok && c.count > 0) return ok(`找到 ${c.count} 个该颜色色块`);
    } else if (until === 'text_appears' || until === 'text_gone') {
      // **cheapFirst：画面没变就不跑 OCR**
      // 这是省时间的关键 —— 等待期间画面多数时候是静止的。
      const changed = baseHash && h !== baseHash;
      if (cheapFirst && !changed && polls > 2) {
        await new Promise((r) => setTimeout(r, pollMs));
        continue;
      }
      const ocr = await import('./ocr.js');
      const rr = await ocr.recognize(path, { minConf: 0.4, maxLines: 200, hash: h });
      if (!rr.ok) { await new Promise((r) => setTimeout(r, pollMs)); continue; }
      ocrRuns += 1;
      const hit = rr.lines.some((l) => String(l.text || '').includes(text));
      if (until === 'text_appears' && hit) return ok(`「${text}」已出现`);
      if (until === 'text_gone' && !hit && text) return ok(`「${text}」已消失`);
      if (hit) baseHash = h;    // 已出现但等它消失时，把基线滑过去
    } else {
      return { text: `不认识的 until「${until}」。可用：text_appears / text_gone / fingerprint_is / fingerprint_changes / diff_gt / color_present / stable` };
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  return {
    text: `⏱ ${Math.round((Date.now() - t0) / 1000)} 秒内没等到「${until}」`
      + (text ? `（${text}）` : '')
      + `\n轮询 ${polls} 次，跑了 ${ocrRuns} 次 OCR`
      + (cheapFirst ? '（cheapFirst 生效：画面没变就跳过 OCR）' : '')
      + '\n可以：① 加长 timeoutMs ② 换判据 ③ 直接截图看看现在是什么',
    ok: false, elapsedMs: Date.now() - t0, polls, ocrRuns,
  };

  function ok(why) {
    return {
      text: `✅ ${why}（等了 ${Date.now() - t0}ms，轮询 ${polls} 次`
        + (ocrRuns ? `，OCR ${ocrRuns} 次` : '，没跑 OCR') + '）',
      ok: true, elapsedMs: Date.now() - t0, polls, ocrRuns,
    };
  }
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
    // **必须给 text**：out() 的 schema 里 text 是 required，
    // 少了模型拿到空结果（同文件其他分支都写了，这两处漏了 —— 审查 S13）。
    return { text: `常驻解码器已停止${r?.hint ? '：' + r.hint : '。'}`, ok: true, ...r };
  }
  const s = await vd.videoStats();
  const ready = Boolean(s.headerDone && !s.headerError);
  return {
    text: ready
      ? `解码器 ${s.decoder ? '在跑' : '未启动'}；流 ${s.width}x${s.height}，${s.frames} 帧，${s.fps || 0} fps；`
        + `${s.hasKeyframe ? '已收到关键帧' : '还没关键帧（画面静止时不发帧，正常）'}。`
      : '视频流还没接上（先 vdisplay_start 建屏）。',
    ok: ready,
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
