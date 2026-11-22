package com.xerp.scanner;

import android.app.AlertDialog;
import android.app.Dialog;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.text.Editable;
import android.text.InputType;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Locale;

public final class ProductEditorSheet {
    public interface OnSaved {
        void onProductSaved(Models.Product product, Models.UnitSpec boundUnit, Double extraQty);
    }

    private static final List<String> QUICK_UNITS = Arrays.asList("个", "件", "盒", "瓶", "袋", "箱", "包", "支", "台", "套", "kg");

    private ProductEditorSheet() { }

    public static void show(MainActivity act, Models.Product existing, String prefillBarcode,
                            Double defaultQty, String qtyLabel, boolean showBindTab, OnSaved onSaved) {
        AppStore store = act.store;
        if (!store.can("prod.edit") && !store.perms.isEmpty()) {
            Ui.toast(act, "当前账号没有新增/编辑商品权限");
            return;
        }

        LinearLayout outer = Ui.col(act);
        int maxH = Math.round(act.getResources().getDisplayMetrics().heightPixels * 0.83f);
        outer.setLayoutParams(new LinearLayout.LayoutParams(-1, -2));

        // Top Bar with title + Close
        LinearLayout top = Ui.row(act);
        top.setPadding(Ui.dp(act, 16), Ui.dp(act, 10), Ui.dp(act, 16), Ui.dp(act, 10));
        String titleStr = existing != null ? "编辑商品 · " + existing.name : "快速建档 / 绑定条码";
        top.addView(Ui.tv(act, titleStr, 17, Ui.INK, true), new LinearLayout.LayoutParams(0, -2, 1));
        TextView closeBtn = Ui.badge(act, "关闭", Ui.CHIP_BG, Ui.MUTED);
        closeBtn.setTextSize(12);
        closeBtn.setPadding(Ui.dp(act, 10), Ui.dp(act, 5), Ui.dp(act, 10), Ui.dp(act, 5));
        top.addView(closeBtn);
        outer.addView(top);

        // Segmented Control Mode switcher (New/Edit vs Bind Existing)
        LinearLayout segWrap = Ui.row(act);
        segWrap.setPadding(Ui.dp(act, 16), 0, Ui.dp(act, 16), Ui.dp(act, 10));
        LinearLayout seg = Ui.row(act);
        seg.setBackground(Ui.rounded(act, Ui.CHIP_BG, 12));
        seg.setPadding(Ui.dp(act, 3), Ui.dp(act, 3), Ui.dp(act, 3), Ui.dp(act, 3));
        Button tabNew = Ui.btn(act, existing != null ? "编辑商品" : "新建商品", Ui.CARD, Ui.PRIMARY);
        Button tabBind = Ui.btn(act, "绑定到已有商品", Color.TRANSPARENT, Ui.MUTED);
        tabNew.setMinHeight(Ui.dp(act, 34)); tabNew.setMinimumHeight(Ui.dp(act, 34)); tabNew.setTextSize(13);
        tabBind.setMinHeight(Ui.dp(act, 34)); tabBind.setMinimumHeight(Ui.dp(act, 34)); tabBind.setTextSize(13);
        tabNew.setElevation(Ui.dp(act, 1));
        tabBind.setElevation(0);
        tabNew.setBackground(Ui.rounded(act, Ui.CARD, 9));
        tabBind.setBackgroundColor(Color.TRANSPARENT);
        seg.addView(tabNew, new LinearLayout.LayoutParams(0, Ui.dp(act, 34), 1));
        seg.addView(Ui.space(act, 4, 1));
        seg.addView(tabBind, new LinearLayout.LayoutParams(0, Ui.dp(act, 34), 1));
        segWrap.addView(seg, new LinearLayout.LayoutParams(-1, -2));
        if (showBindTab && existing == null) outer.addView(segWrap);

        outer.addView(Ui.divider(act));

        ScrollView scroll = new ScrollView(act);
        scroll.setFillViewport(true);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, 0, 1);
        outer.addView(scroll, slp);

        // ---------- Pane A: New / Edit Product ----------
        LinearLayout formPane = Ui.col(act);
        formPane.setPadding(Ui.dp(act, 16), Ui.dp(act, 12), Ui.dp(act, 16), Ui.dp(act, 16));

