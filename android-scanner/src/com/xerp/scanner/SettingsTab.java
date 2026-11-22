package com.xerp.scanner;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

public class SettingsTab implements TabPage {
    private final MainActivity act;
    private final AppStore store;
    private final ScrollView root;
    private final LinearLayout col;

    public SettingsTab(MainActivity act) {
        this.act = act;
        this.store = act.store;
        root = new ScrollView(act);
        root.setBackgroundColor(Ui.BG);
        col = Ui.col(act);
        col.setPadding(Ui.dp(act, 12), Ui.dp(act, 12), Ui.dp(act, 12), Ui.dp(act, 20));
        root.addView(col);
    }

    @Override public View getView() { return root; }
    @Override public boolean needsCamera() { return false; }
    @Override public void onShown() { render(); }
    @Override public void onDataUpdated() { render(); }
    @Override public void onBarcodeScanned(String code) { }
    @Override public void onCameraStateChanged(boolean open) { }

    private void render() {
        col.removeAllViews();

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(-1, -2);
        clp.bottomMargin = Ui.dp(act, 12);

        // 0. Brand & Splash Logo Card
        LinearLayout brand = Ui.card(act, 14);
        brand.addView(Ui.tv(act, "品牌与启动页 Logo", 15, Ui.INK, true));
        LinearLayout bRow = Ui.row(act);
        bRow.setPadding(0, Ui.dp(act, 10), 0, Ui.dp(act, 10));
        BrandLogoView logoPrev = new BrandLogoView(act, store);
        int lpSize = Ui.dp(act, 68);
        bRow.addView(logoPrev, new LinearLayout.LayoutParams(lpSize, lpSize));
        bRow.addView(Ui.space(act, 12, 1));
        LinearLayout bInfo = Ui.col(act);
        boolean hasCustom = store.hasCustomLogo();
        boolean hasCustomBrand = hasCustom || !store.splashTitle.trim().isEmpty()
                || !AppStore.DEFAULT_SUBTITLE.equals(store.splashSubtitle);
        bInfo.addView(Ui.badge(act, hasCustom ? "自定义公司 Logo" : "默认 x.erp Logo",
                hasCustom ? Ui.ACCENT_SOFT : Ui.PRIMARY_SOFT, hasCustom ? Ui.ACCENT : Ui.PRIMARY));
        bInfo.addView(Ui.tv(act, store.effectiveSplashTitle(), 16, Ui.INK, true));
        bInfo.addView(Ui.tv(act, store.splashSubtitle, 12, Ui.MUTED, false));
        bRow.addView(bInfo, new LinearLayout.LayoutParams(0, -2, 1));
        brand.addView(bRow);

        LinearLayout bBtns = Ui.row(act);
        Button bChange = Ui.btn(act, "更换 Logo", Ui.PRIMARY, Color.WHITE);
        bChange.setMinHeight(Ui.dp(act, 38)); bChange.setMinimumHeight(Ui.dp(act, 38)); bChange.setTextSize(13);
        bChange.setOnClickListener(v -> act.pickCustomLogo(this::render));
        Button bPreview = Ui.outlineBtn(act, "预览启动页", Ui.ACCENT, Ui.ACCENT);
        bPreview.setMinHeight(Ui.dp(act, 38)); bPreview.setMinimumHeight(Ui.dp(act, 38)); bPreview.setTextSize(13);
        bPreview.setOnClickListener(v -> {
            Intent i = new Intent(act, SplashActivity.class);
            i.putExtra("preview", true);
            act.startActivity(i);
            act.overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
        });
        bBtns.addView(bChange, new LinearLayout.LayoutParams(0, Ui.dp(act, 38), 1));
        bBtns.addView(Ui.space(act, 6, 1));
        bBtns.addView(bPreview, new LinearLayout.LayoutParams(0, Ui.dp(act, 38), 1));
        if (hasCustomBrand) {
            Button bReset = Ui.outlineBtn(act, "恢复默认", Ui.WARN, Ui.WARN);
            bReset.setMinHeight(Ui.dp(act, 38)); bReset.setMinimumHeight(Ui.dp(act, 38)); bReset.setTextSize(13);
            bReset.setOnClickListener(v -> {
                store.clearCustomLogo();
                store.splashTitle = "";
                store.splashSubtitle = AppStore.DEFAULT_SUBTITLE;
                store.savePrefs();
                act.refreshBrandLogo();
                render();
                Ui.toast(act, "已恢复默认 x.erp 启动页与 Logo");
            });
            bBtns.addView(Ui.space(act, 6, 1));
            bBtns.addView(bReset, new LinearLayout.LayoutParams(0, Ui.dp(act, 38), 0.9f));
        }
        brand.addView(bBtns);

        Button bSub = Ui.outlineBtn(act, "修改启动页名称与标语", Ui.LINE, Ui.MUTED);
        bSub.setMinHeight(Ui.dp(act, 36)); bSub.setMinimumHeight(Ui.dp(act, 36)); bSub.setTextSize(12);
        bSub.setOnClickListener(v -> {
            LinearLayout box = Ui.col(act);
            int pad = Ui.dp(act, 16);
            box.setPadding(pad, Ui.dp(act, 8), pad, 0);
            box.addView(Ui.tv(act, "启动页主标题（留空默认显示 x.erp）", 12, Ui.MUTED, false));
            EditText etTitle = Ui.input(act, "x.erp");
            etTitle.setSingleLine(true);
            etTitle.setText(store.splashTitle);
            box.addView(etTitle);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(-1, -2);
            tlp.topMargin = Ui.dp(act, 10);
            box.addView(Ui.tv(act, "启动页副标题 / 标语", 12, Ui.MUTED, false), tlp);
            EditText etSub = Ui.input(act, AppStore.DEFAULT_SUBTITLE);
            etSub.setSingleLine(true);
            etSub.setText(store.splashSubtitle);
            box.addView(etSub);
            new AlertDialog.Builder(act).setTitle("自定义启动页文字").setView(box)
                    .setPositiveButton("保存", (d, w) -> {
                        store.splashTitle = etTitle.getText().toString().trim();
                        String s = etSub.getText().toString().trim();
                        store.splashSubtitle = s.isEmpty() ? AppStore.DEFAULT_SUBTITLE : s;
                        store.savePrefs();
                        render();
                        Ui.toast(act, "启动页设置已更新");
                    }).setNegativeButton("取消", null).show();
        });
        LinearLayout.LayoutParams sblp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 36));
        sblp.topMargin = Ui.dp(act, 8);
        brand.addView(bSub, sblp);
        col.addView(brand, clp);

        // 1. Account & Server Card
        LinearLayout acc = Ui.card(act, 14);
        acc.addView(Ui.tv(act, "服务器与账号", 15, Ui.INK, true));
        acc.addView(Ui.tv(act, "地址：" + store.server, 13, Ui.MUTED, false));
        acc.addView(Ui.tv(act, "公司：" + store.companyName + (store.isPortal ? " (" + store.companyCode + ")" : ""), 13, Ui.INK, false));
        acc.addView(Ui.tv(act, "用户：" + store.userName + " (" + store.username + ")", 13, Ui.MUTED, false));

        LinearLayout accBtns = Ui.row(act);
        Button bSync = Ui.btn(act, "立即同步数据", Ui.PRIMARY, Color.WHITE);
        bSync.setOnClickListener(v -> act.refreshData(() -> Ui.toast(act, "已同步 " + store.products.size() + " 个商品")));
        accBtns.addView(bSync, new LinearLayout.LayoutParams(0, Ui.dp(act, 42), 1));
        if (store.isPortal && store.companies.size() > 1) {
            Button bCo = Ui.outlineBtn(act, "切换公司", Ui.ACCENT, Ui.ACCENT);
            bCo.setOnClickListener(v -> act.showCompanyPicker());
            accBtns.addView(Ui.space(act, 8, 1));
            accBtns.addView(bCo, new LinearLayout.LayoutParams(0, Ui.dp(act, 42), 1));
        }
        LinearLayout.LayoutParams ablp = new LinearLayout.LayoutParams(-1, -2);
        ablp.topMargin = Ui.dp(act, 10);
        acc.addView(accBtns, ablp);

        Button bLogout = Ui.outlineBtn(act, "更换服务器 / 退出登录", Ui.DANGER, Ui.DANGER);
        bLogout.setOnClickListener(v -> new AlertDialog.Builder(act)
                .setTitle("退出登录").setMessage("确定断开当前账号返回登录页？")
                .setPositiveButton("确定", (d, w) -> {
                    store.clearAuth();
                    act.startActivity(new Intent(act, LoginActivity.class));
                    act.finish();
                }).setNegativeButton("取消", null).show());
        LinearLayout.LayoutParams llp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 42));
        llp.topMargin = Ui.dp(act, 8);
        acc.addView(bLogout, llp);

        col.addView(acc, clp);

        // 1.5 Stocktake Mode & TTS Voice Card
        LinearLayout ttsCard = Ui.card(act, 14);
        ttsCard.addView(Ui.tv(act, "盘点模式与语音播报", 15, Ui.INK, true));
        if (act.tts != null) {
            TextView st = Ui.tv(act, act.tts.statusSummary(), 12, Ui.PRIMARY, false);
            st.setPadding(0, Ui.dp(act, 4), 0, Ui.dp(act, 4));
            ttsCard.addView(st);
        }
        ttsCard.addView(toggleRow("盲盘模式（盘点隐藏账面库存与盈亏）", store.blindMode, on -> {
            store.blindMode = on;
            store.savePrefs();
            act.notifyDataChanged();
        }));
        ttsCard.addView(toggleRow("扫码语音播报（支持无系统 TTS 自动兜底）", store.ttsEnabled, on -> {
            store.ttsEnabled = on;
            store.savePrefs();
            if (!on) {
                if (act.tts != null) act.tts.stop();
            } else if (act.tts != null) {
                act.tts.warmUp();
                act.tts.speakForceCue("语音播报已开启", "tts_on");
            }
            act.notifyDataChanged();
        }));

        LinearLayout engRow = Ui.row(act);
        engRow.setPadding(0, Ui.dp(act, 8), 0, Ui.dp(act, 4));
        engRow.addView(Ui.tv(act, "语音引擎", 13, Ui.INK, false), new LinearLayout.LayoutParams(0, -2, 1));
        String[] engKeys = {"auto", "builtin"};
        String[] engLabels = {"自动(优先系统)", "内置离线语音"};
        for (int i = 0; i < engKeys.length; i++) {
            final String ek = engKeys[i];
            TextView ch = Ui.chip(act, engLabels[i], ek.equals(store.ttsEngineMode));
            ch.setTextSize(12);
            ch.setPadding(Ui.dp(act, 10), Ui.dp(act, 5), Ui.dp(act, 10), Ui.dp(act, 5));
            ch.setOnClickListener(v -> {
                store.ttsEngineMode = ek;
                store.savePrefs();
                if ("auto".equals(ek) && act.tts != null) act.tts.warmUp();
                render();
            });
            engRow.addView(ch);
            if (i < engKeys.length - 1) engRow.addView(Ui.space(act, 6, 1));
        }
        ttsCard.addView(engRow);

        LinearLayout rateRow = Ui.row(act);
        rateRow.setPadding(0, Ui.dp(act, 8), 0, Ui.dp(act, 8));
        rateRow.addView(Ui.tv(act, "播报语速", 13, Ui.INK, false), new LinearLayout.LayoutParams(0, -2, 1));
        float[] rates = {1.0f, 1.2f, 1.5f};
        String[] rateLabels = {"正常 1.0x", "较快 1.2x", "极速 1.5x"};
        for (int i = 0; i < rates.length; i++) {
            final float rv = rates[i];
            TextView ch = Ui.chip(act, rateLabels[i], Math.abs(store.ttsRate - rv) < 0.05f);
            ch.setTextSize(12);
            ch.setPadding(Ui.dp(act, 10), Ui.dp(act, 5), Ui.dp(act, 10), Ui.dp(act, 5));
            ch.setOnClickListener(v -> {
                store.ttsRate = rv;
                store.savePrefs();
                render();
            });
            rateRow.addView(ch);
            if (i < rates.length - 1) rateRow.addView(Ui.space(act, 6, 1));
        }
        ttsCard.addView(rateRow);

        Button bTestTts = Ui.outlineBtn(act, "试听语音播报", Ui.PRIMARY, Ui.PRIMARY);
        bTestTts.setMinHeight(Ui.dp(act, 38));
        bTestTts.setMinimumHeight(Ui.dp(act, 38));
        bTestTts.setTextSize(13);
        bTestTts.setOnClickListener(v -> {
            if (act.tts != null) act.tts.speakTest(act);
        });
        LinearLayout.LayoutParams ttlp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 38));
        ttlp.topMargin = Ui.dp(act, 4);
        ttsCard.addView(bTestTts, ttlp);

        Button bSysTts = Ui.outlineBtn(act, "系统 TTS 设置（选装引擎可念商品名）", Ui.LINE, Ui.MUTED);
        bSysTts.setMinHeight(Ui.dp(act, 34));
        bSysTts.setMinimumHeight(Ui.dp(act, 34));
        bSysTts.setTextSize(12);
        bSysTts.setOnClickListener(v -> {
            if (act.tts != null) act.tts.openSystemTtsSettings(act);
        });
        LinearLayout.LayoutParams stlp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 34));
        stlp.topMargin = Ui.dp(act, 6);
        ttsCard.addView(bSysTts, stlp);
        col.addView(ttsCard, clp);

        // 2. Scanner & One-hand Preferences
        LinearLayout pref = Ui.card(act, 14);
        pref.addView(Ui.tv(act, "扫码与单手偏好", 15, Ui.INK, true));
        pref.addView(toggleRow("连续扫码（关闭则每次扫完自动关相机）", store.continuousScan, on -> { store.continuousScan = on; store.savePrefs(); }));
        pref.addView(toggleRow("扫码成功提示音", store.soundEnabled, on -> { store.soundEnabled = on; store.savePrefs(); }));
        pref.addView(toggleRow("扫码震动反馈", store.vibrateEnabled, on -> { store.vibrateEnabled = on; store.savePrefs(); }));
        pref.addView(toggleRow("未识别条码自动弹出录新弹窗", store.autoPromptNew, on -> { store.autoPromptNew = on; store.savePrefs(); }));
        pref.addView(toggleRow("左手持机布局（翻转底部按钮）", store.leftHanded, on -> { store.leftHanded = on; store.savePrefs(); }));
        pref.addView(toggleRow("蓝牙/PDA 扫码枪 HID 按键监听", store.pdaHidMode, on -> { store.pdaHidMode = on; store.savePrefs(); }));

        // Cooldown chips
        LinearLayout cdRow = Ui.row(act);
        cdRow.setPadding(0, Ui.dp(act, 10), 0, Ui.dp(act, 4));
        cdRow.addView(Ui.tv(act, "防重扫冷却", 13, Ui.INK, false), new LinearLayout.LayoutParams(0, -2, 1));
        int[] ms = {500, 800, 1500};
        String[] lb = {"0.5秒", "0.8秒", "1.5秒"};
        for (int i = 0; i < ms.length; i++) {
            final int val = ms[i];
            TextView ch = Ui.chip(act, lb[i], store.cooldownMs == val);
            ch.setOnClickListener(v -> { store.cooldownMs = val; store.savePrefs(); render(); });
            cdRow.addView(ch);
            if (i < ms.length - 1) cdRow.addView(Ui.space(act, 6, 1));
        }
        pref.addView(cdRow);
        col.addView(pref, clp);

        // 3. Offline Drafts & Version
        LinearLayout draft = Ui.card(act, 14);
        int n = store.countDrafts();
        draft.addView(Ui.tv(act, "离线安全与版本", 15, Ui.INK, true));
        draft.addView(Ui.tv(act, "本地盘点草稿：" + n + " 份（每次扫码实时保存防丢失）", 13, Ui.MUTED, false));
        if (n > 0) {
            Button bClr = Ui.outlineBtn(act, "清理全部本地草稿", Ui.WARN, Ui.WARN);
            bClr.setOnClickListener(v -> new AlertDialog.Builder(act)
                    .setTitle("清理草稿").setMessage("确定删除本地保存的未上传草稿吗？")
                    .setPositiveButton("清理", (d, w) -> { store.clearAllDrafts(); render(); }).setNegativeButton("取消", null).show());
            LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 40));
            dlp.topMargin = Ui.dp(act, 8);
            draft.addView(bClr, dlp);
        }
        String ver = "";
        try { ver = act.getPackageManager().getPackageInfo(act.getPackageName(), 0).versionName; } catch (Exception ignored) { }
        draft.addView(Ui.tv(act, "x.erp 盘点助手 v" + ver + " · 数据实时同步自服务端", 12, Ui.MUTED, false));
        col.addView(draft);
    }

    private interface BoolCb { void onChange(boolean val); }

    private View toggleRow(String label, boolean init, BoolCb cb) {
        LinearLayout row = Ui.row(act);
        row.setPadding(0, Ui.dp(act, 8), 0, Ui.dp(act, 8));
        row.addView(Ui.tv(act, label, 13, Ui.INK, false), new LinearLayout.LayoutParams(0, -2, 1));
        Switch sw = new Switch(act);
        sw.setChecked(init);
        sw.setOnCheckedChangeListener((b, c) -> cb.onChange(c));
        row.addView(sw);
        return row;
    }
}
