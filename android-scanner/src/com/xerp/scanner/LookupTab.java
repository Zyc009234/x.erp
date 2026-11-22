package com.xerp.scanner;

import android.graphics.Color;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.List;
import java.util.Locale;

public class LookupTab implements TabPage {
    private final MainActivity act;
    private final AppStore store;
    private final LinearLayout root;

    private EditText searchEt;
    private LinearLayout contentCol, bottomBar;

    private String lastCode = "";
    private Models.Product activeProduct;
    private Models.UnitSpec activeUnit;
    private Models.SerialRec activeSerial;
    private List<Models.BatchRec> activeBatches;
    private String unknownCode = "";

    public LookupTab(MainActivity act) {
        this.act = act;
        this.store = act.store;
        root = Ui.col(act);
        root.setBackgroundColor(Ui.BG);
        buildUi();
    }

    private void buildUi() {
        LinearLayout top = Ui.row(act);
        top.setBackgroundColor(Color.WHITE);
        top.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));

        searchEt = Ui.input(act, "搜名称 / 编码 / 条码 / 序列号 / 批号");
        searchEt.setSingleLine(true);
        searchEt.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));

        Button addBtn = Ui.btn(act, "+ 新商品", Ui.PRIMARY, Color.WHITE);
        addBtn.setMinHeight(Ui.dp(act, 40));
        addBtn.setMinimumHeight(Ui.dp(act, 40));
        addBtn.setTextSize(13);
        addBtn.setOnClickListener(v -> openEditor(null, ""));

        top.addView(searchEt, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(Ui.space(act, 8, 1));
        top.addView(addBtn, new LinearLayout.LayoutParams(-2, Ui.dp(act, 40)));
        root.addView(top);
        root.addView(Ui.divider(act));

        ScrollView sv = new ScrollView(act);
        contentCol = Ui.col(act);
        contentCol.setPadding(Ui.dp(act, 10), Ui.dp(act, 10), Ui.dp(act, 10), Ui.dp(act, 12));
        sv.addView(contentCol);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        root.addView(Ui.divider(act));
        bottomBar = Ui.col(act);
        bottomBar.setBackgroundColor(Color.WHITE);
        bottomBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
        root.addView(bottomBar);

        searchEt.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) {
                String q = s.toString().trim();
                if (q.isEmpty()) {
                    renderView();
                } else {
                    renderSearchResults(q);
                }
            }
        });
    }

    @Override public View getView() { return root; }
    @Override public boolean needsCamera() { return true; }
    @Override public void onCameraStateChanged(boolean open) { renderBottomBar(); }

    @Override
    public void onShown() {
        if (searchEt.getText().toString().trim().isEmpty()) renderView();
    }

    @Override
    public void onDataUpdated() {
        if (activeProduct != null) activeProduct = store.productById.get(activeProduct.id);
        renderView();
    }

    @Override
    public void onBarcodeScanned(String code) {
        String c = code.trim();
        lastCode = c;
        searchEt.setText("");
        activeProduct = null;
        activeUnit = null;
        activeSerial = null;
        activeBatches = null;
        unknownCode = "";

        Models.BarcodeMatch m = store.findByCode(c);
        if (m != null) {
            activeProduct = m.product;
            activeUnit = m.unit;
            act.scanner.feedbackOk();
            renderView();
            return;
        }
        Models.SerialRec sr = store.serialBySn.get(c);
        if (sr != null) {
            activeSerial = sr;
            activeProduct = store.productById.get(sr.productId);
            act.scanner.feedbackOk();
            renderView();
            return;
        }
        List<Models.BatchRec> br = store.batchesByNo.get(c);
        if (br != null && !br.isEmpty()) {
            activeBatches = br;
            activeProduct = store.productById.get(br.get(0).productId);
            act.scanner.feedbackOk();
            renderView();
            return;
        }

        unknownCode = c;
        act.scanner.feedbackUnknown();
        renderView();
        if (store.autoPromptNew) openEditor(null, c);
    }

    private void openEditor(Models.Product existing, String code) {
        ProductEditorSheet.show(act, existing, code, null, "期初库存", existing == null, (p, boundUnit, extra) -> {
            unknownCode = "";
            activeProduct = p;
            activeUnit = boundUnit;
            activeSerial = null;
            activeBatches = null;
            renderView();
        });
    }

    private void renderSearchResults(String q) {
        contentCol.removeAllViews();
        renderBottomBar();
        String ql = q.toLowerCase(Locale.ROOT);
        int shown = 0;
        for (Models.Product p : store.products) {
            StringBuilder hay = new StringBuilder(p.name + " " + p.sku + " " + p.barcode + " " + p.spec + " " + p.brand);
            for (Models.UnitSpec u : p.units) hay.append(" ").append(u.barcode);
            if (!hay.toString().toLowerCase(Locale.ROOT).contains(ql)) continue;

            LinearLayout row = Ui.row(act);
            row.setBackground(Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 10));
            row.setPadding(Ui.dp(act, 12), Ui.dp(act, 10), Ui.dp(act, 12), Ui.dp(act, 10));
            LinearLayout info = Ui.col(act);
            info.addView(Ui.tv(act, p.name, 14, Ui.INK, true));
            String sub = p.sku + (p.barcode.isEmpty() ? "" : " · " + p.barcode) + (p.spec.isEmpty() ? "" : " · " + p.spec);
            info.addView(Ui.tv(act, sub, 12, Ui.MUTED, false));
            row.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
            row.addView(Ui.tv(act, Ui.fmtQty(p.whQty(store.selectedWh)) + " " + p.unit, 14, Ui.PRIMARY, true));
            row.setOnClickListener(v -> {
                activeProduct = p;
                activeUnit = null;
                activeSerial = null;
                activeBatches = null;
                unknownCode = "";
                searchEt.setText("");
                renderView();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.bottomMargin = Ui.dp(act, 6);
            contentCol.addView(row, lp);
            if (++shown >= 50) break;
        }
        if (shown == 0) {
            LinearLayout card = Ui.card(act, 14);
            card.addView(Ui.tv(act, "没有匹配商品：" + q, 14, Ui.MUTED, false));
            Button btn = Ui.btn(act, "以「" + q + "」新建商品", Ui.PRIMARY, Color.WHITE);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 44));
            blp.topMargin = Ui.dp(act, 10);
            btn.setOnClickListener(v -> openEditor(null, q));
            card.addView(btn, blp);
            contentCol.addView(card);
        }
    }

    private void renderView() {
        contentCol.removeAllViews();
        if (!unknownCode.isEmpty()) {
            renderBottomBar();
            LinearLayout card = Ui.card(act, 16);
            card.setBackground(Ui.outlined(act, Ui.WARN_SOFT, Ui.WARN, 1, 12));
            card.addView(Ui.tv(act, "未收录的条码", 16, 0xFF92400E, true));
            card.addView(Ui.tv(act, unknownCode, 18, Ui.INK, true));
            LinearLayout btns = Ui.row(act);
            Button bNew = Ui.btn(act, "+ 快速新建商品", Ui.PRIMARY, Color.WHITE);
            bNew.setOnClickListener(v -> openEditor(null, unknownCode));
            Button bBind = Ui.btn(act, "绑定到已有商品", Ui.ACCENT, Color.WHITE);
            bBind.setOnClickListener(v -> openEditor(null, unknownCode));
            btns.addView(bNew, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1));
            btns.addView(Ui.space(act, 8, 1));
            btns.addView(bBind, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.topMargin = Ui.dp(act, 12);
            card.addView(btns, lp);
            contentCol.addView(card);
            return;
        }

        if (activeSerial != null) {
            LinearLayout sc = Ui.card(act, 12);
            sc.setBackground(Ui.outlined(act, Ui.ACCENT_SOFT, Ui.ACCENT, 1, 12));
            sc.addView(Ui.tv(act, "序列号追踪：" + activeSerial.sn, 15, Ui.ACCENT, true));
            sc.addView(Ui.tv(act, "状态：" + activeSerial.status + " · 仓库：" + store.whName(activeSerial.wh), 13, Ui.INK, false));
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, -2);
            slp.bottomMargin = Ui.dp(act, 10);
            contentCol.addView(sc, slp);
        }

        if (activeBatches != null && !activeBatches.isEmpty()) {
            LinearLayout bc = Ui.card(act, 12);
            bc.setBackground(Ui.outlined(act, Ui.PRIMARY_SOFT, Ui.PRIMARY, 1, 12));
            bc.addView(Ui.tv(act, "批号查询：" + activeBatches.get(0).no, 15, Ui.PRIMARY, true));
            for (Models.BatchRec b : activeBatches) {
                Models.Product bp = store.productById.get(b.productId);
                String line = (bp != null ? bp.name : "") + " · " + store.whName(b.wh) + " · 数量 " + Ui.fmtQty(b.qty)
                        + (b.expDate.isEmpty() ? "" : " · 效期 " + b.expDate);
                bc.addView(Ui.tv(act, line, 12, Ui.INK, false));
            }
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, -2);
            blp.bottomMargin = Ui.dp(act, 10);
            contentCol.addView(bc, blp);
        }

        if (activeProduct == null) {
            renderBottomBar();
            LinearLayout card = Ui.card(act, 16);
            card.addView(Ui.tv(act, "扫码查货 · 录新商品 · 绑条码", 16, Ui.INK, true));
            TextView sub = Ui.tv(act, "支持扫描商品主条码、箱条码、序列号或批号。\n点底部「开启扫码」后再扫商品；遇到新条码可直接语音/拍照建档或绑到已有商品。", 13, Ui.MUTED, false);
            sub.setPadding(0, Ui.dp(act, 6), 0, 0);
            card.addView(sub);
            contentCol.addView(card);
            return;
        }

        Models.Product p = activeProduct;
        // Main Info Card
        LinearLayout info = Ui.card(act, 14);
        LinearLayout head = Ui.row(act);
        LinearLayout hl = Ui.col(act);
        hl.addView(Ui.tv(act, p.name, 18, Ui.INK, true));
        String meta = p.sku + (p.spec.isEmpty() ? "" : " · " + p.spec) + (p.brand.isEmpty() ? "" : " · " + p.brand);
        hl.addView(Ui.tv(act, meta, 13, Ui.MUTED, false));
        head.addView(hl, new LinearLayout.LayoutParams(0, -2, 1));
        if (!p.category.isEmpty()) head.addView(Ui.badge(act, p.category, Ui.ACCENT_SOFT, Ui.ACCENT));
        info.addView(head);

        if (activeUnit != null) {
            LinearLayout uw = Ui.row(act);
            uw.setPadding(0, Ui.dp(act, 6), 0, 0);
            uw.addView(Ui.badge(act, "扫入包装码：" + activeUnit.name + " = " + activeUnit.rate + p.unit, Ui.PRIMARY_SOFT, Ui.PRIMARY));
            info.addView(uw);
        }

        // Barcode row + quick generate or show fullscreen
        LinearLayout bRow = Ui.row(act);
        bRow.setPadding(0, Ui.dp(act, 8), 0, 0);
        String codeDisp = p.barcode.isEmpty() ? "未设条码（编码 " + p.sku + "）" : ("条码：" + p.barcode);
        bRow.addView(Ui.tv(act, codeDisp, 13, p.barcode.isEmpty() ? Ui.WARN : Ui.INK, true),
                new LinearLayout.LayoutParams(0, -2, 1));
        TextView showCodeBtn = Ui.badge(act, p.barcode.isEmpty() ? "生成EAN13" : "亮码", Ui.ACCENT_SOFT, Ui.ACCENT);
        showCodeBtn.setPadding(Ui.dp(act, 10), Ui.dp(act, 5), Ui.dp(act, 10), Ui.dp(act, 5));
        showCodeBtn.setOnClickListener(v -> {
            if (p.barcode.isEmpty()) generateAndBindBarcode(p);
            else BarcodeGenHelper.showFullscreenBarcode(act, p.name, p.spec, activeUnit != null ? activeUnit.barcode : p.barcode);
        });
        bRow.addView(showCodeBtn);
        info.addView(bRow);

        if (store.seesPrice) {
            info.addView(Ui.tv(act, "售价 " + Ui.fmtMoney(p.price) + "/" + p.unit + "   成本 " + Ui.fmtMoney(p.cost), 13, Ui.ACCENT, true));
        }

        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(-1, -2);
        ilp.bottomMargin = Ui.dp(act, 8);
        contentCol.addView(info, ilp);

        // Warehouse Stock Card
        LinearLayout stockCard = Ui.card(act, 12);
        stockCard.addView(Ui.tv(act, "库存分布（总库存 " + Ui.fmtQty(p.stock) + " " + p.unit + "）", 14, Ui.INK, true));
        for (Models.Warehouse w : store.warehouses) {
            double q = p.whQty(w.id);
            LinearLayout wr = Ui.row(act);
            wr.setPadding(0, Ui.dp(act, 4), 0, 0);
            wr.addView(Ui.tv(act, w.name + (w.id.equals(store.selectedWh) ? " (当前)" : ""), 13, Ui.MUTED, w.id.equals(store.selectedWh)),
                    new LinearLayout.LayoutParams(0, -2, 1));
            wr.addView(Ui.tv(act, Ui.fmtQty(q) + " " + p.unit, 14, q <= p.safety ? Ui.WARN : Ui.PRIMARY, true));
            stockCard.addView(wr);
        }
        contentCol.addView(stockCard, ilp);

        // Packaging units
        if (!p.units.isEmpty()) {
            LinearLayout uc = Ui.card(act, 12);
            uc.addView(Ui.tv(act, "多单位 / 箱码", 14, Ui.INK, true));
            for (Models.UnitSpec u : p.units) {
                String txt = "1 " + u.name + " = " + u.rate + " " + p.unit
                        + (u.barcode.isEmpty() ? "（无条码）" : " · 条码 " + u.barcode);
                uc.addView(Ui.tv(act, txt, 13, Ui.MUTED, false));
            }
            contentCol.addView(uc, ilp);
        }

        // Active batches
        if (p.batch) {
            LinearLayout bc = Ui.card(act, 12);
            bc.addView(Ui.tv(act, "在库批次", 14, Ui.INK, true));
            int n = 0;
            for (Models.BatchRec b : store.batches) {
                if (!b.productId.equals(p.id) || b.qty <= 0) continue;
                bc.addView(Ui.tv(act, b.no + " · " + store.whName(b.wh) + " · " + Ui.fmtQty(b.qty) + p.unit
                        + (b.expDate.isEmpty() ? "" : " · 效期 " + b.expDate), 12, Ui.MUTED, false));
                n++;
            }
            if (n == 0) bc.addView(Ui.tv(act, "暂无在库批次", 12, Ui.MUTED, false));
            contentCol.addView(bc, ilp);
        }

        renderBottomBar();
    }

    private void renderBottomBar() {
        bottomBar.setVisibility(View.VISIBLE);
        bottomBar.removeAllViews();

        if (activeProduct != null) {
            Models.Product p = activeProduct;
            LinearLayout prodRow = Ui.row(act);
            Button bCheck = Ui.btn(act, "快速盘点", Ui.PRIMARY, Color.WHITE);
            Button bEdit = Ui.outlineBtn(act, "编辑/绑码", Ui.ACCENT, Ui.ACCENT);
            Button bPhoto = Ui.outlineBtn(act, "拍图", Ui.LINE, Ui.INK);
            Button bLabel = Ui.outlineBtn(act, "打标签", Ui.LINE, Ui.INK);

            bCheck.setOnClickListener(v -> quickCheckProduct(p));
            bEdit.setOnClickListener(v -> openEditor(p, ""));
            bPhoto.setOnClickListener(v -> quickSnapProduct(p));
            bLabel.setOnClickListener(v -> {
                store.addToLabelQueue(p, activeUnit, 1);
                Ui.toast(act, "已加入标签打印队列");
                act.switchToTab(3);
            });

            Button[] btns = {bCheck, bEdit, bPhoto, bLabel};
            float[] ws = {1.2f, 1.1f, 0.85f, 0.95f};
            for (int i = 0; i < btns.length; i++) {
                btns[i].setTextSize(12);
                btns[i].setPadding(Ui.dp(act, 4), 0, Ui.dp(act, 4), 0);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(act, 40), ws[i]);
                if (i > 0) lp.leftMargin = Ui.dp(act, 6);
                prodRow.addView(btns[i], lp);
            }
            LinearLayout.LayoutParams prlp = new LinearLayout.LayoutParams(-1, -2);
            prlp.bottomMargin = Ui.dp(act, 8);
            bottomBar.addView(prodRow, prlp);
        }

        boolean camOn = act.isCameraOpen();
        LinearLayout scanRow = Ui.row(act);
        Button bCam = Ui.btn(act, camOn ? "关闭相机" : "扫码查货", camOn ? Ui.DANGER : Ui.PRIMARY, Color.WHITE);
        bCam.setOnClickListener(v -> act.toggleCamera());
        Button bAdd = Ui.outlineBtn(act, "+ 新建商品", Ui.ACCENT, Ui.ACCENT);
        bAdd.setOnClickListener(v -> openEditor(null, ""));
        if (store.leftHanded) {
            scanRow.addView(bCam, new LinearLayout.LayoutParams(0, Ui.dp(act, 44), 1.4f));
            scanRow.addView(Ui.space(act, 8, 1));
            scanRow.addView(bAdd, new LinearLayout.LayoutParams(0, Ui.dp(act, 44), 1));
        } else {
            scanRow.addView(bAdd, new LinearLayout.LayoutParams(0, Ui.dp(act, 44), 1));
            scanRow.addView(Ui.space(act, 8, 1));
            scanRow.addView(bCam, new LinearLayout.LayoutParams(0, Ui.dp(act, 44), 1.4f));
        }
        bottomBar.addView(scanRow, new LinearLayout.LayoutParams(-1, -2));
    }

    private void quickCheckProduct(Models.Product p) {
        if (!store.can("inv.checkpost") && !store.perms.isEmpty()) {
            Ui.toast(act, "没有盘点调整权限");
            return;
        }
        double cur = p.whQty(store.selectedWh);
        ThumbNumpadDialog.show(act, "快速盘点 · " + p.name, store.whName(store.selectedWh) + " 当前账面：" + Ui.fmtQty(cur) + " " + p.unit,
                cur, cur, p.dec, val -> new Thread(() -> {
                    try {
                        ApiClient.adjustStock(store, p.id, new JSONObject()
                                .put("mode", "check")
                                .put("qty", val)
                                .put("wh", store.selectedWh)
                                .put("note", "手机快速盘点"));
                        act.refreshData(() -> {
                            activeProduct = store.productById.get(p.id);
                            act.scanner.feedbackOk();
                            Ui.toast(act, "库存已盘点为 " + Ui.fmtQty(val));
                        });
                    } catch (Exception e) {
                        act.runOnUiThread(() -> Ui.toast(act, ApiClient.friendlyError(e)));
                    }
                }).start());
    }

    private void quickSnapProduct(Models.Product p) {
        act.takeLiveSnapshot((uri, bmp, err) -> {
            if (err != null) { Ui.toast(act, err); return; }
            if (uri == null) return;
            Ui.toast(act, "正在上传商品图片…");
            new Thread(() -> {
                try {
                    ApiClient.uploadProductImage(store, p.id, uri);
                    p.img = "1";
                    act.runOnUiThread(() -> Ui.toast(act, "商品图片已更新"));
                } catch (Exception e) {
                    act.runOnUiThread(() -> Ui.toast(act, ApiClient.friendlyError(e)));
                }
            }).start();
        });
    }

    private void generateAndBindBarcode(Models.Product p) {
        String code = BarcodeGenHelper.generateInternalEan13(store.allUsedCodes());
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject()
                        .put("name", p.name)
                        .put("sku", p.sku)
                        .put("unit", p.unit)
                        .put("barcode", code);
                JSONArray us = new JSONArray();
                for (Models.UnitSpec u : p.units) us.put(u.toJson());
                body.put("units", us);
                JSONObject res = ApiClient.updateProduct(store, p.id, body);
                Models.Product saved = Models.Product.fromJson(res);
                store.upsertProduct(saved);
                activeProduct = saved;
                act.runOnUiThread(() -> {
                    Ui.toast(act, "已生成并保存条码：" + code);
                    renderView();
                });
            } catch (Exception e) {
                act.runOnUiThread(() -> Ui.toast(act, ApiClient.friendlyError(e)));
            }
        }).start();
    }
}
