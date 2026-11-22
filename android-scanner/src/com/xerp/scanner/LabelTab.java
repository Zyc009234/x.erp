package com.xerp.scanner;

import android.app.AlertDialog;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Set;

public class LabelTab implements TabPage {
    private final MainActivity act;
    private final AppStore store;
    private final LinearLayout root;

    private String viewMode = "queue"; // queue, all, nobar
    private String tpl = "l4030";
    private boolean showCo = false, showSpec = true, showPrice = true;

    private EditText searchEt;
    private TextView tabQueue, tabAll, tabNoBar, tplPill;
    private LinearLayout listCol, previewCard;
    private CheckBox cbCo, cbSpec, cbPrice;
    private Button printBtn;

    private Models.LabelJob previewJob;

    public LabelTab(MainActivity act) {
        this.act = act;
        this.store = act.store;
        this.showPrice = store.seesPrice;
        root = Ui.col(act);
        root.setBackgroundColor(Ui.BG);
        buildUi();
    }

    private void buildUi() {
        // 1. Mode Switch + Search
        LinearLayout top = Ui.col(act);
        top.setBackgroundColor(Color.WHITE);
        top.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));

        LinearLayout pills = Ui.row(act);
        tabQueue = Ui.chip(act, "打印队列", true);
        tabAll = Ui.chip(act, "添加商品", false);
        tabNoBar = Ui.chip(act, "无条码商品", false);
        tabQueue.setOnClickListener(v -> { viewMode = "queue"; renderAll(); });
        tabAll.setOnClickListener(v -> { viewMode = "all"; renderAll(); });
        tabNoBar.setOnClickListener(v -> { viewMode = "nobar"; renderAll(); });
        pills.addView(tabQueue); pills.addView(Ui.space(act, 6, 1));
        pills.addView(tabAll); pills.addView(Ui.space(act, 6, 1));
        pills.addView(tabNoBar);
        top.addView(pills);

        searchEt = Ui.input(act, "搜索商品名称 / 编码 / 条码");
        searchEt.setSingleLine(true);
        searchEt.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, -2);
        slp.topMargin = Ui.dp(act, 8);
        top.addView(searchEt, slp);
        root.addView(top);
        root.addView(Ui.divider(act));

        // 2. Preview Card
        previewCard = Ui.card(act, 10);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(-1, -2);
        plp.setMargins(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 4));
        root.addView(previewCard, plp);

        // 3. List
        ScrollView sv = new ScrollView(act);
        listCol = Ui.col(act);
        listCol.setPadding(Ui.dp(act, 10), Ui.dp(act, 4), Ui.dp(act, 10), Ui.dp(act, 10));
        sv.addView(listCol);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        // 4. Bottom Print Controls
        root.addView(Ui.divider(act));
        LinearLayout foot = Ui.col(act);
        foot.setBackgroundColor(Color.WHITE);
        foot.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 10));

        LinearLayout optsRow = Ui.row(act);
        tplPill = Ui.tv(act, "40×30 热敏 ▾", 12, Ui.ACCENT, true);
        tplPill.setBackground(Ui.outlined(act, Ui.ACCENT_SOFT, Ui.ACCENT, 1, 8));
        tplPill.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        tplPill.setOnClickListener(v -> pickPaper());

        cbCo = new CheckBox(act); cbCo.setText("公司"); cbCo.setTextSize(12); cbCo.setChecked(showCo);
        cbSpec = new CheckBox(act); cbSpec.setText("规格"); cbSpec.setTextSize(12); cbSpec.setChecked(showSpec);
        cbPrice = new CheckBox(act); cbPrice.setText("售价"); cbPrice.setTextSize(12); cbPrice.setChecked(showPrice);
        cbCo.setOnCheckedChangeListener((b, c) -> showCo = c);
        cbSpec.setOnCheckedChangeListener((b, c) -> showSpec = c);
        cbPrice.setOnCheckedChangeListener((b, c) -> showPrice = c);
        if (!store.seesPrice) cbPrice.setVisibility(View.GONE);

        optsRow.addView(tplPill);
        optsRow.addView(Ui.space(act, 6, 1));
        optsRow.addView(cbCo);
        optsRow.addView(cbSpec);
        optsRow.addView(cbPrice);
        foot.addView(optsRow);

        printBtn = Ui.btn(act, "打印标签", Ui.PRIMARY, Color.WHITE);
        printBtn.setOnClickListener(v -> BarcodeGenHelper.printLabels(act, store.companyName, store.labelQueue, tpl, showCo, showSpec, showPrice, store.seesPrice));
        LinearLayout.LayoutParams pblp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 46));
        pblp.topMargin = Ui.dp(act, 6);
        foot.addView(printBtn, pblp);
        root.addView(foot);

        searchEt.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) { renderAll(); }
        });
    }

    @Override public View getView() { return root; }
    @Override public boolean needsCamera() { return false; }
    @Override public void onShown() { renderAll(); }
    @Override public void onDataUpdated() { renderAll(); }

    @Override
    public void onBarcodeScanned(String code) {
        Models.BarcodeMatch m = store.findByCode(code);
        if (m != null) {
            store.addToLabelQueue(m.product, m.unit, 1);
            previewJob = store.labelQueue.get(0);
            viewMode = "queue";
            renderAll();
        }
    }

    private void pickPaper() {
        String[] keys = {"l4030", "l5030", "l6040", "a4"};
        String[] labels = {"40×30 毫米（热敏标签）", "50×30 毫米（热敏标签）", "60×40 毫米（热敏标签）", "A4 不干胶 3×8（70×37）"};
        new AlertDialog.Builder(act).setTitle("选择标签纸尺寸")
                .setItems(labels, (d, w) -> {
                    tpl = keys[w];
                    tplPill.setText(labels[w].split("（")[0] + " ▾");
                }).show();
    }

    private void renderAll() {
        styleTab(tabQueue, "queue".equals(viewMode));
        styleTab(tabAll, "all".equals(viewMode));
        styleTab(tabNoBar, "nobar".equals(viewMode));

        if (previewJob == null && !store.labelQueue.isEmpty()) previewJob = store.labelQueue.get(0);
        renderPreview();
        renderList();
        int total = 0;
        for (Models.LabelJob j : store.labelQueue) total += Math.max(0, j.copies);
        printBtn.setText("打印条码标签（共 " + total + " 张）");
        printBtn.setEnabled(total > 0);
        printBtn.setBackground(Ui.rounded(act, total > 0 ? Ui.PRIMARY : 0xFF9CA3AF, 10));
    }

    private void styleTab(TextView t, boolean on) {
        t.setTextColor(on ? Color.WHITE : Ui.INK);
        t.setBackground(on ? Ui.rounded(act, Ui.PRIMARY, 16) : Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 16));
    }

    private void renderPreview() {
        previewCard.removeAllViews();
        if (previewJob == null) {
            previewCard.setVisibility(View.GONE);
            return;
        }
        previewCard.setVisibility(View.VISIBLE);
        String code = previewJob.code();
        LinearLayout row = Ui.row(act);
        ImageView barImg = new ImageView(act);
        Bitmap bmp = BarcodeGenHelper.renderBarcodeBitmap(code,
                BarcodeGenHelper.supportsCode128(code) ? BarcodeFormat.CODE_128 : BarcodeFormat.QR_CODE, 420, 110);
        if (bmp != null) barImg.setImageBitmap(bmp);
        barImg.setBackgroundColor(Color.WHITE);

        LinearLayout info = Ui.col(act);
        info.addView(Ui.tv(act, previewJob.product.name + (previewJob.unit != null ? " [" + previewJob.unit.name + "]" : ""), 14, Ui.INK, true));
        info.addView(Ui.tv(act, code, 12, Ui.MUTED, false));
        TextView bigBtn = Ui.badge(act, "全屏亮码", Ui.ACCENT_SOFT, Ui.ACCENT);
        bigBtn.setOnClickListener(v -> BarcodeGenHelper.showFullscreenBarcode(act, previewJob.product.name,
                previewJob.unit != null ? ("1" + previewJob.unit.name + "=" + previewJob.unit.rate + previewJob.product.unit) : previewJob.product.spec, code));
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-2, -2);
        blp.topMargin = Ui.dp(act, 4);
        info.addView(bigBtn, blp);

        row.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
        row.addView(Ui.space(act, 10, 1));
        row.addView(barImg, new LinearLayout.LayoutParams(Ui.dp(act, 150), Ui.dp(act, 48)));
        previewCard.addView(row);
    }

    private void renderList() {
        listCol.removeAllViews();
        String q = searchEt.getText().toString().trim().toLowerCase(Locale.ROOT);

        if ("queue".equals(viewMode)) {
            if (!store.labelQueue.isEmpty()) {
                LinearLayout ops = Ui.row(act);
                Button bStock = Ui.outlineBtn(act, "按当前仓库库存设张数", Ui.ACCENT, Ui.ACCENT);
                bStock.setMinHeight(Ui.dp(act, 34)); bStock.setMinimumHeight(Ui.dp(act, 34)); bStock.setTextSize(12);
                bStock.setOnClickListener(v -> {
                    for (Models.LabelJob j : store.labelQueue) {
                        double st = j.product.whQty(store.selectedWh);
                        int n = j.unit != null ? (int) Math.floor(st / j.unit.rate) : (int) Math.max(0, Math.round(st));
                        j.copies = Math.max(1, n);
                    }
                    renderAll();
                });
                Button bClr = Ui.outlineBtn(act, "清空", Ui.DANGER, Ui.DANGER);
                bClr.setMinHeight(Ui.dp(act, 34)); bClr.setMinimumHeight(Ui.dp(act, 34)); bClr.setTextSize(12);
                bClr.setOnClickListener(v -> { store.labelQueue.clear(); previewJob = null; renderAll(); });
                ops.addView(bStock, new LinearLayout.LayoutParams(0, Ui.dp(act, 34), 1));
                ops.addView(Ui.space(act, 8, 1));
                ops.addView(bClr, new LinearLayout.LayoutParams(-2, Ui.dp(act, 34)));
                LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(-1, -2);
                olp.bottomMargin = Ui.dp(act, 8);
                listCol.addView(ops, olp);
            }
            for (int i = 0; i < store.labelQueue.size(); i++) {
                final int idx = i;
                Models.LabelJob j = store.labelQueue.get(i);
                if (!q.isEmpty() && !(j.product.name + j.code()).toLowerCase(Locale.ROOT).contains(q)) continue;
                LinearLayout row = Ui.row(act);
                row.setBackground(Ui.outlined(act, Color.WHITE, j == previewJob ? Ui.PRIMARY : Ui.LINE, 1, 10));
                row.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
                LinearLayout info = Ui.col(act);
                info.addView(Ui.tv(act, j.product.name + (j.unit != null ? " (" + j.unit.name + ")" : ""), 14, Ui.INK, true));
                info.addView(Ui.tv(act, j.code(), 12, Ui.MUTED, false));
                row.addView(info, new LinearLayout.LayoutParams(0, -2, 1));

                TextView bMin = Ui.badge(act, " - ", Ui.CHIP_BG, Ui.INK);
                TextView bCnt = Ui.tv(act, " " + j.copies + " 张 ", 14, Ui.PRIMARY, true);
                TextView bAdd = Ui.badge(act, " + ", Ui.PRIMARY_SOFT, Ui.PRIMARY);
                TextView bDel = Ui.badge(act, "×", Ui.DANGER_SOFT, Ui.DANGER);

                bMin.setOnClickListener(v -> { if (j.copies > 1) { j.copies--; renderAll(); } });
                bAdd.setOnClickListener(v -> { j.copies++; renderAll(); });
                bDel.setOnClickListener(v -> { store.labelQueue.remove(idx); if (previewJob == j) previewJob = null; renderAll(); });
                row.setOnClickListener(v -> { previewJob = j; renderPreview(); renderList(); });

                row.addView(bMin); row.addView(bCnt); row.addView(bAdd);
                row.addView(Ui.space(act, 6, 1)); row.addView(bDel);
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
                lp.bottomMargin = Ui.dp(act, 6);
                listCol.addView(row, lp);
            }
            if (store.labelQueue.isEmpty()) {
                TextView em = Ui.tv(act, "队列为空，可切到「添加商品」或直接扫码加入打印", 13, Ui.MUTED, false);
                em.setGravity(Gravity.CENTER);
                em.setPadding(0, Ui.dp(act, 24), 0, Ui.dp(act, 24));
                listCol.addView(em);
            }
            return;
        }

        // mode: all or nobar
        boolean noBarOnly = "nobar".equals(viewMode);
        List<Models.Product> noBarList = new ArrayList<>();
        for (Models.Product p : store.products) if (p.barcode.isEmpty()) noBarList.add(p);

        if (noBarOnly && !noBarList.isEmpty()) {
            Button batchGen = Ui.btn(act, "一键为全部无条码商品生成 EAN-13（" + noBarList.size() + " 个）", Ui.ACCENT, Color.WHITE);
            batchGen.setOnClickListener(v -> batchGenerateBarcodes(noBarList, batchGen));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 44));
            blp.bottomMargin = Ui.dp(act, 8);
            listCol.addView(batchGen, blp);
        }

        int shown = 0;
        for (Models.Product p : store.products) {
            if (noBarOnly && !p.barcode.isEmpty()) continue;
            if (!q.isEmpty() && !(p.name + " " + p.sku + " " + p.barcode).toLowerCase(Locale.ROOT).contains(q)) continue;

            LinearLayout row = Ui.row(act);
            row.setBackground(Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 10));
            row.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
            LinearLayout info = Ui.col(act);
            info.addView(Ui.tv(act, p.name, 14, Ui.INK, true));
            info.addView(Ui.tv(act, p.barcode.isEmpty() ? ("编码 " + p.sku + " · 无条码") : p.barcode, 12, p.barcode.isEmpty() ? Ui.WARN : Ui.MUTED, false));
            row.addView(info, new LinearLayout.LayoutParams(0, -2, 1));

            TextView actBadge = Ui.badge(act, p.barcode.isEmpty() ? "生码" : "+队列", Ui.PRIMARY_SOFT, Ui.PRIMARY);
            actBadge.setOnClickListener(v -> {
                if (p.barcode.isEmpty()) generateOneBarcode(p);
                else {
                    store.addToLabelQueue(p, null, 1);
                    previewJob = store.labelQueue.get(0);
                    Ui.toast(act, "已加入队列：" + p.name);
                    renderAll();
                }
            });
            row.addView(actBadge);

            for (Models.UnitSpec u : p.units) {
                if (u.barcode.isEmpty()) continue;
                TextView uBadge = Ui.badge(act, "+" + u.name, Ui.ACCENT_SOFT, Ui.ACCENT);
                uBadge.setOnClickListener(v -> {
                    store.addToLabelQueue(p, u, 1);
                    previewJob = store.labelQueue.get(0);
                    Ui.toast(act, "已加入箱码：" + p.name);
                    renderAll();
                });
                row.addView(Ui.space(act, 4, 1));
                row.addView(uBadge);
            }
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.bottomMargin = Ui.dp(act, 6);
            listCol.addView(row, lp);
            if (++shown >= 80) break;
        }
    }

    private void generateOneBarcode(Models.Product p) {
        List<Models.Product> one = new ArrayList<>();
        one.add(p);
        batchGenerateBarcodes(one, null);
    }

    private void batchGenerateBarcodes(List<Models.Product> list, Button btn) {
        if (!store.can("prod.edit") && !store.perms.isEmpty()) {
            Ui.toast(act, "没有编辑商品权限");
            return;
        }
        if (btn != null) { btn.setEnabled(false); btn.setText("正在生成并保存…"); }
        new Thread(() -> {
            int ok = 0;
            String err = null;
            Set<String> used = store.allUsedCodes();
            for (Models.Product p : list) {
                if (!p.barcode.isEmpty()) continue;
                String code = BarcodeGenHelper.generateInternalEan13(used);
                used.add(code);
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
                    ok++;
                } catch (Exception e) {
                    err = e.getMessage();
                    break;
                }
            }
            final int done = ok;
            final String fail = err;
            act.runOnUiThread(() -> {
                if (fail != null) Ui.toast(act, "已生成 " + done + " 个，中断：" + fail);
                else Ui.toast(act, "已生成并保存 " + done + " 个 EAN-13 条码");
                renderAll();
            });
        }).start();
    }
}
