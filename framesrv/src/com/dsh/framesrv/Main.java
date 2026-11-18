package com.dsh.framesrv;

import android.graphics.Bitmap;
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

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.ByteBuffer;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * 常驻取帧服务 —— 用 ImageReader 镜像虚拟屏，自己当 HTTP 服务器。
 *
 * ## 为什么需要它
 *
 * `screencap` 每次 141ms 的 Surface 回读是不可优化的（实测：裸截图 141ms，PNG 再加 98ms）。
 * ImageReader 从合成器直接拿 buffer，实测能到 67fps。
 *
 * ## 架构
 *
 * ```
 * 虚拟屏（scrcpy 建的）
 *    ↓ 镜像
 * ImageReader（本进程，15ms/帧）
 *    ↓ HTTP（本进程自己 serve，不经 Node）
 * Overlay APK / 胶囊
 * ```
 *
 * 这样 Overlay 直接连这个服务，Node 只负责启动它和传端口。
 *
 * ## 用法
 *
 * ```
 * CLASSPATH=/data/local/tmp/dshframe/frame.dex app_process / com.dsh.framesrv.Main \
 *     --display=416 --port=38810 --width=400
 * ```
 *
 * 端点：
 *   /frame.jpg    当前帧（JPEG）
 *   /status       状态（running/frames/fps/aspect）
 *   /stream.mjpg  MJPEG 长连接
 *   /quit         退出
 */
public class Main {

    static final long createdAt = System.currentTimeMillis();
    static int displayId = 0;
    static int port = 38810;
    static int outWidth = 400;
    static int srcW = 720, srcH = 1592;

    static ImageReader reader;
    static VirtualDisplay vd;
    static volatile byte[] latest = null;
    // **缓存最后一帧的原始像素**，收到 /mark 时用它重编一张带标记的。
    // 为什么必须：画面静止时 ImageReader 不出新帧，`latest` 永远是标记之前那张，
    // 标记就永远不出现（实机踩到）。收到 /mark 要能自己主动重画一帧。
    static volatile android.graphics.Bitmap lastBmp = null;
    static final Object bmpLock = new Object();
    static final AtomicInteger frames = new AtomicInteger(0);
    static final AtomicInteger lastSecFrames = new AtomicInteger(0);
    static volatile int fps = 0;
    static final Set<Socket> mjpegClients = ConcurrentHashMap.newKeySet();

    // **看门狗：没人看的时候就别再编码了。**
    // 审计发现：原来不管有没有客户端，每帧都在 encode（53.7fps × ~19MB 垃圾/帧
    // = 1.04 GB/s），而且进程永不退出，一直烧 1.0 核。
    static volatile long lastFetchAt = 0;      // 上次有人取帧

    // **点击标记**：让用户看到 AI 点在哪、有没有点偏。
    // 之前标记只画在 stream.js 的 screencap 慢路径里，快路径（本服务）没画，
    // 所以用户看不到点击位置 —— 这是实机反馈的问题。
    static volatile float markNx = -1f, markNy = -1f;
    static volatile long markAt = 0;
    static volatile long lastCheckAt = 0;
    static final int IDLE_PAUSE_MS = 15_000;   // 15 秒没人取 → 暂停编码
    static final int IDLE_EXIT_MS = 120_000;   // 120 秒彻底没人 → 自己退出