        // 1. Barcode row
        formPane.addView(Ui.tv(act, "商品条码（留空可由编码代替）", 12, Ui.MUTED, true));
        LinearLayout barRow = Ui.row(act);
        EditText etBar = Ui.input(act, "扫码或输入条码");
        etBar.setSingleLine(true);
        etBar.setText(existing != null ? existing.barcode : (prefillBarcode != null ? prefillBarcode : ""));
        Button bScanBar = Ui.outlineBtn(act, "扫", Ui.ACCENT, Ui.ACCENT);
        Button bGenEan = Ui.outlineBtn(act, "生成", Ui.PRIMARY, Ui.PRIMARY);
        bScanBar.setPadding(Ui.dp(act, 10), 0, Ui.dp(act, 10), 0);
        bGenEan.setPadding(Ui.dp(act, 10), 0, Ui.dp(act, 10), 0);
        barRow.addView(etBar, new LinearLayout.LayoutParams(0, -2, 1));
        barRow.addView(Ui.space(act, 6, 1));
        barRow.addView(bScanBar, new LinearLayout.LayoutParams(-2, Ui.dp(act, 42)));
        barRow.addView(Ui.space(act, 6, 1));
        barRow.addView(bGenEan, new LinearLayout.LayoutParams(-2, Ui.dp(act, 42)));
        LinearLayout.LayoutParams brlp = new LinearLayout.LayoutParams(-1, -2);
        brlp.topMargin = Ui.dp(act, 4); brlp.bottomMargin = Ui.dp(act, 10);
        formPane.addView(barRow, brlp);

        // 2. Product Name + Voice
        formPane.addView(Ui.tv(act, "商品名称 *", 12, Ui.MUTED, true));
        LinearLayout nameRow = Ui.row(act);
        EditText etName = Ui.input(act, "例如：农夫山泉 550ml");
        etName.setSingleLine(true);
        if (existing != null) etName.setText(existing.name);
        Button bVoice = Ui.outlineBtn(act, "语音", Ui.WARN, Ui.WARN);
        bVoice.setPadding(Ui.dp(act, 12), 0, Ui.dp(act, 12), 0);
        nameRow.addView(etName, new LinearLayout.LayoutParams(0, -2, 1));
        nameRow.addView(Ui.space(act, 6, 1));
        nameRow.addView(bVoice, new LinearLayout.LayoutParams(-2, Ui.dp(act, 42)));
        LinearLayout.LayoutParams nrlp = new LinearLayout.LayoutParams(-1, -2);
        nrlp.topMargin = Ui.dp(act, 4); nrlp.bottomMargin = Ui.dp(act, 10);
        formPane.addView(nameRow, nrlp);

        // 3. Category chips
        formPane.addView(Ui.tv(act, "分类", 12, Ui.MUTED, true));
        final String[] selCat = {existing != null ? existing.category : ""};
        HorizontalScrollView catScroll = new HorizontalScrollView(act);
        catScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout catRow = Ui.row(act);
        catScroll.addView(catRow);
        LinearLayout.LayoutParams crlp = new LinearLayout.LayoutParams(-1, -2);
        crlp.topMargin = Ui.dp(act, 4); crlp.bottomMargin = Ui.dp(act, 10);
        formPane.addView(catScroll, crlp);

        Runnable[] renderCats = {null};
        renderCats[0] = () -> {
            catRow.removeAllViews();
            List<String> cats = new ArrayList<>();
            cats.add("");
            for (String c : store.categories) if (!cats.contains(c)) cats.add(c);
            if (!selCat[0].isEmpty() && !cats.contains(selCat[0])) cats.add(selCat[0]);
            for (String c : cats) {
                TextView ch = Ui.chip(act, c.isEmpty() ? "未分类" : c, c.equals(selCat[0]));
                ch.setOnClickListener(v -> { selCat[0] = c; renderCats[0].run(); });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
                lp.rightMargin = Ui.dp(act, 6);
                catRow.addView(ch, lp);
            }
            TextView addC = Ui.chip(act, "+ 分类", false);
            addC.setTextColor(Ui.ACCENT);
            addC.setOnClickListener(v -> {
                EditText in = Ui.input(act, "新分类名称");
                in.setSingleLine(true);
                new AlertDialog.Builder(act).setTitle("添加分类").setView(in)
                        .setPositiveButton("确定", (dd, w) -> {
                            String nc = in.getText().toString().trim();
                            if (!nc.isEmpty()) {
                                selCat[0] = nc;
                                if (!store.categories.contains(nc)) store.categories.add(nc);
                                renderCats[0].run();
                            }
                        }).setNegativeButton("取消", null).show();
            });
            catRow.addView(addC);
        };
        renderCats[0].run();

