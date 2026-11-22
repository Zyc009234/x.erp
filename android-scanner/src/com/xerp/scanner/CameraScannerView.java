package com.xerp.scanner;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ImageFormat;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.YuvImage;
import android.hardware.Camera;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.util.Base64;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.io.ByteArrayOutputStream;
import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

@SuppressWarnings("deprecation")
public class CameraScannerView extends FrameLayout implements SurfaceHolder.Callback, Camera.PreviewCallback {
    public interface Listener {
        void onBarcodeScanned(String code);
    }

    public interface SnapshotCallback {
        void onSnapshot(String dataUri, Bitmap preview, String error);
    }

    private final Activity activity;
    private final AppStore store;
    private final SurfaceView surface;
    private final ScanOverlay overlay;
    private final TextView torchBtn, zoomBtn, pauseBtn, resumeCover;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final MultiFormatReader reader = new MultiFormatReader();

    private Camera camera;
    private int cameraOrientation = 90;
    private HandlerThread worker;
    private Handler decoder;
    private Listener listener;
    private volatile boolean busy, paused, wantedActive;
    private boolean torchOn, zoom2x;
    private int frameIndex;
    private String lastCode;
    private long absentSince = -1;
    private long lastFireAt = 0;
    private SnapshotCallback pendingSnapshot;

    public CameraScannerView(Activity act, AppStore store) {
        super(act);
        this.activity = act;
        this.store = store;
        setBackgroundColor(Color.BLACK);

        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(
                BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
                BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF,
                BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX
        ));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        reader.setHints(hints);

        surface = new SurfaceView(act);
        addView(surface, new LayoutParams(-1, -1));
        surface.getHolder().addCallback(this);

        overlay = new ScanOverlay(act);
        addView(overlay, new LayoutParams(-1, -1));

        // Top floating camera controls
        LinearLayout topBar = Ui.row(act);
        topBar.setPadding(Ui.dp(act, 8), Ui.dp(act, 6), Ui.dp(act, 8), Ui.dp(act, 6));
        torchBtn = pill("手电");
        torchBtn.setOnClickListener(v -> toggleTorch());
        zoomBtn = pill("1x");
        zoomBtn.setOnClickListener(v -> toggleZoom());
        pauseBtn = pill("暂停");
        pauseBtn.setOnClickListener(v -> setUserPaused(!paused));

        topBar.addView(torchBtn);
        topBar.addView(Ui.space(act, 6, 1));
        topBar.addView(zoomBtn);
        topBar.addView(Ui.space(act, 6, 1));
        topBar.addView(pauseBtn);
        addView(topBar, new LayoutParams(-2, -2, Gravity.TOP | Gravity.END));

        // Resume cover for paused / single-scan mode
        resumeCover = Ui.tv(act, "点击画面继续扫码", 16, Color.WHITE, true);
        resumeCover.setGravity(Gravity.CENTER);
        resumeCover.setBackgroundColor(0x99000000);
        resumeCover.setVisibility(View.GONE);
        resumeCover.setOnClickListener(v -> setUserPaused(false));
        addView(resumeCover, new LayoutParams(-1, -1));

