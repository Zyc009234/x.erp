package com.xerp.scanner;

import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.MalformedURLException;
import java.net.NetworkInterface;
import java.net.NoRouteToHostException;
import java.net.SocketException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.SSLException;

public final class ApiClient {
    private static final int DEFAULT_PORT = 8686;

    public static class ApiException extends Exception {
        public final int status;
        public ApiException(int status, String msg) { super(msg); this.status = status; }
    }

    private ApiClient() { }

    public static boolean isIpOrLocal(String host) {
        if (host == null || host.isEmpty()) return false;
        if ("localhost".equalsIgnoreCase(host)) return true;
        if (host.contains(":")) return true;
        return host.matches("^\\d{1,3}(\\.\\d{1,3}){3}$");
    }

    private static String normalizePath(Uri u) {
        String p = u.getEncodedPath();
        if (p == null || p.isEmpty() || "/".equals(p)) return "";
        return p.replaceAll("/+$", "");
    }

    public static String normalizeUrl(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        boolean hasScheme = s.matches("(?i)^https?://.*");
        Uri u = Uri.parse(hasScheme ? s : "http://" + s);
        String host = u.getHost();
        if (host == null || host.isEmpty()) return "";
        int port = u.getPort();
        String scheme = u.getScheme().toLowerCase();
        String path = normalizePath(u);
        String portPart = port > 0 ? ":" + port : ("http".equals(scheme) && isIpOrLocal(host) ? ":" + DEFAULT_PORT : "");
        return scheme + "://" + host + portPart + path;
    }

    public static List<String> candidateUrls(String raw) {
        List<String> out = new ArrayList<>();
        if (raw == null) return out;
        String s = raw.trim();
        if (s.isEmpty()) return out;
        boolean hasScheme = s.matches("(?i)^https?://.*");
        Uri u = Uri.parse(hasScheme ? s : "http://" + s);
        String host = u.getHost();
        if (host == null || host.isEmpty()) return out;
        int port = u.getPort();
        String scheme = u.getScheme().toLowerCase();
        String path = normalizePath(u);
        boolean ip = isIpOrLocal(host);
        if (hasScheme) {
            String primary = scheme + "://" + host + (port > 0 ? ":" + port : ("http".equals(scheme) && ip ? ":" + DEFAULT_PORT : "")) + path;
            out.add(primary);
            if ("http".equals(scheme) && port <= 0 && !ip) {
                out.add("https://" + host + path);
            }
        } else if (ip) {
            out.add("http://" + host + (port > 0 ? ":" + port : ":" + DEFAULT_PORT) + path);
        } else if (port > 0) {
            out.add("https://" + host + ":" + port + path);
            out.add("http://" + host + ":" + port + path);
        } else {
            out.add("https://" + host + path);
            out.add("http://" + host + path);
            out.add("http://" + host + ":" + DEFAULT_PORT + path);
        }
        return out;
    }