        // 4. Unit chips + custom unit input
        formPane.addView(Ui.tv(act, "基本单位", 12, Ui.MUTED, true));
        EditText etUnit = Ui.input(act, "个");
        etUnit.setSingleLine(true);
        etUnit.setText(existing != null ? existing.unit : "个");
        HorizontalScrollView unitScroll = new HorizontalScrollView(act);
        unitScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout unitRow = Ui.row(act);
        unitScroll.addView(unitRow);
        Runnable[] renderUnits = {null};
        renderUnits[0] = () -> {
            unitRow.removeAllViews();
            String curU = etUnit.getText().toString().trim();
            for (String u : QUICK_UNITS) {
                TextView ch = Ui.chip(act, u, u.equals(curU));
                ch.setOnClickListener(v -> { etUnit.setText(u); renderUnits[0].run(); });
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
                lp.rightMargin = Ui.dp(act, 6);
                unitRow.addView(ch, lp);
            }
        };
        renderUnits[0].run();
        LinearLayout.LayoutParams uslp = new LinearLayout.LayoutParams(-1, -2);
        uslp.topMargin = Ui.dp(act, 4); uslp.bottomMargin = Ui.dp(act, 6);
        formPane.addView(unitScroll, uslp);
        LinearLayout.LayoutParams eulp = new LinearLayout.LayoutParams(-1, -2);
        eulp.bottomMargin = Ui.dp(act, 10);
        formPane.addView(etUnit, eulp);

        // 5. Qty + Sale Price + Cost Price row
        LinearLayout numRow = Ui.row(act);
        LinearLayout qCol = Ui.col(act);
        String qTitle = existing != null ? "安全库存" : (qtyLabel != null ? qtyLabel : "期初库存");
        qCol.addView(Ui.tv(act, qTitle, 12, Ui.MUTED, true));
        EditText etQty = Ui.input(act, "0");
        etQty.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
        if (existing != null) etQty.setText(Ui.fmtQty(existing.safety));
        else if (defaultQty != null) etQty.setText(Ui.fmtQty(defaultQty));
        qCol.addView(etQty);
        numRow.addView(qCol, new LinearLayout.LayoutParams(0, -2, 1));

        EditText etPrice = Ui.input(act, "0");
        EditText etCost = Ui.input(act, "0");
        if (store.seesPrice) {
            numRow.addView(Ui.space(act, 8, 1));
            LinearLayout pCol = Ui.col(act);
            pCol.addView(Ui.tv(act, "销售价", 12, Ui.MUTED, true));
            etPrice.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
            if (existing != null && existing.price > 0) etPrice.setText(Ui.fmtQty(existing.price));
            pCol.addView(etPrice);
            numRow.addView(pCol, new LinearLayout.LayoutParams(0, -2, 1));

            numRow.addView(Ui.space(act, 8, 1));
            LinearLayout cCol = Ui.col(act);
            cCol.addView(Ui.tv(act, "成本价", 12, Ui.MUTED, true));
            etCost.setInputType(InputType.TYPE_CLASS_NUMBER | InputType.TYPE_NUMBER_FLAG_DECIMAL);
            if (existing != null && existing.cost > 0) etCost.setText(Ui.fmtQty(existing.cost));
            cCol.addView(etCost);
            numRow.addView(cCol, new LinearLayout.LayoutParams(0, -2, 1));
        }
        LinearLayout.LayoutParams nr2 = new LinearLayout.LayoutParams(-1, -2);
        nr2.bottomMargin = Ui.dp(act, 10);
        formPane.addView(numRow, nr2);

