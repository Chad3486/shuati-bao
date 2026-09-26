package com.shuati.bao;

import android.Manifest;
import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.DownloadListener;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class MainActivity extends AppCompatActivity {

    private WebView wv;
    private ValueCallback<Uri[]> mFilePathCallback;
    private static final int FILE_CHOOSE = 1;
    private static final int REQUEST_STORAGE = 1001;
    private static final int REQUEST_NOTI = 1002; // Android 13+ 通知运行时权限（保活通知）

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // 文件选择走 SAF 系统选择器（ACTION_GET_CONTENT），返回 content:// URI 自带临时读权限，
        // 不需要任何存储运行时权限，无需请求（READ_MEDIA_DOCUMENTS 并非真实权限）

        wv = findViewById(R.id.wv);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // IndexedDB 题库存储
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        // JS ↔ Java 桥接：前端保存文件到系统 Download 目录（Blob/Object URL 在 WebView 不触发下载）
        wv.addJavascriptInterface(new WebAppInterface(), "AndroidBridge");

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (mFilePathCallback != null) {
                    mFilePathCallback.onReceiveValue(null);
                }
                mFilePathCallback = callback;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true); // 多文件导入
                i.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
                        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        "application/msword",
                        "text/plain",
                        "application/json"
                });
                try {
                    startActivityForResult(Intent.createChooser(i, "选择文件"), FILE_CHOOSE);
                } catch (Exception e) {
                    mFilePathCallback = null;
                    return false;
                }
                return true;
            }
        });
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String u = request.getUrl().toString();
                if (u.startsWith("http://") || u.startsWith("https://")) {
                    // 外链跳系统浏览器（APP 内只跑本地页面）
                    startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(u)));
                    return true;
                }
                return false;
            }
        });

        // DownloadListener：兜底处理 http(s)/file:// 下载链接（非 Blob 场景）
        wv.setDownloadListener(new DownloadListener() {
            @Override
            public void onDownloadStart(String url, String userAgent, String contentDisposition, String mimetype, long contentLength) {
                try {
                    String fileName = URLUtil.guessFileName(url, contentDisposition, mimetype);
                    DownloadManager.Request req = new DownloadManager.Request(Uri.parse(url));
                    req.setTitle(fileName);
                    req.setDescription("刷题宝导出");
                    req.setMimeType(mimetype);
                    req.allowScanningByMediaScanner();
                    req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                    req.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, fileName);
                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    if (dm != null) dm.enqueue(req);
                    Toast.makeText(MainActivity.this, "开始下载：" + fileName, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show();
                }
            }
        });

        // assets 内联单文件版拷到 filesDir，获得 file:// 完整 API 权限（v1.5 起 tesseract 已移除，不再拷贝）
        String htmlPath = copyAsset("app.html", "index.html");
        wv.loadUrl("file://" + htmlPath);
    }

    /** JS 桥接对象：前端通过 window.AndroidBridge 调用 */
    public class WebAppInterface {

        /**
         * 保存文件到系统 Download 目录（用户可通过文件管理器直接看到）
         * @param fileName 文件名，如 "刷题宝备份_2025-01-01.json"
         * @param base64   文件内容的 base64 编码
         * @return 成功返回 "OK:<文件路径>"，失败返回错误信息
         */
        @android.webkit.JavascriptInterface
        public String saveFile(final String fileName, final String base64) {
            try {
                byte[] data = Base64.decode(base64, Base64.DEFAULT);
                String path;

                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    // Android 10+：用 MediaStore 写入公共 Download 目录，不需要存储权限
                    ContentValuesCompat values = new ContentValuesCompat();
                    values.put(MediaStore.Downloads.DISPLAY_NAME, fileName);
                    values.put(MediaStore.Downloads.MIME_TYPE, guessMimeType(fileName));
                    values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                    Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values.get());
                    if (uri == null) return "ERROR: 无法创建下载记录";
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) return "ERROR: 无法打开输出流";
                        os.write(data);
                    }
                    path = "Download/" + fileName;
                    // 通知媒体扫描，立即可见
                    sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, uri));
                } else {
                    // Android 9 及以下：需要 WRITE_EXTERNAL_STORAGE 权限
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                            != PackageManager.PERMISSION_GRANTED) {
                        ActivityCompat.requestPermissions(MainActivity.this,
                                new String[]{ Manifest.permission.WRITE_EXTERNAL_STORAGE }, REQUEST_STORAGE);
                        return "NEED_PERMISSION: 请授予存储权限后重试";
                    }
                    File dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists()) dir.mkdirs();
                    File file = new File(dir, fileName);
                    try (FileOutputStream fos = new FileOutputStream(file)) {
                        fos.write(data);
                    }
                    path = file.getAbsolutePath();
                    sendBroadcast(new Intent(Intent.ACTION_MEDIA_SCANNER_SCAN_FILE, Uri.fromFile(file)));
                }

                final String toastMsg = "已导出到 Download：" + fileName;
                runOnUiThread(() -> Toast.makeText(MainActivity.this, toastMsg, Toast.LENGTH_LONG).show());
                return "OK:" + path;
            } catch (Exception e) {
                final String err = e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage();
                runOnUiThread(() -> Toast.makeText(MainActivity.this, "导出失败：" + err, Toast.LENGTH_LONG).show());
                return "ERROR:" + err;
            }
        }

        /** 判断是否已通过 JS 桥接，用于前端决定走 <a download> 还是原生保存 */
        @android.webkit.JavascriptInterface
        public boolean isAvailable() { return true; }

        /**
         * AI 长任务开始：拉起前台服务（通知栏进度 + 锁屏 CPU 唤醒）。
         * Android 13+ 需要通知运行时权限——此处静默请求一次；被拒不影响保活，只是通知不可见。
         */
        @android.webkit.JavascriptInterface
        public String keepAliveStart(final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() {
                    if (Build.VERSION.SDK_INT >= 33 &&
                            ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.POST_NOTIFICATIONS)
                                    != PackageManager.PERMISSION_GRANTED) {
                        ActivityCompat.requestPermissions(MainActivity.this,
                                new String[]{ Manifest.permission.POST_NOTIFICATIONS }, REQUEST_NOTI);
                    }
                    KeepAliveService.start(MainActivity.this, text);
                }
            });
            return "OK";
        }

        /** 长任务进度更新：刷新通知栏文案（锁屏也不停） */
        @android.webkit.JavascriptInterface
        public void keepAliveUpdate(final String text) {
            runOnUiThread(new Runnable() {
                @Override public void run() { KeepAliveService.update(MainActivity.this, text); }
            });
        }

        /** 长任务结束：停服务、撤通知、释放唤醒锁（JS 侧 finally 保证必调） */
        @android.webkit.JavascriptInterface
        public void keepAliveStop() {
            runOnUiThread(new Runnable() {
                @Override public void run() { KeepAliveService.stop(MainActivity.this); }
            });
        }
    }

    /** 简易 ContentValues 兼容包装（避免 API 级别分支直接引用） */
    private static class ContentValuesCompat {
        private final android.content.ContentValues v = new android.content.ContentValues();
        void put(String key, String value) { v.put(key, value); }
        android.content.ContentValues get() { return v; }
    }

    private static String guessMimeType(String fileName) {
        String lower = fileName.toLowerCase();
        if (lower.endsWith(".json")) return "application/json";
        if (lower.endsWith(".txt")) return "text/plain";
        if (lower.endsWith(".doc")) return "application/msword";
        if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
        return "application/octet-stream";
    }

    private void copyAssetDir(String assetPath, String outPath) {
        // 递归拷贝 assets 目录（OCR 离线资源），每次启动覆盖，保证升级后不读旧文件
        try {
            String[] list = getAssets().list(assetPath);
            if (list == null || list.length == 0) return;
            File outDir = new File(getFilesDir(), outPath);
            if (!outDir.exists()) outDir.mkdirs();
            for (String name : list) {
                String[] children = getAssets().list(assetPath + "/" + name);
                if (children != null && children.length > 0) {
                    copyAssetDir(assetPath + "/" + name, outPath + "/" + name);
                } else {
                    copyAsset(assetPath + "/" + name, outPath + "/" + name);
                }
            }
        } catch (IOException ignored) {
        }
    }

    private String copyAsset(String assetName, String outName) {
        // 每次启动都覆盖拷贝：否则 App 升级换新 HTML 后仍读旧文件（版本内容永不更新）
        File out = new File(getFilesDir(), outName);
        try (InputStream is = getAssets().open(assetName);
             OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
        } catch (IOException e) {
            return "android_asset/" + assetName; // 兜底直接从 assets 读
        }
        return out.getAbsolutePath();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, @Nullable Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSE) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                ClipData clip = data.getClipData(); // 多选
                if (clip != null) {
                    results = new Uri[clip.getItemCount()];
                    for (int i = 0; i < clip.getItemCount(); i++) results[i] = clip.getItemAt(i).getUri();
                } else if (data.getData() != null) {
                    results = new Uri[]{ data.getData() };
                }
            }
            if (mFilePathCallback != null) {
                mFilePathCallback.onReceiveValue(results);
                mFilePathCallback = null;
            }
        }
    }

    @Override
    public void onBackPressed() {
        if (wv != null && wv.canGoBack()) wv.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        // 兜底：Activity 真正销毁（进程退出）时撤保活通知——
        // 正常的"锁屏/切后台"走 onStop 不销毁，不影响任务继续
        KeepAliveService.stop(this);
        super.onDestroy();
    }
}
