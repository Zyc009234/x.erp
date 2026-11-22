package com.xerp.scanner;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.view.View;

/**
 * Pure Canvas 24x24 vector icon component (zero bitmap/external dependencies).
 */
public class IconView extends View {
    public enum Type {
        CHECK_LIST,
        SWAP,
        SEARCH_BAR,
        TAG,
        SETTINGS,
        SCAN,
        KEYBOARD,
        SYNC,
        WAREHOUSE,
        EYE_OFF,
        EYE,
        VOLUME_ON,
        VOLUME_OFF,
        EMPTY_BOX,
        BRAND,
        PLUS
    }

    private Type type;
    private int color;
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final RectF rect = new RectF();

    public IconView(Context ctx, Type type, int color) {
        super(ctx);
        this.type = type;
        this.color = color;
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeWidth(1.9f);
        stroke.setStrokeCap(Paint.Cap.ROUND);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        fill.setStyle(Paint.Style.FILL);
    }

    public void setIcon(Type type, int color) {
        if (this.type == type && this.color == color) return;
        this.type = type;
        this.color = color;
        invalidate();
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        int def = Ui.dp(getContext(), 20);
        int w = resolveSize(def, widthMeasureSpec);
        int h = resolveSize(def, heightMeasureSpec);
        setMeasuredDimension(w, h);
    }

