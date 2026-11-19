/**
 * vision.js —— 常驻 OpenCV 助手的 Node 侧封装。
 *
 * ## 为什么常驻
 *
 * 实测（tests/CV-BENCHMARK-ARM.md）：`import cv2` 冷启 328ms。
 * 每次起新进程的话，模板匹配从 5.7ms 变成 334ms（慢 58 倍）。
 *
 * 协议复用 ocr.js 那套已验证的：stdin/stdout 每行一个 JSON，
 * 请求带 id，响应按 id 配对。
 *
 * ## 支持的操作（都是实测过的）
 *
 * | op | 用途 | 温态耗时 |
 * |---|---|---|
 * | dhash | 界面指纹，判断「是不是同一屏」 | 7ms |
 * | diff | 两张图差异（MAD + maxCell） | 2.3ms |
 * | match | 模板匹配（自动金字塔 + 低方差回退） | 5-30ms |
 * | color | 颜色阈值 + 连通域 | 6.8ms |
 * | edges | 边缘密度 | 0.7ms |
 * | probe | 一次拿多个统计量，供方法选择打分 | ~20ms |
 */
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELPER = join(__dirname, 'vision_helper.py');
const TIMEOUT_MS = 15000;

const state = {
  child: null,
  ready: false,
  error: null,
  nextId: 1,
  pending: new Map(),
  buf: '',
  started: false,
};

/** 起助手进程（幂等）。 */
function spawnHelper() {
  if (state.child) return true;
  if (state.started) return false;
  state.started = true;
  // **每次 spawn 前清残留。**
  // S7：上一次 helper 写了一半 JSON 就被杀，残留半行会和新进程的 ready 行拼在一起，
  // JSON.parse 失败 → ready 永远 false → 每次调用等 10 秒超时，而进程是活的所以不重建。
  // S6：error 状态不复位的话，"装好 python3 也要重载插件才恢复"。
  state.buf = '';
  state.error = null;
  state.ready = false;
  try {
    if (!existsSync(HELPER)) { state.error = '缺 vision_helper.py'; state.started = false; return false; }
    const child = spawn('python3', [HELPER], { stdio: ['pipe', 'pipe', 'pipe'] });
    state.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      state.buf += chunk;
      let nl;
      while ((nl = state.buf.indexOf('\n')) >= 0) {
        const line = state.buf.slice(0, nl).trim();
        state.buf = state.buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        // 第一条是就绪消息
        if (msg.ready !== undefined && msg.id === undefined) {
          state.ready = !!msg.ready;
          state.error = msg.ready ? null : (msg.error || '未知错误');
          continue;
        }
        const p = state.pending.get(msg.id);
        if (p) {
          clearTimeout(p.timer);
          state.pending.delete(msg.id);
          p.resolve(msg);
        }
      }
    });
    child.stderr.on('data', () => { /* 助手不写 stderr，忽略 */ });
    child.on('exit', () => {
      state.child = null;
      state.ready = false;
      state.started = false;
      state.buf = '';   // 进程没了，残留的半个 JSON 必须丢掉
      for (const [, p] of state.pending) { clearTimeout(p.timer); p.resolve({ ok: false, hint: 'vision 助手退出了' }); }
      state.pending.clear();
    });
    // **S6：error 时要把 started 复位。**
    // ENOENT 时 Node 可能只发 error 不发 exit，started 会永远 true →
    // spawnHelper 直接 return false，之后每次都报同一句"起不来"，
    // 装好 python3 也得重载插件才恢复（ocr.js 是对的，vision 退步了）。
    child.on('error', (e) => {
      state.error = String(e?.message || e);
      state.child = null;
      state.ready = false;
      state.started = false;
      for (const [, p] of state.pending) {
        clearTimeout(p.timer);
        p.resolve({ ok: false, hint: 'vision 助手启动失败：' + state.error });
      }
      state.pending.clear();
    });
    return true;
  } catch (e) {
    state.error = String(e?.message || e);
    return false;
  }
}

/** 等就绪（最多 10 秒）。 */
function waitReady(timeout = 10000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (state.ready) return resolve(true);
      if (state.error) return resolve(false);
      if (Date.now() - t0 > timeout) return resolve(false);
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * 发一个请求给助手。
 * @param {string} op 操作名
 * @param {object} params 参数
 */
export async function call(op, params = {}) {
  if (!spawnHelper()) {
    return { ok: false, hint: `OpenCV 助手起不来：${state.error || '未知'}（装一下 pip install opencv-python-headless）` };
  }
  const ready = await waitReady();
  if (!ready) {
    return { ok: false, hint: state.error ? `OpenCV 不可用：${state.error}` : 'OpenCV 助手启动超时' };
  }
  const id = state.nextId++;
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      state.pending.delete(id);
      resolve({ ok: false, hint: `vision 操作超时（${TIMEOUT_MS}ms）` });
    }, TIMEOUT_MS);
    state.pending.set(id, { resolve, timer });
    try {
      state.child.stdin.write(JSON.stringify({ id, op, ...params }) + '\n');
    } catch (e) {
      clearTimeout(timer);
      state.pending.delete(id);
      resolve({ ok: false, hint: `写不进助手：${String(e?.message || e)}` });
    }
  });
}

/** 界面指纹（64 位 dHash）。 */
export const dhash = (image) => call('dhash', { image });

/** 两张图差异。 */
export const diff = (image, image2) => call('diff', { image, image2 });

/** 模板匹配。 */
export const match = (image, template, opts = {}) => call('match', { image, template, ...opts });

/** 颜色阈值 + 连通域。 */
export const color = (image, target, opts = {}) => call('color', { image, target, ...opts });

/** 边缘密度。 */
export const edges = (image, opts = {}) => call('edges', { image, ...opts });

/** 一次拿多个统计量（方法选择用）。 */
export const probe = (image) => call('probe', { image });

/** 状态。 */
export function info() {
  return { ready: state.ready, running: !!state.child, error: state.error };
}

/** 收工。 */
export function shutdown() {
  // **先 flush pending 再杀**，否则正在等的调用会一直挂到 15 秒超时。
  for (const [, p] of state.pending) {
    clearTimeout(p.timer);
    p.resolve({ ok: false, hint: 'vision 助手已关闭' });
  }
  state.pending.clear();
  try { state.child?.kill('SIGKILL'); } catch { /* ignore */ }
  state.child = null;
  state.ready = false;
  state.started = false;
  state.buf = '';
}
