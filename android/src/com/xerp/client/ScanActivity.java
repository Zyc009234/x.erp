package com.xerp.client;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.hardware.Camera;
import android.media.AudioManager;
import android.media.ToneGenerator;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.ResultReceiver;
import android.os.SystemClock;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.widget.Switch;
import org.json.JSONException;
import org.json.JSONObject;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.view.Gravity;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.HybridBinarizer;

import java.util.Arrays;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

/**
 * 扫码页：相机预览 + ZXing 解码，支持商品条码（EAN-13/8、UPC、Code 128/39、ITF、Codabar）和二维码。
 * 使用旧版 Camera API（所有安卓版本都可用，代码最少），识别到后震动 + 提示音并返回结果。
 */
@SuppressWarnings("deprecation")
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {
    private static final int REQ_CAM = 10;
    private static final int ACCENT = 0xFF4F46E5;
    private static final long REARM_MS = 700;
    private Camera camera;
    private ResultReceiver inventoryReceiver;
    private String lastCode;
    private long absentSince = -1;
    private boolean awaitingResult;
    private int scanRequest;
    private TextView scanStatus, productName, bookQuantity, actualQuantity;
    private Switch continuous;
    private SurfaceView surface;
    private HandlerThread worker;
    private Handler decoder;
    private volatile boolean busy, done;
    private boolean torch;
    private int frame;
    private final MultiFormatReader reader = new MultiFormatReader();

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        inventoryReceiver = getIntent().getParcelableExtra("inventoryReceiver");
        Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
        hints.put(DecodeHintType.POSSIBLE_FORMATS, Arrays.asList(BarcodeFormat.EAN_13, BarcodeFormat.EAN_8, BarcodeFormat.UPC_A, BarcodeFormat.UPC_E,
                BarcodeFormat.CODE_128, BarcodeFormat.CODE_39, BarcodeFormat.CODE_93, BarcodeFormat.ITF, BarcodeFormat.CODABAR, BarcodeFormat.QR_CODE, BarcodeFormat.DATA_MATRIX));
        hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
        hints.put(DecodeHintType.CHARACTER_SET, "UTF-8");
        reader.setHints(hints);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        surface = new SurfaceView(this);
        root.addView(surface, new FrameLayout.LayoutParams(-1, -1));
        root.addView(new Overlay(this), new FrameLayout.LayoutParams(-1, -1));

        if (inventoryReceiver != null) {
            showInventoryLayout(root);
            surface.getHolder().addCallback(this);
            return;
        }

        TextView tip = new TextView(this);
        tip.setText("把条码 / 二维码放进框内，会自动识别");
        tip.setTextColor(Color.WHITE);
        tip.setTextSize(15);
        tip.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(-1, -2, Gravity.TOP);
        tl.topMargin = dp(90);
        root.addView(tip, tl);

        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER);
        Button light = button("手电筒");
        light.setOnClickListener(v -> toggleTorch());
        Button cancel = button("取消");
        cancel.setOnClickListener(v -> { setResult(RESULT_CANCELED); finish(); });
        bar.addView(light);
        bar.addView(cancel);
        FrameLayout.LayoutParams bl = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        bl.bottomMargin = dp(56);
        root.addView(bar, bl);
        setContentView(root);
        surface.getHolder().addCallback(this);
    }

    private void showInventoryLayout(FrameLayout preview) {
        LinearLayout page = column();
        page.setBackgroundColor(Color.WHITE);
        page.addView(preview, new LinearLayout.LayoutParams(-1, 0, 1));

        LinearLayout top = new LinearLayout(this);
        top.setGravity(Gravity.CENTER_VERTICAL);
        top.setBackgroundColor(0x88000000);
        top.addView(inventoryButton("返回", Color.TRANSPARENT, v -> finish()),
                new LinearLayout.LayoutParams(dp(64), dp(48)));
        TextView title = label("扫码盘点", 19, Color.WHITE, true);
        title.setGravity(Gravity.CENTER);
        top.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        top.addView(inventoryButton("手电筒", Color.TRANSPARENT, v -> toggleTorch()),
                new LinearLayout.LayoutParams(dp(80), dp(48)));
        preview.addView(top, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP));

        TextView tip = label("将条码放入框内", 15, Color.WHITE, false);
        tip.setGravity(Gravity.CENTER);
        FrameLayout.LayoutParams tipLayout = new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM);
        tipLayout.bottomMargin = dp(20);
        preview.addView(tip, tipLayout);

        LinearLayout panel = column();
        panel.setPadding(dp(18), dp(12), dp(18), dp(16));
        page.addView(panel, new LinearLayout.LayoutParams(-1, -2));
        String warehouse = getIntent().getStringExtra("warehouse");

        LinearLayout controls = new LinearLayout(this);
        controls.setGravity(Gravity.CENTER_VERTICAL);
        controls.addView(label(warehouse == null ? "仓库" : warehouse, 16, 0xFF111827, true),
                new LinearLayout.LayoutParams(0, -2, 1));
        continuous = new Switch(this);
        continuous.setText("连续扫码  ");
        continuous.setTextColor(0xFF111827);
        continuous.setChecked(true);
        controls.addView(continuous);
        panel.addView(controls);

        scanStatus = label("等待扫描商品", 14, 0xFF4B5563, false);
        scanStatus.setPadding(0, dp(8), 0, dp(8));
        panel.addView(scanStatus);

        LinearLayout details = new LinearLayout(this);
        details.setGravity(Gravity.CENTER_VERTICAL);
        details.setPadding(dp(12), dp(8), dp(12), dp(8));
        details.setBackground(rounded(0xFFF3F4FA));
        panel.addView(details, new LinearLayout.LayoutParams(-1, -2));

        LinearLayout item = column();
        productName = label("最近扫描商品", 17, 0xFF111827, true);
        productName.setMaxLines(2);
        item.addView(productName);
        bookQuantity = label("账面库存 —", 13, 0xFF4B5563, false);
        item.addView(bookQuantity);
        details.addView(item, new LinearLayout.LayoutParams(0, -2, 1));

        LinearLayout quantity = column();
        quantity.setGravity(Gravity.END);
        actualQuantity = label("—", 30, ACCENT, true);
        quantity.addView(actualQuantity);
        quantity.addView(label("实盘数量", 13, 0xFF4B5563, false));
        details.addView(quantity);

        LinearLayout.LayoutParams finishLayout = new LinearLayout.LayoutParams(-1, dp(48));
        finishLayout.topMargin = dp(12);
        panel.addView(inventoryButton("完成扫码", ACCENT, v -> finish()), finishLayout);
        setContentView(page);
    }

    private LinearLayout column() {
        LinearLayout layout = new LinearLayout(this);
        layout.setOrientation(LinearLayout.VERTICAL);
        return layout;
    }

    private GradientDrawable rounded(int color) {
        GradientDrawable background = new GradientDrawable();
        background.setColor(color);
        background.setCornerRadius(dp(12));
        return background;
    }

    private TextView label(String text, int size, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(text);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return view;
    }

    private Button inventoryButton(String text, int color, View.OnClickListener action) {
        Button button = new Button(this);
        button.setText(text);
        button.setTextColor(Color.WHITE);
        button.setTextSize(15);
        button.setAllCaps(false);
        button.setBackground(rounded(color));
        button.setOnClickListener(action);
        return button;
    }

    private Button button(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setTextColor(Color.WHITE);
        b.setTextSize(16);
        b.setAllCaps(false);
        b.setBackgroundColor(0x66000000);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(120), dp(48));
        lp.leftMargin = lp.rightMargin = dp(12);
        b.setLayoutParams(lp);
        return b;
    }

    @Override
    protected void onResume() {
        super.onResume();
        worker = new HandlerThread("decode");
        worker.start();
        decoder = new Handler(worker.getLooper());
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
        } else if (surface.getHolder().getSurface().isValid()) {
            openCamera(surface.getHolder());
        }
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req != REQ_CAM) return;
        if (res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED) {
            if (surface.getHolder().getSurface().isValid()) openCamera(surface.getHolder());
        } else {
            Toast.makeText(this, "需要相机权限才能扫码，可在系统设置 → 应用 → x.erp 里开启", Toast.LENGTH_LONG).show();
            setResult(RESULT_CANCELED);
            finish();
        }
    }

    @Override
    protected void onPause() {
        closeCamera();
        if (worker != null) { worker.quitSafely(); worker = null; }
        super.onPause();
    }

    @Override public void surfaceCreated(SurfaceHolder h) {
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) openCamera(h);
    }
    @Override public void surfaceChanged(SurfaceHolder h, int f, int w, int hh) { }
    @Override public void surfaceDestroyed(SurfaceHolder h) { closeCamera(); }

    private void openCamera(SurfaceHolder holder) {
        if (camera != null) return;
        try {
            int id = 0;
            Camera.CameraInfo info = new Camera.CameraInfo();
            for (int i = 0; i < Camera.getNumberOfCameras(); i++) {
                Camera.getCameraInfo(i, info);
                if (info.facing == Camera.CameraInfo.CAMERA_FACING_BACK) { id = i; break; }
            }
            Camera.getCameraInfo(id, info);
            camera = Camera.open(id);
            int rot = getWindowManager().getDefaultDisplay().getRotation();
            int deg = rot == Surface.ROTATION_90 ? 90 : rot == Surface.ROTATION_180 ? 180 : rot == Surface.ROTATION_270 ? 270 : 0;
            camera.setDisplayOrientation((info.orientation - deg + 360) % 360);
            Camera.Parameters p = camera.getParameters();
            Camera.Size best = null;
            for (Camera.Size s : p.getSupportedPreviewSizes()) {  // 选 1280×720 附近的预览尺寸，兼顾清晰度与速度
                if (best == null || Math.abs(s.width * s.height - 1280 * 720) < Math.abs(best.width * best.height - 1280 * 720)) best = s;
            }
            if (best != null) p.setPreviewSize(best.width, best.height);
            List<String> fm = p.getSupportedFocusModes();
            if (fm.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
            else if (fm.contains(Camera.Parameters.FOCUS_MODE_AUTO)) p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
            camera.setParameters(p);
            camera.setPreviewDisplay(holder);
            camera.setPreviewCallback(this);
            camera.startPreview();
            if (Camera.Parameters.FOCUS_MODE_AUTO.equals(p.getFocusMode())) autoFocusLoop();
        } catch (Exception e) {
            Toast.makeText(this, "打不开相机：" + e.getMessage(), Toast.LENGTH_LONG).show();
            closeCamera();
            finish();
        }
    }

    private void autoFocusLoop() {
        if (camera == null || done) return;
        try { camera.autoFocus((ok, c) -> surface.postDelayed(this::autoFocusLoop, 1500)); } catch (Exception ignored) { }
    }

    private void closeCamera() {
        if (camera == null) return;
        try { camera.setPreviewCallback(null); camera.stopPreview(); } catch (Exception ignored) { }
        camera.release();
        camera = null;
        torch = false;
    }

    private void toggleTorch() {
        if (camera == null) return;
        try {
            Camera.Parameters p = camera.getParameters();
            List<String> modes = p.getSupportedFlashModes();
            if (modes == null || !modes.contains(Camera.Parameters.FLASH_MODE_TORCH)) { Toast.makeText(this, "这台手机不支持手电筒", Toast.LENGTH_SHORT).show(); return; }
            torch = !torch;
            p.setFlashMode(torch ? Camera.Parameters.FLASH_MODE_TORCH : Camera.Parameters.FLASH_MODE_OFF);
            camera.setParameters(p);
        } catch (Exception ignored) { }
    }

    @Override
    public void onPreviewFrame(byte[] data, Camera cam) {
        if (busy || done || decoder == null) return;
        Camera.Size size;
        try { size = cam.getParameters().getPreviewSize(); } catch (Exception e) { return; }
        busy = true;
        final int w = size.width, h = size.height, n = frame++;
        decoder.post(() -> {
            try {
                // 传感器画面是横的：一维条码横着拿在竖屏里，对传感器来说是竖的，所以轮流尝试原图和旋转 90° 的图
                String code = (n % 2 == 0) ? decode(rotate(data, w, h), h, w) : decode(data, w, h);
                if (inventoryReceiver != null) {
                    String detected = code != null ? code
                            : (n % 2 == 0 ? decode(data, w, h) : decode(rotate(data, w, h), h, w));
                    long observedAt = SystemClock.elapsedRealtime();
                    runOnUiThread(() -> {
                        if (camera == cam && !isFinishing()) inventoryFrame(detected, observedAt);
                    });
                } else if (code != null && !done) {
                    done = true;
                    runOnUiThread(() -> finishWith(code));
                }
            } finally { busy = false; }
        });
    }

    private String decode(byte[] y, int w, int h) {
        // 只识别中间 80% 宽、60% 高的区域（与取景框一致），更快也更准
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

    /** 把 NV21 的亮度平面顺时针旋转 90° */
    private static byte[] rotate(byte[] d, int w, int h) {
        byte[] out = new byte[w * h];
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) out[x * h + h - 1 - y] = d[y * w + x];
        return out;
    }

    private void inventoryFrame(String code, long observedAt) {
        if (code == null) {
            if (absentSince < 0) absentSince = observedAt;
            if (observedAt - absentSince >= REARM_MS) lastCode = null;
            return;
        }
        absentSince = -1;
        if (code.equals(lastCode)) {
            return;
        }
        if (awaitingResult) return;
        lastCode = code;
        awaitingResult = true;
        int request = ++scanRequest;
        showStatus("正在确认条码…", 0xFF4B5563);

        Bundle data = new Bundle();
        data.putString("code", code);
        data.putParcelable("reply", new ResultReceiver(new Handler(getMainLooper())) {
            @Override protected void onReceiveResult(int ignored, Bundle response) {
                if (isFinishing() || isDestroyed()) return;
                awaitingResult = false;
                showInventoryResult(response.getString("result"));
            }
        });
        inventoryReceiver.send(0, data);
        scanStatus.postDelayed(() -> {
            if (awaitingResult && request == scanRequest && !isFinishing()) {
                showStatus("正在等待盘点页确认，可返回盘点单检查", 0xFFB91C1C);
            }
        }, 5000);
    }

    private void showStatus(String text, int color) {
        scanStatus.setTextColor(color);
        scanStatus.setText(text);
    }

    private void showInventoryResult(String result) {
        try {
            JSONObject item = new JSONObject(result == null ? "" : result);
            if (item.has("error")) {
                showStatus(item.getString("error"), 0xFFB91C1C);
                return;
            }
            String unit = item.getString("unit");
            productName.setText(item.getString("name"));
            bookQuantity.setText("账面库存 " + item.getString("book") + " " + unit);
            actualQuantity.setText(item.getString("counted"));
            showStatus("扫码成功 · 已累加 " + item.getString("add") + " " + unit, 0xFF047857);
            signalScan();
            if (!continuous.isChecked()) finish();
        } catch (JSONException e) {
            showStatus("盘点页无法接收扫码结果，请返回后重试", 0xFFB91C1C);
        }
    }

    private void finishWith(String code) {
        signalScan();
        setResult(RESULT_OK, new Intent().putExtra("code", code));
        finish();
    }

    private void signalScan() {
        try {
            ToneGenerator tone = new ToneGenerator(AudioManager.STREAM_NOTIFICATION, 80);
            tone.startTone(ToneGenerator.TONE_PROP_BEEP, 120);
            new Handler(getMainLooper()).postDelayed(tone::release, 180);
        } catch (Exception ignored) { }
        try {
            Vibrator v = (Vibrator) getSystemService(VIBRATOR_SERVICE);
            if (v != null) { if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createOneShot(60, VibrationEffect.DEFAULT_AMPLITUDE)); else v.vibrate(60); }
        } catch (Exception ignored) { }
    }

    int dp(int v) { return Math.round(v * getResources().getDisplayMetrics().density); }

    /** 半透明遮罩 + 取景框 */
    private class Overlay extends View {
        private final Paint dim = new Paint(), line = new Paint(Paint.ANTI_ALIAS_FLAG);
        Overlay(Activity a) {
            super(a);
            dim.setColor(0x88000000);
            line.setColor(0xFF6366F1);
            line.setStyle(Paint.Style.STROKE);
            line.setStrokeWidth(dp(3));
        }
        @Override protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            float bw = w * 0.8f, bh = Math.min(h * 0.32f, bw * 0.75f), l = (w - bw) / 2, t = (h - bh) / 2;
            c.drawRect(0, 0, w, t, dim);
            c.drawRect(0, t + bh, w, h, dim);
            c.drawRect(0, t, l, t + bh, dim);
            c.drawRect(l + bw, t, w, t + bh, dim);
            c.drawRoundRect(new RectF(l, t, l + bw, t + bh), dp(12), dp(12), line);
        }
    }
}