        // 6. Photo capture preview row
        final String[] photoDataUri = {null};
        LinearLayout photoBar = Ui.row(act);
        ImageView thumb = new ImageView(act);
        thumb.setScaleType(ImageView.ScaleType.CENTER_CROP);
        thumb.setBackground(Ui.outlined(act, Ui.BG, Ui.LINE, 1, 8));
        thumb.setVisibility(View.GONE);
        Button bSnap = Ui.outlineBtn(act, "抓拍商品图", Ui.ACCENT, Ui.ACCENT);
        Button bPick = Ui.outlineBtn(act, "相册选图", Ui.LINE, Ui.INK);
        bSnap.setMinHeight(Ui.dp(act, 38)); bSnap.setMinimumHeight(Ui.dp(act, 38)); bSnap.setTextSize(13);
        bPick.setMinHeight(Ui.dp(act, 38)); bPick.setMinimumHeight(Ui.dp(act, 38)); bPick.setTextSize(13);
        photoBar.addView(thumb, new LinearLayout.LayoutParams(Ui.dp(act, 48), Ui.dp(act, 48)));
        photoBar.addView(Ui.space(act, 8, 1));
        photoBar.addView(bSnap, new LinearLayout.LayoutParams(0, Ui.dp(act, 38), 1));
        photoBar.addView(Ui.space(act, 8, 1));
        photoBar.addView(bPick, new LinearLayout.LayoutParams(0, Ui.dp(act, 38), 1));
        LinearLayout.LayoutParams pblp = new LinearLayout.LayoutParams(-1, -2);
        pblp.bottomMargin = Ui.dp(act, 10);
        formPane.addView(photoBar, pblp);

        // 7. Expandable More section (Spec, Brand, Box Unit & Barcode, Dec/Batch/Serial)
        TextView moreToggle = Ui.tv(act, "▸ 展开更多：规格型号 / 品牌 / 箱装条码 / 批次属性", 13, Ui.ACCENT, true);
        moreToggle.setPadding(0, Ui.dp(act, 6), 0, Ui.dp(act, 8));
        formPane.addView(moreToggle);

        LinearLayout moreBox = Ui.col(act);
        moreBox.setVisibility(existing != null && (!existing.spec.isEmpty() || !existing.units.isEmpty()) ? View.VISIBLE : View.GONE);
        moreToggle.setText(moreBox.getVisibility() == View.VISIBLE ? "▾ 收起更多设置" : "▸ 展开更多：规格型号 / 品牌 / 箱装条码 / 批次属性");

        LinearLayout sbRow = Ui.row(act);
        EditText etSpec = Ui.input(act, "规格型号");
        EditText etBrand = Ui.input(act, "品牌");
        EditText etSku = Ui.input(act, "商品编码(留空自动)");
        if (existing != null) {
            etSpec.setText(existing.spec);
            etBrand.setText(existing.brand);
            etSku.setText(existing.sku);
        }
        sbRow.addView(etSpec, new LinearLayout.LayoutParams(0, -2, 1));
        sbRow.addView(Ui.space(act, 8, 1));
        sbRow.addView(etBrand, new LinearLayout.LayoutParams(0, -2, 1));
        moreBox.addView(sbRow);
        LinearLayout.LayoutParams skulp = new LinearLayout.LayoutParams(-1, -2);
        skulp.topMargin = Ui.dp(act, 8);
        moreBox.addView(etSku, skulp);

