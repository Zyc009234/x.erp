package com.xerp.scanner;

import android.animation.ValueAnimator;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class SplashActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean finished = false;
    private boolean previewMode = false;
    private long createdAt;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        AppStore store = AppStore.get(this);
        previewMode = getIntent().getBooleanExtra("preview", false);
        createdAt = System.currentTimeMillis();

        boolean loggedIn = !store.server.isEmpty() && !store.token.isEmpty();

        FrameLayout root = new FrameLayout(this);
        root.addView(new BackdropView(this), new FrameLayout.LayoutParams(-1, -1));

        LinearLayout layout = Ui.col(this);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(layout, new FrameLayout.LayoutParams(-1, -1));

        layout.addView(new View(this), new LinearLayout.LayoutParams(-1, 0, 1.0f));

        // Center Showcase
        LinearLayout center = Ui.col(this);
        center.setGravity(Gravity.CENTER_HORIZONTAL);
        center.setPadding(Ui.dp(this, 28), 0, Ui.dp(this, 28), 0);

        BrandLogoView logo = new BrandLogoView(this, store);
        int logoSize = Ui.dp(this, 124);
        logo.setElevation(Ui.dp(this, 10));
        logo.setScaleX(0.84f);
        logo.setScaleY(0.84f);
        logo.setAlpha(0f);
        center.addView(logo, new LinearLayout.LayoutParams(logoSize, logoSize));

        LinearLayout textGroup = Ui.col(this);
        textGroup.setGravity(Gravity.CENTER_HORIZONTAL);
        textGroup.setAlpha(0f);
        textGroup.setTranslationY(Ui.dp(this, 14));

        String coName = store.companyName != null && !store.companyName.trim().isEmpty()
                ? store.companyName.trim() : "x.erp 盘点";
        TextView title = Ui.tv(this, coName, 25, 0xFF0F172A, true);
        title.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(-2, -2);
        tlp.topMargin = Ui.dp(this, 20);
        textGroup.addView(title, tlp);

        String subStr = store.splashSubtitle != null && !store.splashSubtitle.trim().isEmpty()
                ? store.splashSubtitle.trim() : "智能扫码盘点 · 极速建档 · 全链路条码助手";
        TextView sub = Ui.tv(this, subStr, 13, 0xFF64748B, false);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-2, -2);
        slp.topMargin = Ui.dp(this, 6);
        textGroup.addView(sub, slp);

        TextView pill = Ui.badge(this, store.hasCustomLogo() ? "企业专属盘点端" : "x.erp 官方盘点助手",
                Ui.PRIMARY_SOFT, Ui.PRIMARY);
        pill.setTextSize(11);
        LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(-2, -2);
        plp.topMargin = Ui.dp(this, 14);
        textGroup.addView(pill, plp);

        center.addView(textGroup, new LinearLayout.LayoutParams(-1, -2));
        layout.addView(center, new LinearLayout.LayoutParams(-1, -2));

        layout.addView(new View(this), new LinearLayout.LayoutParams(-1, 0, 1.15f));

        // Bottom Progress + Footer
        LinearLayout bottom = Ui.col(this);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);
        bottom.setPadding(Ui.dp(this, 24), 0, Ui.dp(this, 24), Ui.dp(this, 24));

        SlimProgressView bar = new SlimProgressView(this);
        bottom.addView(bar, new LinearLayout.LayoutParams(Ui.dp(this, 148), Ui.dp(this, 4)));

        String hintText = previewMode ? "启动页效果预览（轻触屏幕返回）"
                : (loggedIn ? "正在进入盘点工作台…" : "正在准备连接向导…");
        TextView hint = Ui.tv(this, hintText, 12, 0xFF64748B, false);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(-2, -2);
        hlp.topMargin = Ui.dp(this, 10);
        bottom.addView(hint, hlp);

        String ver = "";
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            ver = pi.versionName;
        } catch (Exception ignored) { }
        TextView powered = Ui.tv(this, "Powered by x.erp" + (ver.isEmpty() ? "" : " · v" + ver), 11, 0xFF94A3B8, false);
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(-2, -2);
        flp.topMargin = Ui.dp(this, 10);
        bottom.addView(powered, flp);

        layout.addView(bottom, new LinearLayout.LayoutParams(-1, -2));

        setContentView(root);
        Ui.applyEdgeToEdge(this, root);

        // Animations
        logo.animate()
                .alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(420)
                .setInterpolator(new DecelerateInterpolator())
                .start();
        textGroup.animate()
                .alpha(1f).translationY(0f)
                .setStartDelay(120)
                .setDuration(400)
                .setInterpolator(new DecelerateInterpolator())
                .start();

        long holdMs = previewMode ? 2200L : 1150L;
        ValueAnimator prog = ValueAnimator.ofFloat(0f, 1f);
        prog.setDuration(holdMs);
        prog.setInterpolator(new DecelerateInterpolator());
        prog.addUpdateListener(a -> bar.setProgress((float) a.getAnimatedValue()));
        prog.start();

        root.setOnClickListener(v -> {
            if (previewMode || System.currentTimeMillis() - createdAt >= 350) proceed(loggedIn);
        });

        handler.postDelayed(() -> proceed(loggedIn), holdMs);
    }

    private void proceed(boolean loggedIn) {
        if (finished || isFinishing()) return;
        finished = true;
        handler.removeCallbacksAndMessages(null);
        if (!previewMode) {
            Intent next = new Intent(this, loggedIn ? MainActivity.class : LoginActivity.class);
            startActivity(next);
        }
        finish();
        overridePendingTransition(android.R.anim.fade_in, android.R.anim.fade_out);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        super.onDestroy();
    }

    private static final class BackdropView extends View {
        private final Paint bg = new Paint();
        private final Paint orb1 = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint orb2 = new Paint(Paint.ANTI_ALIAS_FLAG);

        BackdropView(Context ctx) {
            super(ctx);
        }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            bg.setShader(new LinearGradient(0, 0, 0, h, Color.WHITE, 0xFFF0FDF4, Shader.TileMode.CLAMP));
            c.drawRect(0, 0, w, h, bg);

            float r1 = w * 0.65f;
            orb1.setShader(new RadialGradient(w * 0.85f, h * 0.14f, r1, 0x2010B981, 0x0010B981, Shader.TileMode.CLAMP));
            c.drawCircle(w * 0.85f, h * 0.14f, r1, orb1);

            float r2 = w * 0.60f;
            orb2.setShader(new RadialGradient(w * 0.12f, h * 0.84f, r2, 0x1A0EA5E9, 0x000EA5E9, Shader.TileMode.CLAMP));
            c.drawCircle(w * 0.12f, h * 0.84f, r2, orb2);
        }
    }

    private static final class SlimProgressView extends View {
        private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint bar = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();
        private float progress = 0f;

        SlimProgressView(Context ctx) {
            super(ctx);
            track.setColor(0xFFE2E8F0);
            bar.setColor(Ui.PRIMARY);
        }

        void setProgress(float p) {
            this.progress = Math.max(0f, Math.min(1f, p));
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            float rad = h / 2f;
            r.set(0, 0, w, h);
            c.drawRoundRect(r, rad, rad, track);
            if (progress > 0f) {
                r.set(0, 0, Math.max(h, w * progress), h);
                c.drawRoundRect(r, rad, rad, bar);
            }
        }
    }
}
