/**
 * index.js — 插件入口，只做注册。
 *
 * 六个工具：screen_modes / vdisplay_start / vdisplay_launch / vdisplay_input /
 *          vdisplay_shot / screen_shot_main / vdisplay_status / vdisplay_stop
 *
 * defineTool 要五级回退：插件装在 profile 的 node_modules 下，那里没有 dsh-tools，
 * 引擎自带的那份在 /opt/dsh/node_modules。只写裸包名会让 apply 直接失败。
 */
import {
  inputSpec, launchSpec, mainShotSpec, modesSpec, riskCheckSpec, shotSpec, startSpec, statusSpec,
  stopSpec, userStateSpec,
  streamStartSpec, streamStopSpec, textSpec, appsSpec,
  poolSpec, newScreenSpec, useScreenSpec, closeScreenSpec, checkAppSpec,
  claimAppSpec, releaseAppSpec, leasesSpec,
  // 感知层（2026-11-16）：常驻解码、实时帧、等稳定、自动 ROI、黑屏探针
  liveSpec, liveShotSpec, waitStableSpec, roiSpec, probeSecureSpec,
  // 按文字找/点（2026-11-19）：消掉模型自己算坐标的 17.6% 点空率
  findTextSpec, tapTextSpec, keepAliveSpec,
  findImageSpec, tapImageSpec, fingerprintSpec, screenDiffSpec, probeScreenSpec,
} from './tool-spec.js';
import * as T from './tools.js';

export const name = 'dsh-go-plugin-screen';
export const inject = ['tools'];

