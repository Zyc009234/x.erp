package com.xerp.scanner;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.View;

public class BrandLogoView extends View {
    private final AppStore store;
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint barPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint xPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glowPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint laserPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint bmpPaint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    private final RectF cardRect = new RectF();
    private final RectF dstRect = new RectF();
    private final Path clipPath = new Path();

    public BrandLogoView(Context ctx, AppStore store) {
        super(ctx);
        this.store = store;

        stroke.setStyle(Paint.Style.STROKE);
        barPaint.setColor(Color.WHITE);
        barPaint.setStyle(Paint.Style.FILL);

        xPaint.setColor(Color.WHITE);
        xPaint.setStyle(Paint.Style.STROKE);
        xPaint.setStrokeCap(Paint.Cap.ROUND);

        glowPaint.setColor(0x5FFACC15);
        glowPaint.setStyle(Paint.Style.STROKE);
        glowPaint.setStrokeCap(Paint.Cap.ROUND);

        laserPaint.setColor(0xFFFACC15);
        laserPaint.setStyle(Paint.Style.STROKE);
        laserPaint.setStrokeCap(Paint.Cap.ROUND);
    }

    public void reload() {
        invalidate();
    }

    @Override
    protected void onDraw(Canvas c) {
        int size = Math.min(getWidth(), getHeight());
        if (size <= 0) return;
        float ox = (getWidth() - size) / 2f;
        float oy = (getHeight() - size) / 2f;
        float rad = size * 0.24f;
        cardRect.set(ox, oy, ox + size, oy + size);

        Bitmap custom = store != null ? store.getCustomLogo() : null;
        if (custom != null && !custom.isRecycled()) {
            fill.setShader(null);
            fill.setColor(Color.WHITE);
            c.drawRoundRect(cardRect, rad, rad, fill);

            stroke.setColor(0xFFE2E8F0);
            stroke.setStrokeWidth(Math.max(1f, size * 0.02f));
            c.drawRoundRect(cardRect, rad, rad, stroke);

            clipPath.reset();
            clipPath.addRoundRect(cardRect, rad, rad, Path.Direction.CW);
            int save = c.save();
            c.clipPath(clipPath);
            float pad = size * 0.10f;
            float avail = size - 2f * pad;
            float scale = Math.min(avail / custom.getWidth(), avail / custom.getHeight());
            float dw = custom.getWidth() * scale;
            float dh = custom.getHeight() * scale;
            float dx = ox + (size - dw) / 2f;
            float dy = oy + (size - dh) / 2f;
            dstRect.set(dx, dy, dx + dw, dy + dh);
            c.drawBitmap(custom, null, dstRect, bmpPaint);
            c.restoreToCount(save);
            return;
        }

        // Default x.erp brand emblem: emerald-cyan gradient squircle + viewfinder brackets + geometric X + barcode + gold laser
        fill.setShader(new LinearGradient(ox, oy, ox + size, oy + size,
                new int[]{0xFF047857, 0xFF0D9488, 0xFF0EA5E9}, null, Shader.TileMode.CLAMP));
        c.drawRoundRect(cardRect, rad, rad, fill);
        fill.setShader(null);

        stroke.setColor(0x40FFFFFF);
        stroke.setStrokeWidth(Math.max(1f, size * 0.02f));
        c.drawRoundRect(cardRect, rad, rad, stroke);

        // Corner brackets
        stroke.setColor(0xDCFFFFFF);
        stroke.setStrokeCap(Paint.Cap.ROUND);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        stroke.setStrokeWidth(Math.max(1.5f, size * 0.042f));
        float bl = ox + size * 0.19f, br = ox + size * 0.81f;
        float bt = oy + size * 0.19f, bb = oy + size * 0.81f;
        float bk = size * 0.13f;
        drawBracket(c, bl, bt + bk, bl, bt, bl + bk, bt);
        drawBracket(c, br - bk, bt, br, bt, br, bt + bk);
        drawBracket(c, bl, bb - bk, bl, bb, bl + bk, bb);
        drawBracket(c, br - bk, bb, br, bb, br, bb - bk);
        stroke.setStrokeCap(Paint.Cap.BUTT);

        // Bold geometric white X
        float cx = ox + size * 0.50f, xr = size * 0.125f, xt = oy + size * 0.25f, xb = oy + size * 0.47f;
        xPaint.setStrokeWidth(Math.max(2f, size * 0.070f));
        c.drawLine(cx - xr, xt, cx + xr, xb, xPaint);
        c.drawLine(cx + xr, xt, cx - xr, xb, xPaint);

        // Minimalist barcode bars
        float bx = ox + size * 0.27f, bw = size * 0.46f, by = oy + size * 0.56f, bh = size * 0.20f;
        float[] bars = {0.0f, 0.15f, 0.29f, 0.45f, 0.58f, 0.74f, 0.89f};
        float[] ws = {0.08f, 0.06f, 0.10f, 0.05f, 0.10f, 0.06f, 0.09f};
        float barR = Math.max(1f, size * 0.012f);
        for (int i = 0; i < bars.length; i++) {
            float l = bx + bw * bars[i];
            c.drawRoundRect(l, by, l + bw * ws[i], by + bh, barR, barR, barPaint);
        }

        // Gold scan beam
        float midY = oy + size * 0.52f;
        glowPaint.setStrokeWidth(Math.max(3f, size * 0.085f));
        c.drawLine(ox + size * 0.15f, midY, ox + size * 0.85f, midY, glowPaint);
        laserPaint.setStrokeWidth(Math.max(1.5f, size * 0.036f));
        c.drawLine(ox + size * 0.15f, midY, ox + size * 0.85f, midY, laserPaint);
    }

    private void drawBracket(Canvas c, float x1, float y1, float x2, float y2, float x3, float y3) {
        clipPath.reset();
        clipPath.moveTo(x1, y1);
        clipPath.lineTo(x2, y2);
        clipPath.lineTo(x3, y3);
        c.drawPath(clipPath, stroke);
    }
}
