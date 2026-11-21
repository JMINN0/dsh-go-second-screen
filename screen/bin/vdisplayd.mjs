#!/usr/bin/env node
/**
 * vdisplayd —— 虚拟屏守护进程。
 *
 * 为什么必须有它：虚拟屏跟"建它的那个进程"同生共死（scrcpy server 一断，
 * DisplayManager 就把屏销毁）。CLI 每次调用都是新进程，进程一退屏就没了，
 * 所以 `vdisplay shot` 这种一次性命令根本没法工作。
 *
 * 做法：常驻一个进程，把屏握在手里，CLI 通过回环 HTTP 发命令进来。
 * 这套东西不依赖 DSH，任何 agent（Claude Code / opencode / Codex）用 bash
 * 调 CLI 就能用。
 *
 * 发现机制：把 {pid, port} 写到 $DSH_HOME/plugin-screen/cli-daemon.json，
 * CLI 读这个文件找到守护进程。
 */


import('./../src/stream.js').then(m => m.reconcileStreamState()).catch(() => {});
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, unlink, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import * as vd from '../src/vd.js';

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');
const STATE_DIR = join(DSH_HOME, 'plugin-screen');
const STATE_FILE = join(STATE_DIR, 'cli-daemon.json');

// 没屏、也没人调命令时，闲置这么久就自己退掉，不留垃圾进程
const IDLE_EXIT_MS = 10 * 60 * 1000;

let lastActive = Date.now();
let server = null;

async function writeState(port) {
  await mkdir(STATE_DIR, { recursive: true });
  // 原子写：先写临时文件再 rename。直接 writeFile 会留一个"读得到半截 JSON"的窗口，
  // CLI 那边解析失败会当成"没守护进程"而再拉一个 —— 冷启动并发时会雪崩。
  const tmp = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ pid: process.pid, port, startedAt: Date.now() }, null, 2));
  await rename(tmp, STATE_FILE);
}

/**
 * 清状态文件。**只删自己写的那一份**。
 *
 * 不加这个校验的话，两个实例并存时（冷启动竞态真的会发生），
 * 先退出的那个会把另一个的 state 删掉，对方就变成"活着但隐身"的幽灵进程。
 */
async function clearState() {
  try {
    const cur = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (cur?.pid && cur.pid !== process.pid) return;   // 不是自己的，别动
  } catch { /* 文件不存在或读不了，那就删 */ }
  try { await unlink(STATE_FILE); } catch { /* 没有就算了 */ }
}

/** 命令分发。每个 action 都是 vd.js 里的一个函数。 */
let mutexTail = Promise.resolve();   // 全局互斥链，串行化有副作用的命令

