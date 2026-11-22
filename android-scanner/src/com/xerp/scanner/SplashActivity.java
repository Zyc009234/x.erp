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
import android.graphics.Typeface;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.view.animation.DecelerateInterpolator;
import android.view.animation.LinearInterpolator;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

public class SplashActivity extends Activity {
    private static final long SPLASH_DURATION_MS = 2000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private ValueAnimator haloAnim;
    private ValueAnimator progAnim;
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
        boolean isDefault = store.isDefaultBrand();

        FrameLayout root = new FrameLayout(this);
        root.addView(new XerpBackdropView(this), new FrameLayout.LayoutParams(-1, -1));

        LinearLayout layout = Ui.col(this);
        layout.setGravity(Gravity.CENTER_HORIZONTAL);
        root.addView(layout, new FrameLayout.LayoutParams(-1, -1));

        layout.addView(new View(this), new LinearLayout.LayoutParams(-1, 0, 1.0f));

        // Center Showcase
        LinearLayout center = Ui.col(this);
        center.setGravity(Gravity.CENTER_HORIZONTAL);
        center.setPadding(Ui.dp(this, 24), 0, Ui.dp(this, 24), 0);

        // Pulsing halo + logo stack
        int haloBox = Ui.dp(this, 176);
        int logoSize = Ui.dp(this, 122);
        FrameLayout logoStack = new FrameLayout(this);
        HaloPulseView halo = new HaloPulseView(this);
        logoStack.addView(halo, new FrameLayout.LayoutParams(-1, -1));

        BrandLogoView logo = new BrandLogoView(this, store);
        logo.setElevation(Ui.dp(this, 12));
        logo.setScaleX(0.84f);
        logo.setScaleY(0.84f);
        logo.setAlpha(0f);
        logoStack.addView(logo, new FrameLayout.LayoutParams(logoSize, logoSize, Gravity.CENTER));
        center.addView(logoStack, new LinearLayout.LayoutParams(haloBox, haloBox));

        LinearLayout textGroup = Ui.col(this);
        textGroup.setGravity(Gravity.CENTER_HORIZONTAL);
        textGroup.setAlpha(0f);
        textGroup.setTranslationY(Ui.dp(this, 14));

