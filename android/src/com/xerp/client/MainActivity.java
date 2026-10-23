package com.xerp.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.text.InputType;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * x.erp 安卓客户端：用 WebView 打开局域网里的 x.erp 服务端，并给页面提供手机能力
 * （扫码、保存导出文件、选择导入文件、打印）。页面通过 window.XerpApp 调用这些能力。
 */
public class MainActivity extends Activity {
    static String VERSION = "";
    private static final int REQ_SCAN = 1, REQ_FILE = 2, REQ_SAVE = 3;
    private static final int DEFAULT_PORT = 8686;

    private WebView web;
    private FrameLayout root;
    private SharedPreferences prefs;
    private String server = "";
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingSave;
    private WebView printView;
    private long lastBack;
    private final Handler ui = new Handler(Looper.getMainLooper());

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("xerp", MODE_PRIVATE);
        server = prefs.getString("server", "");
        try { VERSION = getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception ignored) { }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        applyInsets();
        setupWebView();
        setupBack();

        if (server.isEmpty()) askServer(true);
        else web.loadUrl(server + "/");
    }

    /* ---------- 全面屏：内容避开状态栏、导航栏和输入法 ---------- */
    private void applyInsets() {
        getWindow().setStatusBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) c.setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                    WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
        } else {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        root.setOnApplyWindowInsetsListener((v, in) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets s = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(s.left, s.top, s.right, s.bottom);
            } else {
                v.setPadding(in.getSystemWindowInsetLeft(), in.getSystemWindowInsetTop(), in.getSystemWindowInsetRight(), in.getSystemWindowInsetBottom());
            }
            return in;
        });
    }

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100);
        s.setAllowFileAccess(false);
        s.setUserAgentString(s.getUserAgentString() + " XerpAndroid/" + VERSION);
        web.addJavascriptInterface(new Bridge(), "XerpApp");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                Uri u = req.getUrl();
                // 服务端自己的页面留在应用里，其他链接（购买页、GitHub 等）交给系统浏览器
                if (!server.isEmpty() && u.toString().startsWith(server)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { toast("没有可以打开链接的应用"); }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) showError(String.valueOf(err.getDescription()));
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                try { startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE); }
                catch (ActivityNotFoundException e) { fileCallback = null; toast("没有可以选择文件的应用"); return false; }
                return true;
            }
        });
    }

    /* ---------- 返回键：先关弹窗 / 侧栏，再后退，最后连按两次退出 ---------- */
    private void setupBack() {
        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::handleBack);
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() { handleBack(); }

    private void handleBack() {
        web.evaluateJavascript("(window.__xerpBack&&window.__xerpBack())?1:0", r -> {
            if ("1".equals(r)) return;
            if (web.canGoBack()) { web.goBack(); return; }
            long now = System.currentTimeMillis();
            if (now - lastBack < 2000) finish();
            else { lastBack = now; toast("再按一次退出"); }
        });
    }

    /* ---------- 服务器地址 ---------- */
    static String normalize(String s) {
        s = s.trim();
        if (s.isEmpty()) return "";
        if (!s.matches("(?i)^https?://.*")) s = "http://" + s;
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return "";
        int port = u.getPort();
        return u.getScheme().toLowerCase() + "://" + u.getHost() + (port > 0 ? ":" + port : u.getScheme().equalsIgnoreCase("http") ? ":" + DEFAULT_PORT : "");
    }

    private void askServer(boolean first) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        int p = dp(20);
        box.setPadding(p, dp(8), p, 0);
        TextView tip = new TextView(this);
        tip.setText("填写 x.erp 服务端地址（飞牛 NAS 或 Windows 电脑的 IP），手机需要和它连在同一个 Wi-Fi。\n例如：192.168.1.10:8686");
        tip.setTextSize(13);
        tip.setTextColor(0xFF6B7280);
        EditText in = new EditText(this);
        in.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        in.setHint("192.168.1.10:8686");
        in.setText(server.replaceFirst("^http://", ""));
        in.setSingleLine(true);
        box.addView(tip);
        box.addView(in);
        AlertDialog d = new AlertDialog.Builder(this)
                .setTitle(first ? "连接 x.erp 服务器" : "切换服务器")
                .setView(box)
                .setPositiveButton("连接", null)
                .setNeutralButton("自动查找", null)
                .setNegativeButton(first ? "退出" : "取消", (dd, w) -> { if (server.isEmpty()) finish(); })
                .setCancelable(!first)
                .create();
        d.setOnShowListener(x -> {
            d.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String url = normalize(in.getText().toString());
                if (url.isEmpty()) { toast("请填写服务器地址"); return; }
                d.dismiss();
                testAndUse(url, first);
            });
            d.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener(v -> { d.dismiss(); discover(first); });
        });
        d.show();
    }

    private void testAndUse(String url, boolean first) {
        ProgressDialog pd = ProgressDialog.show(this, null, "正在连接 " + url + " …", true, false);
        new Thread(() -> {
            String err = ping(url, 5000);
            ui.post(() -> {
                pd.dismiss();
                if (err == null) useServer(url);
                else new AlertDialog.Builder(this).setTitle("连接失败").setMessage(url + "\n\n" + err + "\n\n请确认：手机和服务器在同一个 Wi-Fi；地址和端口正确；服务端已启动。")
                        .setPositiveButton("重新填写", (d, w) -> askServer(first)).setCancelable(false).show();
            });
        }).start();
    }

    private void useServer(String url) {
        server = url;
        prefs.edit().putString("server", url).apply();
        web.clearHistory();
        web.loadUrl(url + "/");
        toast("已连接 " + url);
    }

    /** 返回 null 表示是 x.erp 服务端，否则返回原因 */
    static String ping(String url, int timeout) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/ping").openConnection();
            c.setConnectTimeout(timeout);
            c.setReadTimeout(timeout);
            InputStream is = c.getInputStream();
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] b = new byte[2048];
            int n;
            while ((n = is.read(b)) > 0 && bo.size() < 8192) bo.write(b, 0, n);
            return bo.toString("UTF-8").contains("\"XERP\"") ? null : "该地址不是 x.erp 服务端";
        } catch (java.net.ConnectException e) {
            return "连接被拒绝（服务端未启动或端口不对）";
        } catch (java.net.SocketTimeoutException e) {
            return "连接超时";
        } catch (java.net.UnknownHostException e) {
            return "找不到该地址";
        } catch (Exception e) {
            return e.getClass().getSimpleName() + "：" + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /* ---------- 自动查找：扫描手机所在网段的 8686 端口 ---------- */
    private void discover(boolean first) {
        List<String> prefixes = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) {
                        String ip = a.getHostAddress();
                        String pre = ip.substring(0, ip.lastIndexOf('.') + 1);
                        if (!prefixes.contains(pre)) prefixes.add(pre);
                    }
                }
            }
        } catch (Exception ignored) { }
        if (prefixes.isEmpty()) {
            new AlertDialog.Builder(this).setMessage("手机没有连接局域网（Wi-Fi），无法自动查找。").setPositiveButton("好", (d, w) -> askServer(first)).show();
            return;
        }
        ProgressDialog pd = ProgressDialog.show(this, null, "正在局域网里查找 x.erp 服务器…", true, false);
        new Thread(() -> {
            List<String> found = Collections.synchronizedList(new ArrayList<>());
            ExecutorService pool = Executors.newFixedThreadPool(48);
            for (String pre : prefixes) for (int i = 1; i < 255; i++) {
                String url = "http://" + pre + i + ":" + DEFAULT_PORT;
                pool.execute(() -> { if (ping(url, 600) == null) found.add(url); });
            }
            pool.shutdown();
            try { pool.awaitTermination(30, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            ui.post(() -> {
                pd.dismiss();
                if (found.isEmpty()) {
                    new AlertDialog.Builder(this).setTitle("没有找到")
                            .setMessage("在 " + String.join("*、", prefixes) + "* 网段的 " + DEFAULT_PORT + " 端口没有找到 x.erp。\n如果服务端改过端口，或不在同一网段，请手动填写地址。")
                            .setPositiveButton("手动填写", (d, w) -> askServer(first)).setCancelable(false).show();
                } else if (found.size() == 1) {
                    useServer(found.get(0));
                } else {
                    String[] items = found.toArray(new String[0]);
                    new AlertDialog.Builder(this).setTitle("找到多个服务器").setItems(items, (d, w) -> useServer(items[w]))
                            .setNegativeButton("手动填写", (d, w) -> askServer(first)).setCancelable(false).show();
                }
            });
        }).start();
    }

    private void showError(String why) {
        String html = "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><meta charset='utf-8'>"
                + "<style>body{font-family:sans-serif;padding:48px 24px;text-align:center;color:#1f2937}h2{margin:12px 0}p{color:#6b7280;line-height:1.6}"
                + "button{display:block;width:100%;max-width:320px;margin:12px auto;height:46px;border:0;border-radius:10px;font-size:16px}"
                + ".a{background:#4f46e5;color:#fff}.b{background:#eef2ff;color:#4f46e5}</style></head><body>"
                + "<div style='font-size:48px'>📡</div><h2>连不上 x.erp 服务器</h2><p>" + escape(server) + "<br>" + escape(why) + "</p>"
                + "<p>请确认手机连着店里 / 公司的 Wi-Fi，服务器已开机。</p>"
                + "<button class='a' onclick='XerpApp.retry()'>重试</button><button class='b' onclick='XerpApp.changeServer()'>更换服务器</button></body></html>";
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    static String escape(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"); }

    /* ---------- 页面调用的手机能力 ---------- */
    class Bridge {
        @JavascriptInterface public String version() { return VERSION; }
        @JavascriptInterface public String server() { return server; }

        @JavascriptInterface public void scan() {
            ui.post(() -> startActivityForResult(new Intent(MainActivity.this, ScanActivity.class), REQ_SCAN));
        }

        @JavascriptInterface public void changeServer() { ui.post(() -> askServer(false)); }

        @JavascriptInterface public void retry() { ui.post(() -> { if (server.isEmpty()) askServer(true); else web.loadUrl(server + "/"); }); }

        /** 保存导出的文件：让用户选择保存位置（不需要存储权限） */
        @JavascriptInterface public void saveFile(String name, String mime, String base64) {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            ui.post(() -> {
                pendingSave = data;
                Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType(mime == null || mime.isEmpty() ? "application/octet-stream" : mime);
                i.putExtra(Intent.EXTRA_TITLE, name);
                try { startActivityForResult(i, REQ_SAVE); } catch (ActivityNotFoundException e) { pendingSave = null; toast("没有可以保存文件的应用"); }
            });
        }

        /** 打印：用一个隐藏的 WebView 排版，交给系统打印（可选打印机或「另存为 PDF」） */
        @JavascriptInterface public void print(String title, String html) {
            ui.post(() -> {
                printView = new WebView(MainActivity.this);
                printView.setWebViewClient(new WebViewClient() {
                    @Override public void onPageFinished(WebView v, String url) {
                        PrintManager pm = (PrintManager) getSystemService(Context.PRINT_SERVICE);
                        String t = title == null || title.isEmpty() ? "x.erp" : title;
                        pm.print(t, v.createPrintDocumentAdapter(t), new PrintAttributes.Builder().build());
                    }
                });
                printView.loadDataWithBaseURL(server.isEmpty() ? null : server + "/", html, "text/html", "utf-8", null);
            });
        }

        @JavascriptInterface public void toast(String msg) { ui.post(() -> MainActivity.this.toast(msg)); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_SCAN) {
            if (res == RESULT_OK && data != null) {
                String code = data.getStringExtra("code");
                web.evaluateJavascript("window.__xerpScanResult&&window.__xerpScanResult(" + JSONObject.quote(code) + ")", null);
            }
        } else if (req == REQ_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(res == RESULT_OK && data != null && data.getData() != null ? new Uri[]{data.getData()} : null);
                fileCallback = null;
            }
        } else if (req == REQ_SAVE) {
            if (res == RESULT_OK && data != null && data.getData() != null && pendingSave != null) {
                try (OutputStream os = getContentResolver().openOutputStream(data.getData())) {
                    os.write(pendingSave);
                    toast("已保存");
                } catch (Exception e) {
                    toast("保存失败：" + e.getMessage());
                }
            }
            pendingSave = null;
        }
    }

    void toast(String msg) {
        Toast t = Toast.makeText(this, msg, Toast.LENGTH_SHORT);
        t.setGravity(Gravity.CENTER, 0, 0);
        t.show();
    }

    int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
