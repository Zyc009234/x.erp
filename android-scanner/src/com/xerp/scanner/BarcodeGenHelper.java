package com.xerp.scanner;

import android.app.Activity;
import android.app.Dialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.view.Gravity;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.google.zxing.BarcodeFormat;
import com.google.zxing.EncodeHintType;
import com.google.zxing.MultiFormatWriter;
import com.google.zxing.common.BitMatrix;

import java.security.SecureRandom;
import java.util.EnumMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

public final class BarcodeGenHelper {
    private static final SecureRandom RNG = new SecureRandom();
    private static final String[] C128 = ("212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 "
            + "221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 "
            + "223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 "
            + "131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 "
            + "113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 "
            + "312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 "
            + "112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 "
            + "121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 "
            + "131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112").split(" ");

    private static WebView printWebView;

    private BarcodeGenHelper() { }

    public static String generateInternalEan13(Set<String> usedCodes) {
        for (int attempt = 0; attempt < 200; attempt++) {
            StringBuilder sb = new StringBuilder("20");
            for (int i = 0; i < 10; i++) sb.append(RNG.nextInt(10));
            String body = sb.toString();
            int sum = 0;
            for (int i = 0; i < 12; i++) {
                int d = body.charAt(i) - '0';
                sum += (i % 2 == 0) ? d : d * 3;
            }
            int check = (10 - (sum % 10)) % 10;
            String code = body + check;
            if (usedCodes == null || !usedCodes.contains(code)) return code;
        }
        return "20" + (System.currentTimeMillis() % 10000000000L);
    }

    public static Bitmap renderBarcodeBitmap(String text, BarcodeFormat fmt, int width, int height) {
        try {
            Map<EncodeHintType, Object> hints = new EnumMap<>(EncodeHintType.class);
            hints.put(EncodeHintType.MARGIN, 1);
            hints.put(EncodeHintType.CHARACTER_SET, "UTF-8");
            BitMatrix m = new MultiFormatWriter().encode(text, fmt, width, height, hints);
            int w = m.getWidth(), h = m.getHeight();
            int[] pixels = new int[w * h];
            for (int y = 0; y < h; y++) {
                int off = y * w;
                for (int x = 0; x < w; x++) pixels[off + x] = m.get(x, y) ? Color.BLACK : Color.WHITE;
            }
            Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
            bmp.setPixels(pixels, 0, w, 0, 0, w, h);
            return bmp;
        } catch (Exception e) {
            return null;
        }
    }