const ACTIONS = {
  async start(args) {
    const r = await vd.start({
      width: Number(args?.width) || 0,        // 0 = 自动按物理屏比例
      height: Number(args?.height) || 0,
      dpi: Number(args?.dpi) || 320,
      systemDecorations: args?.systemDecorations === true,
      orientation: args?.orientation,
      hwc: args?.hwc || 'auto',
    });
    return r;
  },
  async stop(args) {
    return vd.stop({ forceStopApps: args?.forceStopApps === true });
  },
  async status() {
    return vd.status();
  },
  async launch(args) {
    const pkg = String(args?.pkg || '').trim();
    if (!/^[a-z][\w.]*$/i.test(pkg)) return { hint: 'pkg 看起来不是合法包名。' };
    return vd.launch(pkg, args?.activity ? String(args.activity).trim() : '');
  },
  async shot(args) {
    const region = args?.region && typeof args.region === 'object' ? args.region : null;
    const frames = Number(args?.frames) || 0;

    // frames > 1 走九格连拍（自适应采样）。以前 daemon 只有单帧，导致命令行用不了这个能力。
    if (frames > 1) {
      const st = await vd.status();
      if (!st.running) return { ok: false, hint: '虚拟屏没在运行，先 start。' };
      const tl = await import('../src/timeline.js');
      return tl.capture({
        sfId: st.sfId,
        frames,
        intervalMs: Number(args?.intervalMs) || 300,
        cellWidth: Number(args?.width) || 262,
        dir: args?.dir || '/tmp',
        crop: 'none',
      });
    }

    return vd.shot(args?.dir || '/tmp', {
      width: Math.min(Math.max(Number(args?.width) || 540, 240), 1080),
      format: args?.format === 'png' ? 'png' : 'jpeg',
      cropPx: 0,
      region,
    });
  },
  async mainShot(args) {
    return vd.mainShot(args?.dir || '/tmp');
  },
  /**
   * 读屏文字。这里加一份是为了 CLI 和 HTTP 也能用 OCR，
   * 顺便让"OCR 到底通不通"可以用真实入口验证 —— 只测模块不算。
   */
  async text(args) {
    const st = await vd.status();
    if (!st.running) return { ok: false, hint: '虚拟屏没在运行，先 start。' };
    const shot = await vd.shot(args?.dir || '/tmp', {
      width: Math.min(1080, Math.max(360, st.width || 720)),
      format: 'png',
    });
    if (!shot.ok) return { ok: false, hint: shot.hint };
    const ocr = await import('../src/ocr.js');
    const r = await ocr.recognize(shot.path, {
      minConf: args?.minConf === undefined ? 0.45 : Number(args.minConf),
      maxLines: Number(args?.maxLines) || 80,
      hash: args?.fresh === true ? null : shot.hash,
    });
    if (!r.ok) return { ok: false, hint: r.hint };
    return { ok: true, ...r, imageWidth: shot.imageWidth || st.width, imageHeight: shot.imageHeight || st.height, path: shot.path };
  },

  /* ===== 多屏池（pool.js） ===== */
  async poolCreate(args) {
    const pool = await import('../src/pool.js');
    return pool.create(args || {});
  },
  async poolList() {
    const pool = await import('../src/pool.js');
    return pool.list();
  },
  async poolUse(args) {
    const pool = await import('../src/pool.js');
    return pool.use(String(args?.screenId || ''));
  },
  async poolDestroy(args) {
    const pool = await import('../src/pool.js');
    return pool.destroy(String(args?.screenId || ''), args || {});
  },
  /* ===== 租约 ===== */
  async claimApp(args) {
    const lease = await import('../src/lease.js');
    const pool = await import('../src/pool.js');
    const info = pool.info();
    if (!info.active) return { ok: false, code: 'E_NO_SCREEN', hint: '还没有活动屏，先 poolCreate' };
    return lease.claim({
      pkg: String(args?.pkg || ''),
      screenId: args?.screenId ? String(args.screenId) : info.active,
      owner: String(args?.owner || 'unknown'),
      mode: args?.mode, priority: args?.priority,
      preemptible: args?.preemptible,
      nonPreemptibleReason: args?.nonPreemptibleReason,
      onConflict: args?.onConflict || 'fail',
      ttlMs: args?.ttlSec ? Number(args.ttlSec) * 1000 : undefined,
    });
  },
  async releaseApp(args) {
    const lease = await import('../src/lease.js');
    if (args?.leaseId) return lease.release(String(args.leaseId));
    return lease.releaseAll(String(args?.owner || 'unknown'));
  },
  async leasesList() {
    const lease = await import('../src/lease.js');
    return lease.list();
  },

  async checkApp(args) {
    // 占用检测：主屏谁在用、自家屏上有没有、有没有外来屏
    const occ = await import('../src/occupancy.js');
    const pool = await import('../src/pool.js');
    const info = pool.info();
    const ourScreens = new Map(info.screens.map((s) => [Number(s.displayId), s.screenId]));
    return occ.checkApp(String(args?.pkg || ''), { ourScreens });
  },

  async poolInfo() {
    const pool = await import('../src/pool.js');
    return pool.info();
  },

  async apps() {
    // 投屏前查包名。之前没有任何工具能给包名，模型只能猜。
    const r = await vd.adb(['shell', 'pm list packages -3 2>/dev/null']);
    if (!r.ok) return { ok: false, hint: r.err || 'adb 不可用' };
    const pkgs = String(r.out || '').split('\n')
      .map((x) => x.trim().replace(/^package:/, '')).filter(Boolean).sort();
    return { ok: true, count: pkgs.length, packages: pkgs };
  },

  async focusedApp() {
    return { app: await vd.focusedApp() };
  },
  async mainFocus() {
    return { app: await vd.mainFocus() };
  },
  async input(args) {
    const kind = String(args?.kind || '');
    if (!['tap', 'swipe', 'hold', 'text', 'key', 'paste'].includes(kind)) {
      return { hint: `不认识的输入类型「${kind}」。可选：tap / swipe / hold / text / key / paste` };
    }
    return vd.input(kind, args);
  },
};

