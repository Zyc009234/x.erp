package com.xerp.scanner;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Insets;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.drawable.StateListDrawable;
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
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;

import java.text.DecimalFormat;

public final class Ui {
    // Unified x.erp Industrial SaaS Palette (Emerald + Cyan + Slate)
    public static final int BG = 0xFFF4F6FA;
    public static final int SURFACE_2 = 0xFFF8FAFC;
    public static final int CARD = 0xFFFFFFFF;
    public static final int PRIMARY = 0xFF059669;
    public static final int PRIMARY_DARK = 0xFF047857;
    public static final int PRIMARY_END = 0xFF0D9488;
    public static final int PRIMARY_SOFT = 0xFFECFDF5;
    public static final int PRIMARY_BORDER = 0xFFA7F3D0;
    public static final int ACCENT = 0xFF0284C7;
    public static final int ACCENT_SOFT = 0xFFE0F2FE;
    public static final int ACCENT_BORDER = 0xFFBAE6FD;
    public static final int WARN = 0xFFD97706;
    public static final int WARN_SOFT = 0xFFFEF3C7;
    public static final int DANGER = 0xFFDC2626;
    public static final int DANGER_SOFT = 0xFFFEE2E2;
    public static final int INK = 0xFF0F172A;
    public static final int INK_2 = 0xFF334155;
    public static final int MUTED = 0xFF64748B;
    public static final int SUBTLE = 0xFF94A3B8;
    public static final int LINE = 0xFFE2E8F0;
    public static final int LINE_SOFT = 0xFFF1F5F9;
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

