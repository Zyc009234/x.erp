package com.xerp.payrelay;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public class RelayClient {
    public static final String PREFS = "relay";
    public static final String DEFAULT_BASE = "https://www.zhaoyoucai.xyz/xerp-cloud";
    private static final String TAG = "XerpPayRelay";

    public static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public static String base(Context c) {
        String s = prefs(c).getString("base", DEFAULT_BASE).trim();
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    public static boolean configured(Context c) {
        return !prefs(c).getString("device", "").isEmpty() && !prefs(c).getString("secret", "").isEmpty();
    }

    public static String hex(byte[] b) {
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x & 0xff));
        return s.toString();
    }

    public static String hmac(String secret, String msg) throws Exception {
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(mac.doFinal(msg.getBytes(StandardCharsets.UTF_8)));
    }

    public static String randomNonce() {
        byte[] b = new byte[8];
        new SecureRandom().nextBytes(b);
        return hex(b);
    }

    public static String post(Context c, String path, String source, long amountCents, String text) throws Exception {
        SharedPreferences p = prefs(c);
        String device = p.getString("device", "").trim();
        String secret = p.getString("secret", "").trim();
        if (device.isEmpty() || secret.isEmpty()) throw new Exception("还没有填写设备 ID 和密钥");
        long at = System.currentTimeMillis() / 1000;
        String nonce = randomNonce();
        String msg = device + "\n" + source + "\n" + amountCents + "\n" + at + "\n" + nonce;
        JSONObject body = new JSONObject();
        body.put("device", device);
        body.put("source", source);
        body.put("amount", amountCents);
        body.put("at", at);
        body.put("nonce", nonce);
        body.put("text", text == null ? "" : text);
        body.put("sign", hmac(secret, msg));
        HttpURLConnection conn = (HttpURLConnection) new URL(base(c) + path).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(20000);
        conn.setRequestMethod("POST");
        conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
        conn.setDoOutput(true);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body.toString().getBytes(StandardCharsets.UTF_8));
        }
        int code = conn.getResponseCode();
        String resp = "";
        try {
            java.io.InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            if (is != null) {
                java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[1024];
                int n;
                while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
                resp = bos.toString("UTF-8");
            }
        } catch (Exception ignored) {}
        Log.i(TAG, path + " -> " + code + " " + resp);
        if (code >= 400) throw new Exception("服务器返回 " + code + " " + resp);
        return resp;
    }

    // 到账回调失败自动重试，最终失败写本地日志并记下最后一次，避免静默丢单
    public static String postWithRetry(Context c, String path, String source, long amountCents, String text, int attempts) {
        Exception last = null;
        for (int i = 1; i <= attempts; i++) {
            try {
                return post(c, path, source, amountCents, text);
            } catch (Exception e) {
                last = e;
                trace(c, "第 " + i + "/" + attempts + " 次失败 " + path + " amount=" + amountCents + "：" + e.getMessage());
                if (i < attempts) {
                    try { Thread.sleep(i == 1 ? 2000 : 5000); }
                    catch (InterruptedException ie) { Thread.currentThread().interrupt(); break; }
                }
            }
        }
        String msg = last == null ? "未知错误" : last.getMessage();
        prefs(c).edit().putString("lastFail",
                new java.text.SimpleDateFormat("MM-dd HH:mm", java.util.Locale.CHINA).format(new java.util.Date())
                        + " 金额 " + amountCents + "：" + msg).apply();
        trace(c, "放弃 " + path + " amount=" + amountCents + " text=" + text + "：" + msg);
        return null;
    }

    public static void trace(Context c, String line) {
        try {
            java.io.File f = new java.io.File(c.getFilesDir(), "relay.log");
            if (f.length() > 128 * 1024) {
                java.io.File old = new java.io.File(c.getFilesDir(), "relay.old.log");
                if (old.exists()) old.delete();
                f.renameTo(old);
            }
            java.io.FileWriter w = new java.io.FileWriter(f, true);
            w.write(new java.text.SimpleDateFormat("MM-dd HH:mm:ss", java.util.Locale.CHINA).format(new java.util.Date()) + " " + line + "\n");
            w.close();
        } catch (Exception ignored) {}
    }

    public static String readTrace(Context c, int maxLines) {
        java.io.BufferedReader r = null;
        try {
            java.io.File f = new java.io.File(c.getFilesDir(), "relay.log");
            if (!f.exists()) return "还没有记录";
            java.util.ArrayList<String> lines = new java.util.ArrayList<>();
            r = new java.io.BufferedReader(new java.io.InputStreamReader(new java.io.FileInputStream(f), "UTF-8"));
            String s;
            while ((s = r.readLine()) != null) {
                lines.add(s);
                if (lines.size() > maxLines * 3) lines.subList(0, lines.size() - maxLines).clear();
            }
            int from = Math.max(0, lines.size() - maxLines);
            StringBuilder sb = new StringBuilder();
            for (int i = from; i < lines.size(); i++) sb.append(lines.get(i)).append('\n');
            return sb.length() == 0 ? "还没有记录" : sb.toString();
        } catch (Exception e) {
            return "读取失败：" + e.getMessage();
        } finally {
            try { if (r != null) r.close(); } catch (Exception ignored) {}
        }
    }
}
