#!/bin/bash
# 刷题宝 APK 轻量构建：aapt2 + javac + d8 + zipalign + apksigner（无 Gradle）
set -e
SDK=/home/z/my-project/share/agent-model/6ab5ec7b89102b93e992b3d8/tmp/android-sdk
BT=$SDK/android-14              # build-tools 34（zip 内目录名就叫 android-14）
D8=$SDK/android-15/d8           # build-tools 35 的 d8：34 自带的 8.2.2-dev 写 dex 时 NPE，换新版
PLAT=$SDK/android-34/android.jar
SRC=/home/z/my-project/share/agent-model/6ab5ec7b89102b93e992b3d8/tmp/shuati-bao-push/apk-src/app/src/main
OUT=/home/z/my-project/share/agent-model/6ab5ec7b89102b93e992b3d8/tmp/apk-build
rm -rf "$OUT" && mkdir -p "$OUT/gen" "$OUT/classes" "$OUT/dex"

echo '[1/6] aapt2 编译资源'
"$BT/aapt2" compile --dir "$SRC/res" -o "$OUT/res.zip"

echo '[2/6] aapt2 链接（资源+清单+assets → R.java）'
# 原清单不带 package（AGP 8 由 gradle namespace 注入）；轻量构建给副本补上
sed 's/<manifest /<manifest package="com.shuati.bao" /' "$SRC/AndroidManifest.xml" > "$OUT/AndroidManifest.xml"
"$BT/aapt2" link -o "$OUT/base.apk" -I "$PLAT" \
  --manifest "$OUT/AndroidManifest.xml" -A "$SRC/assets" \
  --java "$OUT/gen" --auto-add-overlay \
  --min-sdk-version 21 --target-sdk-version 34 \
  --version-code 30 --version-name 1.7.3 \
  "$OUT/res.zip"

echo '[3/6] javac 编译 Java'
JDK=/home/z/my-project/share/agent-model/6ab5ec7b89102b93e992b3d8/tmp/android-sdk/jdk-21.0.5+11
find "$SRC/java" "$OUT/gen" -name '*.java' > "$OUT/sources.txt"
# javac 21 限制：target 17 不允许 -bootclasspath，故按 Java 8 编译（lambda 由 d8 脱糖到 API 21）
# core-lambda-stubs.jar 提供 LambdaMetafactory 编译期符号（AGP 同款做法）；编译失败必须中止，绝不签出坏包
if ! "$JDK/bin/javac" -Xlint:none -nowarn -source 8 -target 8 \
  -bootclasspath "$PLAT:$BT/core-lambda-stubs.jar" -classpath "$PLAT:$BT/core-lambda-stubs.jar" \
  -d "$OUT/classes" @"$OUT/sources.txt" > "$OUT/javac.log" 2>&1; then
  echo 'javac 失败：'; cat "$OUT/javac.log"; exit 1
fi
grep -E 'error|错误' "$OUT/javac.log" || true

echo '[4/6] d8 出 dex'
# d8 对绝对路径类文件有 NPE 的坑：进 classes 目录用相对路径喂（包路径即类的包名）
cd "$OUT/classes"
PATH="$JDK/bin:$PATH" "$D8" --release --lib "$PLAT" --min-api 21 \
  --output "$OUT/dex" $(find . -name '*.class' | sed 's|^\./||')

echo '[5/6] 组装 + 对齐'
cp "$OUT/base.apk" "$OUT/unsigned.apk"
cd "$OUT/dex" && zip -q -j "$OUT/unsigned.apk" classes.dex
"$BT/zipalign" -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

echo '[6/6] 签名（固定 debug.keystore，可覆盖升级）'
"$BT/apksigner" sign \
  --ks /home/z/my-project/share/agent-model/6ab5ec7b89102b93e992b3d8/tmp/shuati-bao-push/apk-src/app/debug.keystore \
  --ks-pass pass:android --key-pass pass:android --ks-key-alias androiddebugkey \
  --out "$OUT/shuati-bao-v1.7.3.apk" "$OUT/aligned.apk"
"$BT/apksigner" verify "$OUT/shuati-bao-v1.7.3.apk" && echo 'VERIFY_OK'
ls -la "$OUT/shuati-bao-v1.7.3.apk"
