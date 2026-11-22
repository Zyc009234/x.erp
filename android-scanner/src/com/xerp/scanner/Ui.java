package com.xerp.scanner;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.text.DecimalFormat;

public final class Ui {
    public static final int BG = 0xFFF3F4F6;
    public static final int CARD = 0xFFFFFFFF;
    public static final int PRIMARY = 0xFF059669;
    public static final int PRIMARY_SOFT = 0xFFECFDF5;
    public static final int ACCENT = 0xFF4F46E5;
    public static final int ACCENT_SOFT = 0xFFEEF2FF;
    public static final int WARN = 0xFFD97706;
    public static final int WARN_SOFT = 0xFFFEF3C7;
    public static final int DANGER = 0xFFDC2626;
    public static final int DANGER_SOFT = 0xFFFEE2E2;
    public static final int INK = 0xFF111827;
    public static final int MUTED = 0xFF6B7280;
    public static final int LINE = 0xFFE5E7EB;
    public static final int CHIP_BG = 0xFFF1F5F9;

    private Ui() { }

    public static int dp(Context ctx, int v) {
        return Math.round(v * ctx.getResources().getDisplayMetrics().density);
    }

    public static GradientDrawable rounded(Context ctx, int color, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadius(dp(ctx, radiusDp));
        return d;
    }

    public static GradientDrawable outlined(Context ctx, int fill, int stroke, int strokeDp, int radiusDp) {
        GradientDrawable d = new GradientDrawable();
        d.setColor(fill);
        d.setStroke(Math.max(1, dp(ctx, strokeDp)), stroke);
        d.setCornerRadius(dp(ctx, radiusDp));
        return d;
    }

    public static GradientDrawable topRounded(Context ctx, int color, int radiusDp) {
        float r = dp(ctx, radiusDp);
        GradientDrawable d = new GradientDrawable();
        d.setColor(color);
        d.setCornerRadii(new float[]{r, r, r, r, 0, 0, 0, 0});
        return d;
    }

    public static LinearLayout col(Context ctx) {
        LinearLayout l = new LinearLayout(ctx);
        l.setOrientation(LinearLayout.VERTICAL);
        return l;
    }

    public static LinearLayout row(Context ctx) {
        LinearLayout l = new LinearLayout(ctx);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        return l;
    }

    public static LinearLayout card(Context ctx, int padDp) {
        LinearLayout l = col(ctx);
        l.setBackground(outlined(ctx, CARD, LINE, 1, 12));
        int p = dp(ctx, padDp);
        l.setPadding(p, p, p, p);
        return l;
    }

    public static TextView tv(Context ctx, String text, int sp, int color, boolean bold) {
        TextView t = new TextView(ctx);
        t.setText(text == null ? "" : text);
        t.setTextSize(sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return t;
    }

    public static TextView badge(Context ctx, String text, int bg, int fg) {
        TextView t = tv(ctx, text, 11, fg, true);
        t.setBackground(rounded(ctx, bg, 6));
        t.setPadding(dp(ctx, 7), dp(ctx, 3), dp(ctx, 7), dp(ctx, 3));
        t.setSingleLine(true);
        return t;
    }

    public static TextView chip(Context ctx, String text, boolean active) {
        TextView t = tv(ctx, text, 13, active ? Color.WHITE : INK, active);
        t.setBackground(active ? rounded(ctx, PRIMARY, 16) : outlined(ctx, CHIP_BG, LINE, 1, 16));
        t.setPadding(dp(ctx, 12), dp(ctx, 6), dp(ctx, 12), dp(ctx, 6));
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        return t;
    }

    public static Button btn(Context ctx, String text, int bg, int fg) {
        Button b = new Button(ctx);
        b.setText(text);
        b.setTextColor(fg);
        b.setTextSize(15);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setAllCaps(false);
        b.setSingleLine(true);
        b.setEllipsize(TextUtils.TruncateAt.END);
        b.setStateListAnimator(null);
        b.setBackground(rounded(ctx, bg, 10));
        b.setMinHeight(dp(ctx, 44));
        b.setMinimumHeight(dp(ctx, 44));
        b.setPadding(dp(ctx, 12), dp(ctx, 6), dp(ctx, 12), dp(ctx, 6));
        return b;
    }

    public static Button outlineBtn(Context ctx, String text, int stroke, int fg) {
        Button b = btn(ctx, text, Color.WHITE, fg);
        b.setBackground(outlined(ctx, Color.WHITE, stroke, 1, 10));
        return b;
    }

    public static EditText input(Context ctx, String hint) {
        EditText e = new EditText(ctx);
        e.setHint(hint);
        e.setTextSize(15);
        e.setTextColor(INK);
        e.setHintTextColor(0xFF9CA3AF);
        e.setBackground(outlined(ctx, Color.WHITE, LINE, 1, 10));
        e.setPadding(dp(ctx, 12), dp(ctx, 10), dp(ctx, 12), dp(ctx, 10));
        return e;
    }

    public static View divider(Context ctx) {
        View v = new View(ctx);
        v.setBackgroundColor(LINE);
        v.setLayoutParams(new LinearLayout.LayoutParams(-1, 1));
        return v;
    }

    public static View space(Context ctx, int wDp, int hDp) {
        View v = new View(ctx);
        v.setLayoutParams(new LinearLayout.LayoutParams(wDp > 0 ? dp(ctx, wDp) : 0, hDp > 0 ? dp(ctx, hDp) : 0));
        return v;
    }

    public static Dialog showBottomDialog(Context ctx, View content, boolean dim) {
        Dialog d = new Dialog(ctx);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setContentView(content);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(topRounded(ctx, Color.WHITE, 18));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            if (!dim) w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
        d.show();
        return d;
    }

    public static void applyEdgeToEdge(Activity act, View root) {
        act.getWindow().setStatusBarColor(Color.WHITE);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = act.getWindow().getInsetsController();
            if (c != null) {
                c.setSystemBarsAppearance(
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS,
                        WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
                );
            }
        } else {
            act.getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR);
        }
        root.setOnApplyWindowInsetsListener((v, in) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                Insets s = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                v.setPadding(s.left, s.top, s.right, s.bottom);
            } else {
                v.setPadding(in.getSystemWindowInsetLeft(), in.getSystemWindowInsetTop(), in.getSystemWindowInsetRight(), in.getSystemWindowInsetBottom());
            }
            return in;
        });
    }

    public static void toast(Context ctx, String msg) {
        Toast t = Toast.makeText(ctx, msg, Toast.LENGTH_SHORT);
        t.setGravity(Gravity.CENTER, 0, 0);
        t.show();
    }

    public static String fmtQty(double v) {
        double r = Math.round(v * 100.0) / 100.0;
        if (Math.abs(r - Math.rint(r)) < 1e-6) return String.valueOf((long) Math.rint(r));
        return new DecimalFormat("0.##").format(r);
    }

    public static String fmtMoney(double v) {
        return new DecimalFormat("¥0.##").format(Math.round(v * 100.0) / 100.0);
    }
}