    public static String ping(String url, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/ping").openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            InputStream is = c.getInputStream();
            String text = readStream(is, 8192);
            return text.contains("\"XERP\"") ? null : "该地址不是 x.erp 服务端";
        } catch (java.net.ConnectException e) {
            return "连接被拒绝（请确认服务端已启动且端口正确）";
        } catch (java.net.SocketTimeoutException e) {
            return "连接超时";
        } catch (java.net.UnknownHostException e) {
            return "找不到该地址";
        } catch (Exception e) {
            return friendlyError(e);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public static String friendlyError(Throwable e) {
        if (e == null) return "操作失败，请稍后重试";
        if (e instanceof ApiException) {
            ApiException ae = (ApiException) e;
            String m = ae.getMessage();
            if (containsChinese(m)) return m;
            switch (ae.status) {
                case 400: return "请求参数不正确，请检查填写内容";
                case 401: return "登录已失效，请重新登录";
                case 403: return "当前账号没有该操作权限";
                case 404: return "服务端不支持该功能，请升级服务端到最新版本";
                case 409: return "数据已存在或发生冲突";
                case 413: return "上传内容太大，请压缩后重试";
                case 429: return "操作过于频繁，请稍后再试";
                case 500: return "服务器处理出错，请稍后重试";
                case 502:
                case 503:
                case 504: return "服务器暂时不可用，请检查服务端是否正常运行";
                default: return "服务器返回错误（状态码 " + ae.status + "）";
            }
        }
        if (e instanceof java.net.ConnectException) return "无法连接服务器，请检查网络及服务端是否已启动";
        if (e instanceof java.net.SocketTimeoutException) return "连接服务器超时，请检查网络是否畅通";
        if (e instanceof java.net.UnknownHostException) return "找不到服务器地址，请检查 IP 或域名是否正确";
        if (e instanceof SSLException) return "安全连接失败，请检查服务器证书或手机时间";
        if (e instanceof MalformedURLException) return "服务器地址格式不正确";
        if (e instanceof NoRouteToHostException || e instanceof SocketException) return "网络连接异常，请检查 Wi-Fi 或移动网络";
        if (e instanceof JSONException) return "服务器返回格式异常，请确认服务器地址为 x.erp 服务端";
        if (e instanceof IOException) return "网络传输中断，请重试";
        if (e instanceof SecurityException) return "缺少系统权限，请在手机设置中开启权限";
        String m = e.getMessage();
        if (containsChinese(m)) return m;
        return "操作失败，请检查网络或稍后重试";
    }

    private static boolean containsChinese(String s) {
        if (s == null) return false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= '\u4e00' && c <= '\u9fa5') return true;
        }
        return false;
    }

    public static List<String> discoverLanServers() {
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
        List<String> found = Collections.synchronizedList(new ArrayList<>());
        if (prefixes.isEmpty()) return found;
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (String pre : prefixes) {
            for (int i = 1; i < 255; i++) {
                String url = "http://" + pre + i + ":" + DEFAULT_PORT;
                pool.execute(() -> { if (ping(url, 600) == null) found.add(url); });
            }
        }
        pool.shutdown();
        try { pool.awaitTermination(25, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return found;
    }

    public static JSONObject probePortal(String url) {
        try {
            return request("GET", url + "/api/portal/info", null, null);
        } catch (Exception e) {
            return null;
        }
    }

    public static JSONObject login(String url, boolean isPortal, String username, String password, String company) throws Exception {
        JSONObject b = new JSONObject();
        b.put("username", username);
        b.put("password", password);
        if (isPortal && company != null && !company.isEmpty()) b.put("company", company);
        return request("POST", url + (isPortal ? "/api/portal/login" : "/api/login"), null, b);
    }

    public static JSONObject switchCompany(AppStore store, String companyCode) throws Exception {
        return request("POST", store.server + "/api/portal/switch", store.token, new JSONObject().put("company", companyCode));
    }

    public static JSONObject fetchData(AppStore store) throws Exception {
        return request("GET", store.server + "/api/data", store.token, null);
    }

    public static JSONObject createProduct(AppStore store, JSONObject body) throws Exception {
        return request("POST", store.server + "/api/products", store.token, body);
    }

    public static JSONObject updateProduct(AppStore store, String id, JSONObject body) throws Exception {
        return request("PUT", store.server + "/api/products/" + id, store.token, body);
    }

    public static JSONObject uploadProductImage(AppStore store, String id, String dataUri) throws Exception {
        return request("PUT", store.server + "/api/products/" + id + "/image", store.token, new JSONObject().put("data", dataUri));
    }

    public static JSONObject saveCategories(AppStore store, List<String> cats) throws Exception {
        return request("PUT", store.server + "/api/categories", store.token, new JSONObject().put("list", new JSONArray(cats)));
    }

    public static JSONObject createCheckDoc(AppStore store, JSONObject body) throws Exception {
        return request("POST", store.server + "/api/checkdocs", store.token, body);
    }

    public static JSONObject saveCheckDoc(AppStore store, String id, JSONObject body) throws Exception {
        return request("PUT", store.server + "/api/checkdocs/" + id, store.token, body);
    }

    public static JSONObject postCheckDoc(AppStore store, String id, JSONObject body) throws Exception {
        return request("POST", store.server + "/api/checkdocs/" + id + "/post", store.token, body);
    }

    public static JSONObject adjustStock(AppStore store, String productId, JSONObject body) throws Exception {
        return request("POST", store.server + "/api/stock/" + productId, store.token, body);
    }

    public static JSONObject createStockDoc(AppStore store, JSONObject body) throws Exception {
        return request("POST", store.server + "/api/stockdocs", store.token, body);
    }

    public static JSONObject createTransfer(AppStore store, JSONObject body) throws Exception {
        return request("POST", store.server + "/api/transfers", store.token, body);
    }

    public static JSONObject request(String method, String fullUrl, String token, JSONObject body) throws Exception {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(fullUrl).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(10000);
            c.setReadTimeout(25000);
            c.setRequestProperty("Accept", "application/json");
            if (token != null && !token.isEmpty()) c.setRequestProperty("Authorization", "Bearer " + token);
            if (body != null) {
                byte[] bytes = body.toString().getBytes("UTF-8");
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                try (OutputStream os = c.getOutputStream()) { os.write(bytes); }
            }
            int code = c.getResponseCode();
            InputStream is = code >= 200 && code < 400 ? c.getInputStream() : c.getErrorStream();
            String resp = is != null ? readStream(is, 8 * 1024 * 1024) : "";
            if (code >= 200 && code < 300) {
                return resp.trim().isEmpty() ? new JSONObject() : new JSONObject(resp);
            }
            String errMsg = "";
            try {
                JSONObject ej = new JSONObject(resp);
                if (ej.has("error")) errMsg = ej.optString("error", "");
            } catch (Exception ignored) { }
            if (!containsChinese(errMsg)) {
                errMsg = friendlyError(new ApiException(code, ""));
            }
            throw new ApiException(code, errMsg);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String readStream(InputStream is, int maxBytes) throws Exception {
        try (InputStream in = is; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0 && out.size() < maxBytes) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }
}
