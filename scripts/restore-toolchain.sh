#!/bin/bash
# 环境重置后一键恢复工具链。
#
# 什么时候用：DSH Go 升级后（内部运行时镜像会换，apt/pip 装的全丢）。
# 实测：2026-11-05 从 1.0.9 升 1.0.10 时 adb/ffmpeg/imagemagick/tesseract/pillow 全没了。
#
# 用法：bash scripts/restore-toolchain.sh
set -e
echo "=== 1/4 apt 工具 ==="
apt-get update -qq
apt-get install -y -qq \
  android-tools-adb ffmpeg imagemagick tesseract-ocr \
  openjdk-21-jdk-headless \
  android-sdk-build-tools \
  libsmali-java \
  python3-pil 2>&1 | tail -3

echo "=== 2/4 pip 包 ==="
# **opencv 必须装**：模板匹配、颜色检测、Hough、dHash 全依赖它。
# 之前漏了 —— 环境重置后会静默丢失，视觉方法全部失效。
pip install -q pillow numpy zstandard opencv-python-headless \
  -i https://pypi.tuna.tsinghua.edu.cn/simple 2>&1 | tail -2

echo "=== 3/4 Android SDK jar（若已被删，从备份恢复）==="
SDK="$(dirname "$0")/../tools/sdk"
if [ ! -f "$SDK/android-30.jar" ]; then
  echo "  android-30.jar 不在了，重新下载…"
  mkdir -p "$SDK"
  curl -sL -o "$SDK/android-30.jar" \
    "https://github.com/Sable/android-platforms/raw/master/android-30/android.jar"
fi
if [ ! -f "$SDK/r8.jar" ]; then
  echo "  r8.jar 不在了，重新下载…"
  curl -sL -o "$SDK/r8.jar" \
    "https://maven.google.com/com/android/tools/r8/8.3.37/r8-8.3.37.jar"
fi
ls -la "$SDK"/*.jar 2>/dev/null | sed 's/^/  /'

echo "=== 4/4 验证 ==="
for T in adb ffmpeg javac aapt2 apksigner zipalign; do
  if command -v "$T" >/dev/null 2>&1; then echo "  ✅ $T"; else echo "  ❌ $T 仍缺"; fi
done
adb connect 127.0.0.1:5555 >/dev/null 2>&1 || true
adb -s 127.0.0.1:5555 shell echo "  ✅ adb 回环连接正常" 2>/dev/null || echo "  ⚠️ adb 连不上（可能需要重新配对）"

echo ""
echo "=== 恢复完成 ==="
echo "重建取帧服务： cd framesrv && bash build.sh（若存在）"
echo "重建悬浮窗：   cd overlay  && bash build.sh（若存在）"
