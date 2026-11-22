package com.xerp.scanner;

import android.net.Uri;

import org.json.JSONArray;
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

public final class ApiClient {
    private static final int DEFAULT_PORT = 8686;

    public static class ApiException extends Exception {
        public final int status;
        public ApiException(int status, String msg) { super(msg); this.status = status; }
    }

    private ApiClient() { }

    public static String normalizeUrl(String raw) {
        if (raw == null) return "";
        String s = raw.trim();
        if (s.isEmpty()) return "";
        if (!s.matches("(?i)^https?://.*")) s = "http://" + s;
        Uri u = Uri.parse(s);
        if (u.getHost() == null || u.getHost().isEmpty()) return "";
        int port = u.getPort();
        String scheme = u.getScheme().toLowerCase();
        return scheme + "://" + u.getHost() + (port > 0 ? ":" + port : "http".equals(scheme) ? ":" + DEFAULT_PORT : "");
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
            return e.getClass().getSimpleName() + "：" + e.getMessage();
        } finally {
            if (c != null) c.disconnect();
        }
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
            String errMsg = "HTTP " + code;
            try {
                JSONObject ej = new JSONObject(resp);
                if (ej.has("error")) errMsg = ej.getString("error");
            } catch (Exception ignored) { }
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
