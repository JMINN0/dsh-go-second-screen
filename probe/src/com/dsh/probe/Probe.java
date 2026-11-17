package com.dsh.probe;

import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.Surface;

import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * ImageReader 镜像探针 —— 验证「能不能把一块屏的画面收进 ImageReader」。
 *
 * ## 为什么做这个
 *
 * screencap 143ms/帧，大头是 fork/exec + PNG 编码。
 * 如果能把屏镜像进 ImageReader，帧延迟能到 ~16.7ms（1 vsync）+ 拷贝。
 *
 * ## 判据（三条全过才算成功）
 *
 * 1. 不抛 SecurityException（说明有 CAPTURE_VIDEO_OUTPUT）
 * 2. 回调 ≥ 30 次/3 秒（≈ 源屏刷新率的一半以上）
 * 3. 首帧不是全黑（1024 点采样均值 > 5）
 *
 * ## 用法
 *
 * ```
 * CLASSPATH=/data/local/tmp/dshprobe/probe.dex app_process / com.dsh.probe.Probe --display=388 --ms=3000
 * CLASSPATH=... app_process / com.dsh.probe.Probe --display=0 --ms=3000     # 主屏对照
 * ```
 */
public class Probe {

    public static void main(String[] args) {
        int displayId = 0;
        int ms = 3000;
        for (String a : args) {
            if (a.startsWith("--display=")) displayId = Integer.parseInt(a.substring(10));
            if (a.startsWith("--ms=")) ms = Integer.parseInt(a.substring(5));
        }

        System.out.println("PROBE display=" + displayId + " ms=" + ms);

        // Looper 必须有：ImageReader 回调和 DisplayManager 都要
        Looper.prepareMainLooper();

        HandlerThread th = new HandlerThread("probe-th");
        th.start();
        Handler handler = new Handler(th.getLooper());

        ImageReader reader = null;
        VirtualDisplay vd = null;
        final AtomicInteger count = new AtomicInteger(0);
        final AtomicInteger firstMean = new AtomicInteger(-1);
        try {
            // 用真实尺寸（1592x720 常见的横屏；竖屏 720x1592 也行，镜像会自动适配）
            int W = 720, H = 1592;
            reader = ImageReader.newInstance(W, H, PixelFormat.RGBA_8888, 2);
            final long t0 = SystemClock.elapsedRealtime();

            reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
                @Override public void onImageAvailable(ImageReader r) {
                    Image img = null;
                    try {
                        img = r.acquireLatestImage();
                        if (img == null) return;
                        int n = count.incrementAndGet();
                        if (n == 1) {
                            // 首帧采样：32x32 网格的灰度均值，判断是不是全黑
                            ByteBuffer b = img.getPlanes()[0].getBuffer();
                            int stride = img.getPlanes()[0].getRowStride();
                            int w = img.getWidth(), h = img.getHeight();
                            long sum = 0; int cnt = 0;
                            for (int gy = 0; gy < 32; gy++) {
                                int py = gy * h / 32;
                                for (int gx = 0; gx < 32; gx++) {
                                    int px = gx * w / 32;
                                    int off = py * stride + px * 4;
                                    if (off + 2 < b.capacity()) {
                                        int rr = b.get(off) & 0xff;
                                        int gg = b.get(off + 1) & 0xff;
                                        int bb = b.get(off + 2) & 0xff;
                                        sum += (rr * 30 + gg * 59 + bb * 11) / 100;
                                        cnt++;
                                    }
                                }
                            }
                            if (cnt > 0) firstMean.set((int) (sum / cnt));
                        }
                        if (n % 30 == 0) {
                            System.out.println("FRAMES " + n + " elapsed=" + (SystemClock.elapsedRealtime() - t0) + "ms");
                        }
                    } catch (Throwable t) {
                        System.out.println("ERR_CB " + t);
                    } finally {
                        if (img != null) try { img.close(); } catch (Throwable t2) { }
                    }
                }
            }, handler);

            // **关键：反射调 @hide 的 createVirtualDisplay(name,w,h,displayIdToMirror,surface)**
            Surface surf = reader.getSurface();
            Method m = DisplayManager.class.getDeclaredMethod("createVirtualDisplay",
                    String.class, int.class, int.class, int.class, Surface.class);
            m.setAccessible(true);
            vd = (VirtualDisplay) m.invoke(null, "dsh-probe", W, H, displayId, surf);
            System.out.println("MIRROR_OK vd=" + (vd != null));
        } catch (Throwable t) {
            System.out.println("ERR_SETUP " + t.getClass().getSimpleName() + ": " + t.getMessage());
            Throwable c = t.getCause();
            if (c != null) System.out.println("ERR_CAUSE " + c.getClass().getSimpleName() + ": " + c.getMessage());
            System.exit(2);
        }

        // 等一段时间收数据
        try { Thread.sleep(ms); } catch (InterruptedException e) { }

        System.out.println("RESULT count=" + count.get() + " firstMean=" + firstMean.get());
        try { if (vd != null) vd.release(); } catch (Throwable t) { }
        try { if (reader != null) reader.close(); } catch (Throwable t) { }
        System.exit(0);
    }
}