    public static GradientDrawable gradientRounded(Context ctx, int startColor, int endColor, int radiusDp) {
        GradientDrawable d = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, new int[]{startColor, endColor});
        d.setCornerRadius(dp(ctx, radiusDp));
        return d;
    }

    public static Drawable rippleRounded(Context ctx, int color, int radiusDp) {
        GradientDrawable content = rounded(ctx, color, radiusDp);
        return wrapRipple(color, content);
    }

    public static Drawable rippleOutlined(Context ctx, int fill, int stroke, int strokeDp, int radiusDp) {
        GradientDrawable content = outlined(ctx, fill, stroke, strokeDp, radiusDp);
        return wrapRipple(fill, content);
    }

    public static Drawable rippleGradient(Context ctx, int startColor, int endColor, int radiusDp) {
        GradientDrawable content = gradientRounded(ctx, startColor, endColor, radiusDp);
        return wrapRipple(startColor, content);
    }

    private static Drawable wrapRipple(int bgColor, GradientDrawable content) {
        int lum = (Color.red(bgColor) * 299 + Color.green(bgColor) * 587 + Color.blue(bgColor) * 114) / 1000;
        int rippleColor = lum < 160 ? 0x33FFFFFF : 0x1A0F172A;
        return new RippleDrawable(ColorStateList.valueOf(rippleColor), content, content);
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
        l.setBackground(outlined(ctx, CARD, 0xFFE8EDF5, 1, 14));
        l.setElevation(dp(ctx, 2));
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
        t.setBackground(rounded(ctx, bg, 8));
        t.setPadding(dp(ctx, 8), dp(ctx, 4), dp(ctx, 8), dp(ctx, 4));
        t.setSingleLine(true);
        return t;
    }

    public static TextView chip(Context ctx, String text, boolean active) {
        TextView t = tv(ctx, text, 13, active ? Color.WHITE : INK_2, active);
        t.setBackground(active
                ? rippleRounded(ctx, PRIMARY, 18)
                : rippleOutlined(ctx, CARD, LINE, 1, 18));
        t.setPadding(dp(ctx, 13), dp(ctx, 6), dp(ctx, 13), dp(ctx, 6));
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
        b.setBackground(rippleRounded(ctx, bg, 12));
        b.setMinHeight(dp(ctx, 44));
        b.setMinimumHeight(dp(ctx, 44));
        b.setPadding(dp(ctx, 12), dp(ctx, 6), dp(ctx, 12), dp(ctx, 6));
        return b;
    }

    public static Button gradientBtn(Context ctx, String text, int startColor, int endColor) {
        Button b = btn(ctx, text, startColor, Color.WHITE);
        b.setBackground(rippleGradient(ctx, startColor, endColor, 12));
        b.setElevation(dp(ctx, 2));
        return b;
    }

    public static Button outlineBtn(Context ctx, String text, int stroke, int fg) {
        Button b = btn(ctx, text, CARD, fg);
        b.setBackground(rippleOutlined(ctx, CARD, stroke, 1, 12));
        return b;
    }

    public static EditText input(Context ctx, String hint) {
        EditText e = new EditText(ctx);
        e.setHint(hint);
        e.setTextSize(15);
        e.setTextColor(INK);
        e.setHintTextColor(SUBTLE);

        GradientDrawable focused = new GradientDrawable();
        focused.setColor(CARD);
        focused.setStroke(Math.max(2, Math.round(1.5f * ctx.getResources().getDisplayMetrics().density)), PRIMARY);
        focused.setCornerRadius(dp(ctx, 12));

        GradientDrawable normal = outlined(ctx, SURFACE_2, LINE, 1, 12);

        StateListDrawable states = new StateListDrawable();
        states.addState(new int[]{android.R.attr.state_focused}, focused);
        states.addState(new int[0], normal);
        e.setBackground(states);
        e.setPadding(dp(ctx, 13), dp(ctx, 11), dp(ctx, 13), dp(ctx, 11));
        return e;
    }

    public static View divider(Context ctx) {
        View v = new View(ctx);
        v.setBackgroundColor(LINE);
        v.setLayoutParams(new LinearLayout.LayoutParams(-1, 1));
        return v;
    }

    public static View insetDivider(Context ctx) {
        View v = new View(ctx);
        v.setBackgroundColor(LINE_SOFT);
        v.setLayoutParams(new LinearLayout.LayoutParams(-1, Math.max(1, dp(ctx, 1))));
        return v;
    }

    public static View space(Context ctx, int wDp, int hDp) {
        View v = new View(ctx);
        v.setLayoutParams(new LinearLayout.LayoutParams(wDp > 0 ? dp(ctx, wDp) : 0, hDp > 0 ? dp(ctx, hDp) : 0));
        return v;
    }

    public static final class IconPill extends LinearLayout {
        public final IconView icon;
        public final TextView label;

        IconPill(Context ctx, IconView.Type type, String text, int bg, int stroke, int fg) {
            super(ctx);
            setOrientation(HORIZONTAL);
            setGravity(Gravity.CENTER);
            setPadding(dp(ctx, 9), dp(ctx, 5), dp(ctx, 10), dp(ctx, 5));
            icon = new IconView(ctx, type, fg);
            label = tv(ctx, text, 12, fg, true);
            label.setSingleLine(true);
            label.setEllipsize(TextUtils.TruncateAt.END);
            addView(icon, new LayoutParams(dp(ctx, 14), dp(ctx, 14)));
            addView(space(ctx, 4, 1));
            addView(label);
            applyStyle(type, text, bg, stroke, fg);
        }

        public void applyStyle(IconView.Type type, String text, int bg, int stroke, int fg) {
            icon.setIcon(type, fg);
            label.setText(text == null ? "" : text);
            label.setTextColor(fg);
            Context c = getContext();
            if (stroke != 0) {
                setBackground(rippleOutlined(c, bg, stroke, 1, 16));
            } else {
                setBackground(rippleRounded(c, bg, 16));
            }
        }
    }

    public static IconPill iconPill(Context ctx, IconView.Type type, String text, int bg, int stroke, int fg) {
        return new IconPill(ctx, type, text, bg, stroke, fg);
    }

    public static LinearLayout sectionHeader(Context ctx, IconView.Type iconType, String title, int iconColor) {
        LinearLayout row = row(ctx);
        int boxSize = dp(ctx, 26);
        LinearLayout iconBox = row(ctx);
        iconBox.setGravity(Gravity.CENTER);
        int softBg = Color.argb(26, Color.red(iconColor), Color.green(iconColor), Color.blue(iconColor));
        iconBox.setBackground(rounded(ctx, softBg, 8));
        iconBox.addView(new IconView(ctx, iconType, iconColor), new LinearLayout.LayoutParams(dp(ctx, 15), dp(ctx, 15)));
        row.addView(iconBox, new LinearLayout.LayoutParams(boxSize, boxSize));
        row.addView(space(ctx, 8, 1));
        row.addView(tv(ctx, title, 15, INK, true));
        return row;
    }

    public static Switch styledSwitch(Context ctx, boolean checked) {
        Switch sw = new Switch(ctx);
        sw.setChecked(checked);
        int[][] states = new int[][]{new int[]{android.R.attr.state_checked}, new int[]{}};
        sw.setThumbTintList(new ColorStateList(states, new int[]{PRIMARY, 0xFFF8FAFC}));
        sw.setTrackTintList(new ColorStateList(states, new int[]{0x66059669, 0x3394A3B8}));
        return sw;
    }

    public static LinearLayout emptyState(Context ctx, IconView.Type iconType, String title, String subtitle) {
        LinearLayout wrap = col(ctx);
        wrap.setGravity(Gravity.CENTER_HORIZONTAL);
        wrap.setBackground(outlined(ctx, CARD, 0xFFE8EDF5, 1, 16));
        wrap.setElevation(dp(ctx, 1));
        wrap.setPadding(dp(ctx, 20), dp(ctx, 24), dp(ctx, 20), dp(ctx, 24));

        LinearLayout circle = row(ctx);
        circle.setGravity(Gravity.CENTER);
        circle.setBackground(rounded(ctx, PRIMARY_SOFT, 28));
        circle.addView(new IconView(ctx, iconType, PRIMARY), new LinearLayout.LayoutParams(dp(ctx, 26), dp(ctx, 26)));
        wrap.addView(circle, new LinearLayout.LayoutParams(dp(ctx, 52), dp(ctx, 52)));

        TextView t = tv(ctx, title, 15, INK, true);
        t.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(-2, -2);
        tlp.topMargin = dp(ctx, 12);
        wrap.addView(t, tlp);

        if (subtitle != null && !subtitle.isEmpty()) {
            TextView sub = tv(ctx, subtitle, 12, MUTED, false);
            sub.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-2, -2);
            slp.topMargin = dp(ctx, 5);
            wrap.addView(sub, slp);
        }
        return wrap;
    }

    public static Dialog showBottomDialog(Context ctx, View content, boolean dim) {
        LinearLayout shell = col(ctx);
        shell.setGravity(Gravity.CENTER_HORIZONTAL);

        LinearLayout handleWrap = row(ctx);
        handleWrap.setGravity(Gravity.CENTER);
        handleWrap.setPadding(0, dp(ctx, 9), 0, dp(ctx, 3));
        View handle = new View(ctx);
        handle.setBackground(rounded(ctx, 0xFFCBD5E1, 3));
        handleWrap.addView(handle, new LinearLayout.LayoutParams(dp(ctx, 38), dp(ctx, 4)));
        shell.addView(handleWrap, new LinearLayout.LayoutParams(-1, -2));

        ViewGroup.LayoutParams origLp = content.getLayoutParams();
        if (origLp != null) {
            shell.addView(content, origLp);
        } else {
            shell.addView(content, new LinearLayout.LayoutParams(-1, -2));
        }

        Dialog d = new Dialog(ctx);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);
        d.setContentView(shell);
        Window w = d.getWindow();
        if (w != null) {
            w.setBackgroundDrawable(topRounded(ctx, Color.WHITE, 22));
            w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            w.setGravity(Gravity.BOTTOM);
            w.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
            if (!dim) w.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
        }
        d.show();
        return d;
    }

    public static void applyEdgeToEdge(Activity act, View root) {
        applyEdgeToEdgeBar(act, root, Color.WHITE, true);
    }

    public static void applyEdgeToEdgeBar(Activity act, View root, int statusBarColor, boolean lightIcons) {
        act.getWindow().setStatusBarColor(statusBarColor);
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = act.getWindow().getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                int val = lightIcons ? mask : WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(val, mask);
            }
        } else if (lightIcons) {
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
