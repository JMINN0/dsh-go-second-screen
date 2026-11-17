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

    static int displayId = 0;
    static int port = 38810;
    static int outWidth = 400;
    static int srcW = 720, srcH = 1592;

    static ImageReader reader;
    static VirtualDisplay vd;
    static volatile byte[] latest = null;
    static final AtomicInteger frames = new AtomicInteger(0);
    static final AtomicInteger lastSecFrames = new AtomicInteger(0);
    static volatile int fps = 0;
    static final Set<Socket> mjpegClients = ConcurrentHashMap.newKeySet();

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

        // 每秒算一次 fps
        new Thread(new Runnable() {
            public void run() {
                while (true) {
                    try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
                    fps = lastSecFrames.getAndSet(0);
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
                    // 编码 JPEG（放到回调外会更稳，但这里先简单做）
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
            Bitmap bm = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bm.copyPixelsFromBuffer(ByteBuffer.wrap(all.toByteArray()));
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
            bm.recycle();
            return out;
        } catch (Throwable t) {
            return null;
        }
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
                String j = "{\"running\":true,\"frames\":" + frames.get()
                        + ",\"fps\":" + fps + ",\"width\":" + outWidth
                        + ",\"aspect\":" + ((double) srcW / srcH) + "}";
                out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
                        + j.length() + "\r\nCache-Control: no-store\r\n\r\n" + j).getBytes());
                out.flush();
                s.close();
            } else if (path.startsWith("/stream.mjpg")) {
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
