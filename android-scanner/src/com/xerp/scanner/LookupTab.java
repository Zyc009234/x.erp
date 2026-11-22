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

        LinearLayout searchBox = Ui.row(act);
        searchBox.setBackground(Ui.outlined(act, Ui.SURFACE_2, Ui.LINE, 1, 12));
        searchBox.setPadding(Ui.dp(act, 10), 0, Ui.dp(act, 6), 0);
        searchBox.addView(new IconView(act, IconView.Type.SEARCH_BAR, Ui.MUTED),
                new LinearLayout.LayoutParams(Ui.dp(act, 16), Ui.dp(act, 16)));
        searchBox.addView(Ui.space(act, 6, 1));

        searchEt = new EditText(act);
        searchEt.setHint("搜名称 / 编码 / 条码 / 序列号 / 批号");
        searchEt.setTextSize(14);
        searchEt.setTextColor(Ui.INK);
        searchEt.setHintTextColor(Ui.SUBTLE);
        searchEt.setBackground(null);
        searchEt.setSingleLine(true);
        searchEt.setPadding(0, Ui.dp(act, 9), 0, Ui.dp(act, 9));

        TextView clearBtn = Ui.badge(act, "×", Ui.CHIP_BG, Ui.MUTED);
        clearBtn.setVisibility(View.GONE);
        clearBtn.setOnClickListener(v -> searchEt.setText(""));

        searchBox.addView(searchEt, new LinearLayout.LayoutParams(0, -2, 1));
        searchBox.addView(clearBtn);

        Button addBtn = Ui.gradientBtn(act, "+ 新商品", Ui.PRIMARY, Ui.PRIMARY_END);
        addBtn.setMinHeight(Ui.dp(act, 40));
        addBtn.setMinimumHeight(Ui.dp(act, 40));
        addBtn.setTextSize(13);
        addBtn.setOnClickListener(v -> openEditor(null, ""));

        top.addView(searchBox, new LinearLayout.LayoutParams(0, -2, 1));
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
        bottomBar.setElevation(Ui.dp(act, 4));
        bottomBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 9));
        root.addView(bottomBar);

        searchEt.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) {
                String q = s.toString().trim();
                clearBtn.setVisibility(q.isEmpty() ? View.GONE : View.VISIBLE);
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
            if (act.tts != null) act.tts.speakLookupStock(m.product.name, m.product.whQty(store.selectedWh), m.product.unit);
            renderView();
            return;
        }
        Models.SerialRec sr = store.serialBySn.get(c);
        if (sr != null) {
            activeSerial = sr;
            activeProduct = store.productById.get(sr.productId);
            act.scanner.feedbackOk();
            if (act.tts != null) act.tts.speakCue("序列号，" + sr.status, "在库".equals(sr.status) ? "serial_in" : "serial_out");
            renderView();
            return;
        }
        List<Models.BatchRec> br = store.batchesByNo.get(c);
        if (br != null && !br.isEmpty()) {
            activeBatches = br;
            activeProduct = store.productById.get(br.get(0).productId);
            act.scanner.feedbackOk();
            if (act.tts != null) act.tts.speakCue("找到" + br.size() + "条批次记录", "batch_found");
            renderView();
            return;
        }

        unknownCode = c;
        act.scanner.feedbackUnknown();
        if (act.tts != null) act.tts.speakCue("未收录条码", "not_recorded");
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
            row.setBackground(Ui.rippleOutlined(act, Ui.CARD, 0xFFE8EDF5, 1, 12));
            row.setElevation(Ui.dp(act, 1));
            row.setPadding(Ui.dp(act, 12), Ui.dp(act, 10), Ui.dp(act, 12), Ui.dp(act, 10));
            LinearLayout info = Ui.col(act);
            info.addView(Ui.tv(act, p.name, 14, Ui.INK, true));
            String sub = p.sku + (p.barcode.isEmpty() ? "" : " · " + p.barcode) + (p.spec.isEmpty() ? "" : " · " + p.spec);
            info.addView(Ui.tv(act, sub, 12, Ui.MUTED, false));
            row.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
            double whq = p.whQty(store.selectedWh);
            row.addView(Ui.badge(act, Ui.fmtQty(whq) + " " + p.unit,
                    whq <= p.safety ? Ui.WARN_SOFT : Ui.PRIMARY_SOFT,
                    whq <= p.safety ? Ui.WARN : Ui.PRIMARY));
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
            lp.bottomMargin = Ui.dp(act, 7);
            contentCol.addView(row, lp);
            if (++shown >= 50) break;
        }
        if (shown == 0) {
            LinearLayout card = Ui.emptyState(act, IconView.Type.SEARCH_BAR, "没有匹配商品：" + q, "可直接以此条码或名称快速创建新商品");
            Button btn = Ui.gradientBtn(act, "以「" + q + "」新建商品", Ui.PRIMARY, Ui.PRIMARY_END);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 44));
            blp.topMargin = Ui.dp(act, 14);
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
            card.setBackground(Ui.outlined(act, Ui.WARN_SOFT, Ui.WARN, 1, 14));
            card.addView(Ui.tv(act, "未收录的条码", 15, 0xFF92400E, true));
            card.addView(Ui.tv(act, unknownCode, 19, Ui.INK, true));
            LinearLayout btns = Ui.row(act);
            Button bNew = Ui.gradientBtn(act, "+ 快速新建商品", Ui.PRIMARY, Ui.PRIMARY_END);
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
            sc.setBackground(Ui.outlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 14));
            sc.addView(Ui.tv(act, "序列号追踪：" + activeSerial.sn, 15, Ui.ACCENT, true));
            sc.addView(Ui.tv(act, "状态：" + activeSerial.status + " · 仓库：" + store.whName(activeSerial.wh), 13, Ui.INK, false));
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, -2);
            slp.bottomMargin = Ui.dp(act, 10);
            contentCol.addView(sc, slp);
        }

        if (activeBatches != null && !activeBatches.isEmpty()) {
            LinearLayout bc = Ui.card(act, 12);
            bc.setBackground(Ui.outlined(act, Ui.PRIMARY_SOFT, Ui.PRIMARY_BORDER, 1, 14));
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
            contentCol.addView(Ui.emptyState(act, IconView.Type.SEARCH_BAR, "扫码查货 · 录新商品 · 绑条码",
                    "支持商品主条码、箱条码、序列号或批号。\n点下方「扫码查货」即可扫描，未收录条码可语音/拍照极速建档。"));
            return;
        }

        Models.Product p = activeProduct;
        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(-1, -2);
        ilp.bottomMargin = Ui.dp(act, 10);

        // Top Stock Summary Highlight Banner
        double curWhQty = p.whQty(store.selectedWh);
        LinearLayout stockHero = Ui.row(act);
        stockHero.setBackground(Ui.outlined(act, Ui.PRIMARY_SOFT, Ui.PRIMARY_BORDER, 1, 14));
        stockHero.setPadding(Ui.dp(act, 14), Ui.dp(act, 12), Ui.dp(act, 14), Ui.dp(act, 12));
        LinearLayout shLeft = Ui.col(act);
        shLeft.addView(Ui.tv(act, store.whName(store.selectedWh) + " · 当前可用库存", 12, Ui.PRIMARY_DARK, false));
        shLeft.addView(Ui.tv(act, Ui.fmtQty(curWhQty) + " " + p.unit, 24, Ui.PRIMARY, true));
        stockHero.addView(shLeft, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout shRight = Ui.col(act);
        shRight.setGravity(Gravity.END);
        shRight.addView(Ui.tv(act, "全仓合计 " + Ui.fmtQty(p.stock) + " " + p.unit, 12, Ui.INK_2, true));
        if (curWhQty <= p.safety) {
            LinearLayout.LayoutParams wlp = new LinearLayout.LayoutParams(-2, -2);
            wlp.topMargin = Ui.dp(act, 4);
            shRight.addView(Ui.badge(act, "低于安全库存(" + Ui.fmtQty(p.safety) + ")", Ui.WARN_SOFT, Ui.WARN), wlp);
        }
        stockHero.addView(shRight);
        contentCol.addView(stockHero, ilp);

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
            uw.setPadding(0, Ui.dp(act, 8), 0, 0);
            uw.addView(Ui.badge(act, "扫入包装码：" + activeUnit.name + " = " + activeUnit.rate + p.unit, Ui.PRIMARY_SOFT, Ui.PRIMARY));
            info.addView(uw);
        }

        // Barcode row + quick generate or show fullscreen
        LinearLayout bRow = Ui.row(act);
        bRow.setPadding(0, Ui.dp(act, 10), 0, 4);
        String codeDisp = p.barcode.isEmpty() ? "未设条码（编码 " + p.sku + "）" : ("条码：" + p.barcode);
        bRow.addView(Ui.tv(act, codeDisp, 13, p.barcode.isEmpty() ? Ui.WARN : Ui.INK_2, true),
                new LinearLayout.LayoutParams(0, -2, 1));
        TextView showCodeBtn = Ui.badge(act, p.barcode.isEmpty() ? "生成EAN13" : "全屏亮码", Ui.ACCENT_SOFT, Ui.ACCENT);
        showCodeBtn.setBackground(Ui.rippleOutlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 10));
        showCodeBtn.setPadding(Ui.dp(act, 10), Ui.dp(act, 5), Ui.dp(act, 10), Ui.dp(act, 5));
        showCodeBtn.setOnClickListener(v -> {
            if (p.barcode.isEmpty()) generateAndBindBarcode(p);
            else BarcodeGenHelper.showFullscreenBarcode(act, p.name, p.spec, activeUnit != null ? activeUnit.barcode : p.barcode);
        });
        bRow.addView(showCodeBtn);
        info.addView(bRow);

        if (store.seesPrice) {
            LinearLayout metricRow = Ui.row(act);
            LinearLayout.LayoutParams mlp = new LinearLayout.LayoutParams(-1, -2);
            mlp.topMargin = Ui.dp(act, 8);
            LinearLayout mPrice = Ui.col(act);
            mPrice.setBackground(Ui.rounded(act, Ui.SURFACE_2, 10));
            mPrice.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
            mPrice.addView(Ui.tv(act, "销售单价 /" + p.unit, 11, Ui.MUTED, false));
            mPrice.addView(Ui.tv(act, Ui.fmtMoney(p.price), 16, Ui.ACCENT, true));

            LinearLayout mCost = Ui.col(act);
            mCost.setBackground(Ui.rounded(act, Ui.SURFACE_2, 10));
            mCost.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
            mCost.addView(Ui.tv(act, "参考成本 /" + p.unit, 11, Ui.MUTED, false));
            mCost.addView(Ui.tv(act, Ui.fmtMoney(p.cost), 16, Ui.INK, true));

            metricRow.addView(mPrice, new LinearLayout.LayoutParams(0, -2, 1));
            metricRow.addView(Ui.space(act, 8, 1));
            metricRow.addView(mCost, new LinearLayout.LayoutParams(0, -2, 1));
            info.addView(metricRow, mlp);
        }
        contentCol.addView(info, ilp);

        // Warehouse Stock Card
        LinearLayout stockCard = Ui.card(act, 14);
        stockCard.addView(Ui.sectionHeader(act, IconView.Type.WAREHOUSE, "各仓库库存分布", Ui.PRIMARY));
        for (int wi = 0; wi < store.warehouses.size(); wi++) {
            Models.Warehouse w = store.warehouses.get(wi);
            if (wi > 0) stockCard.addView(Ui.insetDivider(act));
            double q = p.whQty(w.id);
            LinearLayout wr = Ui.row(act);
            wr.setPadding(0, Ui.dp(act, 8), 0, Ui.dp(act, 8));
            LinearLayout whLbl = Ui.row(act);
            whLbl.addView(Ui.tv(act, w.name, 13, w.id.equals(store.selectedWh) ? Ui.INK : Ui.MUTED, w.id.equals(store.selectedWh)));
            if (w.id.equals(store.selectedWh)) {
                whLbl.addView(Ui.space(act, 6, 1));
                whLbl.addView(Ui.badge(act, "当前仓", Ui.PRIMARY_SOFT, Ui.PRIMARY));
            }
            wr.addView(whLbl, new LinearLayout.LayoutParams(0, -2, 1));
            wr.addView(Ui.tv(act, Ui.fmtQty(q) + " " + p.unit, 14, q <= p.safety ? Ui.WARN : Ui.PRIMARY, true));
            stockCard.addView(wr);
        }
        contentCol.addView(stockCard, ilp);

        // Packaging units
        if (!p.units.isEmpty()) {
            LinearLayout uc = Ui.card(act, 14);
            uc.addView(Ui.sectionHeader(act, IconView.Type.EMPTY_BOX, "多单位 / 箱码", Ui.ACCENT));
            for (Models.UnitSpec u : p.units) {
                String txt = "1 " + u.name + " = " + u.rate + " " + p.unit
                        + (u.barcode.isEmpty() ? "（无条码）" : " · 条码 " + u.barcode);
                LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(-1, -2);
                ulp.topMargin = Ui.dp(act, 6);
                uc.addView(Ui.tv(act, txt, 13, Ui.INK_2, false), ulp);
            }
            contentCol.addView(uc, ilp);
        }

        // Active batches
        if (p.batch) {
            LinearLayout bc = Ui.card(act, 14);
            bc.addView(Ui.sectionHeader(act, IconView.Type.CHECK_LIST, "在库批次", Ui.PRIMARY));
            int n = 0;
            for (Models.BatchRec b : store.batches) {
                if (!b.productId.equals(p.id) || b.qty <= 0) continue;
                LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, -2);
                blp.topMargin = Ui.dp(act, 6);
                bc.addView(Ui.tv(act, b.no + " · " + store.whName(b.wh) + " · " + Ui.fmtQty(b.qty) + p.unit
                        + (b.expDate.isEmpty() ? "" : " · 效期 " + b.expDate), 12, Ui.INK_2, false), blp);
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
            Button bCheck = Ui.gradientBtn(act, "快速盘点", Ui.PRIMARY, Ui.PRIMARY_END);
            Button bEdit = Ui.outlineBtn(act, "编辑/绑码", Ui.ACCENT_BORDER, Ui.ACCENT);
            bEdit.setBackground(Ui.rippleOutlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 12));
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
        Button bCam = camOn
                ? Ui.btn(act, "关闭相机", Ui.DANGER, Color.WHITE)
                : Ui.gradientBtn(act, "扫码查货", Ui.PRIMARY, Ui.PRIMARY_END);
        bCam.setOnClickListener(v -> act.toggleCamera());
        Button bAdd = Ui.outlineBtn(act, "+ 新建商品", Ui.ACCENT_BORDER, Ui.ACCENT);
        bAdd.setBackground(Ui.rippleOutlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 12));
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