        if (isDefault) {
            LinearLayout wordRow = Ui.row(this);
            wordRow.setGravity(Gravity.CENTER);
            SpannableString wm = new SpannableString("x.erp");
            wm.setSpan(new ForegroundColorSpan(0xFF059669), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            wm.setSpan(new ForegroundColorSpan(0xFF0EA5E9), 1, 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            wm.setSpan(new ForegroundColorSpan(0xFF0F172A), 2, 5, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            TextView title = new TextView(this);
            title.setText(wm);
            title.setTextSize(38);
            title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
            title.setLetterSpacing(0.05f);

            TextView edition = Ui.badge(this, "盘点版", Ui.PRIMARY_SOFT, Ui.PRIMARY);
            edition.setTextSize(12);
            edition.setPadding(Ui.dp(this, 9), Ui.dp(this, 4), Ui.dp(this, 9), Ui.dp(this, 4));
            wordRow.addView(title);
            wordRow.addView(Ui.space(this, 8, 1));
            wordRow.addView(edition);
            LinearLayout.LayoutParams wrlp = new LinearLayout.LayoutParams(-2, -2);
            wrlp.topMargin = Ui.dp(this, 10);
            textGroup.addView(wordRow, wrlp);
        } else {
            TextView title = Ui.tv(this, store.effectiveSplashTitle(), 26, 0xFF0F172A, true);
            title.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(-2, -2);
            tlp.topMargin = Ui.dp(this, 10);
            textGroup.addView(title, tlp);

            TextView badge = Ui.badge(this, "企业专属盘点端", Ui.ACCENT_SOFT, Ui.ACCENT);
            badge.setTextSize(11);
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-2, -2);
            blp.topMargin = Ui.dp(this, 8);
            textGroup.addView(badge, blp);
        }

        String subStr = store.splashSubtitle != null && !store.splashSubtitle.trim().isEmpty()
                ? store.splashSubtitle.trim() : AppStore.DEFAULT_SUBTITLE;
        TextView sub = Ui.tv(this, subStr, 13, 0xFF64748B, false);
        sub.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-2, -2);
        slp.topMargin = Ui.dp(this, 8);
        textGroup.addView(sub, slp);

        // 3 Feature Pills Row
        LinearLayout caps = Ui.row(this);
        caps.setGravity(Gravity.CENTER);
        String[] tags = {"扫码盘点", "极速录新", "条码打印"};
        for (int i = 0; i < tags.length; i++) {
            TextView chip = Ui.tv(this, tags[i], 11, 0xFF475569, true);
            chip.setBackground(Ui.outlined(this, Color.WHITE, 0xFFE2E8F0, 1, 12));
            chip.setPadding(Ui.dp(this, 10), Ui.dp(this, 4), Ui.dp(this, 10), Ui.dp(this, 4));
            caps.addView(chip);
            if (i < tags.length - 1) caps.addView(Ui.space(this, 8, 1));
        }
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(-2, -2);
        clp.topMargin = Ui.dp(this, 18);
        textGroup.addView(caps, clp);

        center.addView(textGroup, new LinearLayout.LayoutParams(-1, -2));
        layout.addView(center, new LinearLayout.LayoutParams(-1, -2));

        layout.addView(new View(this), new LinearLayout.LayoutParams(-1, 0, 1.1f));

        // Bottom 2-second Progress & Version Footer
        LinearLayout bottom = Ui.col(this);
        bottom.setGravity(Gravity.CENTER_HORIZONTAL);
        bottom.setPadding(Ui.dp(this, 24), 0, Ui.dp(this, 24), Ui.dp(this, 26));

        GradientProgressView bar = new GradientProgressView(this);
        bottom.addView(bar, new LinearLayout.LayoutParams(Ui.dp(this, 180), Ui.dp(this, 4)));

        String hintText = previewMode ? "启动页预览 · 轻触返回"
                : (loggedIn ? "正在进入工作台…" : "正在启动 x.erp…");
        TextView hint = Ui.tv(this, hintText, 12, 0xFF64748B, false);
        LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(-2, -2);
        hlp.topMargin = Ui.dp(this, 10);
        bottom.addView(hint, hlp);

        String ver = "";
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            ver = pi.versionName;
        } catch (Exception ignored) { }
        TextView powered = Ui.tv(this, "x.erp" + (ver.isEmpty() ? "" : " · v" + ver), 11, 0xFF94A3B8, false);
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(-2, -2);
        flp.topMargin = Ui.dp(this, 6);
        bottom.addView(powered, flp);

        layout.addView(bottom, new LinearLayout.LayoutParams(-1, -2));

        setContentView(root);
        Ui.applyEdgeToEdge(this, root);

        // Entrance animations
        logo.animate()
                .alpha(1f).scaleX(1f).scaleY(1f)
                .setDuration(420)
                .setInterpolator(new DecelerateInterpolator())
                .start();
        textGroup.animate()
                .alpha(1f).translationY(0f)
                .setStartDelay(140)
                .setDuration(420)
                .setInterpolator(new DecelerateInterpolator())
                .start();

        haloAnim = ValueAnimator.ofFloat(0f, 1f);
        haloAnim.setDuration(1800L);
        haloAnim.setRepeatCount(ValueAnimator.INFINITE);
        haloAnim.setInterpolator(new LinearInterpolator());
        haloAnim.addUpdateListener(a -> halo.setPhase((float) a.getAnimatedValue()));
        haloAnim.start();

        progAnim = ValueAnimator.ofFloat(0f, 1f);
        progAnim.setDuration(SPLASH_DURATION_MS);
        progAnim.setInterpolator(new DecelerateInterpolator());
        progAnim.addUpdateListener(a -> bar.setProgress((float) a.getAnimatedValue()));
        progAnim.start();

