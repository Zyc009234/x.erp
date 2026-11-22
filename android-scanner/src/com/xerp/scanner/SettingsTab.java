package com.xerp.scanner;

import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.view.View;
import android.widget.Button;
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

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(-1, -2);
        clp.bottomMargin = Ui.dp(act, 12);
        col.addView(acc, clp);

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
