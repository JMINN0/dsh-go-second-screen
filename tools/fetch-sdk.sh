#!/usr/bin/env bash
# 下载构建 overlay / framesrv 需要的两个 jar。
#
# 为什么单独下载：这两个 jar 一共 37MB（android-30.jar 21MB + r8.jar 16MB），
# 提交进仓库会让 clone 体积翻十倍。它们只是编译期依赖，运行时不需要。
#
# 用法：bash tools/fetch-sdk.sh
set -euo pipefail
cd "$(dirname "$0")/sdk"

ANDROID_JAR_URL="https://raw.githubusercontent.com/Sable/android-platforms/master/android-30/android.jar"
R8_URL="https://storage.googleapis.com/r8-releases/raw/main/r8.jar"

fetch() {
  local url="$1" out="$2"
  if [ -s "$out" ]; then
    echo "✅ $out 已存在（$(du -h "$out" | cut -f1)），跳过"
    return
  fi
  echo "⬇️  下载 $out ..."
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --retry 3 -o "$out" "$url"
  else
    wget -O "$out" "$url"
  fi
  echo "✅ $out 完成（$(du -h "$out" | cut -f1)）"
}

fetch "$ANDROID_JAR_URL" android-30.jar
fetch "$R8_URL" r8.jar
echo ""
echo "全部就绪。现在可以："
echo "  bash overlay/build.sh"
echo "  bash framesrv/build.sh"