        surface.setOnTouchListener((v, ev) -> {
            if (ev.getAction() == MotionEvent.ACTION_UP && !paused) triggerFocus();
            return true;
        });
    }

    private TextView pill(String label) {
        TextView t = Ui.tv(activity, label, 12, Color.WHITE, true);
        t.setBackground(Ui.rounded(activity, 0x88000000, 14));
        t.setPadding(Ui.dp(activity, 10), Ui.dp(activity, 5), Ui.dp(activity, 10), Ui.dp(activity, 5));
        return t;
    }

    public void setListener(Listener l) {
        this.listener = l;
    }

    public void startCamera() {
        wantedActive = true;
        if (worker == null) {
            worker = new HandlerThread("scanner-decode");
            worker.start();
            decoder = new Handler(worker.getLooper());
        }
        if (activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            if (surface.getHolder().getSurface().isValid()) openCamera(surface.getHolder());
        }
    }

    public void stopCamera() {
        wantedActive = false;
        closeCamera();
        if (worker != null) {
            worker.quitSafely();
            worker = null;
            decoder = null;
        }
    }

    public void setUserPaused(boolean p) {
        paused = p;
        pauseBtn.setText(p ? "恢复" : "暂停");
        pauseBtn.setBackground(Ui.rounded(activity, p ? Ui.PRIMARY : 0x88000000, 14));
        resumeCover.setVisibility(p ? View.VISIBLE : View.GONE);
        if (!p) {
            lastCode = null;
            absentSince = -1;
        }
    }

    public void resumeIfSingleModeDone() {
        if (!store.continuousScan) setUserPaused(false);
    }

    public void flashStatus(int color) {
        main.post(() -> overlay.flash(color));
    }

    public void captureSnapshot(SnapshotCallback cb) {
        if (camera == null) {
            cb.onSnapshot(null, null, "相机未打开");
            return;
        }
        pendingSnapshot = cb;
    }

    private void triggerFocus() {
        if (camera == null) return;
        try {
            camera.autoFocus((ok, c) -> { });
        } catch (Exception ignored) { }
    }

    private void toggleTorch() {
        if (camera == null) return;
        try {
            Camera.Parameters p = camera.getParameters();
            List<String> modes = p.getSupportedFlashModes();
            if (modes == null || !modes.contains(Camera.Parameters.FLASH_MODE_TORCH)) {
                Ui.toast(activity, "当前设备不支持手电筒");
                return;
            }
            torchOn = !torchOn;
            p.setFlashMode(torchOn ? Camera.Parameters.FLASH_MODE_TORCH : Camera.Parameters.FLASH_MODE_OFF);
            camera.setParameters(p);
            torchBtn.setBackground(Ui.rounded(activity, torchOn ? Ui.WARN : 0x88000000, 14));
        } catch (Exception ignored) { }
    }

    private void toggleZoom() {
        if (camera == null) return;
        try {
            Camera.Parameters p = camera.getParameters();
            if (!p.isZoomSupported()) {
                Ui.toast(activity, "当前设备不支持变焦");
                return;
            }
            zoom2x = !zoom2x;
            int max = p.getMaxZoom();
            int target = zoom2x ? Math.min(max, Math.max(1, max / 3)) : 0;
            p.setZoom(target);
            camera.setParameters(p);
            zoomBtn.setText(zoom2x ? "2x" : "1x");
            zoomBtn.setBackground(Ui.rounded(activity, zoom2x ? Ui.ACCENT : 0x88000000, 14));
        } catch (Exception ignored) { }
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        if (wantedActive && activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            openCamera(holder);
        }
    }

    @Override public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) { }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        closeCamera();
    }

    private void openCamera(SurfaceHolder holder) {
        if (camera != null || getVisibility() != View.VISIBLE) return;
        try {
            int id = 0;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
                Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { id = i; break; }
            }
            Camera.getCameraInfo(id, info);
            camera = Camera.open(id);
            int rot = activity.getWindowManager().getDefaultDisplay().getRotation();
            int deg = rot == Surface.ROTATION_90 ? 90 : rot == Surface.ROTATION_180 ? 180 : rot == Surface.ROTATION_270 ? 270 : 0;
            cameraOrientation = (info.orientation - deg + 360) % 360;
            camera.setDisplayOrientation(cameraOrientation);

            Camera.Parameters p = camera.getParameters();
            Camera.Size best = null;
            for (Camera.Size s : p.getSupportedPreviewSizes()) {
                if (best == null || Math.abs(s.width * s.height - 1280 * 720) < Math.abs(best.width * best.height - 1280 * 720)) {
                    best = s;
                }
            }
            if (best != null) p.setPreviewSize(best.width, best.height);
            List<String> fm = p.getSupportedFocusModes();
            if (fm != null) {
                if (fm.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
                    p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
                } else if (fm.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                    p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
                }
            }
            camera.setParameters(p);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
            if (fm != null && !fm.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE) && fm.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
                autoFocusLoop();
            }
        } catch (Exception e) {
            closeCamera();
        }
    }

    private void autoFocusLoop() {
        if (camera == null || !wantedActive) return;
        try {
            camera.autoFocus((ok, c) -> main.postDelayed(this::autoFocusLoop, 1800));
        } catch (Exception ignored) { }
    }

    private void closeCamera() {
        if (camera == null) return;
        try { camera.setPreviewCallback(null); camera.stopPreview(); } catch (Exception ignored) { }
        try { camera.release(); } catch (Exception ignored) { }
        camera = null;
        torchOn = false;
        zoom2x = false;
        torchBtn.setBackground(Ui.rounded(activity, 0x88000000, 14));
        zoomBtn.setText("1x");
        zoomBtn.setBackground(Ui.rounded(activity, 0x88000000, 14));
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (cam != camera) return;
        Camera.Size size;
        try { size = cam.getParameters().getPreviewSize(); } catch (Exception e) { return; }

        SnapshotCallback snap = pendingSnapshot;
        if (snap != null) {
            pendingSnapshot = null;
            byte[] copy = Arrays.copyOf(data, data.length);
            int sw = size.width, sh = size.height, orient = cameraOrientation;
            new Thread(() -> processSnapshot(copy, sw, sh, orient, snap)).start();
            return;
        }

        if (paused || busy || decoder == null) return;
        busy = true;
        final int w = size.width, h = size.height, n = frameIndex++;
        decoder.post(() -> {
            try {
                String code = (n % 2 == 0) ? decode(rotate(data, w, h), h, w) : decode(data, w, h);
                if (code == null) {
                    code = (n % 2 == 0) ? decode(data, w, h) : decode(rotate(data, w, h), h, w);
                }
                final String detected = code;
                final long observedAt = SystemClock.elapsedRealtime();
                main.post(() -> handleFrame(detected, observedAt));
            } finally {
                busy = false;
            }
        });
    }

    private void processSnapshot(byte[] nv21, int w, int h, int orient, SnapshotCallback cb) {
        try {
            YuvImage yuv = new YuvImage(nv21, ImageFormat.NV21, w, h, null);
            ByteArrayOutputStream raw = new ByteArrayOutputStream();
            yuv.compressToJpeg(new Rect(0, 0, w, h), 90, raw);
            byte[] jpeg = raw.toByteArray();
            Bitmap bmp = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
            if (orient != 0) {
                Matrix m = new Matrix();
                m.postRotate(orient);
                Bitmap rot = Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
                bmp.recycle();
                bmp = rot;
            }
            String uri = encodeBitmapToDataUri(bmp);
            final Bitmap finalBmp = bmp;
            main.post(() -> cb.onSnapshot(uri, finalBmp, null));
        } catch (Exception e) {
            main.post(() -> cb.onSnapshot(null, null, "拍照失败：" + e.getMessage()));
        }
    }

    public static String encodeBitmapToDataUri(Bitmap src) throws Exception {
        Bitmap scaled = src;
        int maxDim = 900;
        if (src.getWidth() > maxDim || src.getHeight() > maxDim) {
            float ratio = Math.min((float) maxDim / src.getWidth(), (float) maxDim / src.getHeight());
            int nw = Math.max(1, Math.round(src.getWidth() * ratio));
            int nh = Math.max(1, Math.round(src.getHeight() * ratio));
            scaled = Bitmap.createScaledBitmap(src, nw, nh, true);
        }
        int quality = 85;
        byte[] out;
        do {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            scaled.compress(Bitmap.CompressFormat.JPEG, quality, bos);
            out = bos.toByteArray();
            quality -= 10;
        } while (out.length > 350 * 1024 && quality >= 35);
        if (scaled != src) scaled.recycle();
        return "data:image/jpeg;base64," + Base64.encodeToString(out, Base64.NO_WRAP);
    }

    private void handleFrame(String code, long now) {
        if (paused) return;
        if (code == null) {
            if (absentSince < 0) absentSince = now;
            if (now - absentSince >= store.cooldownMs) lastCode = null;
            return;
        }
        absentSince = -1;
        if (code.equals(lastCode) && now - lastFireAt < Math.max(800, store.cooldownMs)) return;
        if (code.equals(lastCode)) return;
        lastCode = code;
        lastFireAt = now;
        if (!store.continuousScan) setUserPaused(true);
        if (listener != null) listener.onBarcodeScanned(code);
    }

    private String decode(byte[] y, int w, int h) {
        int cw = w * 8 / 10, ch = h * 6 / 10;
        try {
            PlanarYUVLuminanceSource src = new PlanarYUVLuminanceSource(y, w, h, (w - cw) / 2, (h - ch) / 2, cw, ch, false);
            Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(src)));
            return r.getText();
        } catch (Exception e) {
            return null;
        } finally {
            reader.reset();
        }
    }

    private static byte[] rotate(byte[] d, int w, int h) {
        byte[] out = new byte[w * h];
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                out[x * h + h - 1 - y] = d[y * w + x];
            }
        }
        return out;
    }

    public void feedbackOk() {
        flashStatus(Ui.PRIMARY);
        signal(ToneGenerator.TONE_PROP_BEEP, 80, 50);
    }

    public void feedbackUnknown() {
        flashStatus(Ui.WARN);
        signal(ToneGenerator.TONE_PROP_BEEP2, 160, 120);
    }

    public void feedbackError() {
        flashStatus(Ui.DANGER);
        signal(ToneGenerator.TONE_SUP_ERROR, 220, 200);
    }

    private void signal(int tone, int toneMs, int vibMs) {
        if (store.vibrateEnabled) {
            try {
                Vibrator v = (Vibrator) activity.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null && v.hasVibrator()) {
                    if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(vibMs, VibrationEffect.DEFAULT_AMPLITUDE));
                    else v.vibrate(vibMs);
                }
            } catch (Exception ignored) { }
        }
        if (store.soundEnabled) {
            try {
                ToneGenerator tg = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80);
                tg.startTone(tone, toneMs);
                main.postDelayed(tg::release, toneMs + 120);
            } catch (Exception ignored) { }
        }
    }

    private final class ScanOverlay extends View {
        private final Paint mask = new Paint();
        private final Paint box = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint corner = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint laser = new Paint(Paint.ANTI_ALIAS_FLAG);
        private int highlightColor = 0;
        private long highlightUntil = 0;
        private float laserPos = 0.2f;
        private boolean laserDown = true;

        ScanOverlay(Context ctx) {
            super(ctx);
            mask.setColor(0x66000000);
            box.setColor(0x88FFFFFF);
            box.setStyle(Paint.Style.STROKE);
            box.setStrokeWidth(Ui.dp(ctx, 1));
            corner.setColor(Ui.PRIMARY);
            corner.setStyle(Paint.Style.STROKE);
            corner.setStrokeWidth(Ui.dp(ctx, 4));
            laser.setColor(0xCC10B981);
            laser.setStrokeWidth(Ui.dp(ctx, 2));
        }

        void flash(int color) {
            highlightColor = color;
            highlightUntil = SystemClock.uptimeMillis() + 550;
            invalidate();
        }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            float bw = w * 0.78f, bh = h * 0.62f;
            float l = (w - bw) / 2f, t = (h - bh) / 2f, r = l + bw, b = t + bh;
            c.drawRect(0, 0, w, t, mask);
            c.drawRect(0, b, w, h, mask);
            c.drawRect(0, t, l, b, mask);
            c.drawRect(r, t, w, b, mask);

            boolean flashing = SystemClock.uptimeMillis() < highlightUntil;
            corner.setColor(flashing ? highlightColor : Ui.PRIMARY);
            box.setColor(flashing ? highlightColor : 0x66FFFFFF);
            c.drawRoundRect(new RectF(l, t, r, b), 10, 10, box);

            float len = Math.min(bw, bh) * 0.14f;
            c.drawLine(l, t, l + len, t, corner); c.drawLine(l, t, l, t + len, corner);
            c.drawLine(r - len, t, r, t, corner); c.drawLine(r, t, r, t + len, corner);
            c.drawLine(l, b, l + len, b, corner); c.drawLine(l, b - len, l, b, corner);
            c.drawLine(r - len, b, r, b, corner); c.drawLine(r, b - len, r, b, corner);

            if (!paused && wantedActive) {
                float ly = t + bh * laserPos;
                c.drawLine(l + 12, ly, r - 12, ly, laser);
                laserPos += laserDown ? 0.025f : -0.025f;
                if (laserPos >= 0.90f) { laserPos = 0.90f; laserDown = false; }
                else if (laserPos <= 0.10f) { laserPos = 0.10f; laserDown = true; }
                postInvalidateDelayed(35);
            }
        }
    }
}
