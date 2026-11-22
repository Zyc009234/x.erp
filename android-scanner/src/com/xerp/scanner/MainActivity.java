package com.xerp.scanner;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.SystemClock;
import android.speech.RecognizerIntent;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    public interface CodeCallback { void onCode(String code); }
    public interface TextCallback { void onText(String text); }

    private static final int REQ_CAM = 101, REQ_VOICE = 102, REQ_GALLERY = 103, REQ_LOGO = 104;

    public AppStore store;
    public CameraScannerView scanner;
    public TtsSpeaker tts;

    private BrandLogoView topLogo;
    private TextView whPill, coPill, camPill, manualBtn, syncBtn;
    private FrameLayout camHolder, tabHolder;
    private LinearLayout oneShotBanner, navBar;

    private final List<TabPage> tabs = new ArrayList<>();
    private final List<TextView> navBtns = new ArrayList<>();
    private int currentTab = 0;

    private boolean cameraOpen = false;
    private boolean pendingCameraOpen = false;
    private boolean photoAiming = false;
    private boolean modalCameraLock = false;
    private boolean oneShotPrevCam = false;
    private Runnable pendingAfterCamPerm;
    private Runnable logoChangedCallback;

    private CodeCallback oneShotCallback;
    private TextCallback voiceCallback;
    private CameraScannerView.SnapshotCallback photoCallback;

    // PDA / Bluetooth HID barcode scanner buffer
    private final StringBuilder hidBuf = new StringBuilder();
    private long lastHidTime = 0;
    private long lastBack = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = AppStore.get(this);
        if (store.server.isEmpty() || store.token.isEmpty()) {
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }
        tts = new TtsSpeaker(this, store);

        LinearLayout root = Ui.col(this);
        root.setBackgroundColor(Ui.BG);

        // 1. Top Compact Status Bar
        LinearLayout topBar = Ui.row(this);
        topBar.setBackgroundColor(Color.WHITE);
        topBar.setPadding(Ui.dp(this, 8), Ui.dp(this, 6), Ui.dp(this, 8), Ui.dp(this, 6));

        topLogo = new BrandLogoView(this, store);
        topLogo.setOnClickListener(v -> switchToTab(4));
        topBar.addView(topLogo, new LinearLayout.LayoutParams(Ui.dp(this, 26), Ui.dp(this, 26)));
        topBar.addView(Ui.space(this, 6, 1));

        whPill = Ui.tv(this, store.whName(store.selectedWh) + " ▾", 12, Ui.PRIMARY, true);
        whPill.setBackground(Ui.outlined(this, Ui.PRIMARY_SOFT, Ui.PRIMARY, 1, 14));
        whPill.setPadding(Ui.dp(this, 8), Ui.dp(this, 5), Ui.dp(this, 8), Ui.dp(this, 5));
        whPill.setSingleLine(true);
        whPill.setOnClickListener(v -> showWarehousePicker());

        coPill = Ui.tv(this, "", 12, Ui.MUTED, true);
        coPill.setSingleLine(true);
        coPill.setPadding(Ui.dp(this, 6), Ui.dp(this, 4), Ui.dp(this, 6), Ui.dp(this, 4));
        coPill.setOnClickListener(v -> showCompanyPicker());

        camPill = Ui.badge(this, "扫码", Ui.PRIMARY, Color.WHITE);
        camPill.setTextSize(12);
        camPill.setPadding(Ui.dp(this, 10), Ui.dp(this, 6), Ui.dp(this, 10), Ui.dp(this, 6));
        camPill.setOnClickListener(v -> toggleCamera());

        manualBtn = Ui.badge(this, "输码", Ui.CHIP_BG, Ui.INK);
        manualBtn.setTextSize(12);
        manualBtn.setPadding(Ui.dp(this, 8), Ui.dp(this, 6), Ui.dp(this, 8), Ui.dp(this, 6));
        manualBtn.setOnClickListener(v -> openManualBarcodeDialog());

        syncBtn = Ui.badge(this, "同步", Ui.ACCENT_SOFT, Ui.ACCENT);
        syncBtn.setTextSize(12);
        syncBtn.setPadding(Ui.dp(this, 8), Ui.dp(this, 6), Ui.dp(this, 8), Ui.dp(this, 6));
        syncBtn.setOnClickListener(v -> refreshData(() -> Ui.toast(this, "已同步 " + store.products.size() + " 个商品")));

        topBar.addView(whPill);
        topBar.addView(coPill, new LinearLayout.LayoutParams(0, -2, 1));
        topBar.addView(camPill);
        topBar.addView(Ui.space(this, 5, 1));
        topBar.addView(manualBtn);
        topBar.addView(Ui.space(this, 5, 1));
        topBar.addView(syncBtn);
        root.addView(topBar);
        root.addView(Ui.divider(this));

        // 2. Embedded Camera Holder (OFF by default; opens strictly on demand)
        camHolder = new FrameLayout(this);
        int camH = Math.round(getResources().getDisplayMetrics().heightPixels * 0.30f);
        scanner = new CameraScannerView(this, store);
        scanner.setListener(this::handleIncomingBarcode);
        scanner.setCloseListener(this::cancelTransientOrCloseCamera);
        camHolder.addView(scanner, new FrameLayout.LayoutParams(-1, -1));

        oneShotBanner = Ui.row(this);
        oneShotBanner.setBackgroundColor(0xDD111827);
        oneShotBanner.setPadding(Ui.dp(this, 12), Ui.dp(this, 8), Ui.dp(this, 12), Ui.dp(this, 8));
        oneShotBanner.setVisibility(View.GONE);
        camHolder.addView(oneShotBanner, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));

        camHolder.setVisibility(View.GONE);
        root.addView(camHolder, new LinearLayout.LayoutParams(-1, camH));

        // 3. Middle Tab Container
        tabHolder = new FrameLayout(this);
        root.addView(tabHolder, new LinearLayout.LayoutParams(-1, 0, 1));

        // 4. Bottom Fixed 5-Tab Thumb Navigation Bar
        root.addView(Ui.divider(this));
        navBar = Ui.row(this);
        navBar.setBackgroundColor(Color.WHITE);
        navBar.setPadding(Ui.dp(this, 4), Ui.dp(this, 6), Ui.dp(this, 4), Ui.dp(this, 8));
        root.addView(navBar);

        tabs.add(new StocktakeTab(this));
        tabs.add(new StockMoveTab(this));
        tabs.add(new LookupTab(this));
        tabs.add(new LabelTab(this));
        tabs.add(new SettingsTab(this));

        String[] labels = {"盘点", "出入库", "查/录", "标签", "设置"};
        for (int i = 0; i < labels.length; i++) {
            final int idx = i;
            TextView tv = Ui.tv(this, labels[i], 14, Ui.MUTED, true);
            tv.setGravity(Gravity.CENTER);
            tv.setPadding(0, Ui.dp(this, 10), 0, Ui.dp(this, 10));
            tv.setOnClickListener(v -> switchToTab(idx));
            navBtns.add(tv);
            navBar.addView(tv, new LinearLayout.LayoutParams(0, -2, 1));
        }

        setContentView(root);
        Ui.applyEdgeToEdge(this, root);
        syncWarehouseBadge();
        switchToTab(0);
        refreshData(null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (cameraOpen) {
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                scanner.startCamera();
            } else {
                setCameraOpen(false);
            }
        }
    }

    @Override
    protected void onPause() {
        scanner.stopCamera();
        if (tts != null) tts.stop();
        if (cameraOpen && !photoAiming && oneShotCallback == null) {
            setCameraOpen(false);
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (tts != null) tts.shutdown();
        super.onDestroy();
    }

    public void speakCue(String text, String clipKey) {
        if (tts != null) tts.speakCue(text, clipKey);
    }

    public boolean isCameraOpen() {
        return cameraOpen;
    }

    public void setModalCameraLock(boolean lock) {
        this.modalCameraLock = lock;
    }

    public void toggleCamera() {
        setCameraOpen(!cameraOpen);
    }

    public void setCameraOpen(boolean open) {
        if (open) {
            if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
                pendingCameraOpen = true;
                requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
                return;
            }
            cameraOpen = true;
            camHolder.setVisibility(View.VISIBLE);
            scanner.startCamera();
        } else {
            cameraOpen = false;
            photoAiming = false;
            scanner.setDecodeDisabled(false);
            oneShotBanner.setVisibility(View.GONE);
            camHolder.setVisibility(View.GONE);
            scanner.stopCamera();
        }
        updateCamPill();
        if (currentTab < tabs.size()) tabs.get(currentTab).onCameraStateChanged(cameraOpen);
    }

    private void updateCamPill() {
        boolean show = currentTab < tabs.size() && tabs.get(currentTab).needsCamera();
        camPill.setVisibility(show ? View.VISIBLE : View.GONE);
        camPill.setText(cameraOpen ? "关相机" : "扫码");
        camPill.setBackground(Ui.rounded(this, cameraOpen ? Ui.DANGER : Ui.PRIMARY, 14));
    }

    private void cancelTransientOrCloseCamera() {
        if (oneShotCallback != null) {
            CodeCallback c = oneShotCallback;
            boolean restore = oneShotPrevCam;
            oneShotCallback = null;
            oneShotBanner.setVisibility(View.GONE);
            setCameraOpen(restore);
            if (c != null) c.onCode(null);
            return;
        }
        if (photoAiming) {
            photoAiming = false;
            scanner.setDecodeDisabled(false);
            oneShotBanner.setVisibility(View.GONE);
            setCameraOpen(false);
            return;
        }
        setCameraOpen(false);
    }

    @Override
    public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        if (req == REQ_CAM) {
            boolean granted = res.length > 0 && res[0] == PackageManager.PERMISSION_GRANTED;
            Runnable after = pendingAfterCamPerm;
            pendingAfterCamPerm = null;
            boolean want = pendingCameraOpen;
            pendingCameraOpen = false;
            if (granted) {
                if (after != null) after.run();
                else if (want) setCameraOpen(true);
            } else {
                Ui.toast(this, "未授予相机权限，可使用蓝牙扫码枪或手动输入条码");
            }
        }
    }

    public void switchToTab(int idx) {
        if (idx < 0 || idx >= tabs.size()) return;
        currentTab = idx;
        tabHolder.removeAllViews();
        TabPage page = tabs.get(idx);
        tabHolder.addView(page.getView(), new FrameLayout.LayoutParams(-1, -1));

        for (int i = 0; i < navBtns.size(); i++) {
            boolean on = i == idx;
            TextView b = navBtns.get(i);
            b.setTextColor(on ? Ui.PRIMARY : Ui.MUTED);
            b.setBackground(on ? Ui.rounded(this, Ui.PRIMARY_SOFT, 10) : null);
        }

        if (!page.needsCamera() && cameraOpen) {
            setCameraOpen(false);
        } else {
            updateCamPill();
        }
        page.onShown();
        page.onCameraStateChanged(cameraOpen);
    }

    public void syncWarehouseBadge() {
        whPill.setText(store.whName(store.selectedWh) + " ▾");
        if (store.isPortal && store.companies.size() > 1) {
            coPill.setText(store.companyName + " ▾");
        } else {
            coPill.setText(store.companyName);
        }
    }

    private void showWarehousePicker() {
        if (store.warehouses.isEmpty()) return;
        String[] names = new String[store.warehouses.size()];
        for (int i = 0; i < store.warehouses.size(); i++) names[i] = store.warehouses.get(i).name;
        new AlertDialog.Builder(this).setTitle("切换当前仓库")
                .setItems(names, (d, w) -> {
                    store.selectedWh = store.warehouses.get(w).id;
                    store.savePrefs();
                    syncWarehouseBadge();
                    notifyDataChanged();
                }).show();
    }

    public void showCompanyPicker() {
        if (!store.isPortal || store.companies.size() <= 1) return;
        String[] names = new String[store.companies.size()];
        for (int i = 0; i < store.companies.size(); i++) {
            names[i] = store.companies.get(i).name + " (" + store.companies.get(i).code + ")";
        }
        new AlertDialog.Builder(this).setTitle("切换账套 / 公司")
                .setItems(names, (d, w) -> {
                    Models.Company target = store.companies.get(w);
                    if (target.code.equals(store.companyCode)) return;
                    new Thread(() -> {
                        try {
                            JSONObject res = ApiClient.switchCompany(store, target.code);
                            JSONObject co = res.optJSONObject("company");
                            if (co != null) {
                                store.companyCode = co.optString("code", target.code);
                                store.companyName = co.optString("name", target.name);
                            }
                            JSONObject data = ApiClient.fetchData(store);
                            store.reloadFromJson(data);
                            runOnUiThread(() -> {
                                syncWarehouseBadge();
                                notifyDataChanged();
                                Ui.toast(this, "已切换到：" + store.companyName);
                            });
                        } catch (Exception e) {
                            runOnUiThread(() -> Ui.toast(this, ApiClient.friendlyError(e)));
                        }
                    }).start();
                }).show();
    }

    private void openManualBarcodeDialog() {
        EditText et = Ui.input(this, "输入条码 / 商品编码");
        et.setSingleLine(true);
        new AlertDialog.Builder(this).setTitle("手动输入条码")
                .setView(et)
                .setPositiveButton("确定", (d, w) -> {
                    String code = et.getText().toString().trim();
                    if (!code.isEmpty()) handleIncomingBarcode(code);
                })
                .setNegativeButton("取消", null).show();
    }

    public void refreshData(Runnable onDone) {
        syncBtn.setText("同步中…");
        new Thread(() -> {
            try {
                JSONObject data = ApiClient.fetchData(store);
                store.reloadFromJson(data);
                runOnUiThread(() -> {
                    syncBtn.setText("同步");
                    syncWarehouseBadge();
                    notifyDataChanged();
                    if (onDone != null) onDone.run();
                });
            } catch (ApiClient.ApiException ae) {
                runOnUiThread(() -> {
                    syncBtn.setText("同步");
                    if (ae.status == 401) {
                        store.clearAuth();
                        Ui.toast(this, "登录已过期，请重新登录");
                        startActivity(new Intent(this, LoginActivity.class));
                        finish();
                    } else {
                        Ui.toast(this, ApiClient.friendlyError(ae));
                    }
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    syncBtn.setText("同步");
                    Ui.toast(this, ApiClient.friendlyError(e));
                });
            }
        }).start();
    }

    public void notifyDataChanged() {
        if (currentTab < tabs.size()) tabs.get(currentTab).onDataUpdated();
    }

    private void handleIncomingBarcode(String code) {
        if (photoAiming) return;
        if (oneShotCallback != null) {
            CodeCallback cb = oneShotCallback;
            boolean restore = oneShotPrevCam;
            oneShotCallback = null;
            oneShotBanner.setVisibility(View.GONE);
            scanner.feedbackOk();
            setCameraOpen(restore);
            cb.onCode(code);
            return;
        }
        tabs.get(currentTab).onBarcodeScanned(code);
        if (!store.continuousScan && !modalCameraLock && cameraOpen) {
            setCameraOpen(false);
        }
    }

    public void captureOneShotBarcode(String prompt, CodeCallback cb) {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingAfterCamPerm = () -> captureOneShotBarcode(prompt, cb);
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
            return;
        }
        oneShotPrevCam = cameraOpen;
        oneShotCallback = cb;
        photoAiming = false;
        scanner.setDecodeDisabled(false);
        setCameraOpen(true);
        oneShotBanner.removeAllViews();
        oneShotBanner.setVisibility(View.VISIBLE);
        oneShotBanner.addView(Ui.tv(this, prompt, 13, Color.WHITE, true), new LinearLayout.LayoutParams(0, -2, 1));
        TextView cancel = Ui.badge(this, "取消扫码", Ui.DANGER, Color.WHITE);
        cancel.setOnClickListener(v -> cancelTransientOrCloseCamera());
        oneShotBanner.addView(cancel);
    }

    public void takeLiveSnapshot(CameraScannerView.SnapshotCallback cb) {
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            pendingAfterCamPerm = () -> takeLiveSnapshot(cb);
            requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAM);
            return;
        }
        final boolean prevCam = cameraOpen;
        photoAiming = true;
        scanner.setDecodeDisabled(true);
        setCameraOpen(true);
        oneShotBanner.removeAllViews();
        oneShotBanner.setVisibility(View.VISIBLE);
        oneShotBanner.addView(Ui.tv(this, "对准商品后点击拍照", 13, Color.WHITE, true), new LinearLayout.LayoutParams(0, -2, 1));

        TextView snap = Ui.badge(this, "拍照", Ui.PRIMARY, Color.WHITE);
        snap.setTextSize(13);
        snap.setPadding(Ui.dp(this, 14), Ui.dp(this, 6), Ui.dp(this, 14), Ui.dp(this, 6));
        snap.setOnClickListener(v -> {
            snap.setEnabled(false);
            scanner.captureSnapshot((uri, bmp, err) -> {
                photoAiming = false;
                scanner.setDecodeDisabled(false);
                oneShotBanner.setVisibility(View.GONE);
                setCameraOpen(prevCam);
                cb.onSnapshot(uri, bmp, err);
            });
        });

        TextView cancel = Ui.badge(this, "取消", Ui.DANGER, Color.WHITE);
        cancel.setTextSize(13);
        cancel.setPadding(Ui.dp(this, 12), Ui.dp(this, 6), Ui.dp(this, 12), Ui.dp(this, 6));
        cancel.setOnClickListener(v -> {
            photoAiming = false;
            scanner.setDecodeDisabled(false);
            oneShotBanner.setVisibility(View.GONE);
            setCameraOpen(prevCam);
            cb.onSnapshot(null, null, null);
        });

        oneShotBanner.addView(snap);
        oneShotBanner.addView(Ui.space(this, 8, 1));
        oneShotBanner.addView(cancel);
    }

    public void refreshBrandLogo() {
        if (topLogo != null) topLogo.reload();
    }

    public void pickCustomLogo(Runnable onChanged) {
        logoChangedCallback = onChanged;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        try { startActivityForResult(Intent.createChooser(i, "选择公司 Logo"), REQ_LOGO); }
        catch (Exception e) { logoChangedCallback = null; Ui.toast(this, "没有可选择图片的相册应用"); }
    }

    public void pickGalleryImage(CameraScannerView.SnapshotCallback cb) {
        photoCallback = cb;
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        try { startActivityForResult(Intent.createChooser(i, "选择商品图片"), REQ_GALLERY); }
        catch (Exception e) { photoCallback = null; cb.onSnapshot(null, null, "没有可选择图片的相册应用"); }
    }

    public void startVoiceInput(TextCallback cb) {
        voiceCallback = cb;
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN");
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说出商品名称");
        try { startActivityForResult(i, REQ_VOICE); }
        catch (Exception e) { voiceCallback = null; Ui.toast(this, "当前系统未安装语音识别引擎"); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_VOICE && voiceCallback != null) {
            TextCallback cb = voiceCallback;
            voiceCallback = null;
            if (res == RESULT_OK && data != null) {
                ArrayList<String> list = data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS);
                if (list != null && !list.isEmpty()) cb.onText(list.get(0));
            }
        } else if (req == REQ_GALLERY && photoCallback != null) {
            CameraScannerView.SnapshotCallback cb = photoCallback;
            photoCallback = null;
            if (res != RESULT_OK || data == null || data.getData() == null) return;
            Uri uri = data.getData();
            new Thread(() -> {
                try (InputStream is = getContentResolver().openInputStream(uri)) {
                    Bitmap bmp = BitmapFactory.decodeStream(is);
                    if (bmp == null) throw new Exception("无法读取图片");
                    String dataUri = CameraScannerView.encodeBitmapToDataUri(bmp);
                    runOnUiThread(() -> cb.onSnapshot(dataUri, bmp, null));
                } catch (Exception e) {
                    runOnUiThread(() -> cb.onSnapshot(null, null, "读取图片失败，请换一张再试"));
                }
            }).start();
        } else if (req == REQ_LOGO && logoChangedCallback != null) {
            Runnable cb = logoChangedCallback;
            logoChangedCallback = null;
            if (res != RESULT_OK || data == null || data.getData() == null) return;
            Uri uri = data.getData();
            new Thread(() -> {
                try {
                    Bitmap bmp = AppStore.decodeSampledUri(this, uri, 512);
                    store.saveCustomLogo(bmp);
                    runOnUiThread(() -> {
                        refreshBrandLogo();
                        cb.run();
                        Ui.toast(this, "公司 Logo 已更新");
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> Ui.toast(this, ApiClient.friendlyError(e)));
                }
            }).start();
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (store.pdaHidMode && event.getAction() == KeyEvent.ACTION_DOWN && !(getCurrentFocus() instanceof EditText)) {
            int code = event.getKeyCode();
            long now = SystemClock.uptimeMillis();
            if (now - lastHidTime > 300) hidBuf.setLength(0);
            lastHidTime = now;
            if (code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER || code == KeyEvent.KEYCODE_TAB) {
                if (hidBuf.length() >= 2) {
                    String scanned = hidBuf.toString().trim();
                    hidBuf.setLength(0);
                    handleIncomingBarcode(scanned);
                    return true;
                }
                hidBuf.setLength(0);
            } else {
                int ch = event.getUnicodeChar();
                if (ch >= 32 && ch <= 126) {
                    hidBuf.append((char) ch);
                    return true;
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (oneShotCallback != null || photoAiming) {
            cancelTransientOrCloseCamera();
            return;
        }
        if (cameraOpen) {
            setCameraOpen(false);
            return;
        }
        if (currentTab != 0) {
            switchToTab(0);
            return;
        }
        long now = System.currentTimeMillis();
        if (now - lastBack < 2000) finish();
        else { lastBack = now; Ui.toast(this, "再按一次退出"); }
    }
}
