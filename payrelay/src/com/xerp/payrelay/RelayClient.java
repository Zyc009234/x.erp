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
}
