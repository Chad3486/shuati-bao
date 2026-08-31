# 刷题宝 📱

一个纯本地的移动端刷题应用——把 PDF / Word 题库文件导入手机，自动解析成结构化题目，随时随地刷题。

无需服务器、无需注册，所有数据存在手机本地（IndexedDB）。

## 功能

### 📥 智能导入
- 支持 **PDF / DOCX**，可多文件批量导入
- **本地正则解析优先**（秒级、零费用），疑难格式才调 AI 兜底
- 自动清除页眉页脚噪声（"统一服务热线"等）、跨页断行自动拼接
- **题型小节感知**：识别"一、单选题 / 二、多选题 / 三、判断题"结构，各节题号独立不互相覆盖
- 选项乱序（PDF 转制常见）自动重排，残缺题自动跳过并报告
- 扫描版 PDF 自动 OCR 兜底（Tesseract.js）
- 支持 DeepSeek 等 OpenAI 兼容接口作为 AI 解析引擎（Key 存本地）

### ✏️ 题库管理
- 题库重命名、按小节分组选题练习
- 删除题目进**回收站**（可恢复 / 彻底删除需二次确认）
- 答案两步走：先扫题、后补答案（上传答案文件 or AI 解答）
- AI 校验答案并补解析
- 断点续扫：纯 AI 模式中断后可继续，已扫部分不重复计费

### 📝 刷题体验
- 单选 / 多选 / 判断 / 填空
- 错题本（自动聚合最近答错的题）、收藏、跳过永久答对
- 答题进度自动保存，中途退出可继续
- 日间 / 夜间主题
- 题库导出 / 导入 JSON 备份

## 下载安装

### 方式一：Release（推荐）
到 [Releases](../../releases) 页面下载最新 `刷题宝.apk`，传到安卓手机安装（需允许"未知来源"）。

### 方式二：Actions 构建
Actions → 最新绿色 ✓ 运行 → Artifacts 下载（需登录 GitHub，保留 90 天）。

> 要求 Android 5.0+（minSdk 21）。

### 方式三：直接用网页版
不装 App 也行：下载 `dist/刷题宝-单文件版.html` 发到手机浏览器打开即可（功能一致，数据同样存本地）。

## 从源码构建 APK

本仓库已配好 GitHub Actions，无需本地环境：

1. Fork 或直接使用本仓库
2. Actions → **Build ShuatiBao APK** → Run workflow
3. 等约 3~5 分钟 → Artifacts 下载 APK

本地构建（需要 JDK 17 + Android SDK + Gradle 8.4+）：

```bash
gradle -p apk-src :app:assembleDebug
# 产物：apk-src/app/build/outputs/apk/debug/app-debug.apk
```

改了网页代码后先重建单文件再构建 APK：

```bash
node build-single.mjs
cp "dist/刷题宝-单文件版.html" apk-src/app/src/main/assets/app.html
```

## 技术栈

| 层 | 技术 |
|---|---|
| 前端 | 原生 JS（无框架），单文件打包（2MB 离线可用） |
| 存储 | IndexedDB（题库/答题记录/回收站） |
| PDF | pdf.js（含 Blob Worker 内联，file:// 可用）+ Tesseract.js OCR |
| Word | mammoth.js |
| AI | OpenAI 兼容接口（默认 DeepSeek），限流重试 + 断点续扫 |
| APK 壳 | Android WebView（minSdk 21），[apk-src/](apk-src/) |

目录结构：

```
├── index.html / css / js   # 网页版源码（extract 解析 / llm AI / db 存储 / app 页面 / quiz 会话）
├── dist/刷题宝-单文件版.html  # 单文件打包产物（手机浏览器直接可用）
├── apk-src/                 # Android WebView 壳工程
├── build-single.mjs         # 单文件打包脚本
└── .github/workflows/       # CI 构建 APK
```

## 使用建议

- 首次使用：设置 → 填 AI 接口（[DeepSeek](https://platform.deepseek.com) 注册即送额度）→ 导入文件
- 不填 AI 也能用：本地解析 + 上传答案文件，全程零费用
- 题库重要的话记得定期「导出备份」JSON

## License

MIT