    @Override
    protected void onDraw(Canvas c) {
        int size = Math.min(getWidth(), getHeight());
        if (size <= 0 || type == null) return;

        int save = c.save();
        float ox = (getWidth() - size) / 2f;
        float oy = (getHeight() - size) / 2f;
        c.translate(ox, oy);
        float scale = size / 24f;
        c.scale(scale, scale);

        stroke.setColor(color);
        fill.setColor(color);
        stroke.setStrokeWidth(1.9f);

        switch (type) {
            case CHECK_LIST:
                rect.set(4.5f, 4f, 19.5f, 20f);
                c.drawRoundRect(rect, 2.5f, 2.5f, stroke);
                path.reset();
                path.moveTo(8f, 9.5f);
                path.lineTo(9.8f, 11.2f);
                path.lineTo(13f, 8f);
                c.drawPath(path, stroke);
                c.drawLine(15f, 9.5f, 17f, 9.5f, stroke);
                path.reset();
                path.moveTo(8f, 15.2f);
                path.lineTo(9.8f, 16.9f);
                path.lineTo(13f, 13.7f);
                c.drawPath(path, stroke);
                c.drawLine(15f, 15.2f, 17f, 15.2f, stroke);
                break;

            case SWAP:
                c.drawLine(5f, 8.5f, 19f, 8.5f, stroke);
                path.reset();
                path.moveTo(15.2f, 4.8f);
                path.lineTo(19f, 8.5f);
                path.lineTo(15.2f, 12.2f);
                c.drawPath(path, stroke);
                c.drawLine(19f, 15.5f, 5f, 15.5f, stroke);
                path.reset();
                path.moveTo(8.8f, 11.8f);
                path.lineTo(5f, 15.5f);
                path.lineTo(8.8f, 19.2f);
                c.drawPath(path, stroke);
                break;

            case SEARCH_BAR:
                c.drawCircle(10.5f, 10.5f, 5.8f, stroke);
                c.drawLine(14.8f, 14.8f, 19.8f, 19.8f, stroke);
                stroke.setStrokeWidth(1.5f);
                c.drawLine(8.2f, 8.8f, 8.2f, 12.2f, stroke);
                c.drawLine(10.5f, 8.3f, 10.5f, 12.2f, stroke);
                c.drawLine(12.8f, 9.3f, 12.8f, 12.2f, stroke);
                break;

            case TAG:
                path.reset();
                path.moveTo(4f, 5.5f);
                path.lineTo(11.5f, 4f);
                path.lineTo(20f, 12.5f);
                path.lineTo(12.5f, 20f);
                path.lineTo(4f, 11.5f);
                path.close();
                c.drawPath(path, stroke);
                c.drawCircle(8.6f, 8.6f, 1.3f, fill);
                break;

            case SETTINGS:
                c.drawCircle(12f, 12f, 3.2f, stroke);
                rect.set(5.6f, 5.6f, 18.4f, 18.4f);
                c.drawCircle(12f, 12f, 6.6f, stroke);
                for (int i = 0; i < 6; i++) {
                    double a = Math.PI / 3.0 * i;
                    float x1 = 12f + (float) Math.cos(a) * 6.8f;
                    float y1 = 12f + (float) Math.sin(a) * 6.8f;
                    float x2 = 12f + (float) Math.cos(a) * 9.5f;
                    float y2 = 12f + (float) Math.sin(a) * 9.5f;
                    c.drawLine(x1, y1, x2, y2, stroke);
                }
                break;

            case SCAN:
                path.reset();
                path.moveTo(4f, 8.5f); path.lineTo(4f, 4.5f); path.lineTo(8.5f, 4.5f);
                path.moveTo(15.5f, 4.5f); path.lineTo(20f, 4.5f); path.lineTo(20f, 8.5f);
                path.moveTo(4f, 15.5f); path.lineTo(4f, 19.5f); path.lineTo(8.5f, 19.5f);
                path.moveTo(15.5f, 19.5f); path.lineTo(20f, 19.5f); path.lineTo(20f, 15.5f);
                c.drawPath(path, stroke);
                c.drawLine(5.5f, 12f, 18.5f, 12f, stroke);
                break;

            case KEYBOARD:
                rect.set(3f, 5f, 21f, 19f);
                c.drawRoundRect(rect, 2.5f, 2.5f, stroke);
                float[] xs = {7f, 12f, 17f};
                for (float x : xs) {
                    c.drawCircle(x, 9.2f, 1.0f, fill);
                    c.drawCircle(x, 12.4f, 1.0f, fill);
                }
                c.drawLine(8f, 15.8f, 16f, 15.8f, stroke);
                break;

            case SYNC:
                rect.set(5f, 5f, 19f, 19f);
                path.reset();
                path.addArc(rect, -35f, 150f);
                c.drawPath(path, stroke);
                path.reset();
                path.addArc(rect, 145f, 150f);
                c.drawPath(path, stroke);
                path.reset();
                path.moveTo(15.2f, 4.2f); path.lineTo(18.6f, 6.2f); path.lineTo(16.6f, 9.5f);
                c.drawPath(path, stroke);
                path.reset();
                path.moveTo(8.8f, 19.8f); path.lineTo(5.4f, 17.8f); path.lineTo(7.4f, 14.5f);
                c.drawPath(path, stroke);
                break;

            case WAREHOUSE:
                path.reset();
                path.moveTo(3f, 9.8f);
                path.lineTo(12f, 4f);
                path.lineTo(21f, 9.8f);
                c.drawPath(path, stroke);
                path.reset();
                path.moveTo(5.2f, 8.8f);
                path.lineTo(5.2f, 19.5f);
                path.lineTo(18.8f, 19.5f);
                path.lineTo(18.8f, 8.8f);
                c.drawPath(path, stroke);
                rect.set(9f, 13.5f, 15f, 19.5f);
                c.drawRect(rect, stroke);
                c.drawLine(12f, 13.5f, 12f, 19.5f, stroke);
                break;

            case EYE_OFF:
                drawEyeContour(c);
                c.drawLine(4.5f, 19.5f, 19.5f, 4.5f, stroke);
                break;

            case EYE:
                drawEyeContour(c);
                c.drawCircle(12f, 12f, 2.8f, stroke);
                break;

            case VOLUME_ON:
                drawSpeakerBody(c);
                rect.set(12.2f, 7.8f, 18.2f, 16.2f);
                c.drawArc(rect, -52f, 104f, false, stroke);
                rect.set(14.8f, 5.2f, 21.5f, 18.8f);
                c.drawArc(rect, -55f, 110f, false, stroke);
                break;

            case VOLUME_OFF:
                drawSpeakerBody(c);
                c.drawLine(15.5f, 9.2f, 20.5f, 14.2f, stroke);
                c.drawLine(20.5f, 9.2f, 15.5f, 14.2f, stroke);
                break;

            case EMPTY_BOX:
                rect.set(4.5f, 8f, 19.5f, 19.5f);
                c.drawRoundRect(rect, 2f, 2f, stroke);
                path.reset();
                path.moveTo(4.5f, 8.5f);
                path.lineTo(7.5f, 4.5f);
                path.lineTo(16.5f, 4.5f);
                path.lineTo(19.5f, 8.5f);
                c.drawPath(path, stroke);
                c.drawLine(12f, 4.5f, 12f, 8.5f, stroke);
                c.drawLine(9f, 13.2f, 15f, 13.2f, stroke);
                break;

            case BRAND:
                rect.set(4.5f, 4.5f, 19.5f, 19.5f);
                c.drawRoundRect(rect, 4f, 4f, stroke);
                path.reset();
                path.moveTo(12f, 7.6f);
                path.lineTo(13.4f, 10.6f);
                path.lineTo(16.4f, 12f);
                path.lineTo(13.4f, 13.4f);
                path.lineTo(12f, 16.4f);
                path.lineTo(10.6f, 13.4f);
                path.lineTo(7.6f, 12f);
                path.lineTo(10.6f, 10.6f);
                path.close();
                c.drawPath(path, stroke);
                break;

            case PLUS:
                c.drawLine(12f, 5f, 12f, 19f, stroke);
                c.drawLine(5f, 12f, 19f, 12f, stroke);
                break;
        }
        c.restoreToCount(save);
    }

    private void drawEyeContour(Canvas c) {
        path.reset();
        path.moveTo(3f, 12f);
        path.quadTo(12f, 4.5f, 21f, 12f);
        path.quadTo(12f, 19.5f, 3f, 12f);
        c.drawPath(path, stroke);
    }

    private void drawSpeakerBody(Canvas c) {
        path.reset();
        path.moveTo(4f, 9.5f);
        path.lineTo(7.6f, 9.5f);
        path.lineTo(12.2f, 5.5f);
        path.lineTo(12.2f, 18.5f);
        path.lineTo(7.6f, 14.5f);
        path.lineTo(4f, 14.5f);
        path.close();
        c.drawPath(path, stroke);
    }
}