    public static boolean supportsCode128(String text) {
        if (text == null || text.isEmpty()) return false;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 32 || c > 126) return false;
        }
        return true;
    }

    public static void showFullscreenBarcode(Activity act, String title, String subtitle, String code) {
        if (code == null || code.trim().isEmpty()) {
            Ui.toast(act, "该商品还没有条码");
            return;
        }
        Dialog d = new Dialog(act);
        d.requestWindowFeature(Window.FEATURE_NO_TITLE);

        LinearLayout root = Ui.col(act);
        root.setBackgroundColor(Color.WHITE);
        root.setGravity(Gravity.CENTER);
        root.setPadding(Ui.dp(act, 24), Ui.dp(act, 32), Ui.dp(act, 24), Ui.dp(act, 24));

        TextView tTitle = Ui.tv(act, title, 20, Ui.INK, true);
        tTitle.setGravity(Gravity.CENTER);
        root.addView(tTitle);
        if (subtitle != null && !subtitle.isEmpty()) {
            TextView tSub = Ui.tv(act, subtitle, 14, Ui.MUTED, false);
            tSub.setGravity(Gravity.CENTER);
            tSub.setPadding(0, Ui.dp(act, 4), 0, Ui.dp(act, 16));
            root.addView(tSub);
        }

        ImageView img = new ImageView(act);
        img.setAdjustViewBounds(true);
        img.setPadding(Ui.dp(act, 12), Ui.dp(act, 16), Ui.dp(act, 12), Ui.dp(act, 16));
        img.setBackground(Ui.outlined(act, Color.WHITE, Ui.LINE, 1, 12));
        root.addView(img, new LinearLayout.LayoutParams(-1, Ui.dp(act, 220)));

        TextView tCode = Ui.tv(act, code, 22, Ui.INK, true);
        tCode.setGravity(Gravity.CENTER);
        tCode.setPadding(0, Ui.dp(act, 12), 0, Ui.dp(act, 18));
        root.addView(tCode);

        final boolean[] isQr = {!supportsCode128(code)};
        Runnable draw = () -> {
            Bitmap b = isQr[0]
                    ? renderBarcodeBitmap(code, BarcodeFormat.QR_CODE, 600, 600)
                    : renderBarcodeBitmap(code, BarcodeFormat.CODE_128, 900, 320);
            if (b != null) img.setImageBitmap(b);
        };
        draw.run();

        LinearLayout bar = Ui.row(act);
        Button switchBtn = Ui.outlineBtn(act, isQr[0] ? "切换一维条码" : "切换二维码", Ui.LINE, Ui.INK);
        switchBtn.setOnClickListener(v -> {
            isQr[0] = !isQr[0];
            switchBtn.setText(isQr[0] ? "切换一维条码" : "切换二维码");
            draw.run();
        });
        Button copyBtn = Ui.outlineBtn(act, "复制条码", Ui.ACCENT, Ui.ACCENT);
        copyBtn.setOnClickListener(v -> {
            ClipboardManager cm = (ClipboardManager) act.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("barcode", code));
            Ui.toast(act, "已复制：" + code);
        });
        bar.addView(switchBtn, new LinearLayout.LayoutParams(0, -2, 1));
        bar.addView(Ui.space(act, 10, 1));
        bar.addView(copyBtn, new LinearLayout.LayoutParams(0, -2, 1));
        root.addView(bar, new LinearLayout.LayoutParams(-1, -2));

        Button close = Ui.btn(act, "关闭", Ui.PRIMARY, Color.WHITE);
        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(-1, Ui.dp(act, 48));
        clp.topMargin = Ui.dp(act, 12);
        close.setOnClickListener(v -> d.dismiss());
        root.addView(close, clp);

        d.setContentView(root);
        Window w = d.getWindow();
        if (w != null) w.setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        d.show();
    }

    public static void printLabels(Activity act, String companyName, List<Models.LabelJob> jobs, String tpl, boolean showCo, boolean showSpec, boolean showPrice, boolean seesPrice) {
        if (jobs.isEmpty()) { Ui.toast(act, "打印队列为空"); return; }
        int total = 0;
        for (Models.LabelJob j : jobs) total += Math.max(0, j.copies);
        if (total == 0) { Ui.toast(act, "请至少打印 1 张标签"); return; }
        if (total > 2000) { Ui.toast(act, "一次最多打印 2000 张"); return; }

        int wMm = 40, hMm = 30;
        boolean sheet = false;
        if ("l5030".equals(tpl)) { wMm = 50; hMm = 30; }
        else if ("l6040".equals(tpl)) { wMm = 60; hMm = 40; }
        else if ("a4".equals(tpl)) { wMm = 70; hMm = 37; sheet = true; }
        double fs = Math.min(wMm, hMm * 1.4) / 40.0;

        StringBuilder css = new StringBuilder();
        css.append("@page{margin:0}");
        css.append("*{box-sizing:border-box;margin:0;padding:0}");
        css.append("body{font-family:sans-serif;color:#000}");
        css.append(".lb{width:").append(wMm).append("mm;height:").append(hMm).append("mm;padding:")
                .append(String.format(Locale.US, "%.1fmm %.1fmm", 1.5 * fs, 2.0 * fs))
                .append(";display:flex;flex-direction:column;justify-content:space-between;overflow:hidden;")
                .append(sheet ? "" : "page-break-after:always;").append("}");
        css.append(".lb-co{font-size:").append(String.format(Locale.US, "%.1fpt", 6.5 * fs)).append(";color:#333}");
        css.append(".lb-name{font-size:").append(String.format(Locale.US, "%.1fpt", 9.0 * fs)).append(";font-weight:700;line-height:1.15;max-height:2.3em;overflow:hidden}");
        css.append(".lb-spec{font-size:").append(String.format(Locale.US, "%.1fpt", 7.0 * fs)).append("}");
        css.append(".lb-price{font-size:").append(String.format(Locale.US, "%.1fpt", 11.0 * fs)).append(";font-weight:800}");
        css.append(".lb-bar{height:").append(String.format(Locale.US, "%.1fmm", hMm * 0.30)).append(";margin-top:1mm}");
        css.append(".lb-code{font:").append(String.format(Locale.US, "%.1fpt/1 monospace", 7.0 * fs)).append(";text-align:center;letter-spacing:.5px}");
        if (sheet) css.append(".sheet{display:grid;grid-template-columns:repeat(3,70mm);grid-auto-rows:37mm;width:210mm}");

        StringBuilder body = new StringBuilder();
        if (sheet) body.append("<div class='sheet'>");
        for (Models.LabelJob j : jobs) {
            if (j.copies <= 0) continue;
            String code = j.code();
            String spec = j.product.spec;
            if (j.unit != null) {
                String uInfo = "1" + j.unit.name + "=" + j.unit.rate + j.product.unit;
                spec = (showSpec && !spec.isEmpty()) ? (spec + " · " + uInfo) : uInfo;
            } else if (!showSpec) {
                spec = "";
            }
            String svg = barcodeSvg(code, 40);
            StringBuilder card = new StringBuilder();
            card.append("<div class='lb'>");
            if (showCo && !companyName.isEmpty()) card.append("<div class='lb-co'>").append(esc(companyName)).append("</div>");
            card.append("<div class='lb-name'>").append(esc(j.product.name)).append("</div>");
            if (!spec.isEmpty()) card.append("<div class='lb-spec'>").append(esc(spec)).append("</div>");
            if (showPrice && seesPrice) {
                double p = (j.unit != null && j.unit.price != null) ? j.unit.price : j.product.price * (j.unit != null ? j.unit.rate : 1);
                String uName = j.unit != null ? j.unit.name : j.product.unit;
                card.append("<div class='lb-price'>¥").append(String.format("%.2f", p)).append("<small>/").append(esc(uName)).append("</small></div>");
            }
            card.append("<div class='lb-bar'>").append(svg.isEmpty() ? "<span>不支持字符</span>" : svg).append("</div>");
            card.append("<div class='lb-code'>").append(esc(code)).append("</div></div>");
            String one = card.toString();
            for (int k = 0; k < j.copies; k++) body.append(one);
        }
        if (sheet) body.append("</div>");

        String html = "<!doctype html><html><head><meta charset='utf-8'><style>" + css + "</style></head><body>" + body + "</body></html>";
        printWebView = new WebView(act);
        printWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                PrintManager pm = (PrintManager) act.getSystemService(Context.PRINT_SERVICE);
                if (pm != null) pm.print("条码标签", view.createPrintDocumentAdapter("条码标签"), new PrintAttributes.Builder().build());
            }
        });
        printWebView.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    private static String barcodeSvg(String text, int h) {
        if (!supportsCode128(text)) return "";
        boolean allDigitsEven = text.length() >= 4 && text.length() % 2 == 0 && text.matches("^\\d+$");
        int[] codes = new int[allDigitsEven ? text.length() / 2 + 3 : text.length() + 3];
        int idx = 0;
        if (allDigitsEven) {
            codes[idx++] = 105;
            for (int i = 0; i < text.length(); i += 2) codes[idx++] = Integer.parseInt(text.substring(i, i + 2));
        } else {
            codes[idx++] = 104;
            for (int i = 0; i < text.length(); i++) codes[idx++] = text.charAt(i) - 32;
        }
        int sum = 0;
        for (int i = 0; i < idx; i++) sum += codes[i] * (i == 0 ? 1 : i);
        codes[idx++] = sum % 103;
        codes[idx] = 106;

        StringBuilder pat = new StringBuilder();
        for (int c : codes) pat.append(C128[c]);

        int x = 10;
        StringBuilder bars = new StringBuilder();
        for (int i = 0; i < pat.length(); i++) {
            int w = pat.charAt(i) - '0';
            if (i % 2 == 0) bars.append("<rect x='").append(x).append("' y='0' width='").append(w).append("' height='").append(h).append("'/>");
            x += w;
        }
        return "<svg viewBox='0 0 " + (x + 10) + " " + h + "' preserveAspectRatio='none' style='width:100%;height:100%;display:block' fill='#000'>" + bars + "</svg>";
    }

    private static String esc(String s) {
        if (s == null) return "";
        return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;");
    }
}
