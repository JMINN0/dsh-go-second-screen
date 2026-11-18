#!/bin/bash
# 编译悬浮窗 APK：javac → d8 → aapt → zipalign → apksigner。
set -e
# **先算绝对路径再 cd**：$0 可能是相对路径（如 overlay/build.sh），
# cd 之后再用 $0 算会重复叠一层（overlay/overlay/...），脚本就静默失败。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"
SDK="$ROOT_DIR/tools/sdk"
BT=/usr/lib/android-sdk/build-tools/debian
ADB="adb -s ${DSH_ADB_TARGET:-127.0.0.1:5555}"

[ -f "$SDK/android-30.jar" ] || { echo "缺 android-30.jar"; exit 1; }
[ -f "$SDK/r8.jar" ] || { echo "缺 r8.jar"; exit 1; }

[ -f build/dsh-release.jks ] || {
  echo "生成签名密钥…"
  mkdir -p build
  keytool -genkeypair -v -keystore build/dsh-release.jks -alias dsh \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass dsh123456 -keypass dsh123456 \
    -dname "CN=DSH Overlay, OU=Dev, O=DSH, L=CN, S=CN, C=CN" 2>&1 | tail -1
}

rm -rf build/classes && mkdir -p build/classes
javac -source 8 -target 8 -nowarn -cp "$SDK/android-30.jar" -d build/classes src/com/dsh/overlay/*.java
java -cp "$SDK/r8.jar" com.android.tools.r8.D8 --min-api 26 --release \
  --lib "$SDK/android-30.jar" --output build/ build/classes/com/dsh/overlay/*.class

cd build
rm -f app-*.apk
$BT/aapt package -f -M ../AndroidManifest.xml -I "$SDK/android-30.jar" -F app-u.apk
$BT/aapt add -f app-u.apk classes.dex >/dev/null
$BT/zipalign -f 4 app-u.apk app-a.apk
$BT/apksigner sign --ks dsh-release.jks --ks-key-alias dsh \
  --ks-pass pass:dsh123456 --key-pass pass:dsh123456 \
  --out app-s.apk app-a.apk
echo "✅ APK $(stat -c%s app-s.apk) 字节"

cp app-s.apk ../../screen/assets/overlay/ai-overlay.apk
echo "✅ 已更新内置 APK"
$ADB install -r app-s.apk 2>&1 | tail -1
