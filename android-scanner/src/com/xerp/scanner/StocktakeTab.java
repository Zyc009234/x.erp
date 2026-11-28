package com.xerp.scanner;

import android.app.AlertDialog;
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
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

public class StocktakeTab implements TabPage {
    private static class UndoStep {
        String productId;
        Double prevCount;
        boolean wasAdded;
        UndoStep(String pid, Double prev, boolean added) {
            productId = pid; prevCount = prev; wasAdded = added;
        }
    }

    private final MainActivity act;
    private final AppStore store;
    private final LinearLayout root;

    private TextView docBtn, saveBtn, postBtn;
    private LinearLayout modeBar, progressBarRow;
    private View progressFill, progressRest;
    private IconView modeHintIcon;
    private TextView modeHintTv;
    private Ui.IconPill blindToggleBtn, ttsToggleBtn;
    private LinearLayout unknownBanner, heroCard, listCol, thumbBar;
    private TextView filterAll, filterDone, filterDiff, filterTodo;
    private View diffSpacer;
    private ScrollView listScroll;

    private Models.CheckDoc activeDoc;
    private final Map<String, Double> countedMap = new LinkedHashMap<>();
    private final Set<String> addedIds = new HashSet<>();
    private final List<UndoStep> undoStack = new ArrayList<>();

    private String filterMode = "done"; // done, diff, todo, all
    private String currentPid = "";
    private String lastActionText = "";
    private String pendingUnknownCode = "";

    public StocktakeTab(MainActivity act) {
        this.act = act;
        this.store = act.store;
        root = Ui.col(act);
        root.setBackgroundColor(Ui.BG);
        buildUi();
    }

