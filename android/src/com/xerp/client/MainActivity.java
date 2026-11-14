package com.xerp.client;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
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
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.security.MessageDigest;
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
    private static final String UPDATE_MANIFEST = "https://www.zhaoyoucai.xyz/xerp/updates.json";

    private WebView web;
    private FrameLayout root;
    private SharedPreferences prefs;
    private String server = "";
    private ValueCallback<Uri[]> fileCallback;
    private byte[] pendingSave;
    private WebView printView;
    private int versionCode = 0;
    private File pendingInstall;
    private long lastBack;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private int connSeq = 0;          // 每次连接加 1，旧的连接结果、超时检查作废
    private boolean pageDone = true;  // 服务端首页是否已加载完
    private static final int LOAD_TIMEOUT = 20000;
    private LinearLayout connBox;     // 「正在连接」遮罩：原生控件，WebView 还没启动好也能马上显示
    private TextView connAddr;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("xerp", MODE_PRIVATE);
        server = prefs.getString("server", "");
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            VERSION = pi.versionName;
            versionCode = Build.VERSION.SDK_INT >= 28 ? (int) pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception ignored) { }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        applyInsets();
        setupWebView();
        setupBack();

        if (server.isEmpty()) askServer(true);
        else connect();
        if (!server.isEmpty()) ui.postDelayed(this::autoCheckUpdate, 5000);
    }

    /* ---------- 连接：先显示「正在连接」页（随时可以更换服务器），5 秒探测服务端，通了再打开；打开超过 15 秒也提示 ---------- */
    private void connect() {
        int seq = ++connSeq;
        String url = server;
        showConnecting();
        new Thread(() -> {
            String err = ping(url, 5000);
            ui.post(() -> {
                if (seq != connSeq) return;  // 期间换了服务器或点了重试
                if (err != null) { showError(err); return; }
                openServer(seq);
            });
        }).start();
    }

    private void openServer(int seq) {
        pageDone = false;
        web.loadUrl(server + "/");
        ui.postDelayed(() -> {
            if (seq != connSeq || pageDone) return;
            connSeq++;
            web.stopLoading();
            showError("服务器响应太慢（超过 " + LOAD_TIMEOUT / 1000 + " 秒）");
        }, LOAD_TIMEOUT);
    }

    private void showConnecting() {
        if (connBox == null) {
            connBox = new LinearLayout(this);
            connBox.setOrientation(LinearLayout.VERTICAL);
            connBox.setGravity(Gravity.CENTER_HORIZONTAL);
            connBox.setBackgroundColor(Color.WHITE);
            connBox.setPadding(dp(24), dp(120), dp(24), 0);
            connBox.setClickable(true);  // 挡住下面的 WebView
            ProgressBar pb = new ProgressBar(this);
            connBox.addView(pb, new LinearLayout.LayoutParams(dp(44), dp(44)));
            TextView t = new TextView(this);
            t.setText("正在连接服务器…");
            t.setTextSize(18);
            t.setTextColor(0xFF1F2937);
            t.setGravity(Gravity.CENTER);
            t.setPadding(0, dp(18), 0, dp(6));
            connBox.addView(t);
            connAddr = new TextView(this);
            connAddr.setTextSize(14);
            connAddr.setTextColor(0xFF6B7280);
            connAddr.setGravity(Gravity.CENTER);
            connBox.addView(connAddr);
            Button b = new Button(this);
            b.setText("更换服务器");
            b.setTextSize(16);
            b.setAllCaps(false);
            b.setTextColor(0xFF4F46E5);
            b.setBackgroundColor(0xFFEEF2FF);
            b.setOnClickListener(v -> askServer(false));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(280), dp(48));
            lp.topMargin = dp(32);
            connBox.addView(b, lp);
            root.addView(connBox, new FrameLayout.LayoutParams(-1, -1));
        }
        connAddr.setText(server);
        connBox.setVisibility(View.VISIBLE);
    }

    private void hideConnecting() { if (connBox != null) connBox.setVisibility(View.GONE); }

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
                // 服务端自己的页面留在应用里，其他链接（官网、GitHub 等）交给系统浏览器
                if (!server.isEmpty() && u.toString().startsWith(server)) return false;
                try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException e) { toast("没有可以打开链接的应用"); }
                return true;
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) { markDone(url); }

            @Override
            public void onPageFinished(WebView view, String url) { markDone(url); }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req.isForMainFrame()) { connSeq++; showError(String.valueOf(err.getDescription())); }
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
        showConnecting();
        openServer(++connSeq);  // 刚探测过，直接打开
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

    private void markDone(String url) {
        if (url != null && !server.isEmpty() && url.startsWith(server)) { pageDone = true; hideConnecting(); }
    }

    private void showError(String why) {
        hideConnecting();
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

    /* ---------- 安卓客户端更新：自动检查，下载后交给系统安装程序，用户还要再确认一次 ---------- */
    private void autoCheckUpdate() {
        long last = prefs.getLong("lastUpdateCheck", 0);
        if (System.currentTimeMillis() - last < 24 * 3600 * 1000L) return;
        prefs.edit().putLong("lastUpdateCheck", System.currentTimeMillis()).apply();
        runUpdateCheck(false);
    }

    private void runUpdateCheck(boolean manual) {
        if (manual) ui.post(() -> toast("正在检查客户端更新…"));
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(UPDATE_MANIFEST).openConnection();
                c.setConnectTimeout(8000);
                c.setReadTimeout(8000);
                c.setRequestProperty("User-Agent", "x.erp/" + VERSION);
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                JSONObject j = new JSONObject(readText(c.getInputStream()));
                JSONObject pkgs = j.optJSONObject("packages");
                JSONObject p = pkgs == null ? null : pkgs.optJSONObject("android");
                if (p == null) throw new Exception("更新清单里没有安卓版本");
                String latest = p.optString("version", "");
                int latestCode = p.optInt("versionCode", 0);
                boolean newer = latestCode > 0 ? latestCode > versionCode : compareVersion(latest, VERSION) > 0;
                if (!newer) {
                    if (manual) ui.post(() -> toast("已是最新版本 v" + VERSION));
                    return;
                }
                String url = p.optString("url", ""), sha = p.optString("sha256", "");
                if (url.isEmpty() || sha.isEmpty()) throw new Exception("更新清单缺少安装包地址");
                long size = p.optLong("size", 0);
                String notes = notesText(j.optJSONArray("notes"));
                ui.post(() -> showUpdateDialog(latest, url, sha, size, notes));
            } catch (Exception e) {
                if (manual) ui.post(() -> toast("检查更新失败：" + e.getMessage()));
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    private static String readText(InputStream in) throws Exception {
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static String notesText(JSONArray arr) {
        if (arr == null) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < arr.length(); i++) b.append("• ").append(arr.optString(i)).append('\n');
        return b.toString();
    }

    private void showUpdateDialog(String latest, String url, String sha, long size, String notes) {
        if (isFinishing() || isDestroyed()) return;
        String msg = "当前版本 v" + VERSION + "，最新版本 v" + latest + (size > 0 ? " · " + formatSize(size) : "") + "\n\n"
            + (notes == null ? "" : notes) + "\n下载后系统会再次确认安装，不会静默更新。";
        new AlertDialog.Builder(this)
            .setTitle("发现新版本 v" + latest)
            .setMessage(msg)
            .setPositiveButton("下载并安装", (d, w) -> downloadUpdate(latest, url, sha, size))
            .setNegativeButton("稍后", null)
            .show();
    }

    private void downloadUpdate(String version, String url, String sha, long size) {
        File base = getExternalFilesDir(null);
        if (base == null) base = getFilesDir();
        File dir = new File(base, "updates");
        if (!dir.exists() && !dir.mkdirs()) { toast("无法创建下载目录"); return; }
        File file = new File(dir, "xerp-" + version + ".apk");
        ProgressDialog pd = new ProgressDialog(this);
        pd.setTitle("下载 x.erp " + version);
        pd.setMessage("准备下载…");
        pd.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        pd.setMax(100);
        pd.setCancelable(false);
        pd.show();
        new Thread(() -> {
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(url).openConnection();
                c.setConnectTimeout(10000);
                c.setReadTimeout(30000);
                c.setRequestProperty("User-Agent", "x.erp/" + VERSION);
                int code = c.getResponseCode();
                if (code != 200) throw new Exception("HTTP " + code);
                long total = c.getContentLengthLong();
                if (total <= 0) total = size;
                long got = 0;
                int lastPct = -1;
                try (InputStream in = c.getInputStream(); FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buf = new byte[16384];
                    int n;
                    while ((n = in.read(buf)) > 0) {
                        out.write(buf, 0, n);
                        got += n;
                        if (total > 0) {
                            int pct = (int) (got * 100 / total);
                            if (pct != lastPct) {
                                lastPct = pct;
                                final int show = pct;
                                ui.post(() -> { if (pd.isShowing()) pd.setProgress(show); });
                            }
                        }
                    }
                }
                String hash = sha256(file);
                if (!hash.equalsIgnoreCase(sha)) throw new Exception("安装包 SHA-256 校验失败");
                ui.post(() -> { pd.dismiss(); installApk(file); });
            } catch (Exception e) {
                try { file.delete(); } catch (Exception ignored) { }
                ui.post(() -> { pd.dismiss(); toast("下载失败：" + e.getMessage()); });
            } finally {
                if (c != null) c.disconnect();
            }
        }).start();
    }

    private static String sha256(File file) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder s = new StringBuilder();
        for (byte b : md.digest()) s.append(String.format("%02x", b));
        return s.toString();
    }

    private void installApk(File file) {
        if (Build.VERSION.SDK_INT >= 26 && !getPackageManager().canRequestPackageInstalls()) {
            pendingInstall = file;
            toast("请允许 x.erp 安装未知应用，返回后会继续安装");
            try { startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName()))); }
            catch (Exception e) { toast("请在系统设置里允许安装未知应用"); }
            return;
        }
        pendingInstall = null;
        Uri uri = Uri.parse("content://com.xerp.client.updates/" + Uri.encode(file.getName()));
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        try { startActivity(i); }
        catch (ActivityNotFoundException e) { toast("没有找到系统安装程序"); }
    }

    private static String formatSize(long n) {
        if (n >= 1024 * 1024) return String.format("%.1f MB", n / 1024.0 / 1024.0);
        return Math.max(1, Math.round(n / 1024.0)) + " KB";
    }

    private static int compareVersion(String a, String b) {
        String[] x = String.valueOf(a).split("\\."), y = String.valueOf(b).split("\\.");
        for (int i = 0; i < 3; i++) {
            int n = i < x.length ? parseInt(x[i]) : 0, m = i < y.length ? parseInt(y[i]) : 0;
            if (n != m) return n - m;
        }
        return 0;
    }

    private static int parseInt(String s) {
        try { return Integer.parseInt(s); } catch (Exception e) { return 0; }
    }

    /* ---------- 页面调用的手机能力 ---------- */
    class Bridge {
        @JavascriptInterface public String version() { return VERSION; }
        @JavascriptInterface public String server() { return server; }
        @JavascriptInterface public void checkAppUpdate() { runUpdateCheck(true); }

        @JavascriptInterface public void scan() {
            ui.post(() -> startActivityForResult(new Intent(MainActivity.this, ScanActivity.class), REQ_SCAN));
        }

        @JavascriptInterface public void changeServer() { ui.post(() -> askServer(false)); }

        @JavascriptInterface public void retry() { ui.post(() -> { if (server.isEmpty()) askServer(true); else connect(); }); }

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
    protected void onResume() {
        super.onResume();
        if (pendingInstall != null && (Build.VERSION.SDK_INT < 26 || getPackageManager().canRequestPackageInstalls())) {
            File f = pendingInstall;
            pendingInstall = null;
            ui.postDelayed(() -> installApk(f), 300);
        }
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
