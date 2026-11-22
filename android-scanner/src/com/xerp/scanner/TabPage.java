package com.xerp.scanner;

import android.view.View;

public interface TabPage {
    View getView();
    boolean needsCamera();
    void onShown();
    void onDataUpdated();
    void onBarcodeScanned(String code);
}
