package com.xerp.scanner;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class AppStore {
    private static AppStore INST;
    private final Context ctx;
    private final SharedPreferences prefs;

    // Session
    public String server = "";
    public String token = "";
    public String username = "";
    public String userName = "";
    public boolean isPortal;
    public String companyCode = "default";
    public String companyName = "";
    public List<Models.Company> companies = new ArrayList<>();
    public Set<String> perms = new HashSet<>();
    public boolean seesPrice = true;
    public String defaultWh = "w1";
    public String selectedWh = "w1";
    public List<String> docTypesIn = new ArrayList<>();
    public List<String> docTypesOut = new ArrayList<>();

    // Preferences
    public boolean continuousScan = true;
    public boolean soundEnabled = true;
    public boolean vibrateEnabled = true;
    public int cooldownMs = 800;
    public boolean autoPromptNew = true;
    public boolean leftHanded = false;
    public boolean pdaHidMode = true;
    public boolean ttsEnabled = true;
    public float ttsRate = 1.2f;
    public boolean blindMode = false;
    public static final String DEFAULT_SUBTITLE = "轻量开源进销存 · 单手扫码盘点";
    public String splashTitle = "";
    public String splashSubtitle = DEFAULT_SUBTITLE;

    private Bitmap cachedLogo;
    private boolean logoLoaded = false;

    // Data
    public List<Models.Product> products = new ArrayList<>();
    public List<Models.Warehouse> warehouses = new ArrayList<>();
    public List<String> categories = new ArrayList<>();
    public List<Models.CheckDoc> checkDocs = new ArrayList<>();
    public List<Models.BatchRec> batches = new ArrayList<>();
    public List<Models.SerialRec> serials = new ArrayList<>();

    // Indexes
    public Map<String, Models.Product> productById = new HashMap<>();
    public Map<String, Models.BarcodeMatch> exactCodeIndex = new HashMap<>();
    public Map<String, Models.BarcodeMatch> lowerCodeIndex = new HashMap<>();
    public Map<String, Models.SerialRec> serialBySn = new HashMap<>();
    public Map<String, List<Models.BatchRec>> batchesByNo = new HashMap<>();

    // Label Queue
    public List<Models.LabelJob> labelQueue = new ArrayList<>();

    private AppStore(Context c) {
        ctx = c.getApplicationContext();
        prefs = ctx.getSharedPreferences("xerp_scanner", Context.MODE_PRIVATE);
        loadPrefs();
    }

    public static synchronized AppStore get(Context c) {
        if (INST == null) INST = new AppStore(c);
        return INST;
    }

    private void loadPrefs() {
        server = prefs.getString("server", "");
        token = prefs.getString("token", "");
        username = prefs.getString("username", "");
        userName = prefs.getString("userName", "");
        isPortal = prefs.getBoolean("isPortal", false);
        companyCode = prefs.getString("companyCode", "default");
        companyName = prefs.getString("companyName", "");
        selectedWh = prefs.getString("selectedWh", "w1");
        continuousScan = prefs.getBoolean("continuousScan", true);
        soundEnabled = prefs.getBoolean("soundEnabled", true);
        vibrateEnabled = prefs.getBoolean("vibrateEnabled", true);
        cooldownMs = prefs.getInt("cooldownMs", 800);
        autoPromptNew = prefs.getBoolean("autoPromptNew", true);
        leftHanded = prefs.getBoolean("leftHanded", false);
        pdaHidMode = prefs.getBoolean("pdaHidMode", true);
        ttsEnabled = prefs.getBoolean("ttsEnabled", true);
        ttsRate = prefs.getFloat("ttsRate", 1.2f);
        blindMode = prefs.getBoolean("blindMode", false);
        splashTitle = prefs.getString("splashTitle", "");
        String sub = prefs.getString("splashSubtitle", "");
        if (!sub.isEmpty()) splashSubtitle = sub;
        try {
            JSONArray cs = new JSONArray(prefs.getString("companies", "[]"));
            companies.clear();
            for (int i = 0; i < cs.length(); i++) {
                JSONObject o = cs.optJSONObject(i);
                if (o != null) companies.add(Models.Company.fromJson(o));
            }
        } catch (Exception ignored) { }
    }

    public void saveSession() {
        JSONArray cs = new JSONArray();
        for (Models.Company c : companies) {
            try {
                cs.put(new JSONObject().put("code", c.code).put("name", c.name));
            } catch (Exception ignored) { }
        }
        prefs.edit()
                .putString("server", server)
                .putString("token", token)
                .putString("username", username)
                .putString("userName", userName)
                .putBoolean("isPortal", isPortal)
                .putString("companyCode", companyCode)
                .putString("companyName", companyName)
                .putString("selectedWh", selectedWh)
                .putString("companies", cs.toString())
                .apply();
    }

    public void saveRecentServer(String url) {
        List<String> list = getRecentServers();
        list.remove(url);
        list.add(0, url);
        if (list.size() > 5) list = list.subList(0, 5);
        prefs.edit().putString("recentServers", new JSONArray(list).toString()).apply();
    }

    public List<String> getRecentServers() {
        List<String> out = new ArrayList<>();
        try {
            JSONArray a = new JSONArray(prefs.getString("recentServers", "[]"));
            for (int i = 0; i < a.length(); i++) {
                String s = a.optString(i, "");
                if (!s.isEmpty() && !out.contains(s)) out.add(s);
            }
        } catch (Exception ignored) { }
        return out;
    }

    public void savePrefs() {
        prefs.edit()
                .putString("selectedWh", selectedWh)
                .putBoolean("continuousScan", continuousScan)
                .putBoolean("soundEnabled", soundEnabled)
                .putBoolean("vibrateEnabled", vibrateEnabled)
                .putInt("cooldownMs", cooldownMs)
                .putBoolean("autoPromptNew", autoPromptNew)
                .putBoolean("leftHanded", leftHanded)
                .putBoolean("pdaHidMode", pdaHidMode)
                .putBoolean("ttsEnabled", ttsEnabled)
                .putFloat("ttsRate", ttsRate)
                .putBoolean("blindMode", blindMode)
                .putString("splashTitle", splashTitle == null ? "" : splashTitle)
                .putString("splashSubtitle", splashSubtitle == null ? "" : splashSubtitle)
                .apply();
    }

    public String effectiveSplashTitle() {
        if (splashTitle != null && !splashTitle.trim().isEmpty()) {
            return splashTitle.trim();
        }
        if (hasCustomLogo() && companyName != null) {
            String co = companyName.trim();
            if (!co.isEmpty() && !co.contains("示例") && !"默认公司".equals(co)) {
                return co;
            }
        }
        return "x.erp";
    }

    public boolean isDefaultBrand() {
        return "x.erp".equals(effectiveSplashTitle());
    }

    private File companyLogoFile() {
        return new File(ctx.getFilesDir(), "company_logo.png");
    }

    public boolean hasCustomLogo() {
        return companyLogoFile().isFile();
    }

    public synchronized Bitmap getCustomLogo() {
        if (!logoLoaded) {
            File f = companyLogoFile();
            if (f.isFile()) {
                try { cachedLogo = BitmapFactory.decodeFile(f.getAbsolutePath()); } catch (Exception ignored) { cachedLogo = null; }
            }
            logoLoaded = true;
        }
        return cachedLogo;
    }

    public synchronized void saveCustomLogo(Bitmap src) throws Exception {
        if (src == null) throw new Exception("无法读取所选图片");
        int maxDim = 512;
        Bitmap scaled = src;
        if (src.getWidth() > maxDim || src.getHeight() > maxDim) {
            float r = Math.min((float) maxDim / src.getWidth(), (float) maxDim / src.getHeight());
            int nw = Math.max(1, Math.round(src.getWidth() * r));
            int nh = Math.max(1, Math.round(src.getHeight() * r));
            scaled = Bitmap.createScaledBitmap(src, nw, nh, true);
        }
        File f = companyLogoFile();
        try (FileOutputStream fos = new FileOutputStream(f)) {
            if (!scaled.compress(Bitmap.CompressFormat.PNG, 100, fos)) {
                throw new Exception("保存 Logo 失败");
            }
        }
        if (scaled != src) src.recycle();
        cachedLogo = BitmapFactory.decodeFile(f.getAbsolutePath());
        logoLoaded = true;
    }

    public synchronized void clearCustomLogo() {
        try { companyLogoFile().delete(); } catch (Exception ignored) { }
        cachedLogo = null;
        logoLoaded = true;
    }

    public static Bitmap decodeSampledUri(Context ctx, Uri uri, int maxDim) throws Exception {
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inJustDecodeBounds = true;
        try (java.io.InputStream is = ctx.getContentResolver().openInputStream(uri)) {
            if (is == null) throw new Exception("无法打开所选图片");
            BitmapFactory.decodeStream(is, null, opts);
        }
        if (opts.outWidth <= 0 || opts.outHeight <= 0) throw new Exception("无效的图片格式");
        int sample = 1;
        while (opts.outWidth / (sample * 2) >= maxDim && opts.outHeight / (sample * 2) >= maxDim) {
            sample *= 2;
        }
        BitmapFactory.Options dec = new BitmapFactory.Options();
        dec.inSampleSize = sample;
        Bitmap bmp;
        try (java.io.InputStream is = ctx.getContentResolver().openInputStream(uri)) {
            if (is == null) throw new Exception("无法读取所选图片");
            bmp = BitmapFactory.decodeStream(is, null, dec);
        }
        if (bmp == null) throw new Exception("图片解码失败，请换一张图片");
        if (bmp.getWidth() > maxDim || bmp.getHeight() > maxDim) {
            float r = Math.min((float) maxDim / bmp.getWidth(), (float) maxDim / bmp.getHeight());
            int nw = Math.max(1, Math.round(bmp.getWidth() * r));
            int nh = Math.max(1, Math.round(bmp.getHeight() * r));
            Bitmap scaled = Bitmap.createScaledBitmap(bmp, nw, nh, true);
            bmp.recycle();
            return scaled;
        }
        return bmp;
    }

    public void clearAuth() {
        token = "";
        perms.clear();
        prefs.edit().remove("token").apply();
    }

    public boolean can(String perm) {
        return perms.contains(perm);
    }

    public String whName(String id) {
        for (Models.Warehouse w : warehouses) {
            if (w.id.equals(id)) return w.name;
        }
        return "默认仓库";
    }

    public synchronized void reloadFromJson(JSONObject root) {
        JSONObject settings = root.optJSONObject("settings");
        if (settings != null) {
            String co = settings.optString("company", "");
            if (!co.isEmpty()) companyName = co;
        }
        JSONObject user = root.optJSONObject("user");
        perms.clear();
        if (user != null) {
            username = user.optString("username", username);
            userName = user.optString("name", userName);
            JSONArray ps = user.optJSONArray("perms");
            if (ps != null) for (int i = 0; i < ps.length(); i++) perms.add(ps.optString(i));
        }
        seesPrice = perms.isEmpty() || perms.contains("inv.cost") || perms.contains("sales") || perms.contains("purchase") || perms.contains("finance") || perms.contains("reports") || perms.contains("dashboard");

        JSONObject meta = root.optJSONObject("meta");
        docTypesIn.clear();
        docTypesOut.clear();
        if (meta != null) {
            defaultWh = meta.optString("defaultWh", "w1");
            JSONObject dt = meta.optJSONObject("docTypes");
            if (dt != null) {
                JSONArray ain = dt.optJSONArray("in");
                if (ain != null) for (int i = 0; i < ain.length(); i++) docTypesIn.add(ain.optString(i));
                JSONArray aout = dt.optJSONArray("out");
                if (aout != null) for (int i = 0; i < aout.length(); i++) docTypesOut.add(aout.optString(i));
            }
        }
        if (docTypesIn.isEmpty()) {
            docTypesIn.add("其他入库"); docTypesIn.add("采购入库"); docTypesIn.add("生产入库");
        }
        if (docTypesOut.isEmpty()) {
            docTypesOut.add("其他出库"); docTypesOut.add("领料出库"); docTypesOut.add("报损出库"); docTypesOut.add("销售出库");
        }

        JSONObject data = root.optJSONObject("data");
        if (data == null) data = new JSONObject();

        warehouses.clear();
        JSONArray whArr = data.optJSONArray("warehouses");
        if (whArr != null) {
            for (int i = 0; i < whArr.length(); i++) {
                JSONObject o = whArr.optJSONObject(i);
                if (o != null) warehouses.add(Models.Warehouse.fromJson(o));
            }
        }
        if (warehouses.isEmpty()) {
            Models.Warehouse w = new Models.Warehouse();
            w.id = defaultWh;
            w.name = "默认仓库";
            warehouses.add(w);
        }
        boolean whExists = false;
        for (Models.Warehouse w : warehouses) if (w.id.equals(selectedWh)) { whExists = true; break; }
        if (!whExists) selectedWh = warehouses.get(0).id;

        products.clear();
        JSONArray pArr = data.optJSONArray("products");
        if (pArr != null) {
            for (int i = 0; i < pArr.length(); i++) {
                JSONObject o = pArr.optJSONObject(i);
                if (o != null) products.add(Models.Product.fromJson(o));
            }
        }

        Set<String> catSet = new LinkedHashSet<>();
        if (settings != null) {
            JSONArray cs = settings.optJSONArray("categories");
            if (cs != null) for (int i = 0; i < cs.length(); i++) {
                String s = cs.optString(i, "").trim();
                if (!s.isEmpty()) catSet.add(s);
            }
        }
        for (Models.Product p : products) {
            if (!p.category.trim().isEmpty()) catSet.add(p.category.trim());
        }
        categories = new ArrayList<>(catSet);

        checkDocs.clear();
        JSONArray cArr = data.optJSONArray("checkDocs");
        if (cArr != null) {
            for (int i = 0; i < cArr.length(); i++) {
                JSONObject o = cArr.optJSONObject(i);
                if (o != null) checkDocs.add(Models.CheckDoc.fromJson(o));
            }
        }

        batches.clear();
        JSONArray bArr = data.optJSONArray("batches");
        if (bArr != null) {
            for (int i = 0; i < bArr.length(); i++) {
                JSONObject o = bArr.optJSONObject(i);
                if (o != null) batches.add(Models.BatchRec.fromJson(o));
            }
        }

        serials.clear();
        JSONArray sArr = data.optJSONArray("serials");
        if (sArr != null) {
            for (int i = 0; i < sArr.length(); i++) {
                JSONObject o = sArr.optJSONObject(i);
                if (o != null) serials.add(Models.SerialRec.fromJson(o));
            }
        }

        rebuildIndexes();
        saveSession();
    }

    public synchronized void upsertProduct(Models.Product p) {
        if (p == null || p.id.isEmpty()) return;
        boolean replaced = false;
        for (int i = 0; i < products.size(); i++) {
            if (products.get(i).id.equals(p.id)) {
                products.set(i, p);
                replaced = true;
                break;
            }
        }
        if (!replaced) products.add(0, p);
        if (!p.category.trim().isEmpty() && !categories.contains(p.category.trim())) {
            categories.add(p.category.trim());
        }
        rebuildIndexes();
    }

    public synchronized void rebuildIndexes() {
        productById.clear();
        exactCodeIndex.clear();
        lowerCodeIndex.clear();
        for (Models.Product p : products) {
            productById.put(p.id, p);
            indexCode(p.barcode, new Models.BarcodeMatch(p, null));
            for (Models.UnitSpec u : p.units) {
                indexCode(u.barcode, new Models.BarcodeMatch(p, u));
            }
        }
        // Index SKU separately so explicit barcodes win if equal
        for (Models.Product p : products) {
            if (p.sku != null && !p.sku.trim().isEmpty()) {
                String k = p.sku.trim();
                if (!exactCodeIndex.containsKey(k)) {
                    exactCodeIndex.put(k, new Models.BarcodeMatch(p, null));
                    lowerCodeIndex.put(k.toLowerCase(Locale.ROOT), new Models.BarcodeMatch(p, null));
                }
            }
        }

        serialBySn.clear();
        for (Models.SerialRec s : serials) {
            if (!s.sn.trim().isEmpty()) serialBySn.put(s.sn.trim(), s);
        }

        batchesByNo.clear();
        for (Models.BatchRec b : batches) {
            if (b.no.trim().isEmpty()) continue;
            List<Models.BatchRec> list = batchesByNo.get(b.no.trim());
            if (list == null) { list = new ArrayList<>(); batchesByNo.put(b.no.trim(), list); }
            list.add(b);
        }
    }

    private void indexCode(String code, Models.BarcodeMatch m) {
        if (code == null) return;
        String t = code.trim();
        if (t.isEmpty()) return;
        exactCodeIndex.put(t, m);
        lowerCodeIndex.put(t.toLowerCase(Locale.ROOT), m);
    }

    public synchronized Models.BarcodeMatch findByCode(String code) {
        if (code == null) return null;
        String t = code.trim();
        if (t.isEmpty()) return null;
        Models.BarcodeMatch m = exactCodeIndex.get(t);
        if (m != null) return m;
        return lowerCodeIndex.get(t.toLowerCase(Locale.ROOT));
    }

    public synchronized Set<String> allUsedCodes() {
        Set<String> set = new HashSet<>();
        for (Models.Product p : products) {
            if (!p.sku.isEmpty()) set.add(p.sku);
            if (!p.barcode.isEmpty()) set.add(p.barcode);
            for (Models.UnitSpec u : p.units) if (!u.barcode.isEmpty()) set.add(u.barcode);
        }
        return set;
    }

    public void addToLabelQueue(Models.Product p, Models.UnitSpec u, int addCopies) {
        for (Models.LabelJob j : labelQueue) {
            String ju = j.unit == null ? "" : j.unit.name;
            String uu = u == null ? "" : u.name;
            if (j.product.id.equals(p.id) && ju.equals(uu)) {
                j.copies = Math.max(1, j.copies + addCopies);
                j.product = p;
                j.unit = u;
                return;
            }
        }
        labelQueue.add(0, new Models.LabelJob(p, u, Math.max(1, addCopies)));
    }

    /* ---------- 离线安全盘点草稿 ---------- */
    private File draftFile(String docId) {
        File dir = new File(ctx.getFilesDir(), "drafts");
        if (!dir.exists()) dir.mkdirs();
        String safeCo = (companyCode == null ? "default" : companyCode).replaceAll("[^a-zA-Z0-9_-]", "_");
        return new File(dir, "check_" + safeCo + "_" + docId + ".json");
    }

    public void saveDraft(String docId, Map<String, Double> countedMap, Set<String> addedIds) {
        try {
            JSONObject root = new JSONObject();
            JSONObject vals = new JSONObject();
            for (Map.Entry<String, Double> e : countedMap.entrySet()) {
                if (e.getValue() == null) vals.put(e.getKey(), JSONObject.NULL);
                else vals.put(e.getKey(), e.getValue());
            }
            root.put("counts", vals);
            root.put("added", new JSONArray(addedIds));
            root.put("savedAt", System.currentTimeMillis());
            try (FileOutputStream fos = new FileOutputStream(draftFile(docId))) {
                fos.write(root.toString().getBytes("UTF-8"));
            }
        } catch (Exception ignored) { }
    }

    public JSONObject loadDraft(String docId) {
        File f = draftFile(docId);
        if (!f.isFile()) return null;
        try (FileInputStream fis = new FileInputStream(f); ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[4096];
            int n;
            while ((n = fis.read(buf)) > 0) bos.write(buf, 0, n);
            return new JSONObject(bos.toString("UTF-8"));
        } catch (Exception e) {
            return null;
        }
    }

    public void deleteDraft(String docId) {
        try { draftFile(docId).delete(); } catch (Exception ignored) { }
    }

    public int countDrafts() {
        File dir = new File(ctx.getFilesDir(), "drafts");
        File[] fs = dir.listFiles();
        return fs == null ? 0 : fs.length;
    }

    public void clearAllDrafts() {
        File dir = new File(ctx.getFilesDir(), "drafts");
        File[] fs = dir.listFiles();
        if (fs != null) for (File f : fs) f.delete();
    }
}