        root.setOnClickListener(v -> {
            if (previewMode || System.currentTimeMillis() - createdAt >= 450) proceed(loggedIn);
        });

        handler.postDelayed(() -> proceed(loggedIn), SPLASH_DURATION_MS);
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
        if (haloAnim != null) haloAnim.cancel();
        if (progAnim != null) progAnim.cancel();
        super.onDestroy();
    }

    private static final class XerpBackdropView extends View {
        private final Paint bg = new Paint();
        private final Paint grid = new Paint();
        private final Paint orb1 = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint orb2 = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint decoBar = new Paint();
        private final float step;

        XerpBackdropView(Context ctx) {
            super(ctx);
            step = Ui.dp(ctx, 36);
            grid.setColor(0x09059669);
            grid.setStrokeWidth(1f);
            decoBar.setColor(0x0A0F172A);
        }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;

            bg.setShader(new LinearGradient(0, 0, 0, h,
                    new int[]{Color.WHITE, 0xFFF4FDF9, 0xFFECFDF5}, null, Shader.TileMode.CLAMP));
            c.drawRect(0, 0, w, h, bg);

            // Subtle engineering grid
            for (float x = step; x < w; x += step) c.drawLine(x, 0, x, h, grid);
            for (float y = step; y < h; y += step) c.drawLine(0, y, w, y, grid);

            // Soft radial glow orbs
            float r1 = w * 0.65f;
            orb1.setShader(new RadialGradient(w * 0.85f, h * 0.14f, r1, 0x2010B981, 0x0010B981, Shader.TileMode.CLAMP));
            c.drawCircle(w * 0.85f, h * 0.14f, r1, orb1);

            float r2 = w * 0.60f;
            orb2.setShader(new RadialGradient(w * 0.12f, h * 0.82f, r2, 0x1A0EA5E9, 0x000EA5E9, Shader.TileMode.CLAMP));
            c.drawCircle(w * 0.12f, h * 0.82f, r2, orb2);

            // Subtle bottom horizon barcode accent
            float bw = w * 0.50f, startX = (w - bw) / 2f;
            float topY = h - step * 0.55f;
            float[] pos = {0.0f, 0.08f, 0.17f, 0.24f, 0.35f, 0.44f, 0.54f, 0.63f, 0.72f, 0.83f, 0.92f};
            float[] widths = {0.04f, 0.03f, 0.05f, 0.02f, 0.05f, 0.03f, 0.04f, 0.02f, 0.05f, 0.03f, 0.06f};
            for (int i = 0; i < pos.length; i++) {
                float x = startX + bw * pos[i];
                c.drawRect(x, topY, x + bw * widths[i], h, decoBar);
            }
        }
    }

    private static final class HaloPulseView extends View {
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private float phase = 0f;

        HaloPulseView(Context ctx) {
            super(ctx);
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeWidth(Ui.dp(ctx, 2));
        }

        void setPhase(float p) {
            this.phase = p;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            float cx = getWidth() / 2f, cy = getHeight() / 2f;
            float baseR = Math.min(cx, cy) * 0.70f;
            float span = Math.min(cx, cy) * 0.28f;
            for (int k = 0; k < 2; k++) {
                float t = (phase + k * 0.5f) % 1.0f;
                int alpha = Math.round((1f - t) * 70);
                ring.setColor(Color.argb(alpha, 5, 150, 105));
                c.drawCircle(cx, cy, baseR + span * t, ring);
            }
        }
    }

    private static final class GradientProgressView extends View {
        private final Paint track = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint bar = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF r = new RectF();
        private float progress = 0f;

        GradientProgressView(Context ctx) {
            super(ctx);
            track.setColor(0xFFE2E8F0);
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
                float fillW = Math.max(h, w * progress);
                bar.setShader(new LinearGradient(0, 0, w, 0, 0xFF059669, 0xFF0EA5E9, Shader.TileMode.CLAMP));
                r.set(0, 0, fillW, h);
                c.drawRoundRect(r, rad, rad, bar);
            }
        }
    }
}
