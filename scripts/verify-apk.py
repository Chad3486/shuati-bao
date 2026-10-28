#!/usr/bin/env python3
"""发版前硬校验：APK 的 versionName 必须与内嵌 assets/app.html 的 VERSION 一致。

背景：v1.8.17 曾发出 versionName=1.8.17、内嵌 app.html 实为 1.8.16 的包，
根因是修复改到了旧 js 源码而 APK 用的内嵌 app.html 没重生成。这个校验把这种
情况卡在 CI 里，不再靠人眼看。
"""
import os
import re
import sys
import zipfile


def main() -> int:
    want = (os.environ.get('VERSION_NAME') or '').strip()
    if not want:
        print('VERSION_NAME 未设置')
        return 1
    apk = f'shuati-bao-v{want}.apk'
    if not os.path.exists(apk):
        print(f'找不到 {apk}')
        return 1

    with zipfile.ZipFile(apk) as z:
        html = z.read('assets/app.html').decode('utf-8', 'ignore')
        mani = z.read('AndroidManifest.xml')

    found = re.findall(r"const VERSION = '([0-9.]+)'", html)
    print(f'APK: {apk} ({os.path.getsize(apk)} bytes)')
    print(f'内嵌 app.html VERSION = {found[:1]}，期望 {want}')
    if not found or found[0] != want:
        print('❌ 内嵌 app.html 版本号不一致，拒绝发版')
        return 1

    # 二进制 AndroidManifest 的字符串池是 UTF-16LE
    if want not in mani.decode('utf-16-le', 'ignore'):
        print(f'❌ AndroidManifest 里找不到 versionName={want}')
        return 1

    print('✅ 校验通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
