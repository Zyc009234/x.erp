package com.xerp.scanner;

import android.app.AlertDialog;
import android.app.Dialog;
import android.graphics.Color;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class StockMoveTab implements TabPage {
    private final MainActivity act;
    private final AppStore store;
    private final LinearLayout root;

    private String mode = "in"; // in, out, transfer
    private String docType = "";
    private String toWh = "";
    private String remark = "";

    private Button segIn, segOut, segTransfer;
    private LinearLayout ctxBar, unknownBar, cartList, thumbBar;
    private TextView typePill, notePill;
    private String pendingUnknown = "";
    private int activeIdx = -1;

    private final List<Models.ScanCartItem> cart = new ArrayList<>();
    private final List<String> activeSerialList = new ArrayList<>();
    private Runnable onSerialSheetUpdate;

    public StockMoveTab(MainActivity act) {
        this.act = act;
        this.store = act.store;
        root = Ui.col(act);
        root.setBackgroundColor(Ui.BG);
        buildUi();
    }

    private void buildUi() {
        // 1. Mode Switch
        LinearLayout seg = Ui.row(act);
        seg.setBackgroundColor(Color.WHITE);
        seg.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 6));
        segIn = Ui.btn(act, "扫码入库", Ui.PRIMARY, Color.WHITE);
        segOut = Ui.outlineBtn(act, "扫码出库", Ui.LINE, Ui.INK);
        segTransfer = Ui.outlineBtn(act, "仓库调拨", Ui.LINE, Ui.INK);
        for (Button b : new Button[]{segIn, segOut, segTransfer}) {
            b.setMinHeight(Ui.dp(act, 36));
            b.setMinimumHeight(Ui.dp(act, 36));
            b.setTextSize(13);
        }
        segIn.setOnClickListener(v -> setMode("in"));
        segOut.setOnClickListener(v -> setMode("out"));
        segTransfer.setOnClickListener(v -> setMode("transfer"));
        seg.addView(segIn, new LinearLayout.LayoutParams(0, Ui.dp(act, 36), 1));
        seg.addView(Ui.space(act, 6, 1));
        seg.addView(segOut, new LinearLayout.LayoutParams(0, Ui.dp(act, 36), 1));
        seg.addView(Ui.space(act, 6, 1));
        seg.addView(segTransfer, new LinearLayout.LayoutParams(0, Ui.dp(act, 36), 1));
        root.addView(seg);

        // 2. Context Bar (docType or target warehouse + remark)
        ctxBar = Ui.row(act);
        ctxBar.setBackgroundColor(Color.WHITE);
        ctxBar.setPadding(Ui.dp(act, 10), 0, Ui.dp(act, 10), Ui.dp(act, 8));
        typePill = Ui.tv(act, "其他入库 ▾", 13, Ui.ACCENT, true);
        typePill.setBackground(Ui.outlined(act, Ui.ACCENT_SOFT, Ui.ACCENT, 1, 8));
        typePill.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        typePill.setOnClickListener(v -> pickContextType());

        notePill = Ui.tv(act, "备注", 13, Ui.MUTED, false);
        notePill.setBackground(Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 8));
        notePill.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        notePill.setOnClickListener(v -> editRemark());

        ctxBar.addView(typePill, new LinearLayout.LayoutParams(0, -2, 1));
        ctxBar.addView(Ui.space(act, 8, 1));
        ctxBar.addView(notePill);
        root.addView(ctxBar);
        root.addView(Ui.divider(act));

        // 3. Unknown barcode banner
        unknownBar = Ui.row(act);
        unknownBar.setBackgroundColor(Ui.WARN_SOFT);
        unknownBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
        unknownBar.setVisibility(View.GONE);
        root.addView(unknownBar);

        // 4. Cart List
        ScrollView sv = new ScrollView(act);
        cartList = Ui.col(act);
        cartList.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 10));
        sv.addView(cartList);
        root.addView(sv, new LinearLayout.LayoutParams(-1, 0, 1));

        // 5. Bottom Stepper + Submit
        root.addView(Ui.divider(act));
        thumbBar = Ui.col(act);
        thumbBar.setBackgroundColor(Color.WHITE);
        thumbBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
        root.addView(thumbBar);
    }

    @Override public View getView() { return root; }
    @Override public boolean needsCamera() { return true; }
    @Override public void onCameraStateChanged(boolean open) { renderAll(); }

    @Override
    public void onShown() {
        syncContextDefaults();
        renderAll();
    }

    @Override
    public void onDataUpdated() {
        syncContextDefaults();
        renderAll();
    }

    private void setMode(String m) {
        if (mode.equals(m)) return;
        mode = m;
        docType = "";
        syncContextDefaults();
        renderAll();
    }

    private void syncContextDefaults() {
        if ("in".equals(mode)) {
            if (docType.isEmpty() || !store.docTypesIn.contains(docType)) {
                docType = store.docTypesIn.isEmpty() ? "其他入库" : store.docTypesIn.get(0);
            }
        } else if ("out".equals(mode)) {
            if (docType.isEmpty() || !store.docTypesOut.contains(docType)) {
                docType = store.docTypesOut.isEmpty() ? "其他出库" : store.docTypesOut.get(0);
            }
        } else {
            if (toWh.isEmpty() || toWh.equals(store.selectedWh)) {
                for (Models.Warehouse w : store.warehouses) {
                    if (!w.id.equals(store.selectedWh)) { toWh = w.id; break; }
                }
            }
        }
    }

    private void pickContextType() {
        if ("transfer".equals(mode)) {
            List<Models.Warehouse> others = new ArrayList<>();
            for (Models.Warehouse w : store.warehouses) if (!w.id.equals(store.selectedWh)) others.add(w);
            if (others.isEmpty()) { Ui.toast(act, "只有一个仓库，无法调拨"); return; }
            String[] names = new String[others.size()];
            for (int i = 0; i < others.size(); i++) names[i] = others.get(i).name;
            new AlertDialog.Builder(act).setTitle("选择调入仓库")
                    .setItems(names, (d, w) -> { toWh = others.get(w).id; renderAll(); }).show();
            return;
        }
        List<String> list = "in".equals(mode) ? store.docTypesIn : store.docTypesOut;
        String[] arr = list.toArray(new String[0]);
        new AlertDialog.Builder(act).setTitle("选择业务类型")
                .setItems(arr, (d, w) -> { docType = arr[w]; renderAll(); }).show();
    }

    private void editRemark() {
        EditText et = Ui.input(act, "填写备注或往来单位（选填）");
        et.setText(remark);
        new AlertDialog.Builder(act).setTitle("单据备注").setView(et)
                .setPositiveButton("确定", (d, w) -> { remark = et.getText().toString().trim(); renderAll(); })
                .setNegativeButton("取消", null).show();
    }

    @Override
    public void onBarcodeScanned(String code) {
        String c = code.trim();
        if (onSerialSheetUpdate != null) {
            handleSerialScan(c);
            return;
        }
        Models.BarcodeMatch match = store.findByCode(c);
        if (match == null) {
            act.scanner.feedbackUnknown();
            if (act.tts != null) act.tts.speakCue("未找到条码", "not_found");
            pendingUnknown = c;
            showUnknownBanner();
            if ("in".equals(mode) && store.autoPromptNew) {
                openQuickNewForInbound(c);
            }
            return;
        }
        pendingUnknown = "";
        unknownBar.setVisibility(View.GONE);
        addMatchToCart(match);
    }

    private void handleSerialScan(String sn) {
        if (activeIdx < 0 || activeIdx >= cart.size()) return;
        Models.ScanCartItem item = cart.get(activeIdx);
        Models.Product p = store.productById.get(item.productId);
        if (p == null) return;
        if (item.serials.contains(sn)) {
            act.scanner.feedbackError();
            if (act.tts != null) act.tts.speakCue("重复序列号", "sn_dup");
            Ui.toast(act, "重复序列号：" + sn);
            return;
        }
        Models.SerialRec rec = store.serialBySn.get(sn);
        if ("in".equals(mode)) {
            if (rec != null && "在库".equals(rec.status)) {
                act.scanner.feedbackError();
                if (act.tts != null) act.tts.speakCue("序列号异常", "sn_err");
                Ui.toast(act, "该序列号已在库：" + sn);
                return;
            }
        } else {
            if (rec == null || !rec.productId.equals(p.id) || !"在库".equals(rec.status) || !rec.wh.equals(store.selectedWh)) {
                act.scanner.feedbackError();
                if (act.tts != null) act.tts.speakCue("序列号异常", "sn_err");
                Ui.toast(act, "该序列号不在当前仓库在库列表");
                return;
            }
        }
        item.serials.add(sn);
        item.qty = item.serials.size();
        act.scanner.feedbackOk();
        if (act.tts != null) act.tts.speakSerialCount(item.serials.size());
        if (onSerialSheetUpdate != null) onSerialSheetUpdate.run();
        renderAll();
    }

    private void addMatchToCart(Models.BarcodeMatch m) {
        Models.Product p = m.product;
        String uName = m.unitName();
        int rate = m.rate();

        if (p.serial) {
            int idx = findCartIndex(p.id, p.unit);
            if (idx < 0) {
                Models.ScanCartItem it = new Models.ScanCartItem();
                it.productId = p.id;
                it.unitName = p.unit;
                it.rate = 1;
                it.qty = 0;
                cart.add(0, it);
                activeIdx = 0;
            } else {
                activeIdx = idx;
            }
            act.scanner.feedbackOk();
            if (act.tts != null) act.tts.speakCue(TtsSpeaker.shortName(p.name) + "，请扫序列号", "sn_scan");
            renderAll();
            openSerialSheet(cart.get(activeIdx), p);
            return;
        }

        int idx = findCartIndex(p.id, uName);
        if (idx >= 0) {
            Models.ScanCartItem it = cart.get(idx);
            it.qty += 1;
            activeIdx = idx;
        } else {
            Models.ScanCartItem it = new Models.ScanCartItem();
            it.productId = p.id;
            it.unitName = uName;
            it.rate = rate;
            it.qty = 1;
            if ("in".equals(mode) && store.seesPrice) it.price = p.cost * rate;
            if (p.batch && "in".equals(mode)) it.batchNo = "扫码入库";
            cart.add(0, it);
            activeIdx = 0;
        }

        boolean lowStock = false;
        if (!"in".equals(mode)) {
            double avail = p.whQty(store.selectedWh);
            double need = cart.get(activeIdx).baseQty();
            if (need > avail + 1e-6) {
                lowStock = true;
                Ui.toast(act, "注意：当前仓仅剩 " + Ui.fmtQty(avail) + " " + p.unit);
                if (act.tts != null) act.tts.speakLowStock(p.name, avail);
            }
        }
        if (!lowStock && act.tts != null) {
            act.tts.speakMove(p.name, mode, cart.get(activeIdx).qty, uName);
        }
        act.scanner.feedbackOk();
        renderAll();
    }

    private int findCartIndex(String pid, String uName) {
        for (int i = 0; i < cart.size(); i++) {
            Models.ScanCartItem it = cart.get(i);
            if (it.productId.equals(pid) && it.unitName.equals(uName)) return i;
        }
        return -1;
    }

    private void showUnknownBanner() {
        unknownBar.removeAllViews();
        if (pendingUnknown.isEmpty()) { unknownBar.setVisibility(View.GONE); return; }
        unknownBar.setVisibility(View.VISIBLE);
        unknownBar.addView(Ui.tv(act, "未找到条码：" + pendingUnknown, 13, 0xFF92400E, true),
                new LinearLayout.LayoutParams(0, -2, 1));
        TextView bNew = Ui.badge(act, "建档并加入", Ui.PRIMARY, Color.WHITE);
        bNew.setTextSize(12);
        bNew.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        bNew.setOnClickListener(v -> openQuickNewForInbound(pendingUnknown));
        unknownBar.addView(bNew);
    }

    private void openQuickNewForInbound(String code) {
        ProductEditorSheet.show(act, null, code, 0.0, "期初库存", true, (product, boundUnit, extraQty) -> {
            pendingUnknown = "";
            unknownBar.setVisibility(View.GONE);
            addMatchToCart(new Models.BarcodeMatch(product, boundUnit));
        });
    }

    private void openSerialSheet(Models.ScanCartItem item, Models.Product p) {
        LinearLayout box = Ui.col(act);
        box.setPadding(Ui.dp(act, 16), Ui.dp(act, 14), Ui.dp(act, 16), Ui.dp(act, 16));
        box.addView(Ui.tv(act, p.name + " · 扫序列号", 17, Ui.INK, true));
        TextView sub = Ui.tv(act, "请用上方相机连续扫描每个商品序列号（已扫 " + item.serials.size() + " 件）", 13, Ui.MUTED, false);
        sub.setPadding(0, Ui.dp(act, 4), 0, Ui.dp(act, 10));
        box.addView(sub);

        ScrollView sv = new ScrollView(act);
        LinearLayout list = Ui.col(act);
        sv.addView(list);
        box.addView(sv, new LinearLayout.LayoutParams(-1, Ui.dp(act, 170)));

        Runnable drawSn = () -> {
            sub.setText("请用上方相机连续扫描每个商品序列号（已扫 " + item.serials.size() + " 件）");
            list.removeAllViews();
            for (int i = item.serials.size() - 1; i >= 0; i--) {
                final int idx = i;
                String sn = item.serials.get(i);
                LinearLayout row = Ui.row(act);
                row.setBackground(Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 8));
                row.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
                row.addView(Ui.tv(act, (i + 1) + ". " + sn, 14, Ui.INK, true), new LinearLayout.LayoutParams(0, -2, 1));
                TextView del = Ui.badge(act, "删", Ui.DANGER_SOFT, Ui.DANGER);
                del.setOnClickListener(v -> {
                    item.serials.remove(idx);
                    item.qty = item.serials.size();
                    if (onSerialSheetUpdate != null) onSerialSheetUpdate.run();
                    renderAll();
                });
                row.addView(del);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(-1, -2);
                rlp.bottomMargin = Ui.dp(act, 6);
                list.addView(row, rlp);
            }
            if (item.serials.isEmpty()) list.addView(Ui.tv(act, "暂无已扫序列号", 13, Ui.MUTED, false));
        };
        onSerialSheetUpdate = drawSn;
        drawSn.run();

        Button done = Ui.btn(act, "完成录入", Ui.PRIMARY, Color.WHITE);
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 48));
        dlp.topMargin = Ui.dp(act, 10);
        box.addView(done, dlp);

        final boolean prevCam = act.isCameraOpen();
        act.setModalCameraLock(true);
        act.setCameraOpen(true);
        Dialog dlg = Ui.showBottomDialog(act, box, false);
        dlg.setOnDismissListener(d -> {
            onSerialSheetUpdate = null;
            act.setModalCameraLock(false);
            act.setCameraOpen(prevCam);
        });
        done.setOnClickListener(v -> dlg.dismiss());
    }

    private void pickBatchForItem(Models.ScanCartItem item, Models.Product p) {
        if ("in".equals(mode)) {
            EditText etNo = Ui.input(act, "批号（如 B20261122）");
            etNo.setText(item.batchNo);
            EditText etExp = Ui.input(act, "有效期 YYYY-MM-DD（选填）");
            etExp.setText(item.expDate);
            LinearLayout box = Ui.col(act);
            int pad = Ui.dp(act, 16);
            box.setPadding(pad, Ui.dp(act, 8), pad, 0);
            box.addView(etNo);
            box.addView(Ui.space(act, 1, 8));
            box.addView(etExp);
            new AlertDialog.Builder(act).setTitle(p.name + " 批次设置").setView(box)
                    .setPositiveButton("确定", (d, w) -> {
                        item.batchNo = etNo.getText().toString().trim();
                        item.expDate = etExp.getText().toString().trim();
                        renderAll();
                    }).setNegativeButton("取消", null).show();
        } else {
            List<Models.BatchRec> avail = new ArrayList<>();
            for (Models.BatchRec b : store.batches) {
                if (b.productId.equals(p.id) && b.wh.equals(store.selectedWh) && b.qty > 0) avail.add(b);
            }
            if (avail.isEmpty()) { Ui.toast(act, "当前仓暂无可选批次（将自动按先到期先出扣减）"); return; }
            String[] labels = new String[avail.size() + 1];
            labels[0] = "自动按先到期先出 (FEFO)";
            for (int i = 0; i < avail.size(); i++) {
                Models.BatchRec b = avail.get(i);
                labels[i + 1] = b.no + (b.expDate.isEmpty() ? "" : " (效期:" + b.expDate + ")") + " · 剩 " + Ui.fmtQty(b.qty);
            }
            new AlertDialog.Builder(act).setTitle("选择出库批次")
                    .setItems(labels, (d, w) -> {
                        if (w == 0) { item.preferBatchId = ""; item.preferBatchLabel = ""; }
                        else {
                            Models.BatchRec b = avail.get(w - 1);
                            item.preferBatchId = b.id;
                            item.preferBatchLabel = b.no;
                        }
                        renderAll();
                    }).show();
        }
    }

    private void renderAll() {
        segIn.setBackground("in".equals(mode) ? Ui.rounded(act, Ui.PRIMARY, 10) : Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 10));
        segIn.setTextColor("in".equals(mode) ? Color.WHITE : Ui.INK);
        segOut.setBackground("out".equals(mode) ? Ui.rounded(act, Ui.DANGER, 10) : Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 10));
        segOut.setTextColor("out".equals(mode) ? Color.WHITE : Ui.INK);
        segTransfer.setBackground("transfer".equals(mode) ? Ui.rounded(act, Ui.ACCENT, 10) : Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 10));
        segTransfer.setTextColor("transfer".equals(mode) ? Color.WHITE : Ui.INK);

        if ("transfer".equals(mode)) {
            typePill.setText(store.whName(store.selectedWh) + " → " + (toWh.isEmpty() ? "选调入仓" : store.whName(toWh)) + " ▾");
        } else {
            typePill.setText(docType + " ▾");
        }
        notePill.setText(remark.isEmpty() ? "备注" : "注:" + remark);

        cartList.removeAllViews();
        for (int i = 0; i < cart.size(); i++) {
            final int idx = i;
            Models.ScanCartItem it = cart.get(i);
            Models.Product p = store.productById.get(it.productId);
            if (p == null) continue;
            boolean sel = idx == activeIdx;
            LinearLayout card = Ui.col(act);
            card.setBackground(Ui.outlined(act, sel ? Ui.PRIMARY_SOFT : Color.WHITE, sel ? Ui.PRIMARY : Ui.LINE, 1, 10));
            card.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));

            LinearLayout top = Ui.row(act);
            LinearLayout info = Ui.col(act);
            info.addView(Ui.tv(act, p.name, 14, Ui.INK, true));
            String sub = it.unitName + (it.rate > 1 ? " (=" + Ui.fmtQty(it.baseQty()) + p.unit + ")" : "")
                    + " · 库存 " + Ui.fmtQty(p.whQty(store.selectedWh));
            info.addView(Ui.tv(act, sub, 12, Ui.MUTED, false));
            top.addView(info, new LinearLayout.LayoutParams(0, -2, 1));
            top.addView(Ui.tv(act, "× " + Ui.fmtQty(it.qty) + " " + it.unitName, 16, Ui.INK, true));
            card.addView(top);

            if (p.batch || p.serial) {
                LinearLayout extras = Ui.row(act);
                extras.setPadding(0, Ui.dp(act, 6), 0, 0);
                if (p.batch) {
                    String bText = !it.batchNo.isEmpty() ? ("批:" + it.batchNo) : (!it.preferBatchLabel.isEmpty() ? ("批:" + it.preferBatchLabel) : "设置批次");
                    TextView bBadge = Ui.badge(act, bText, Ui.ACCENT_SOFT, Ui.ACCENT);
                    bBadge.setOnClickListener(v -> pickBatchForItem(it, p));
                    extras.addView(bBadge);
                }
                if (p.serial) {
                    TextView sBadge = Ui.badge(act, "扫序列号 (" + it.serials.size() + ")", Ui.PRIMARY_SOFT, Ui.PRIMARY);
                    sBadge.setOnClickListener(v -> { activeIdx = idx; openSerialSheet(it, p); });
                    extras.addView(sBadge);
                }
                card.addView(extras);
            }

            card.setOnClickListener(v -> {
                activeIdx = idx;
                renderAll();
            });
            LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(-1, -2);
            clp.bottomMargin = Ui.dp(act, 6);
            cartList.addView(card, clp);
        }
        if (cart.isEmpty()) {
            TextView em = Ui.tv(act, "扫描商品条码加入明细（支持整箱条码自动换算）", 13, Ui.MUTED, false);
            em.setGravity(Gravity.CENTER);
            em.setPadding(0, Ui.dp(act, 24), 0, Ui.dp(act, 24));
            cartList.addView(em);
        }

        // Bottom Bar: item stepper (if active) + Submit Button
        thumbBar.removeAllViews();
        if (activeIdx >= 0 && activeIdx < cart.size()) {
            Models.ScanCartItem it = cart.get(activeIdx);
            Models.Product p = store.productById.get(it.productId);
            if (p != null && !p.serial) {
                LinearLayout stepper = Ui.row(act);
                Button bDel = Ui.outlineBtn(act, "移除", Ui.DANGER, Ui.DANGER);
                Button bMin = Ui.outlineBtn(act, "-1", Ui.LINE, Ui.INK);
                Button bQty = Ui.btn(act, Ui.fmtQty(it.qty) + " " + it.unitName, Ui.ACCENT_SOFT, Ui.ACCENT);
                Button bAdd = Ui.btn(act, "+1", Ui.PRIMARY, Color.WHITE);

                bDel.setOnClickListener(v -> {
                    cart.remove(activeIdx);
                    activeIdx = cart.isEmpty() ? -1 : Math.min(activeIdx, cart.size() - 1);
                    renderAll();
                });
                bMin.setOnClickListener(v -> {
                    if (it.qty > 1) { it.qty = Math.round((it.qty - 1) * 100.0) / 100.0; renderAll(); }
                });
                bAdd.setOnClickListener(v -> { it.qty = Math.round((it.qty + 1) * 100.0) / 100.0; renderAll(); });
                bQty.setOnClickListener(v -> ThumbNumpadDialog.show(act, p.name, "单位：" + it.unitName, it.qty, null, p.dec, val -> {
                    if (val <= 0) cart.remove(activeIdx);
                    else it.qty = val;
                    activeIdx = cart.isEmpty() ? -1 : Math.min(activeIdx, cart.size() - 1);
                    renderAll();
                }));

                stepper.addView(bDel, new LinearLayout.LayoutParams(0, Ui.dp(act, 40), 0.9f));
                stepper.addView(Ui.space(act, 6, 1));
                stepper.addView(bMin, new LinearLayout.LayoutParams(0, Ui.dp(act, 40), 0.9f));
                stepper.addView(Ui.space(act, 6, 1));
                stepper.addView(bQty, new LinearLayout.LayoutParams(0, Ui.dp(act, 40), 1.4f));
                stepper.addView(Ui.space(act, 6, 1));
                stepper.addView(bAdd, new LinearLayout.LayoutParams(0, Ui.dp(act, 40), 1.1f));
                LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, -2);
                slp.bottomMargin = Ui.dp(act, 8);
                thumbBar.addView(stepper, slp);
            }
        }

        boolean camOn = act.isCameraOpen();
        Button bCam = Ui.btn(act, camOn ? "关相机" : "扫码", camOn ? Ui.DANGER : Ui.ACCENT, Color.WHITE);
        bCam.setOnClickListener(v -> act.toggleCamera());

        String actTitle = "in".equals(mode) ? "提交入库" : "out".equals(mode) ? "提交出库" : "提交调拨";
        int actColor = "in".equals(mode) ? Ui.PRIMARY : "out".equals(mode) ? Ui.DANGER : Ui.ACCENT;
        Button submit = Ui.btn(act, actTitle + "（" + cart.size() + "）", cart.isEmpty() ? 0xFF9CA3AF : actColor, Color.WHITE);
        submit.setEnabled(!cart.isEmpty());
        submit.setOnClickListener(v -> submitMove(submit));

        LinearLayout actionRow = Ui.row(act);
        if (store.leftHanded) {
            actionRow.addView(bCam, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1));
            actionRow.addView(Ui.space(act, 8, 1));
            actionRow.addView(submit, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1.6f));
        } else {
            actionRow.addView(submit, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1.6f));
            actionRow.addView(Ui.space(act, 8, 1));
            actionRow.addView(bCam, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1));
        }
        thumbBar.addView(actionRow, new LinearLayout.LayoutParams(-1, -2));
    }

    private void submitMove(Button submit) {
        if (cart.isEmpty()) return;
        String needPerm = "in".equals(mode) ? "inv.in" : "out".equals(mode) ? "inv.out" : "inv.transfer";
        if (!store.can(needPerm) && !store.perms.isEmpty()) {
            Ui.toast(act, "没有提交该单据的权限");
            return;
        }
        if ("transfer".equals(mode) && (toWh.isEmpty() || toWh.equals(store.selectedWh))) {
            Ui.toast(act, "请选择不同的调入仓库");
            return;
        }
        try {
            JSONArray items = new JSONArray();
            for (Models.ScanCartItem it : cart) {
                Models.Product p = store.productById.get(it.productId);
                if (p != null && p.serial && it.serials.isEmpty()) {
                    Ui.toast(act, "「" + p.name + "」尚未扫描序列号");
                    return;
                }
                JSONObject o = new JSONObject();
                o.put("productId", it.productId);
                o.put("unit", it.unitName);
                o.put("qty", it.qty);
                if (it.price != null) o.put("price", it.price);
                if (!it.batchNo.isEmpty()) o.put("batchNo", it.batchNo);
                if (!it.expDate.isEmpty()) o.put("expDate", it.expDate);
                if (!it.preferBatchId.isEmpty()) o.put("preferBatch", it.preferBatchId);
                if (!it.serials.isEmpty()) o.put("serials", new JSONArray(it.serials));
                items.put(o);
            }

            submit.setEnabled(false);
            new Thread(() -> {
                try {
                    JSONObject res;
                    if ("transfer".equals(mode)) {
                        JSONObject b = new JSONObject()
                                .put("from", store.selectedWh)
                                .put("to", toWh)
                                .put("remark", remark)
                                .put("items", items);
                        res = ApiClient.createTransfer(store, b);
                    } else {
                        JSONObject b = new JSONObject()
                                .put("dir", mode)
                                .put("type", docType)
                                .put("wh", store.selectedWh)
                                .put("remark", remark)
                                .put("items", items);
                        res = ApiClient.createStockDoc(store, b);
                    }
                    String no = res.optString("no", "");
                    act.refreshData(() -> {
                        cart.clear();
                        activeIdx = -1;
                        remark = "";
                        act.scanner.feedbackOk();
                        if (act.tts != null) act.tts.speakCue("单据已提交", "submitted");
                        Ui.toast(act, "单据已提交：" + no);
                        renderAll();
                    });
                } catch (Exception e) {
                    act.runOnUiThread(() -> {
                        submit.setEnabled(true);
                        act.scanner.feedbackError();
                        Ui.toast(act, ApiClient.friendlyError(e));
                    });
                }
            }).start();
        } catch (Exception e) {
            Ui.toast(act, ApiClient.friendlyError(e));
        }
    }
}
