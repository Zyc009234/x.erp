package com.xerp.scanner;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

public final class Models {
    private Models() { }

    public static class Company {
        public String code = "";
        public String name = "";
        public static Company fromJson(JSONObject j) {
            Company c = new Company();
            c.code = j.optString("code", "");
            c.name = j.optString("name", c.code);
            return c;
        }
    }

    public static class UnitSpec {
        public String name = "";
        public double rate = 1;
        public String barcode = "";
        public Double price;

        public static UnitSpec fromJson(JSONObject j) {
            UnitSpec u = new UnitSpec();
            u.name = j.optString("name", "");
            double r = j.optDouble("rate", 1);
            u.rate = (Double.isFinite(r) && r > 0) ? r : 1;
            u.barcode = j.optString("barcode", "");
            if (j.has("price") && !j.isNull("price")) u.price = j.optDouble("price", 0);
            return u;
        }

        public JSONObject toJson() {
            JSONObject j = new JSONObject();
            try {
                j.put("name", name);
                j.put("rate", rate);
                if (barcode != null && !barcode.isEmpty()) j.put("barcode", barcode);
                if (price != null) j.put("price", price);
            } catch (Exception ignored) { }
            return j;
        }
    }

    public static class Product {
        public String id = "";
        public String sku = "";
        public String barcode = "";
        public String name = "";
        public String spec = "";
        public String brand = "";
        public String category = "";
        public String unit = "个";
        public String buyUnit = "";
        public String saleUnit = "";
        public double cost;
        public double price;
        public double stock;
        public double safety;
        public boolean batch;
        public boolean serial;
        public boolean dec;
        public String remark = "";
        public String img = "";
        public Map<String, Double> wh = new HashMap<>();
        public List<UnitSpec> units = new ArrayList<>();

        public double whQty(String whId) {
            if (wh != null && wh.containsKey(whId)) return wh.get(whId);
            if ("w1".equals(whId) && (wh == null || wh.isEmpty())) return stock;
            return 0;
        }

        public String primaryCode() {
            return (barcode != null && !barcode.isEmpty()) ? barcode : sku;
        }

        public static Product fromJson(JSONObject j) {
            Product p = new Product();
            p.id = j.optString("id", "");
            p.sku = j.optString("sku", "");
            p.barcode = j.optString("barcode", "");
            p.name = j.optString("name", "");
            p.spec = j.optString("spec", "");
            p.brand = j.optString("brand", "");
            p.category = j.optString("category", "");
            p.unit = j.optString("unit", "个");
            if (p.unit.isEmpty()) p.unit = "个";
            p.buyUnit = j.optString("buyUnit", "");
            p.saleUnit = j.optString("saleUnit", "");
            p.cost = j.optDouble("cost", 0);
            p.price = j.optDouble("price", 0);
            p.stock = j.optDouble("stock", 0);
            p.safety = j.optDouble("safety", 0);
            p.batch = j.optBoolean("batch", false);
            p.serial = j.optBoolean("serial", false);
            p.dec = j.optBoolean("dec", false);
            p.remark = j.optString("remark", "");
            p.img = j.optString("img", "");
            JSONObject w = j.optJSONObject("wh");
            if (w != null) {
                Iterator<String> it = w.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    p.wh.put(k, w.optDouble(k, 0));
                }
            }
            JSONArray us = j.optJSONArray("units");
            if (us != null) {
                for (int i = 0; i < us.length(); i++) {
                    JSONObject u = us.optJSONObject(i);
                    if (u != null) p.units.add(UnitSpec.fromJson(u));
                }
            }
            return p;
        }
    }

    public static class Warehouse {
        public String id = "";
        public String code = "";
        public String name = "";

        public static Warehouse fromJson(JSONObject j) {
            Warehouse w = new Warehouse();
            w.id = j.optString("id", "");
            w.code = j.optString("code", "");
            w.name = j.optString("name", "");
            return w;
        }
    }

    public static class CheckLine {
        public String productId = "";
        public double book;
        public Double counted;
        public boolean added;

        public static CheckLine fromJson(JSONObject j) {
            CheckLine l = new CheckLine();
            l.productId = j.optString("productId", "");
            l.book = j.optDouble("book", 0);
            if (j.has("counted") && !j.isNull("counted")) l.counted = j.optDouble("counted", 0);
            return l;
        }
    }

    public static class CheckDoc {
        public String id = "";
        public String no = "";
        public String wh = "w1";
        public String date = "";
        public String scope = "";
        public String status = "";
        public String remark = "";
        public List<CheckLine> lines = new ArrayList<>();

        public static CheckDoc fromJson(JSONObject j) {
            CheckDoc d = new CheckDoc();
            d.id = j.optString("id", "");
            d.no = j.optString("no", "");
            d.wh = j.optString("wh", "w1");
            d.date = j.optString("date", "");
            d.scope = j.optString("scope", "");
            d.status = j.optString("status", "");
            d.remark = j.optString("remark", "");
            JSONArray arr = j.optJSONArray("lines");
            if (arr != null) {
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject x = arr.optJSONObject(i);
                    if (x != null) d.lines.add(CheckLine.fromJson(x));
                }
            }
            return d;
        }
    }

    public static class BatchRec {
        public String id = "";
        public String productId = "";
        public String wh = "";
        public String no = "";
        public String prodDate = "";
        public String expDate = "";
        public double qty;

        public static BatchRec fromJson(JSONObject j) {
            BatchRec b = new BatchRec();
            b.id = j.optString("id", "");
            b.productId = j.optString("productId", "");
            b.wh = j.optString("wh", "");
            b.no = j.optString("no", "");
            b.prodDate = j.optString("prodDate", "");
            b.expDate = j.optString("expDate", "");
            b.qty = j.optDouble("qty", 0);
            return b;
        }
    }

    public static class SerialRec {
        public String id = "";
        public String productId = "";
        public String sn = "";
        public String wh = "";
        public String status = "";
        public JSONArray hist = new JSONArray();

        public static SerialRec fromJson(JSONObject j) {
            SerialRec s = new SerialRec();
            s.id = j.optString("id", "");
            s.productId = j.optString("productId", "");
            s.sn = j.optString("sn", "");
            s.wh = j.optString("wh", "");
            s.status = j.optString("status", "");
            JSONArray h = j.optJSONArray("hist");
            if (h != null) s.hist = h;
            return s;
        }
    }

    public static class BarcodeMatch {
        public Product product;
        public UnitSpec unit; // null means base unit / sku
        public BarcodeMatch(Product product, UnitSpec unit) {
            this.product = product;
            this.unit = unit;
        }
        public double rate() { return unit != null ? unit.rate : 1; }
        public String unitName() { return unit != null ? unit.name : product.unit; }
    }

    public static class ScanCartItem {
        public String productId = "";
        public String unitName = "";
        public double rate = 1;
        public double qty = 1;
        public Double price;
        public String batchNo = "";
        public String prodDate = "";
        public String expDate = "";
        public String preferBatchId = "";
        public String preferBatchLabel = "";
        public List<String> serials = new ArrayList<>();
        public String note = "";

        public double baseQty() { return qty * rate; }
    }

    public static class LabelJob {
        public Product product;
        public UnitSpec unit;
        public int copies = 1;
        public LabelJob(Product p, UnitSpec u, int c) {
            product = p;
            unit = u;
            copies = c;
        }
        public String code() { return unit != null && !unit.barcode.isEmpty() ? unit.barcode : product.primaryCode(); }
    }
}