function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

async function handle(req, res) {
  lastActive = Date.now();

  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true, pid: process.pid });
  }
  if (req.method !== 'POST' || req.url !== '/cmd') {
    return send(res, 404, { error: 'not found' });
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw || '{}'); } catch { return send(res, 400, { error: 'body 不是合法 JSON' }); }

  const fn = ACTIONS[payload.action];
  if (!fn) {
    return send(res, 400, { error: `不认识的 action「${payload.action}」`, available: Object.keys(ACTIONS) });
  }

  /*
   * **有副作用的命令必须串行。**
   *
   * 为什么：vd.js 的 state 是模块级单例，而 start() 从「判空」到「写 displayId」
   * 中间有好几段 await（推 jar、spawn server、等 socket）。两个 MCP 客户端同时
   * 发 start，两边都看到 displayId 为空，就会各建一块屏 —— 而设备上有多块 scrcpy
   * 屏时 resolveScrcpySfId() 会分不清，之后所有截图都报歧义。
   *
   * 只读命令（status/focusedApp/mainFocus）不加锁，保持并发。
   */
  const MUTATING = new Set(['start', 'stop', 'launch', 'input', 'shot', 'mainShot', 'text',
  // 池操作会切换全局活动上下文，必须串行，否则两个请求会互相切走
  'poolCreate', 'poolUse', 'poolDestroy',
  // 租约也改全局状态（可能撤销别人的），必须串行
  'claimApp', 'releaseApp']);
  const run = async () => {
    try {
      const out = await fn(payload.args || {});
      return send(res, 200, { ok: true, result: out });
    } catch (e) {
      return send(res, 500, { ok: false, error: e?.message || String(e) });
    }
  };

  if (!MUTATING.has(payload.action)) return run();

  // single-flight：一把全局锁，后来的排队
  const prev = mutexTail;
  let release;
  mutexTail = new Promise((r) => { release = r; });
  try {
    await prev;
    return await run();
  } finally {
    release();
  }
}

async function shutdown(reason) {
  try { await vd.stop({ forceStopApps: false }); } catch { /* 尽力而为 */ }
  // vd.stop() 正常会恢复 HWC，但它可能因为 adb 不通而失败；
  // 这里同步再兜一次，保证全局属性不留残。
  try { vd.restoreHwcSync(); } catch { /* ignore */ }
  await clearState();
  if (server) { try { server.close(); } catch { /* ignore */ } }
  process.exit(0);
}

