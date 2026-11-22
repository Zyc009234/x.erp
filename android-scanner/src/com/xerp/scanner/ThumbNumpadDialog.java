package com.xerp.scanner;

import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public final class ThumbNumpadDialog {
    public interface OnConfirm {
        void onConfirm(double value);
    }

    private ThumbNumpadDialog() { }

    public static void show(Context ctx, String title, String subtitle, Double initialVal, Double bookVal, boolean allowDec, OnConfirm onConfirm) {
        LinearLayout root = Ui.col(ctx);
        root.setPadding(Ui.dp(ctx, 16), Ui.dp(ctx, 14), Ui.dp(ctx, 16), Ui.dp(ctx, 16));

        // Header
        LinearLayout head = Ui.row(ctx);
        LinearLayout titles = Ui.col(ctx);
        TextView tTitle = Ui.tv(ctx, title, 17, Ui.INK, true);
        tTitle.setMaxLines(1);
        titles.addView(tTitle);
        if (subtitle != null && !subtitle.isEmpty()) {
            titles.addView(Ui.tv(ctx, subtitle, 12, Ui.MUTED, false));
        }
        head.addView(titles, new LinearLayout.LayoutParams(0, -2, 1));
        TextView closeX = Ui.tv(ctx, "取消", 14, Ui.MUTED, true);
        closeX.setPadding(Ui.dp(ctx, 10), Ui.dp(ctx, 6), Ui.dp(ctx, 4), Ui.dp(ctx, 6));
        head.addView(closeX);
        root.addView(head);

        // Large Display Box
        TextView disp = Ui.tv(ctx, "", 32, Ui.PRIMARY, true);
        disp.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
        disp.setBackground(Ui.outlined(ctx, Ui.PRIMARY_SOFT, Ui.PRIMARY, 1, 12));
        disp.setPadding(Ui.dp(ctx, 16), Ui.dp(ctx, 10), Ui.dp(ctx, 16), Ui.dp(ctx, 10));
        LinearLayout.LayoutParams dlp = new LinearLayout.LayoutParams(-1, -2);
        dlp.topMargin = Ui.dp(ctx, 10);
        root.addView(disp, dlp);

        final StringBuilder buf = new StringBuilder(initialVal == null ? "0" : Ui.fmtQty(initialVal));
        final boolean[] replaceNext = {initialVal != null};

        Runnable syncDisp = () -> disp.setText(buf.length() == 0 ? "0" : buf.toString());
        syncDisp.run();

        // Quick action chips row
        LinearLayout quick = Ui.row(ctx);
        LinearLayout.LayoutParams qlp = new LinearLayout.LayoutParams(-1, -2);
        qlp.topMargin = Ui.dp(ctx, 10);
        if (bookVal != null) {
            Button eqBook = Ui.outlineBtn(ctx, "=账面(" + Ui.fmtQty(bookVal) + ")", Ui.ACCENT, Ui.ACCENT);
            eqBook.setTextSize(13);
            eqBook.setMinHeight(Ui.dp(ctx, 36));
            eqBook.setMinimumHeight(Ui.dp(ctx, 36));
            eqBook.setOnClickListener(v -> {
                buf.setLength(0);
                buf.append(Ui.fmtQty(Math.max(0, bookVal)));
                replaceNext[0] = true;
                syncDisp.run();
            });
            quick.addView(eqBook, new LinearLayout.LayoutParams(0, Ui.dp(ctx, 36), 1.4f));
            quick.addView(Ui.space(ctx, 6, 1));
        }
        int[] adds = {1, 5, 10};
        for (int a : adds) {
            Button ab = Ui.outlineBtn(ctx, "+" + a, Ui.LINE, Ui.INK);
            ab.setTextSize(13);
            ab.setMinHeight(Ui.dp(ctx, 36));
            ab.setMinimumHeight(Ui.dp(ctx, 36));
            ab.setOnClickListener(v -> {
                double cur = parseSafe(buf.toString());
                double next = Math.round((cur + a) * 100.0) / 100.0;
                buf.setLength(0);
                buf.append(Ui.fmtQty(next));
                replaceNext[0] = true;
                syncDisp.run();
            });
            quick.addView(ab, new LinearLayout.LayoutParams(0, Ui.dp(ctx, 36), 1f));
            quick.addView(Ui.space(ctx, 6, 1));
        }
        Button clr = Ui.outlineBtn(ctx, "清零", Ui.DANGER_SOFT, Ui.DANGER);
        clr.setTextSize(13);
        clr.setMinHeight(Ui.dp(ctx, 36));
        clr.setMinimumHeight(Ui.dp(ctx, 36));
        clr.setOnClickListener(v -> {
            buf.setLength(0);
            buf.append("0");
            replaceNext[0] = true;
            syncDisp.run();
        });
        quick.addView(clr, new LinearLayout.LayoutParams(0, Ui.dp(ctx, 36), 1f));
        root.addView(quick, qlp);

        // 3x4 Keypad Grid
        String[][] keys = {
                {"7", "8", "9"},
                {"4", "5", "6"},
                {"1", "2", "3"},
                {allowDec ? "." : "C", "0", "⌫"}
        };
        LinearLayout pad = Ui.col(ctx);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(-1, -2);
        plp.topMargin = Ui.dp(ctx, 10);
        for (String[] rKeys : keys) {
            LinearLayout kr = Ui.row(ctx);
            for (int c = 0; c < 3; c++) {
                final String k = rKeys[c];
                Button kb = Ui.outlineBtn(ctx, k, Ui.LINE, Ui.INK);
                kb.setTextSize(20);
                kb.setBackground(Ui.outlined(ctx, 0xFFF9FAFB, Ui.LINE, 1, 10));
                kb.setOnClickListener(v -> {
                    if ("⌫".equals(k)) {
                        replaceNext[0] = false;
                        if (buf.length() > 0) buf.deleteCharAt(buf.length() - 1);
                        if (buf.length() == 0) buf.append("0");
                    } else if ("C".equals(k)) {
                        buf.setLength(0);
                        buf.append("0");
                        replaceNext[0] = true;
                    } else if (".".equals(k)) {
                        if (replaceNext[0]) { buf.setLength(0); buf.append("0"); replaceNext[0] = false; }
                        if (buf.indexOf(".") < 0) buf.append(".");
                    } else {
                        if (replaceNext[0] || "0".equals(buf.toString())) {
                            buf.setLength(0);
                            replaceNext[0] = false;
                        }
                        int dot = buf.indexOf(".");
                        if (dot >= 0 && buf.length() - dot > 2) return; // max 2 decimals
                        if (buf.length() < 10) buf.append(k);
                    }
                    syncDisp.run();
                });
                LinearLayout.LayoutParams klp = new LinearLayout.LayoutParams(0, Ui.dp(ctx, 52), 1);
                if (c > 0) klp.leftMargin = Ui.dp(ctx, 8);
                kr.addView(kb, klp);
            }
            LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(-1, -2);
            rlp.topMargin = Ui.dp(ctx, 6);
            pad.addView(kr, rlp);
        }
        root.addView(pad, plp);

        Button ok = Ui.btn(ctx, "确定", Ui.PRIMARY, Color.WHITE);
        ok.setTextSize(17);
        LinearLayout.LayoutParams olp = new LinearLayout.LayoutParams(-1, Ui.dp(ctx, 52));
        olp.topMargin = Ui.dp(ctx, 12);
        root.addView(ok, olp);

        Dialog d = Ui.showBottomDialog(ctx, root, true);
        closeX.setOnClickListener(v -> d.dismiss());
        ok.setOnClickListener(v -> {
            double val = parseSafe(buf.toString());
            if (!allowDec) val = Math.rint(val);
            else val = Math.round(val * 100.0) / 100.0;
            if (val < 0) val = 0;
            d.dismiss();
            onConfirm.onConfirm(val);
        });
    }

    private static double parseSafe(String s) {
        try { return Double.parseDouble(s); } catch (Exception e) { return 0; }
    }
}
