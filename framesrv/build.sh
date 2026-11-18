#!/bin/bash
# 编译 framesrv：Java → dex，推到设备。
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SCRIPT_DIR"
SDK="$ROOT_DIR/tools/sdk"
ADB="adb -s ${DSH_ADB_TARGET:-127.0.0.1:5555}"

[ -f "$SDK/android-30.jar" ] || { echo "缺 android-30.jar，先跑 scripts/restore-toolchain.sh"; exit 1; }
[ -f "$SDK/r8.jar" ] || { echo "缺 r8.jar，先跑 scripts/restore-toolchain.sh"; exit 1; }

rm -rf build/classes && mkdir -p build/classes
javac -source 8 -target 8 -nowarn -cp "$SDK/android-30.jar" \
  -d build/classes src/com/dsh/framesrv/Main.java
java -cp "$SDK/r8.jar" com.android.tools.r8.D8 --min-api 26 --release \
  --lib "$SDK/android-30.jar" --output build/ build/classes/com/dsh/framesrv/*.class
echo "✅ build/classes.dex $(stat -c%s build/classes.dex) 字节"

$ADB shell "mkdir -p /data/local/tmp/dshframe" 2>/dev/null
$ADB push build/classes.dex /data/local/tmp/dshframe/frame.dex >/dev/null
$ADB shell "chmod 644 /data/local/tmp/dshframe/frame.dex"
echo "✅ 已推到设备 /data/local/tmp/dshframe/frame.dex"