    public static void main(String[] args) {
        for (String a : args) {
            if (a.startsWith("--display=")) displayId = Integer.parseInt(a.substring(10));
            if (a.startsWith("--port=")) port = Integer.parseInt(a.substring(7));
            if (a.startsWith("--width=")) outWidth = Integer.parseInt(a.substring(8));
            if (a.startsWith("--size=")) {
                String[] wh = a.substring(7).split("x");
                if (wh.length == 2) { srcW = Integer.parseInt(wh[0]); srcH = Integer.parseInt(wh[1]); }
            }
        }
        System.out.println("START display=" + displayId + " port=" + port + " size=" + srcW + "x" + srcH);

        Looper.prepareMainLooper();
        HandlerThread th = new HandlerThread("framesrv");
        th.start();
        Handler h = new Handler(th.getLooper());

        // 每秒算一次 fps + **空闲自杀**
        new Thread(new Runnable() {
            public void run() {
                while (true) {
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                    fps = lastSecFrames.getAndSet(0);
                    // **长时间没人看就自己退出。**
                    // 原来这个进程永不停止：app_process 一直活着，一直编码，
                    // 一直占 1.0 核，直到手机重启或 OOM。
                    long idle = System.currentTimeMillis() - Math.max(lastFetchAt, createdAt);
                    if (idle > IDLE_EXIT_MS && mjpegClients.isEmpty()) {   // 有长连接就不退
                        System.out.println("IDLE_EXIT idleMs=" + idle);
                        System.exit(0);
                    }
                }
            }
        }).start();

        // 建 ImageReader
        reader = ImageReader.newInstance(srcW, srcH, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
            public void onImageAvailable(ImageReader r) {
                Image img = null;
                try {
                    img = r.acquireLatestImage();
                    if (img == null) return;
                    frames.incrementAndGet();
                    lastSecFrames.incrementAndGet();
                    // **没人看就不编码** —— 只统计帧数，把 buffer 直接还回去。
                    // 这是审计里最大的一笔浪费：原来无条件编码，1.04 GB/s 的垃圾。
                    long nowMs = System.currentTimeMillis();
                    boolean watching = (nowMs - lastFetchAt) < IDLE_PAUSE_MS;
                    if (!watching && mjpegClients.isEmpty()) {
                        return;    // finally 会 close
                    }
                    byte[] jpg = encode(img);
                    if (jpg != null) {
                        latest = jpg;
                        for (Socket s : mjpegClients) {
                            try {
                                OutputStream o = s.getOutputStream();
                                o.write(("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: "
                                        + jpg.length + "\r\n\r\n").getBytes());
                                o.write(jpg);
                                o.write("\r\n".getBytes());
                                o.flush();
                            } catch (Throwable t) {
                                mjpegClients.remove(s);
                                try { s.close(); } catch (Throwable t2) { }
                            }
                        }
                    }
                } catch (Throwable t) {
                    System.out.println("ERR_CB " + t);
                } finally {
                    if (img != null) try { img.close(); } catch (Throwable t3) { }
                }
            }
        }, h);

        // 镜像目标屏
        try {
            Surface surf = reader.getSurface();
            Method m = DisplayManager.class.getDeclaredMethod("createVirtualDisplay",
                    String.class, int.class, int.class, int.class, Surface.class);
            m.setAccessible(true);
            vd = (VirtualDisplay) m.invoke(null, "dsh-frames", srcW, srcH, displayId, surf);
            System.out.println("MIRROR_OK " + (vd != null));
        } catch (Throwable t) {
            System.out.println("ERR_MIRROR " + t.getClass().getSimpleName() + ": " + t.getMessage());
            Throwable c = t.getCause();
            if (c != null) System.out.println("  cause: " + c);
            System.exit(2);
        }

        // ===== HTTP 服务器 =====
        try {
            final ServerSocket ss = new ServerSocket(port, 8, java.net.InetAddress.getByName("127.0.0.1"));
            System.out.println("HTTP_OK port=" + port);
            new Thread(new Runnable() {
                public void run() {
                    while (true) {
                        try {
                            final Socket s = ss.accept();
                            new Thread(new Runnable() { public void run() { handle(s); } }).start();
                        } catch (Throwable t) { return; }
                    }
                }
            }).start();
        } catch (Throwable t) {
            System.out.println("ERR_HTTP " + t);
            System.exit(3);
        }