        // Auxiliary unit row
        moreBox.addView(Ui.tv(act, "大包装/辅助单位（如 1 箱 = 12 个）", 12, Ui.MUTED, true), skulp);
        LinearLayout pkgRow = Ui.row(act);
        EditText etPkgName = Ui.input(act, "单位(如 箱)");
        EditText etPkgRate = Ui.input(act, "换算(如 12)");
        etPkgRate.setInputType(InputType.TYPE_CLASS_NUMBER);
        pkgRow.addView(etPkgName, new LinearLayout.LayoutParams(0, -2, 1));
        pkgRow.addView(Ui.space(act, 6, 1));
        pkgRow.addView(etPkgRate, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams pglp = new LinearLayout.LayoutParams(-1, -2);
        pglp.topMargin = Ui.dp(act, 4);
        moreBox.addView(pkgRow, pglp);

        LinearLayout pkgBarRow = Ui.row(act);
        EditText etPkgBar = Ui.input(act, "大包装条码（箱码）");
        Button bScanPkgBar = Ui.outlineBtn(act, "扫箱码", Ui.ACCENT, Ui.ACCENT);
        bScanPkgBar.setPadding(Ui.dp(act, 10), 0, Ui.dp(act, 10), 0);
        pkgBarRow.addView(etPkgBar, new LinearLayout.LayoutParams(0, -2, 1));
        pkgBarRow.addView(Ui.space(act, 6, 1));
        pkgBarRow.addView(bScanPkgBar, new LinearLayout.LayoutParams(-2, Ui.dp(act, 42)));
        moreBox.addView(pkgBarRow, pglp);

        if (existing != null && !existing.units.isEmpty()) {
            Models.UnitSpec u0 = existing.units.get(0);
            etPkgName.setText(u0.name);
            etPkgRate.setText(String.valueOf(u0.rate));
            etPkgBar.setText(u0.barcode);
        }

        LinearLayout flagsRow = Ui.row(act);
        CheckBox cbDec = new CheckBox(act); cbDec.setText("允许小数"); cbDec.setTextSize(13);
        CheckBox cbBatch = new CheckBox(act); cbBatch.setText("批次/效期"); cbBatch.setTextSize(13);
        CheckBox cbSerial = new CheckBox(act); cbSerial.setText("序列号"); cbSerial.setTextSize(13);
        if (existing != null) {
            cbDec.setChecked(existing.dec);
            cbBatch.setChecked(existing.batch);
            cbSerial.setChecked(existing.serial);
        }
        flagsRow.addView(cbDec);
        flagsRow.addView(cbBatch);
        flagsRow.addView(cbSerial);
        moreBox.addView(flagsRow, skulp);

        moreToggle.setOnClickListener(v -> {
            boolean show = moreBox.getVisibility() != View.VISIBLE;
            moreBox.setVisibility(show ? View.VISIBLE : View.GONE);
            moreToggle.setText(show ? "▾ 收起更多设置" : "▸ 展开更多：规格型号 / 品牌 / 箱装条码 / 批次属性");
        });
        formPane.addView(moreBox);

        // ---------- Pane B: Bind Barcode to Existing Product ----------
        LinearLayout bindPane = Ui.col(act);
        bindPane.setPadding(Ui.dp(act, 16), Ui.dp(act, 12), Ui.dp(act, 16), Ui.dp(act, 16));
        bindPane.setVisibility(View.GONE);
        String codeToBind = prefillBarcode != null ? prefillBarcode.trim() : "";
        bindPane.addView(Ui.tv(act, "将条码 [" + codeToBind + "] 绑定到：", 13, Ui.PRIMARY, true));
        EditText etSearch = Ui.input(act, "输入商品名称 / 编码 / 规格筛选");
        LinearLayout.LayoutParams slp2 = new LinearLayout.LayoutParams(-1, -2);
        slp2.topMargin = Ui.dp(act, 8); slp2.bottomMargin = Ui.dp(act, 8);
        bindPane.addView(etSearch, slp2);
        LinearLayout bindList = Ui.col(act);
        bindPane.addView(bindList);

        LinearLayout panes = Ui.col(act);
        panes.addView(formPane);
        panes.addView(bindPane);
        scroll.addView(panes);

        // Bottom fixed Save Bar (Thumb zone!)
        LinearLayout foot = Ui.row(act);
        foot.setPadding(Ui.dp(act, 16), Ui.dp(act, 10), Ui.dp(act, 16), Ui.dp(act, 14));
        Button bSave = Ui.gradientBtn(act, existing != null ? "保存修改" : "保存新商品", Ui.PRIMARY, Ui.PRIMARY_END);
        bSave.setTextSize(16);
        foot.addView(bSave, new LinearLayout.LayoutParams(-1, Ui.dp(act, 50)));
        outer.addView(Ui.divider(act));
        outer.addView(foot);

        // Bounded height wrapper
        LinearLayout frame = Ui.col(act);
        frame.addView(outer, new LinearLayout.LayoutParams(-1, maxH));
        Dialog dlg = Ui.showBottomDialog(act, frame, true);

        Runnable renderBindList = () -> {
            bindList.removeAllViews();
            String q = etSearch.getText().toString().trim().toLowerCase(Locale.ROOT);
            int shown = 0;
            for (Models.Product p : store.products) {
                String hay = (p.name + " " + p.sku + " " + p.spec + " " + p.barcode).toLowerCase(Locale.ROOT);
                if (!q.isEmpty() && !hay.contains(q)) continue;
                LinearLayout item = Ui.row(act);
                item.setBackground(Ui.rippleOutlined(act, Color.WHITE, Ui.LINE, 1, 12));
                item.setPadding(Ui.dp(act, 12), Ui.dp(act, 10), Ui.dp(act, 12), Ui.dp(act, 10));
                LinearLayout info = Ui.col(act);
                info.addView(Ui.tv(act, p.name, 14, Ui.INK, true));
                String sub = p.sku + (p.spec.isEmpty() ? "" : " · " + p.spec) + (p.barcode.isEmpty() ? " · 无条码" : " · 已有码:" + p.barcode);
                info.addView(Ui.tv(act, sub, 12, Ui.MUTED, false));
                item.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
                item.addView(Ui.badge(act, "绑定", Ui.ACCENT_SOFT, Ui.ACCENT));
                item.setOnClickListener(v -> showBindChoice(act, dlg, store, p, codeToBind, onSaved));
                LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(-1, -2);
                ilp.bottomMargin = Ui.dp(act, 8);
                bindList.addView(item, ilp);
                if (++shown >= 30) break;
            }
            if (shown == 0) bindList.addView(Ui.emptyState(act, IconView.Type.SEARCH_BAR, "没有找到匹配的商品", "请换个名称、编码或规格关键字"));
        };
        etSearch.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int start, int count, int after) { }
            @Override public void onTextChanged(CharSequence s, int start, int before, int count) { }
            @Override public void afterTextChanged(Editable s) { renderBindList.run(); }
        });
        renderBindList.run();

        tabNew.setOnClickListener(v -> {
            tabNew.setBackground(Ui.rounded(act, Ui.CARD, 9)); tabNew.setTextColor(Ui.PRIMARY); tabNew.setElevation(Ui.dp(act, 1));
            tabBind.setBackgroundColor(Color.TRANSPARENT); tabBind.setTextColor(Ui.MUTED); tabBind.setElevation(0);
            formPane.setVisibility(View.VISIBLE);
            bindPane.setVisibility(View.GONE);
            foot.setVisibility(View.VISIBLE);
        });
        tabBind.setOnClickListener(v -> {
            tabBind.setBackground(Ui.rounded(act, Ui.CARD, 9)); tabBind.setTextColor(Ui.PRIMARY); tabBind.setElevation(Ui.dp(act, 1));
            tabNew.setBackgroundColor(Color.TRANSPARENT); tabNew.setTextColor(Ui.MUTED); tabNew.setElevation(0);
            formPane.setVisibility(View.GONE);
            bindPane.setVisibility(View.VISIBLE);
            foot.setVisibility(View.GONE);
        });

        closeBtn.setOnClickListener(v -> dlg.dismiss());

        bGenEan.setOnClickListener(v -> etBar.setText(BarcodeGenHelper.generateInternalEan13(store.allUsedCodes())));
        bScanBar.setOnClickListener(v -> {
            dlg.hide();
            act.captureOneShotBarcode("扫描商品主条码", code -> {
                dlg.show();
                if (code != null) etBar.setText(code);
            });
        });
        bScanPkgBar.setOnClickListener(v -> {
            dlg.hide();
            act.captureOneShotBarcode("扫描大包装/箱条码", code -> {
                dlg.show();
                if (code != null) etPkgBar.setText(code);
            });
        });
        bVoice.setOnClickListener(v -> act.startVoiceInput(text -> {
            if (text != null && !text.isEmpty()) etName.setText(text);
        }));
        bSnap.setOnClickListener(v -> {
            bSnap.setEnabled(false);
            dlg.hide();
            act.takeLiveSnapshot((uri, bmp, err) -> {
                dlg.show();
                bSnap.setEnabled(true);
                if (err != null) { Ui.toast(act, err); return; }
                if (uri == null || bmp == null) return;
                photoDataUri[0] = uri;
                thumb.setImageBitmap(bmp);
                thumb.setVisibility(View.VISIBLE);
                Ui.toast(act, "已抓拍图片");
            });
        });
        bPick.setOnClickListener(v -> act.pickGalleryImage((uri, bmp, err) -> {
            if (err != null) { Ui.toast(act, err); return; }
            photoDataUri[0] = uri;
            thumb.setImageBitmap(bmp);
            thumb.setVisibility(View.VISIBLE);
        }));

        bSave.setOnClickListener(v -> {
            String name = etName.getText().toString().trim();
            if (name.isEmpty()) { Ui.toast(act, "请填写商品名称"); etName.requestFocus(); return; }
            String unit = etUnit.getText().toString().trim();
            if (unit.isEmpty()) unit = "个";

            try {
                JSONObject body = new JSONObject();
                body.put("name", name);
                body.put("sku", etSku.getText().toString().trim());
                body.put("barcode", etBar.getText().toString().trim());
                body.put("category", selCat[0]);
                body.put("unit", unit);
                body.put("spec", etSpec.getText().toString().trim());
                body.put("brand", etBrand.getText().toString().trim());
                body.put("dec", cbDec.isChecked());
                body.put("batch", cbBatch.isChecked());
                body.put("serial", cbSerial.isChecked());

                double qVal = parseNum(etQty.getText().toString().trim(), 0);
                if (existing != null) {
                    body.put("safety", Math.round(qVal));
                } else {
                    // When launched from stocktake with empty string in qTitle ("本次实盘数量"), keep initial stock 0 unless explicit initial stock
                    boolean fromStocktake = qtyLabel != null && qtyLabel.contains("实盘");
                    body.put("stock", fromStocktake ? 0 : Math.round(qVal));
                    body.put("wh", store.selectedWh);
                }
                if (store.seesPrice) {
                    body.put("price", parseNum(etPrice.getText().toString().trim(), 0));
                    body.put("cost", parseNum(etCost.getText().toString().trim(), 0));
                }

                JSONArray unitsArr = new JSONArray();
                String pkgN = etPkgName.getText().toString().trim();
                String pkgRStr = etPkgRate.getText().toString().trim();
                String pkgB = etPkgBar.getText().toString().trim();
                if (!pkgN.isEmpty() || !pkgRStr.isEmpty() || !pkgB.isEmpty()) {
                    int rate = (int) parseNum(pkgRStr, 0);
                    if (pkgN.isEmpty() || rate < 2) {
                        Ui.toast(act, "辅助单位请填名称且换算需 ≥ 2");
                        return;
                    }
                    Models.UnitSpec u0 = new Models.UnitSpec();
                    u0.name = pkgN;
                    u0.rate = rate;
                    u0.barcode = pkgB;
                    unitsArr.put(u0.toJson());
                }
                if (existing != null && existing.units.size() > 1) {
                    for (int i = 1; i < existing.units.size(); i++) unitsArr.put(existing.units.get(i).toJson());
                }
                body.put("units", unitsArr);

                bSave.setEnabled(false);
                bSave.setText("正在保存…");
                new Thread(() -> {
                    try {
                        JSONObject res = existing != null
                                ? ApiClient.updateProduct(store, existing.id, body)
                                : ApiClient.createProduct(store, body);
                        Models.Product saved = Models.Product.fromJson(res);
                        if (photoDataUri[0] != null) {
                            ApiClient.uploadProductImage(store, saved.id, photoDataUri[0]);
                            saved.img = "1";
                        }
                        store.upsertProduct(saved);
                        Double extra = existing == null && qtyLabel != null && qtyLabel.contains("实盘")
                                ? parseNum(etQty.getText().toString().trim(), 1)
                                : null;
                        act.runOnUiThread(() -> {
                            dlg.dismiss();
                            Ui.toast(act, existing != null ? "商品已更新" : "新商品已创建");
                            act.notifyDataChanged();
                            if (onSaved != null) onSaved.onProductSaved(saved, null, extra);
                        });
                    } catch (Exception ex) {
                        act.runOnUiThread(() -> {
                            bSave.setEnabled(true);
                            bSave.setText(existing != null ? "保存修改" : "保存新商品");
                            Ui.toast(act, ApiClient.friendlyError(ex));
                        });
                    }
                }).start();
            } catch (Exception ex) {
                Ui.toast(act, "表单填写有误，请检查");
            }
        });
    }

    private static void showBindChoice(MainActivity act, Dialog parentDlg, AppStore store, Models.Product p, String code, OnSaved onSaved) {
        if (code.isEmpty()) { Ui.toast(act, "没有可绑定的条码"); return; }
        List<String> labels = new ArrayList<>();
        labels.add("设为主条码（基本单位：" + p.unit + (p.barcode.isEmpty() ? "" : "，将替换 " + p.barcode) + "）");
        for (Models.UnitSpec u : p.units) {
            labels.add("设为 [" + u.name + " ×" + u.rate + "] 条码" + (u.barcode.isEmpty() ? "" : "（原：" + u.barcode + "）"));
        }
        labels.add("+ 新建大包装单位并绑定此条码");

        new AlertDialog.Builder(act)
                .setTitle("绑定到「" + p.name + "」")
                .setItems(labels.toArray(new String[0]), (d, which) -> {
                    if (which == labels.size() - 1) {
                        askNewPkgBind(act, parentDlg, store, p, code, onSaved);
                    } else if (which == 0) {
                        doBind(act, parentDlg, store, p, code, -1, null, onSaved);
                    } else {
                        doBind(act, parentDlg, store, p, code, which - 1, p.units.get(which - 1), onSaved);
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private static void askNewPkgBind(MainActivity act, Dialog parentDlg, AppStore store, Models.Product p, String code, OnSaved onSaved) {
        LinearLayout box = Ui.col(act);
        int pad = Ui.dp(act, 16);
        box.setPadding(pad, Ui.dp(act, 8), pad, 0);
        EditText etU = Ui.input(act, "包装单位名称（如：箱、盒）");
        etU.setText("箱");
        EditText etR = Ui.input(act, "1 箱等于多少 " + p.unit + "（填整数 ≥ 2）");
        etR.setInputType(InputType.TYPE_CLASS_NUMBER);
        etR.setText("12");
        box.addView(etU);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        lp.topMargin = Ui.dp(act, 8);
        box.addView(etR, lp);
        new AlertDialog.Builder(act).setTitle("添加包装单位并绑码")
                .setView(box)
                .setPositiveButton("确定绑定", (dd, w) -> {
                    String un = etU.getText().toString().trim();
                    int r = (int) parseNum(etR.getText().toString().trim(), 0);
                    if (un.isEmpty() || r < 2) { Ui.toast(act, "单位不能为空且换算 ≥ 2"); return; }
                    Models.UnitSpec nu = new Models.UnitSpec();
                    nu.name = un; nu.rate = r; nu.barcode = code;
                    p.units.add(nu);
                    doBind(act, parentDlg, store, p, code, p.units.size() - 1, nu, onSaved);
                }).setNegativeButton("取消", null).show();
    }

    private static void doBind(MainActivity act, Dialog parentDlg, AppStore store, Models.Product p, String code, int unitIdx, Models.UnitSpec boundUnit, OnSaved onSaved) {
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject();
                body.put("name", p.name);
                body.put("sku", p.sku);
                body.put("unit", p.unit);
                body.put("barcode", unitIdx < 0 ? code : p.barcode);
                JSONArray us = new JSONArray();
                for (int i = 0; i < p.units.size(); i++) {
                    Models.UnitSpec u = p.units.get(i);
                    if (i == unitIdx) u.barcode = code;
                    us.put(u.toJson());
                }
                body.put("units", us);
                JSONObject res = ApiClient.updateProduct(store, p.id, body);
                Models.Product saved = Models.Product.fromJson(res);
                store.upsertProduct(saved);
                Models.UnitSpec matchU = unitIdx >= 0 && unitIdx < saved.units.size() ? saved.units.get(unitIdx) : null;
                act.runOnUiThread(() -> {
                    parentDlg.dismiss();
                    Ui.toast(act, "条码已绑定到「" + saved.name + "」");
                    act.notifyDataChanged();
                    if (onSaved != null) onSaved.onProductSaved(saved, matchU, null);
                });
            } catch (Exception e) {
                act.runOnUiThread(() -> Ui.toast(act, ApiClient.friendlyError(e)));
            }
        }).start();
    }

    private static double parseNum(String s, double def) {
        try { return s.isEmpty() ? def : Double.parseDouble(s); } catch (Exception e) { return def; }
    }
}