    private void buildUi() {
        // 1. Top checkdoc selector + Save / Post
        LinearLayout top = Ui.row(act);
        top.setBackgroundColor(Color.WHITE);
        top.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));

        docBtn = Ui.tv(act, "选择盘点单 ▾", 13, Ui.INK, true);
        docBtn.setBackground(Ui.rippleOutlined(act, Ui.SURFACE_2, Ui.LINE, 1, 10));
        docBtn.setPadding(Ui.dp(act, 10), Ui.dp(act, 7), Ui.dp(act, 10), Ui.dp(act, 7));
        docBtn.setSingleLine(true);
        docBtn.setEllipsize(android.text.TextUtils.TruncateAt.END);
        docBtn.setOnClickListener(v -> showDocPicker());

        saveBtn = Ui.badge(act, "保存", Ui.ACCENT_SOFT, Ui.ACCENT);
        saveBtn.setBackground(Ui.rippleOutlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 10));
        saveBtn.setTextSize(12);
        saveBtn.setPadding(Ui.dp(act, 12), Ui.dp(act, 7), Ui.dp(act, 12), Ui.dp(act, 7));
        saveBtn.setOnClickListener(v -> syncToServer(false));

        postBtn = Ui.badge(act, "审核", Ui.PRIMARY, Color.WHITE);
        postBtn.setBackground(Ui.rippleGradient(act, Ui.PRIMARY, Ui.PRIMARY_END, 10));
        postBtn.setTextSize(12);
        postBtn.setPadding(Ui.dp(act, 12), Ui.dp(act, 7), Ui.dp(act, 12), Ui.dp(act, 7));
        postBtn.setOnClickListener(v -> syncToServer(true));

        top.addView(docBtn, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(Ui.space(act, 6, 1));
        top.addView(saveBtn);
        top.addView(Ui.space(act, 6, 1));
        top.addView(postBtn);
        root.addView(top);

        // 1.2 Real-time Stocktake Progress Bar
        progressBarRow = Ui.row(act);
        progressBarRow.setBackgroundColor(Ui.LINE_SOFT);
        progressFill = new View(act);
        progressFill.setBackground(Ui.gradientRounded(act, Ui.PRIMARY, Ui.ACCENT, 0));
        progressRest = new View(act);
        progressBarRow.addView(progressFill, new LinearLayout.LayoutParams(0, -1, 0f));
        progressBarRow.addView(progressRest, new LinearLayout.LayoutParams(0, -1, 1f));
        root.addView(progressBarRow, new LinearLayout.LayoutParams(-1, Ui.dp(act, 3)));

        // 1.5 Compact Stocktake Mode Bar (Blind Count + TTS Toggle)
        modeBar = Ui.row(act);
        modeBar.setBackgroundColor(Ui.SURFACE_2);
        modeBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        modeHintIcon = new IconView(act, IconView.Type.EYE, Ui.MUTED);
        modeBar.addView(modeHintIcon, new LinearLayout.LayoutParams(Ui.dp(act, 14), Ui.dp(act, 14)));
        modeBar.addView(Ui.space(act, 5, 1));

        modeHintTv = Ui.tv(act, "", 12, Ui.MUTED, false);
        modeHintTv.setSingleLine(true);

        blindToggleBtn = Ui.iconPill(act, IconView.Type.EYE_OFF, "盲盘", Ui.CARD, Ui.LINE, Ui.INK_2);
        blindToggleBtn.setPadding(Ui.dp(act, 8), Ui.dp(act, 4), Ui.dp(act, 9), Ui.dp(act, 4));
        blindToggleBtn.setOnClickListener(v -> {
            store.blindMode = !store.blindMode;
            store.savePrefs();
            if (store.blindMode && "diff".equals(filterMode)) filterMode = "done";
            renderAll();
            if (act.tts != null) act.tts.speakCue(store.blindMode ? "已开启盲盘模式" : "已关闭盲盘模式", store.blindMode ? "blind_on" : "blind_off");
            Ui.toast(act, store.blindMode ? "已开启盲盘模式（隐藏账面库存与盈亏）" : "已关闭盲盘模式");
        });

        ttsToggleBtn = Ui.iconPill(act, IconView.Type.VOLUME_ON, "语音 开", Ui.PRIMARY_SOFT, Ui.PRIMARY_BORDER, Ui.PRIMARY);
        ttsToggleBtn.setPadding(Ui.dp(act, 8), Ui.dp(act, 4), Ui.dp(act, 9), Ui.dp(act, 4));
        ttsToggleBtn.setOnClickListener(v -> {
            store.ttsEnabled = !store.ttsEnabled;
            store.savePrefs();
            if (!store.ttsEnabled) {
                if (act.tts != null) act.tts.stop();
            } else if (act.tts != null) {
                act.tts.warmUp();
                act.tts.speakForceCue("语音播报已开启", "tts_on");
            }
            renderAll();
        });

        modeBar.addView(modeHintTv, new LinearLayout.LayoutParams(0, -2, 1));
        modeBar.addView(blindToggleBtn);
        modeBar.addView(Ui.space(act, 6, 1));
        modeBar.addView(ttsToggleBtn);
        root.addView(modeBar);
        root.addView(Ui.divider(act));

        // 2. Unknown barcode banner (hidden unless needed)
        unknownBanner = Ui.row(act);
        unknownBanner.setBackgroundColor(Ui.WARN_SOFT);
        unknownBanner.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 8));
        unknownBanner.setVisibility(View.GONE);
        root.addView(unknownBanner);

        // 3. Current item hero card
        heroCard = Ui.card(act, 12);
        heroCard.setElevation(Ui.dp(act, 3));
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(-1, -2);
        hlp.setMargins(Ui.dp(act, 10), Ui.dp(act, 10), Ui.dp(act, 10), Ui.dp(act, 6));
        root.addView(heroCard, hlp);

        // 4. Filter bar
        LinearLayout fBar = Ui.row(act);
        fBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 2), Ui.dp(act, 10), Ui.dp(act, 8));
        filterDone = Ui.chip(act, "已盘", true);
        filterDiff = Ui.chip(act, "有差异", false);
        filterTodo = Ui.chip(act, "未盘", false);
        filterAll = Ui.chip(act, "全部", false);
        for (TextView fp : new TextView[]{filterDone, filterDiff, filterTodo, filterAll}) {
            fp.setTextSize(12);
            fp.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        }
        filterDone.setOnClickListener(v -> setFilter("done"));
        filterDiff.setOnClickListener(v -> setFilter("diff"));
        filterTodo.setOnClickListener(v -> setFilter("todo"));
        filterAll.setOnClickListener(v -> setFilter("all"));

        diffSpacer = Ui.space(act, 6, 1);
        fBar.addView(filterDone); fBar.addView(Ui.space(act, 6, 1));
        fBar.addView(filterDiff); fBar.addView(diffSpacer);
        fBar.addView(filterTodo); fBar.addView(Ui.space(act, 6, 1));
        fBar.addView(filterAll);
        root.addView(fBar);

        // 5. Scrollable item list
        listScroll = new ScrollView(act);
        listCol = Ui.col(act);
        listCol.setPadding(Ui.dp(act, 10), 0, Ui.dp(act, 10), Ui.dp(act, 12));
        listScroll.addView(listCol);
        root.addView(listScroll, new LinearLayout.LayoutParams(-1, 0, 1));

        // 6. One-hand bottom thumb bar
        root.addView(Ui.divider(act));
        thumbBar = Ui.row(act);
        thumbBar.setBackgroundColor(Color.WHITE);
        thumbBar.setElevation(Ui.dp(act, 4));
        thumbBar.setPadding(Ui.dp(act, 10), Ui.dp(act, 8), Ui.dp(act, 10), Ui.dp(act, 9));
        root.addView(thumbBar);
    }

    @Override public View getView() { return root; }
    @Override public boolean needsCamera() { return true; }
    @Override public void onCameraStateChanged(boolean open) { renderThumbBar(); }

    @Override
    public void onShown() {
        if (activeDoc == null) pickDefaultDoc();
        renderAll();
    }

    @Override
    public void onDataUpdated() {
        String oldId = activeDoc != null ? activeDoc.id : "";
        Models.CheckDoc found = null;
        for (Models.CheckDoc d : store.checkDocs) {
            if (d.id.equals(oldId) && "盘点中".equals(d.status)) { found = d; break; }
        }
        if (found == null) pickDefaultDoc();
        else bindDoc(found, false);
        renderAll();
    }

    private void pickDefaultDoc() {
        Models.CheckDoc pick = null;
        for (Models.CheckDoc d : store.checkDocs) {
            if ("盘点中".equals(d.status) && d.wh.equals(store.selectedWh)) { pick = d; break; }
        }
        if (pick == null) {
            for (Models.CheckDoc d : store.checkDocs) {
                if ("盘点中".equals(d.status)) { pick = d; break; }
            }
        }
        if (pick != null) bindDoc(pick, true);
        else {
            activeDoc = null;
            countedMap.clear();
            addedIds.clear();
            undoStack.clear();
            currentPid = "";
        }
    }

    private void bindDoc(Models.CheckDoc doc, boolean clearUndo) {
        activeDoc = doc;
        countedMap.clear();
        addedIds.clear();
        if (clearUndo) undoStack.clear();
        for (Models.CheckLine l : doc.lines) {
            if (l.counted != null) countedMap.put(l.productId, l.counted);
        }
        // Restore offline draft if present
        JSONObject draft = store.loadDraft(doc.id);
        if (draft != null) {
            JSONArray addArr = draft.optJSONArray("added");
            if (addArr != null) {
                for (int i = 0; i < addArr.length(); i++) {
                    String pid = addArr.optString(i, "");
                    if (!pid.isEmpty()) addedIds.add(pid);
                }
            }
            JSONObject counts = draft.optJSONObject("counts");
            if (counts != null) {
                java.util.Iterator<String> it = counts.keys();
                while (it.hasNext()) {
                    String pid = it.next();
                    if (counts.isNull(pid)) countedMap.remove(pid);
                    else countedMap.put(pid, counts.optDouble(pid, 0));
                    ensureLineExists(pid);
                }
            }
        }
        if (!doc.wh.equals(store.selectedWh)) {
            store.selectedWh = doc.wh;
            act.syncWarehouseBadge();
        }
    }

    private void ensureLineExists(String pid) {
        if (activeDoc == null) return;
        for (Models.CheckLine l : activeDoc.lines) {
            if (l.productId.equals(pid)) return;
        }
        Models.Product p = store.productById.get(pid);
        if (p != null) {
            Models.CheckLine nl = new Models.CheckLine();
            nl.productId = p.id;
            nl.book = p.whQty(activeDoc.wh);
            nl.added = true;
            activeDoc.lines.add(0, nl);
            addedIds.add(p.id);
        }
    }

    private void setFilter(String mode) {
        filterMode = mode;
        renderAll();
    }

    @Override
    public void onBarcodeScanned(String code) {
        String c = code.trim();
        Models.BarcodeMatch match = store.findByCode(c);
        if (match == null) {
            act.scanner.feedbackUnknown();
            if (act.tts != null) act.tts.speakCue("未找到条码", "not_found");
            pendingUnknownCode = c;
            showUnknownBanner();
            if (store.autoPromptNew) {
                openQuickNewForCode(c, true);
            }
            return;
        }

        pendingUnknownCode = "";
        unknownBanner.setVisibility(View.GONE);

        if (activeDoc == null) {
            // Auto-create a blind stocktake doc seamlessly when scanning on empty screen
            autoCreateFreeDocThenApply(match, (double) match.rate());
            return;
        }
        applyMatchedScan(match, (double) match.rate(), "扫码 " + match.unitName() + " +" + match.rate());
    }

    private void applyMatchedScan(Models.BarcodeMatch match, double addQty, String note) {
        if (activeDoc == null) return;
        Models.Product p = match.product;
        boolean wasAdded = !hasLine(p.id) && !addedIds.contains(p.id);
        ensureLineExists(p.id);
        Double prev = countedMap.get(p.id);
        double base = prev == null ? 0 : prev;
        double next = Math.round((base + addQty) * 100.0) / 100.0;
        if (!p.dec) next = Math.rint(next);

        undoStack.add(new UndoStep(p.id, prev, wasAdded));
        if (undoStack.size() > 50) undoStack.remove(0);

        countedMap.put(p.id, next);
        currentPid = p.id;
        lastActionText = note;
        saveDraftNow();
        act.scanner.feedbackOk();
        if (act.tts != null) {
            if (match.unit != null && Math.abs(addQty - match.rate()) < 1e-6) {
                act.tts.speakCountAdd(p.name, match.unit.name, addQty, next);
            } else {
                act.tts.speakCountAdd(p.name, null, addQty, next);
            }
        }
        renderAll();
    }

    private boolean hasLine(String pid) {
        if (activeDoc == null) return false;
        for (Models.CheckLine l : activeDoc.lines) if (l.productId.equals(pid)) return true;
        return false;
    }

    private void saveDraftNow() {
        if (activeDoc != null) store.saveDraft(activeDoc.id, countedMap, addedIds);
    }

    private void showUnknownBanner() {
        unknownBanner.removeAllViews();
        if (pendingUnknownCode.isEmpty()) {
            unknownBanner.setVisibility(View.GONE);
            return;
        }
        unknownBanner.setVisibility(View.VISIBLE);
        unknownBanner.addView(Ui.tv(act, "未识别：" + pendingUnknownCode, 13, 0xFF92400E, true),
                new LinearLayout.LayoutParams(0, -2, 1));
        TextView bNew = Ui.badge(act, "新建商品", Ui.PRIMARY, Color.WHITE);
        bNew.setTextSize(12);
        bNew.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        bNew.setOnClickListener(v -> openQuickNewForCode(pendingUnknownCode, true));

        TextView bBind = Ui.badge(act, "绑已有", Ui.ACCENT, Color.WHITE);
        bBind.setTextSize(12);
        bBind.setPadding(Ui.dp(act, 10), Ui.dp(act, 6), Ui.dp(act, 10), Ui.dp(act, 6));
        bBind.setOnClickListener(v -> openBindForCode(pendingUnknownCode));

        unknownBanner.addView(bNew);
        unknownBanner.addView(Ui.space(act, 6, 1));
        unknownBanner.addView(bBind);
    }

    private void openQuickNewForCode(String code, boolean allowBindTab) {
        ProductEditorSheet.show(act, null, code, 1.0, "本次实盘数量", allowBindTab, (product, boundUnit, extraQty) -> {
            pendingUnknownCode = "";
            unknownBanner.setVisibility(View.GONE);
            double qty = extraQty != null ? Math.max(0, extraQty) : (boundUnit != null ? boundUnit.rate : 1);
            Models.BarcodeMatch m = new Models.BarcodeMatch(product, boundUnit);
            if (activeDoc == null) autoCreateFreeDocThenApply(m, qty);
            else applyMatchedScan(m, qty, boundUnit != null ? "绑定 " + boundUnit.name + " +" + Ui.fmtQty(qty) : "新商品 +" + Ui.fmtQty(qty));
        });
    }

    private void openBindForCode(String code) {
        openQuickNewForCode(code, true);
    }

    private void autoCreateFreeDocThenApply(Models.BarcodeMatch match, double addQty) {
        if (!store.can("inv.check") && !store.perms.isEmpty()) {
            Ui.toast(act, "没有盘点录入权限");
            return;
        }
        Ui.toast(act, "正在新建自由盘点单…");
        new Thread(() -> {
            try {
                JSONObject res = ApiClient.createCheckDoc(store, new JSONObject()
                        .put("wh", store.selectedWh)
                        .put("empty", true)
                        .put("scope", "扫码自由盘点"));
                Models.CheckDoc doc = Models.CheckDoc.fromJson(res);
                store.checkDocs.add(0, doc);
                act.runOnUiThread(() -> {
                    bindDoc(doc, true);
                    applyMatchedScan(match, addQty, "建单并扫入 +" + Ui.fmtQty(addQty));
                });
            } catch (Exception e) {
                act.runOnUiThread(() -> Ui.toast(act, "建单失败：" + ApiClient.friendlyError(e)));
            }
        }).start();
    }

    private void showDocPicker() {
        List<Models.CheckDoc> active = new ArrayList<>();
        for (Models.CheckDoc d : store.checkDocs) {
            if ("盘点中".equals(d.status)) active.add(d);
        }
        List<String> items = new ArrayList<>();
        items.add("+ 新建「扫码自由盘点」（空单，扫一个加一个）");
        items.add("+ 新建「当前仓库全部商品」盘点单");
        items.add("+ 按商品分类新建盘点单");
        for (Models.CheckDoc d : active) {
            items.add(d.no + " · " + store.whName(d.wh) + " (" + d.scope + ")");
        }
        new AlertDialog.Builder(act)
                .setTitle("选择或新建盘点单")
                .setItems(items.toArray(new String[0]), (dlg, w) -> {
                    if (w == 0) createCheck(true, "");
                    else if (w == 1) createCheck(false, "");
                    else if (w == 2) pickCategoryAndCreate();
                    else {
                        bindDoc(active.get(w - 3), true);
                        renderAll();
                    }
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void pickCategoryAndCreate() {
        if (store.categories.isEmpty()) { Ui.toast(act, "还没有商品分类"); return; }
        String[] cs = store.categories.toArray(new String[0]);
        new AlertDialog.Builder(act).setTitle("选择分类")
                .setItems(cs, (d, w) -> createCheck(false, cs[w]))
                .show();
    }

    private void createCheck(boolean empty, String category) {
        if (!store.can("inv.check") && !store.perms.isEmpty()) {
            Ui.toast(act, "没有盘点录入权限");
            return;
        }
        new Thread(() -> {
            try {
                JSONObject body = new JSONObject().put("wh", store.selectedWh);
                if (empty) { body.put("empty", true); body.put("scope", "扫码自由盘点"); }
                else if (!category.isEmpty()) body.put("category", category);
                JSONObject res = ApiClient.createCheckDoc(store, body);
                Models.CheckDoc doc = Models.CheckDoc.fromJson(res);
                store.checkDocs.add(0, doc);
                act.runOnUiThread(() -> {
                    bindDoc(doc, true);
                    renderAll();
                    Ui.toast(act, "已新建盘点单 " + doc.no);
                });
            } catch (Exception e) {
                act.runOnUiThread(() -> Ui.toast(act, ApiClient.friendlyError(e)));
            }
        }).start();
    }

    private void syncToServer(boolean post) {
        if (activeDoc == null) { Ui.toast(act, "请先选择或新建盘点单"); return; }
        if (post && !store.can("inv.checkpost") && !store.perms.isEmpty()) {
            Ui.toast(act, "当前账号没有盘点审核权限，请点「保存」暂存");
            return;
        }
        if (post && countedMap.isEmpty()) {
            Ui.toast(act, "还没有录入任何实盘数量");
            return;
        }
        if (post) {
            int n = 0;
            double gain = 0, loss = 0;
            double totalCounted = 0;
            for (Models.CheckLine l : activeDoc.lines) {
                Double c = countedMap.get(l.productId);
                if (c == null) continue;
                n++;
                totalCounted += c;
                Models.Product p = store.productById.get(l.productId);
                double book = p != null ? p.whQty(activeDoc.wh) : l.book;
                double d = c - book;
                if (d > 0) gain += d; else loss -= d;
            }
            String msg = store.blindMode
                    ? "盲盘模式：已盘 " + n + " 项（实盘合计 " + Ui.fmtQty(totalCounted) + "）\n\n审核后将按实盘数自动计算盈亏并调整库存。\n如需核对差异，可先点「保存」或关闭盲盘查看。"
                    : "已盘 " + n + " 项\n预计盘盈：+" + Ui.fmtQty(gain) + "\n预计盘亏：-" + Ui.fmtQty(loss) + "\n\n审核后将直接按实盘数调整库存。";
            new AlertDialog.Builder(act)
                    .setTitle("确认审核盘点单 " + activeDoc.no)
                    .setMessage(msg)
                    .setPositiveButton("确定审核", (d, w) -> performSync(true))
                    .setNegativeButton("取消", null)
                    .show();
        } else {
            performSync(false);
        }
    }

    private void performSync(boolean post) {
        try {
            JSONArray lines = new JSONArray();
            for (Models.CheckLine l : activeDoc.lines) {
                Double c = countedMap.get(l.productId);
                boolean isAdded = addedIds.contains(l.productId);
                if (c == null && !isAdded) continue;
                JSONObject item = new JSONObject();
                item.put("productId", l.productId);
                item.put("counted", c == null ? JSONObject.NULL : c);
                if (isAdded) item.put("add", true);
                lines.put(item);
            }
            // Include any countedMap entries that weren't in lines
            for (Map.Entry<String, Double> e : countedMap.entrySet()) {
                if (!hasLine(e.getKey())) {
                    lines.put(new JSONObject().put("productId", e.getKey()).put("counted", e.getValue()).put("add", true));
                }
            }
            JSONObject body = new JSONObject().put("lines", lines);
            saveBtn.setEnabled(false);
            postBtn.setEnabled(false);
            new Thread(() -> {
                try {
                    if (post) {
                        ApiClient.postCheckDoc(store, activeDoc.id, body);
                        store.deleteDraft(activeDoc.id);
                    } else {
                        ApiClient.saveCheckDoc(store, activeDoc.id, body);
                        store.deleteDraft(activeDoc.id);
                    }
                    act.refreshData(() -> {
                        saveBtn.setEnabled(true);
                        postBtn.setEnabled(true);
                        if (act.tts != null) act.tts.speakCue(post ? "盘点已审核" : "盘点已保存", post ? "posted" : "saved");
                        Ui.toast(act, post ? "盘点已审核，库存已更新" : "盘点进度已保存到服务器");
                    });
                } catch (Exception e) {
                    act.runOnUiThread(() -> {
                        saveBtn.setEnabled(true);
                        postBtn.setEnabled(true);
                        Ui.toast(act, ApiClient.friendlyError(e));
                    });
                }
            }).start();
        } catch (Exception e) {
            Ui.toast(act, ApiClient.friendlyError(e));
        }
    }

    private void renderAll() {
        if (store.blindMode && "diff".equals(filterMode)) {
            filterMode = "done";
        }
        if (store.blindMode) {
            modeBar.setBackgroundColor(0xFFFFFBEB);
            modeHintIcon.setIcon(IconView.Type.EYE_OFF, Ui.WARN);
            modeHintTv.setText("盲盘中 · 已隐藏账面库存与盈亏");
            modeHintTv.setTextColor(Ui.WARN);
            modeHintTv.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.BOLD);
            blindToggleBtn.applyStyle(IconView.Type.EYE_OFF, "盲盘 开", Ui.WARN, 0, Color.WHITE);
        } else {
            modeBar.setBackgroundColor(Ui.SURFACE_2);
            modeHintIcon.setIcon(IconView.Type.EYE, Ui.MUTED);
            modeHintTv.setText("明盘 · 显示账面库存与盈亏");
            modeHintTv.setTextColor(Ui.MUTED);
            modeHintTv.setTypeface(android.graphics.Typeface.DEFAULT, android.graphics.Typeface.NORMAL);
            blindToggleBtn.applyStyle(IconView.Type.EYE_OFF, "盲盘", Ui.CARD, Ui.LINE, Ui.INK_2);
        }

        if (store.ttsEnabled) {
            ttsToggleBtn.applyStyle(IconView.Type.VOLUME_ON, "语音 开", Ui.PRIMARY_SOFT, Ui.PRIMARY_BORDER, Ui.PRIMARY);
        } else {
            ttsToggleBtn.applyStyle(IconView.Type.VOLUME_OFF, "静音", Ui.CHIP_BG, Ui.LINE, Ui.MUTED);
        }

        filterDiff.setVisibility(store.blindMode ? View.GONE : View.VISIBLE);
        diffSpacer.setVisibility(store.blindMode ? View.GONE : View.VISIBLE);

        int cAll = 0, cDone = 0, cTodo = 0, cDiff = 0;
        if (activeDoc != null) {
            for (Models.CheckLine l : activeDoc.lines) {
                Models.Product lp = store.productById.get(l.productId);
                if (lp == null) continue;
                cAll++;
                Double lc = countedMap.get(l.productId);
                if (lc == null) {
                    cTodo++;
                } else {
                    cDone++;
                    if (!store.blindMode) {
                        double lDiff = Math.round((lc - lp.whQty(activeDoc.wh)) * 100.0) / 100.0;
                        if (Math.abs(lDiff) >= 1e-6) cDiff++;
                    }
                }
            }
        }
        filterDone.setText(activeDoc == null ? "已盘" : "已盘(" + cDone + ")");
        filterDiff.setText(activeDoc == null ? "有差异" : "有差异(" + cDiff + ")");
        filterTodo.setText(activeDoc == null ? "未盘" : "未盘(" + cTodo + ")");
        filterAll.setText(activeDoc == null ? "全部" : "全部(" + cAll + ")");

        if (activeDoc == null) {
            docBtn.setText("无进行中盘点单（点此新建）▾");
            saveBtn.setVisibility(View.GONE);
            postBtn.setVisibility(View.GONE);
            progressBarRow.setVisibility(View.GONE);
        } else {
            int done = countedMap.size(), total = activeDoc.lines.size();
            docBtn.setText(activeDoc.no + " · " + done + "/" + total + " ▾");
            saveBtn.setVisibility(View.VISIBLE);
            postBtn.setVisibility(store.can("inv.checkpost") || store.perms.isEmpty() ? View.VISIBLE : View.GONE);
            if (total <= 0) {
                progressBarRow.setVisibility(View.GONE);
            } else {
                progressBarRow.setVisibility(View.VISIBLE);
                int clamped = Math.min(total, done);
                ((LinearLayout.LayoutParams) progressFill.getLayoutParams()).weight = clamped;
                ((LinearLayout.LayoutParams) progressRest.getLayoutParams()).weight = Math.max(0, total - clamped);
                progressBarRow.requestLayout();
            }
        }

        // Render filter pills
        renderFilterPill(filterDone, "done");
        renderFilterPill(filterDiff, "diff");
        renderFilterPill(filterTodo, "todo");
        renderFilterPill(filterAll, "all");

        renderHero();
        renderList();
        renderThumbBar();
    }

    private void renderFilterPill(TextView pill, String key) {
        boolean on = filterMode.equals(key);
        pill.setTextColor(on ? Color.WHITE : Ui.INK_2);
        pill.setTypeface(android.graphics.Typeface.DEFAULT, on ? android.graphics.Typeface.BOLD : android.graphics.Typeface.NORMAL);
        pill.setBackground(on ? Ui.rippleRounded(act, Ui.PRIMARY, 18) : Ui.rippleOutlined(act, Ui.CARD, Ui.LINE, 1, 18));
    }

    private void renderHero() {
        heroCard.removeAllViews();
        if (activeDoc == null) {
            heroCard.setBackground(null);
            heroCard.setElevation(0);
            heroCard.setPadding(0, 0, 0, 0);
            heroCard.addView(Ui.emptyState(act, IconView.Type.SCAN, "扫码直接开盘", "对准商品条码自动建立自由盘点单，或点上方选择已有单据"));
            return;
        }
        Models.Product p = currentPid.isEmpty() ? null : store.productById.get(currentPid);
        if (p == null) {
            heroCard.setBackground(null);
            heroCard.setElevation(0);
            heroCard.setPadding(0, 0, 0, 0);
            heroCard.addView(Ui.emptyState(act, IconView.Type.SCAN, "请扫描商品条码", "点下方「开启扫码盘点」，或轻触列表任意商品手动输入实盘"));
            return;
        }
        heroCard.setBackground(Ui.outlined(act, Ui.CARD, 0xFFE8EDF5, 1, 16));
        heroCard.setElevation(Ui.dp(act, 3));
        int hp = Ui.dp(act, 12);
        heroCard.setPadding(hp, hp, hp, hp);

        double book = p.whQty(activeDoc.wh);
        Double cnt = countedMap.get(p.id);
        LinearLayout outerRow = Ui.row(act);
        outerRow.setGravity(Gravity.FILL_VERTICAL);

        View accentBar = new View(act);
        accentBar.setBackground(Ui.rounded(act, store.blindMode ? Ui.WARN : Ui.PRIMARY, 3));
        LinearLayout.LayoutParams abl = new LinearLayout.LayoutParams(Ui.dp(act, 4), -1);
        abl.rightMargin = Ui.dp(act, 10);
        outerRow.addView(accentBar, abl);

        LinearLayout row = Ui.row(act);
        LinearLayout left = Ui.col(act);
        TextView name = Ui.tv(act, p.name + (p.spec.isEmpty() ? "" : " · " + p.spec), 15, Ui.INK, true);
        name.setMaxLines(1);
        name.setEllipsize(android.text.TextUtils.TruncateAt.END);
        left.addView(name);
        String meta = store.blindMode
                ? ("盲盘中 · 单位 " + p.unit + (lastActionText.isEmpty() ? "" : " · " + lastActionText))
                : ("账面 " + Ui.fmtQty(book) + " " + p.unit + (lastActionText.isEmpty() ? "" : " · " + lastActionText));
        left.addView(Ui.tv(act, meta, 12, store.blindMode ? Ui.WARN : Ui.PRIMARY, false));
        row.addView(left, new LinearLayout.LayoutParams(0, -2, 1));

        LinearLayout right = Ui.col(act);
        right.setGravity(Gravity.END);
        TextView bigNum = Ui.tv(act, cnt == null ? "—" : Ui.fmtQty(cnt), 30, Ui.PRIMARY, true);
        right.addView(bigNum);

        LinearLayout badges = Ui.row(act);
        double boxStep = !p.units.isEmpty() ? p.units.get(0).rate : 5;
        String boxLabel = !p.units.isEmpty() ? ("+" + p.units.get(0).name + "(" + Ui.fmtQty(boxStep) + ")") : "+5";
        TextView plusBoxBadge = Ui.badge(act, boxLabel, Ui.PRIMARY_SOFT, Ui.PRIMARY);
        plusBoxBadge.setBackground(Ui.rippleOutlined(act, Ui.PRIMARY_SOFT, Ui.PRIMARY_BORDER, 1, 8));
        plusBoxBadge.setOnClickListener(v -> adjustCurrent(boxStep));
        badges.addView(plusBoxBadge);

        if (cnt != null) {
            badges.addView(Ui.space(act, 4, 1));
            if (store.blindMode) {
                badges.addView(Ui.badge(act, "已盘", Ui.PRIMARY_SOFT, Ui.PRIMARY));
            } else {
                double diff = Math.round((cnt - book) * 100.0) / 100.0;
                String dStr = diff == 0 ? "相符" : (diff > 0 ? "盈+" + Ui.fmtQty(diff) : "亏" + Ui.fmtQty(diff));
                int bg = diff == 0 ? Ui.PRIMARY_SOFT : diff > 0 ? Ui.ACCENT_SOFT : Ui.DANGER_SOFT;
                int fg = diff == 0 ? Ui.PRIMARY : diff > 0 ? Ui.ACCENT : Ui.DANGER;
                badges.addView(Ui.badge(act, dStr, bg, fg));
            }
        }
        right.addView(badges);
        row.addView(right);
        outerRow.addView(row, new LinearLayout.LayoutParams(0, -2, 1));
        heroCard.addView(outerRow);
    }

    private void renderList() {
        listCol.removeAllViews();
        if (activeDoc == null) return;
        int count = 0;
        for (Models.CheckLine l : activeDoc.lines) {
            Models.Product p = store.productById.get(l.productId);
            if (p == null) continue;
            Double c = countedMap.get(l.productId);
            double book = p.whQty(activeDoc.wh);
            double diff = c == null ? 0 : Math.round((c - book) * 100.0) / 100.0;
            if ("done".equals(filterMode) && c == null) continue;
            if ("todo".equals(filterMode) && c != null) continue;
            if (!store.blindMode && "diff".equals(filterMode) && (c == null || Math.abs(diff) < 1e-6)) continue;

            boolean sel = p.id.equals(currentPid);
            LinearLayout r = Ui.row(act);
            r.setBackground(sel
                    ? Ui.rippleOutlined(act, Ui.PRIMARY_SOFT, Ui.PRIMARY, 1, 12)
                    : Ui.rippleOutlined(act, Ui.CARD, 0xFFE8EDF5, 1, 12));
            r.setElevation(Ui.dp(act, sel ? 2 : 1));
            r.setPadding(Ui.dp(act, 12), Ui.dp(act, 10), Ui.dp(act, 12), Ui.dp(act, 10));

            LinearLayout info = Ui.col(act);
            TextView tn = Ui.tv(act, p.name, 14, Ui.INK, true);
            tn.setMaxLines(1);
            tn.setEllipsize(android.text.TextUtils.TruncateAt.END);
            info.addView(tn);
            String subText = store.blindMode
                    ? (p.sku + (p.spec.isEmpty() ? "" : " · " + p.spec) + " · " + p.unit)
                    : (p.sku + " · 账面 " + Ui.fmtQty(book) + " " + p.unit);
            info.addView(Ui.tv(act, subText, 12, Ui.MUTED, false));
            r.addView(info, new LinearLayout.LayoutParams(0, -2, 1));

            if (c != null) {
                r.addView(Ui.tv(act, Ui.fmtQty(c) + (store.blindMode ? " " + p.unit : ""), 17, Ui.INK, true));
                r.addView(Ui.space(act, 6, 1));
                if (store.blindMode) {
                    r.addView(Ui.badge(act, "已盘", Ui.PRIMARY_SOFT, Ui.PRIMARY));
                } else {
                    String dStr = diff == 0 ? "平" : (diff > 0 ? "+" + Ui.fmtQty(diff) : Ui.fmtQty(diff));
                    int bg = diff == 0 ? Ui.PRIMARY_SOFT : diff > 0 ? Ui.ACCENT_SOFT : Ui.DANGER_SOFT;
                    int fg = diff == 0 ? Ui.PRIMARY : diff > 0 ? Ui.ACCENT : Ui.DANGER;
                    r.addView(Ui.badge(act, dStr, bg, fg));
                }
            } else {
                r.addView(Ui.badge(act, "未盘", Ui.CHIP_BG, Ui.MUTED));
            }
            r.setOnClickListener(v -> {
                currentPid = p.id;
                lastActionText = "手动选中";
                renderHero();
                renderThumbBar();
                openNumpadForCurrent();
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
            lp.bottomMargin = Ui.dp(act, 7);
            listCol.addView(r, lp);
            if (++count >= 80) break;
        }
        if (count == 0) {
            LinearLayout empty = Ui.emptyState(act, IconView.Type.CHECK_LIST, "当前筛选下没有商品", "可切换「未盘 / 全部」查看，或直接扫描条码新增盘点");
            LinearLayout.LayoutParams elp = new LinearLayout.LayoutParams(-1, -2);
            elp.topMargin = Ui.dp(act, 8);
            listCol.addView(empty, elp);
        }
    }

    private void renderThumbBar() {
        thumbBar.removeAllViews();
        boolean camOn = act.isCameraOpen();
        Button bCam = camOn
                ? Ui.btn(act, "关相机", Ui.DANGER, Color.WHITE)
                : Ui.gradientBtn(act, "扫码盘点", Ui.PRIMARY, Ui.PRIMARY_END);
        bCam.setOnClickListener(v -> act.toggleCamera());

        Models.Product p = currentPid.isEmpty() ? null : store.productById.get(currentPid);
        if (p == null) {
            bCam.setText(camOn ? "关闭相机" : "开启扫码盘点");
            Button newProdBtn = Ui.outlineBtn(act, "+ 新建商品", Ui.ACCENT_BORDER, Ui.ACCENT);
            newProdBtn.setBackground(Ui.rippleOutlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 12));
            newProdBtn.setOnClickListener(v -> openQuickNewForCode("", true));
            if (store.leftHanded) {
                thumbBar.addView(bCam, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1.4f));
                thumbBar.addView(Ui.space(act, 8, 1));
                thumbBar.addView(newProdBtn, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1));
            } else {
                thumbBar.addView(newProdBtn, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1));
                thumbBar.addView(Ui.space(act, 8, 1));
                thumbBar.addView(bCam, new LinearLayout.LayoutParams(0, Ui.dp(act, 46), 1.4f));
            }
            return;
        }
        Double cur = countedMap.get(p.id);
        bCam.setText(camOn ? "关相机" : "扫码");
        Button bMinus = Ui.outlineBtn(act, "-1", Ui.LINE, Ui.INK);
        Button bNum = Ui.btn(act, "实盘 " + (cur == null ? "—" : Ui.fmtQty(cur)), Ui.ACCENT_SOFT, Ui.ACCENT);
        bNum.setBackground(Ui.rippleOutlined(act, Ui.ACCENT_SOFT, Ui.ACCENT_BORDER, 1, 12));
        Button bPlus1 = Ui.gradientBtn(act, "+1", Ui.PRIMARY, Ui.PRIMARY_END);
        Button bUndo = Ui.outlineBtn(act, "撤销", Ui.WARN, Ui.WARN);

        bMinus.setOnClickListener(v -> adjustCurrent(-1));
        bPlus1.setOnClickListener(v -> adjustCurrent(1));
        bNum.setOnClickListener(v -> openNumpadForCurrent());
        bUndo.setEnabled(!undoStack.isEmpty());
        bUndo.setAlpha(undoStack.isEmpty() ? 0.45f : 1.0f);
        bUndo.setOnClickListener(v -> undoLast());

        View[] order = store.leftHanded
                ? new View[]{bCam, bPlus1, bNum, bMinus, bUndo}
                : new View[]{bUndo, bMinus, bNum, bPlus1, bCam};
        float[] weights = store.leftHanded
                ? new float[]{1.1f, 1.0f, 1.3f, 0.85f, 0.85f}
                : new float[]{0.85f, 0.85f, 1.3f, 1.0f, 1.1f};

        for (int i = 0; i < order.length; i++) {
            Button b = (Button) order[i];
            b.setTextSize(13);
            b.setPadding(Ui.dp(act, 4), 0, Ui.dp(act, 4), 0);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, Ui.dp(act, 44), weights[i]);
            if (i > 0) lp.leftMargin = Ui.dp(act, 5);
            thumbBar.addView(b, lp);
        }
    }

    private void adjustCurrent(double delta) {
        if (activeDoc == null || currentPid.isEmpty()) return;
        Models.Product p = store.productById.get(currentPid);
        if (p == null) return;
        Double prev = countedMap.get(p.id);
        double cur = prev == null ? 0 : prev;
        double next = Math.max(0, Math.round((cur + delta) * 100.0) / 100.0);
        undoStack.add(new UndoStep(p.id, prev, false));
        countedMap.put(p.id, next);
        lastActionText = (delta > 0 ? "手动 +" : "手动 ") + Ui.fmtQty(delta);
        saveDraftNow();
        if (act.tts != null) act.tts.speakDelta(delta, next);
        renderAll();
    }

    private void openNumpadForCurrent() {
        if (activeDoc == null || currentPid.isEmpty()) return;
        Models.Product p = store.productById.get(currentPid);
        if (p == null) return;
        double book = p.whQty(activeDoc.wh);
        String numSub = store.blindMode ? ("盲盘模式 · 单位：" + p.unit) : ("账面：" + Ui.fmtQty(book) + " " + p.unit);
        Double numBook = store.blindMode ? null : book;
        ThumbNumpadDialog.show(act, p.name, numSub,
                countedMap.get(p.id), numBook, p.dec, val -> {
                    Double prev = countedMap.get(p.id);
                    undoStack.add(new UndoStep(p.id, prev, false));
                    countedMap.put(p.id, val);
                    lastActionText = "键盘录入";
                    saveDraftNow();
                    if (act.tts != null) act.tts.speakCountSet(p.name, val);
                    renderAll();
                });
    }

    private void undoLast() {
        if (undoStack.isEmpty() || activeDoc == null) return;
        UndoStep step = undoStack.remove(undoStack.size() - 1);
        if (step.prevCount == null) countedMap.remove(step.productId);
        else countedMap.put(step.productId, step.prevCount);
        if (step.wasAdded) {
            addedIds.remove(step.productId);
            for (int i = 0; i < activeDoc.lines.size(); i++) {
                if (activeDoc.lines.get(i).productId.equals(step.productId)) {
                    activeDoc.lines.remove(i);
                    break;
                }
            }
        }
        currentPid = step.productId;
        lastActionText = "已撤销上一步";
        saveDraftNow();
        if (act.tts != null) act.tts.speakUndo(step.prevCount);
        renderAll();
    }
}