async function loadDefineTool() {
  const tryImport = async (spec) => {
    const mod = await import(spec);
    return mod?.defineTool ? mod.defineTool : null;
  };
  try { const d = await tryImport('@deepseek-ai/dsh-tools'); if (d) return d; } catch {}
  const override = process.env.DSH_TOOLS_PATH;
  if (override) {
    try {
      const { pathToFileURL } = await import('node:url');
      const d = await tryImport(pathToFileURL(override).href);
      if (d) return d;
    } catch {}
  }
  const { existsSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  for (const root of [process.env.DSH_ROOT, '/opt/dsh', '/usr/local/lib/dsh', '/app'].filter(Boolean)) {
    const entry = `${root}/node_modules/@deepseek-ai/dsh-tools/lib/index.js`;
    if (!existsSync(entry)) continue;
    try { const d = await tryImport(pathToFileURL(entry).href); if (d) return d; } catch {}
  }
  for (const seed of [process.argv?.[1], process.cwd()].filter(Boolean)) {
    let dir = dirname(seed);
    for (let i = 0; i < 8; i += 1) {
      const entry = join(dir, 'node_modules/@deepseek-ai/dsh-tools/lib/index.js');
      if (existsSync(entry)) {
        try { const d = await tryImport(pathToFileURL(entry).href); if (d) return d; } catch {}
      }
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  throw new Error('cannot resolve @deepseek-ai/dsh-tools');
}

export async function apply(ctx) {
  // 启动时修一次假状态（见 stream.js 的 reconcileStreamState）
  import('./stream.js').then(m => m.reconcileStreamState?.()).catch(() => {});
  // **启动空闲看门狗**：AI 不调工具就自动放掉虚拟屏和推流（省电）。
  // 实测不关的话 framesrv 持续 10.3% CPU —— 悬浮窗连着 MJPEG，
  // framesrv 就以为「有人在看」，一直编码。
  try { T.startIdleWatchdog(); } catch { /* ignore */ }
  // Cordis 规定：没通过 ctx.inject 声明依赖之前，**碰 ctx 的任何属性都会抛**
  // （"cannot get property X without inject"）。所以所有 ctx 访问都放进 inject 回调里。
  // 这个坑让三个插件在真实引擎里全部加载失败过，工具一个都没出现。
  const disposers = [];
  try {
    ctx.inject(['tools'], (c) => {
      loadDefineTool()
        .then((defineTool) => {
          const defs = [
            [modesSpec, () => T.modes()],
            [startSpec, (a) => T.start(a)],
            [launchSpec, (a) => T.launch(a)],
            [inputSpec, (a) => T.input(a)],
            [shotSpec, (a) => T.shot(a)],
            [textSpec, (a) => T.text(a)],
            [appsSpec, () => T.apps()],
            [poolSpec, () => T.poolInfo()],
            [newScreenSpec, (a) => T.newScreen(a)],
            [useScreenSpec, (a) => T.useScreen(a)],
            [closeScreenSpec, (a) => T.closeScreen(a)],
            [checkAppSpec, (a) => T.checkApp(a)],
            [claimAppSpec, (a) => T.claimApp(a)],
            [releaseAppSpec, (a) => T.releaseApp(a)],
            [leasesSpec, () => T.leases()],
            [mainShotSpec, (a) => T.mainShot(a)],
            [statusSpec, () => T.status()],
            [stopSpec, (a) => T.stop(a)],   // 以前写成 () => T.stop()，把 args 丢了，forceStopApps 永远无效
            [streamStartSpec, (a) => T.streamStart(a)],
            [streamStopSpec, () => T.streamStop()],
            // 感知层（2026-11-16）：常驻解码、实时帧、等稳定、自动 ROI、黑屏探针
            [liveSpec, (a) => T.live(a)],
            [liveShotSpec, (a) => T.liveShot(a)],
            [waitStableSpec, (a) => T.waitStable(a)],
            [roiSpec, (a) => T.roi(a)],
            [probeSecureSpec, (a) => T.probeSecure(a)],
              // 安全闸门（2026-11-19 对抗审查发现）：这两个能力一直缺
              [userStateSpec, () => T.userState()],
              [riskCheckSpec, (a) => T.riskCheck(a?.pkg)],
              // 按文字找/点（2026-11-19）：消掉模型自己算坐标的 17.6% 点空率
              [findTextSpec, (a) => T.findText(a)],
              [tapTextSpec, (a) => T.tapText(a)],
              // 后台屏生命周期（2026-11-19）：让 AI 按任务预估空闲超时
              [keepAliveSpec, (a) => T.keepAlive(a)],
              // 视觉方法（2026-11-19）：模板/指纹/差分/探测，全部基于常驻 OpenCV
              [findImageSpec, (a) => T.findImage(a)],
              [tapImageSpec, (a) => T.tapImage(a)],
              [fingerprintSpec, (a) => T.fingerprint(a)],
              [screenDiffSpec, (a) => T.screenDiff(a)],
              [probeScreenSpec, (a) => T.probeScreen(a)],
          ];
          for (const [spec, exec] of defs) {
            try {
              // **每次工具调用都刷新空闲计时**，看门狗据此判断「AI 还在干活」。
              const wrapped = async (a) => {
                try { T.touchActivity(); } catch { /* ignore */ }
                return exec(a);
              };
              disposers.push(c.tools.register(defineTool({ ...spec(), execute: wrapped })));
            } catch (e) {
              console.error('[dsh-go-plugin-screen] register failed:', e?.message || e);
            }
          }
        })
        .catch((e) => console.error('[dsh-go-plugin-screen] apply failed, plugin disabled:', e?.message || e));
    });
  } catch (e) {
    console.error('[dsh-go-plugin-screen] inject failed:', e?.message || e);
  }
  return async () => {
    for (const d of disposers) { try { d?.(); } catch { /* 单个工具 dispose 失败不影响其他 */ } }
    // **卸载时把常驻子进程关掉。** 不关的话 OCR 的 python3 会变成孤儿，
    // 带着 15MB 模型一直占内存，重载一次多一个（对抗审查第三轮 S3）。
    try { const ocr = await import('./ocr.js'); ocr.shutdown(); } catch { /* 没加载过就算了 */ }
    try {
      const vd = await import('./vd.js');
      const st = await vd.status().catch(() => null);
      if (st?.running) await vd.stop({ forceStopApps: false }).catch(() => {});
    } catch { /* 清理失败不阻塞卸载 */ }
  };
}