function startIdleWatch() {
  setInterval(async () => {
    const idle = Date.now() - lastActive;
    if (idle < IDLE_EXIT_MS) return;
    // 屏还开着就别退——用户可能正等着用
    const st = await vd.status().catch(() => null);
    if (st?.running) return;
    await shutdown('idle');
  }, 30_000).unref?.();

    /* 每 5 秒把当前 App 的风控等级同步给浮窗。
     *
     * 浮窗每 3 秒重读那个文件并重绘，但文件原来只在 input() 时才写 ——
     * 用户在那块屏上切了 App 又没点屏幕，底部 L 等级就一直停在旧值。
     * 等级是用来判断「这一步能不能这么操作」的，过期值比不显示更糟。
     *
     * 5 秒是权衡：一次 dumpsys 约 250ms，太快会拖 CPU；
     * 人切换 App 再看浮窗，5 秒滞后可以接受。没屏在跑就跳过，不空转。
     */
    setInterval(async () => {
      try {
        const st = await vd.status().catch(() => null);
        if (!st?.running) return;
        await vd.syncRiskLevel();
      } catch { /* 同步失败不影响守护进程 */ }
    }, 5_000).unref?.();
}

/**
 * 启动时对账：清理上一次运行留下的残留。
 *
 * 为什么需要：守护进程被 SIGKILL 或被系统 OOM 杀掉时，`process.on('exit')`
 * **不会执行**，于是 `debug.sf.enable_hwc_vds` 会留在 1 —— 那是全局 SurfaceFlinger
 * 属性，整台设备的合成策略都被改变，直到手机重启才恢复。实测确认过这个残留。
 *
 * 判据：属性是 1，但设备上**已经没有任何 scrcpy 虚拟屏** → 说明是上次没清掉的，
 * 不是正在使用中的。这个判据不会误杀"用户自己开着 HWC"的情况，因为那种情况下
 * 属性是 1 且通常也没有我们的虚拟屏……所以只有在我们自己写过状态文件时才做。
 */
async function reconcileLeftovers() {
  try {
    const hwc = String(await vd.shell('getprop debug.sf.enable_hwc_vds')).trim();
    if (hwc !== '1') return;

    const n = String(await vd.shell(
      'dumpsys display 2>/dev/null | grep -c \'DisplayDeviceInfo{"scrcpy"\'',
    )).trim();
    if (Number(n) > 0) return;   // 还有虚拟屏在用，别动

    await vd.shell('setprop debug.sf.enable_hwc_vds 0');
    console.error('[vdisplayd] 对账：清掉了上次异常退出残留的 debug.sf.enable_hwc_vds=1');
  } catch { /* 对账失败不能拖垮启动 */ }
}

async function main() {
  // 已有实例就直接报错退出，避免两个守护进程抢同一台设备的虚拟屏
  try {
    const old = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (old?.pid && old.pid !== process.pid) {
      try {
        process.kill(old.pid, 0);
        console.error(`[vdisplayd] 已经有守护进程在跑（pid ${old.pid}, port ${old.port}），不重复启动。`);
        process.exit(0);
      } catch { /* 旧进程已经死了，继续 */ }
    }
  } catch { /* 没有状态文件，正常 */ }

  await reconcileLeftovers();

  server = createServer((req, res) => {
    handle(req, res).catch((e) => send(res, 500, { error: e?.message || String(e) }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  await writeState(port);
  console.log(`[vdisplayd] listening on 127.0.0.1:${port} (pid ${process.pid})`);

  startIdleWatch();

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => { shutdown(sig).catch(() => process.exit(0)); });
  }

  // 最后一道保险：不管从哪条路退出，都同步把 HWC 属性恢复原值。
  // 这个属性是全局的 —— 留着 1 会一直影响整台设备的合成策略，直到重启手机。
  // 注意 SIGKILL 抓不到，那种情况下只能靠下次 vd.start() 重新对账。
  process.on('exit', () => {
    try { vd.restoreHwcSync(); } catch { /* 退出中，尽力而为 */ }
  });
  process.on('uncaughtException', (e) => {
    console.error('[vdisplayd] uncaught:', e?.message || e);
  });
}

main().catch(async (e) => {
  console.error('[vdisplayd] 启动失败:', e?.message || e);
  await clearState();
  process.exit(1);
});