        Looper.loop();
    }

    /** 把 Image 编码成 JPEG（缩到 outWidth）。 */
    static byte[] encode(Image img) {
        try {
            int w = img.getWidth(), h = img.getHeight();
            ByteBuffer buf = img.getPlanes()[0].getBuffer();
            int stride = img.getPlanes()[0].getRowStride();
            // 拷到紧凑 buffer（处理 stride 对齐）
            byte[] row = new byte[w * 4];
            ByteArrayOutputStream all = new ByteArrayOutputStream(w * h * 4);
            for (int y = 0; y < h; y++) {
                buf.position(y * stride);
                buf.get(row, 0, w * 4);
                all.write(row, 0, w * 4);
            }
            // **必须手动转 RGBA→ARGB 并强制 alpha=255。**
            // ImageReader 给的是 RGBA_8888（内存序 R,G,B,A），而 Bitmap 的
            // ARGB_8888 走 copyPixelsFromBuffer 时按 ARGB 解释 —— alpha 位拿到的是
            // blue 通道值，常常是 0 → 全透明 → JPEG 编码出来全黑。
            // 实测症状：159 帧全是亮度 1.0 的黑图。
            byte[] raw = all.toByteArray();
            int n = w * h;
            int[] argb = new int[n];
            for (int i = 0; i < n; i++) {
                int o = i * 4;
                int r = raw[o] & 0xff;
                int g = raw[o + 1] & 0xff;
                int b = raw[o + 2] & 0xff;
                argb[i] = (0xff << 24) | (r << 16) | (g << 8) | b;   // 强制不透明
            }
            Bitmap bm = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bm.setPixels(argb, 0, w, 0, 0, w, h);
            byte[] out = null;
            if (w > outWidth) {
                int nh = h * outWidth / w;
                Bitmap small = Bitmap.createScaledBitmap(bm, outWidth, nh, true);
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                small.compress(Bitmap.CompressFormat.JPEG, 70, o);
                out = o.toByteArray();
                small.recycle();
            } else {
                ByteArrayOutputStream o = new ByteArrayOutputStream();
                bm.compress(Bitmap.CompressFormat.JPEG, 70, o);
                out = o.toByteArray();
            }
            // **画点击十字**（5 秒内的标记）
            byte[] marked = out;
            try {
                long age = System.currentTimeMillis() - markAt;
                if (marked != null && markNx >= 0 && age < 5000) {
                    android.graphics.Bitmap target = null;
                    if (w > outWidth) {
                        // out 是缩放后的，重画一遍
                        int nh2 = h * outWidth / w;
                        target = android.graphics.Bitmap.createScaledBitmap(bm, outWidth, nh2, true);
                    }
                    if (target != null) {
                        android.graphics.Canvas cv = new android.graphics.Canvas(target);
                        android.graphics.Paint pt = new android.graphics.Paint();
                        pt.setAntiAlias(true);
                        float tw = target.getWidth(), th = target.getHeight();
                        float cx = markNx * tw, cy = markNy * th;
                        // 透明度：最新 1.0 → 2 秒后 0.45 常驻
                        int alpha = (age < 2000) ? 255 : 115;
                        float arm = Math.max(9f, tw * 0.028f);
                        float thick = Math.max(3f, tw * 0.008f);
                        // 白色描边（深色背景也看得见）
                        pt.setColor(0x80FFFFFF);
                        pt.setStyle(android.graphics.Paint.Style.STROKE);
                        pt.setStrokeWidth(thick + 2);
                        float boxR = Math.max(18f, tw * 0.055f);
                        cv.drawRect(cx - boxR, cy - boxR, cx + boxR, cy + boxR, pt);
                        // 红色十字
                        pt.setColor((alpha << 24) | 0xFF2D2D);
                        pt.setStyle(android.graphics.Paint.Style.FILL);
                        cv.drawRect(cx - arm, cy - thick, cx + arm, cy + thick, pt);
                        cv.drawRect(cx - thick, cy - arm, cx + thick, cy + arm, pt);
                        // 空心外框
                        pt.setStyle(android.graphics.Paint.Style.STROKE);
                        pt.setStrokeWidth(thick);
                        cv.drawRect(cx - boxR, cy - boxR, cx + boxR, cy + boxR, pt);
                        java.io.ByteArrayOutputStream o2 = new java.io.ByteArrayOutputStream();
                        target.compress(Bitmap.CompressFormat.JPEG, 70, o2);
                        marked = o2.toByteArray();
                        target.recycle();
                    }
                }
            } catch (Throwable t) { /* 画失败就用原图 */ }
            // **留一份 bmp 给 /mark 重画用**（不 recycle）
            synchronized (bmpLock) {
                if (lastBmp != null && lastBmp != bm) { try { lastBmp.recycle(); } catch (Throwable t) { } }
                lastBmp = bm;
            }
            return marked;
        } catch (Throwable t) {
            return null;
        }
    }

    /** 用缓存的最后一帧重编一张带标记的（/mark 时调）。 */
    static void reencodeWithMark() {
        try {
            android.graphics.Bitmap src;
            synchronized (bmpLock) { src = lastBmp; }
            if (src == null || src.isRecycled()) return;
            int ow = outWidth;
            int oh = src.getHeight() * ow / src.getWidth();
            android.graphics.Bitmap target = android.graphics.Bitmap.createScaledBitmap(src, ow, oh, true);
            android.graphics.Canvas cv = new android.graphics.Canvas(target);
            android.graphics.Paint pt = new android.graphics.Paint();
            pt.setAntiAlias(true);
            float tw = target.getWidth(), th = target.getHeight();
            float cx = markNx * tw, cy = markNy * th;
            float arm = Math.max(9f, tw * 0.028f);
            float thick = Math.max(3f, tw * 0.008f);
            float boxR = Math.max(18f, tw * 0.055f);
            pt.setColor(0x80FFFFFF);
            pt.setStyle(android.graphics.Paint.Style.STROKE);
            pt.setStrokeWidth(thick + 2);
            cv.drawRect(cx - boxR, cy - boxR, cx + boxR, cy + boxR, pt);
            pt.setColor(0xFFFF2D2D);
            pt.setStyle(android.graphics.Paint.Style.FILL);
            cv.drawRect(cx - arm, cy - thick, cx + arm, cy + thick, pt);
            cv.drawRect(cx - thick, cy - arm, cx + thick, cy + arm, pt);
            pt.setStyle(android.graphics.Paint.Style.STROKE);
            pt.setStrokeWidth(thick);
            cv.drawRect(cx - boxR, cy - boxR, cx + boxR, cy + boxR, pt);
            java.io.ByteArrayOutputStream o = new java.io.ByteArrayOutputStream();
            target.compress(Bitmap.CompressFormat.JPEG, 70, o);
            byte[] jpg = o.toByteArray();
            target.recycle();
            latest = jpg;
            // 推给所有 MJPEG 客户端
            for (Socket c2 : mjpegClients) {
                try {
                    OutputStream os = c2.getOutputStream();
                    os.write(("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + jpg.length + "\r\n\r\n").getBytes());
                    os.write(jpg); os.write("\r\n".getBytes()); os.flush();
                } catch (Throwable t) { mjpegClients.remove(c2); }
            }
        } catch (Throwable t) { /* 画失败就算了 */ }
    }

    static void handle(Socket s) {
        try {
            s.setSoTimeout(30000);
            InputStream in = s.getInputStream();
            // 读请求行
            StringBuilder sb = new StringBuilder();
            int c;
            while ((c = in.read()) >= 0 && c != '\n') { if (c != '\r') sb.append((char) c); }
            String line = sb.toString();
            String path = "/";
            if (line.contains(" ")) path = line.split(" ")[1];
            // 把 header 读完
            int nl = 0;
            while ((c = in.read()) >= 0) { if (c == '\n') { nl++; if (nl >= 2) break; } else if (c != '\r') nl = 0; }

            OutputStream out = s.getOutputStream();
            if (path.startsWith("/frame.jpg")) {
                lastFetchAt = System.currentTimeMillis();   // 有人在看
                byte[] j = latest;
                if (j == null) {
                    out.write("HTTP/1.1 503 No Frame\r\n\r\n".getBytes());
                } else {
                    out.write(("HTTP/1.1 200 OK\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + j.length + "\r\nCache-Control: no-store\r\n\r\n").getBytes());
                    out.write(j);
                }
                out.flush();
                s.close();
            } else if (path.startsWith("/status")) {
                // **running 必须反映「还在被看」的状态，不能写死 true。**
                // 写死的话悬浮窗永远认为推流活着，不会自动关；
                // 审计发现 README 承诺的「推流停了自己消失」因此失效。
                // **活跃 = 最近有人取帧，或者有 MJPEG 长连接挂着。**
                // 只算 lastFetchAt 是错的：悬浮窗用 MJPEG 长连接，只在连上时取一次，
                // 之后一直收推送。120 秒后 lastFetchAt 过期 → running 变 false
                // → 悬浮窗自己 stopSelf 退出（实机玩 MC 时踩到的）。
                boolean alive = !mjpegClients.isEmpty()
                        || (System.currentTimeMillis() - lastFetchAt) < IDLE_EXIT_MS;
                String j = "{\"running\":" + alive + ",\"frames\":" + frames.get()
                        + ",\"fps\":" + fps + ",\"width\":" + outWidth
                        + ",\"aspect\":" + ((double) srcW / srcH) + "}";
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + j.length() + "\r\nCache-Control: no-store\r\n\r\n" + j).getBytes());
                out.flush();
                s.close();
            } else if (path.startsWith("/stream.mjpg")) {
                lastFetchAt = System.currentTimeMillis();   // 长连接 = 有人在看
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=--dshframe\r\n"
                        + "Cache-Control: no-store\r\nConnection: keep-alive\r\n\r\n").getBytes());
                out.flush();
                mjpegClients.add(s);      // 不关，交给推送循环
                byte[] j = latest;
                if (j != null) {
                    out.write(("--dshframe\r\nContent-Type: image/jpeg\r\nContent-Length: "
                            + j.length + "\r\n\r\n").getBytes());
                    out.write(j); out.write("\r\n".getBytes()); out.flush();
                }
            } else if (path.startsWith("/mark")) {
                // /mark?nx=0.5&ny=0.3  → 记下点击位置，下一帧画十字
                try {
                    int qi = path.indexOf('?');
                    if (qi > 0) {
                        String q = path.substring(qi + 1);
                        for (String kv : q.split("&")) {
                            String[] p2 = kv.split("=");
                            if (p2.length == 2) {
                                if ("nx".equals(p2[0])) markNx = Float.parseFloat(p2[1]);
                                if ("ny".equals(p2[0])) markNy = Float.parseFloat(p2[1]);
                            }
                        }
                        markAt = System.currentTimeMillis();
                        // **立刻用缓存的最后一帧重编一张带标记的**，
                        // 不等下一个 ImageReader 回调（静止画面根本不回调）
                        reencodeWithMark();
                    }
                    out.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok".getBytes());
                } catch (Throwable t) {
                    out.write("HTTP/1.1 400 Bad\r\nContent-Length: 3\r\n\r\nbad".getBytes());
                }
                out.flush();
                s.close();
            } else if (path.startsWith("/quit")) {
                out.write("HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nbye".getBytes());
                out.flush();
                System.out.println("QUIT");
                System.exit(0);
            } else {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 2\r\n\r\nno".getBytes());
                out.flush();
                s.close();
            }
        } catch (Throwable t) {
            try { s.close(); } catch (Throwable t2) { }
        }
    }
}
