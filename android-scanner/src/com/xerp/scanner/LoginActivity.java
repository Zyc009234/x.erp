package com.xerp.scanner;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.text.SpannableString;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class LoginActivity extends Activity {
    private static final int REQ_PICK_LOGO = 201;

    private AppStore store;
    private BrandLogoView logoView;
    private EditText etServer, etUser, etPass;
    private LinearLayout recentRow, coBox;
    private TextView coPick;
    private Button bLogin;

    private boolean probedPortal = false;
    private String probedUrl = "";
    private List<Models.Company> portalCompanies = new ArrayList<>();
    private String selectedCompanyCode = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        store = AppStore.get(this);
        if (!store.server.isEmpty() && !store.token.isEmpty()) {
            startActivity(new Intent(this, MainActivity.class));
            finish();
            return;
        }

        FrameLayout pageShell = new FrameLayout(this);
        pageShell.setBackgroundColor(Ui.BG);
        pageShell.addView(new HeroArcBackdrop(this), new FrameLayout.LayoutParams(-1, Ui.dp(this, 250)));

        ScrollView sv = new ScrollView(this);
        sv.setFillViewport(true);
        sv.setVerticalScrollBarEnabled(false);

        LinearLayout root = Ui.col(this);
        root.setPadding(Ui.dp(this, 18), Ui.dp(this, 24), Ui.dp(this, 18), Ui.dp(this, 24));
        sv.addView(root);
        pageShell.addView(sv, new FrameLayout.LayoutParams(-1, -1));

        // Brand Header Showcase
        LinearLayout hero = Ui.col(this);
        hero.setGravity(Gravity.CENTER_HORIZONTAL);
        hero.setPadding(0, Ui.dp(this, 4), 0, Ui.dp(this, 18));

        FrameLayout logoFrame = new FrameLayout(this);
        logoFrame.setBackground(Ui.rounded(this, Color.WHITE, 22));
        logoFrame.setElevation(Ui.dp(this, 8));
        int padL = Ui.dp(this, 4);
        logoFrame.setPadding(padL, padL, padL, padL);
        logoView = new BrandLogoView(this, store);
        int lSize = Ui.dp(this, 76);
        logoView.setOnClickListener(v -> onLogoClick());
        logoFrame.addView(logoView, new FrameLayout.LayoutParams(-1, -1));
        hero.addView(logoFrame, new LinearLayout.LayoutParams(lSize, lSize));

        String coTitle = store.effectiveSplashTitle();
        TextView brand = Ui.tv(this, coTitle, store.isDefaultBrand() ? 27 : 22, Color.WHITE, true);
        if (store.isDefaultBrand()) {
            brand.setText("x.erp");
            brand.setLetterSpacing(0.04f);
        }
        brand.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams blp0 = new LinearLayout.LayoutParams(-2, -2);
        blp0.topMargin = Ui.dp(this, 10);
        hero.addView(brand, blp0);

        TextView sub = Ui.tv(this, store.splashSubtitle, 12, 0xFFE2F8F0, false);
        sub.setGravity(Gravity.CENTER);
        sub.setPadding(0, Ui.dp(this, 3), 0, Ui.dp(this, 6));
        hero.addView(sub);

        TextView tapHint = Ui.badge(this, "轻触上方图标可更换公司 Logo", 0x26FFFFFF, Color.WHITE);
        tapHint.setTextSize(11);
        tapHint.setTypeface(Typeface.DEFAULT, Typeface.NORMAL);
        hero.addView(tapHint);
        root.addView(hero);

        // Floating Login Card
        LinearLayout card = Ui.col(this);
        card.setBackground(Ui.outlined(this, Ui.CARD, 0xFFE8EDF5, 1, 18));
        card.setElevation(Ui.dp(this, 5));
        card.setPadding(Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18), Ui.dp(this, 18));

        card.addView(Ui.sectionHeader(this, IconView.Type.WAREHOUSE, "连接工作台", Ui.PRIMARY));
        LinearLayout.LayoutParams shlp = new LinearLayout.LayoutParams(-1, -2);
        shlp.topMargin = Ui.dp(this, 14);
        card.addView(Ui.tv(this, "服务器地址（局域网 IP 或远程域名）", 12, Ui.MUTED, true), shlp);
        LinearLayout srvRow = Ui.row(this);
        etServer = Ui.input(this, "例如 192.168.1.10:8686 或 erp.example.com");
        etServer.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        etServer.setSingleLine(true);
        etServer.setText(store.server);
        Button bDiscover = Ui.outlineBtn(this, "自动查找", Ui.ACCENT, Ui.ACCENT);
        bDiscover.setTextSize(13);
        bDiscover.setOnClickListener(v -> discoverLan());
        srvRow.addView(etServer, new LinearLayout.LayoutParams(0, -2, 1));
        srvRow.addView(Ui.space(this, 8, 1));
        srvRow.addView(bDiscover, new LinearLayout.LayoutParams(-2, Ui.dp(this, 44)));
        LinearLayout.LayoutParams slp = new LinearLayout.LayoutParams(-1, -2);
        slp.topMargin = Ui.dp(this, 5);
        card.addView(srvRow, slp);

        // Recent servers
        HorizontalScrollView hsv = new HorizontalScrollView(this);
        hsv.setHorizontalScrollBarEnabled(false);
        recentRow = Ui.row(this);
        hsv.addView(recentRow);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(-1, -2);
        rlp.topMargin = Ui.dp(this, 8);
        card.addView(hsv, rlp);
        renderRecentServers();

        // Company Selector (shown when portal has multiple companies)
        coBox = Ui.col(this);
        coBox.setVisibility(View.GONE);
        coBox.addView(Ui.tv(this, "选择账套 / 公司", 12, Ui.MUTED, true));
        coPick = Ui.tv(this, "默认公司 ▾", 14, Ui.INK, true);
        coPick.setBackground(Ui.rippleOutlined(this, Ui.SURFACE_2, Ui.LINE, 1, 12));
        coPick.setPadding(Ui.dp(this, 13), Ui.dp(this, 11), Ui.dp(this, 13), Ui.dp(this, 11));
        coPick.setOnClickListener(v -> showCompanyChoices());
        LinearLayout.LayoutParams colp = new LinearLayout.LayoutParams(-1, -2);
        colp.topMargin = Ui.dp(this, 5);
        coBox.addView(coPick, colp);
        LinearLayout.LayoutParams cblp = new LinearLayout.LayoutParams(-1, -2);
        cblp.topMargin = Ui.dp(this, 12);
        card.addView(coBox, cblp);

        // Username & Password
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(-1, -2);
        flp.topMargin = Ui.dp(this, 12);
        card.addView(Ui.tv(this, "用户名", 12, Ui.MUTED, true), flp);
        etUser = Ui.input(this, "默认 admin");
        etUser.setSingleLine(true);
        etUser.setText(store.username.isEmpty() ? "admin" : store.username);
        card.addView(etUser, slp);

        card.addView(Ui.tv(this, "密码", 12, Ui.MUTED, true), flp);
        etPass = Ui.input(this, "请输入登录密码");
        etPass.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        etPass.setSingleLine(true);
        card.addView(etPass, slp);

        bLogin = Ui.gradientBtn(this, "连接并登录", Ui.PRIMARY, Ui.PRIMARY_END);
        bLogin.setTextSize(16);
        bLogin.setOnClickListener(v -> doConnectAndLogin());
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-1, Ui.dp(this, 50));
        blp.topMargin = Ui.dp(this, 18);
        card.addView(bLogin, blp);

        root.addView(card);

        TextView foot = Ui.tv(this, "与飞牛 NAS / Docker / Windows 版 x.erp 数据实时互通", 12, Ui.MUTED, false);
        foot.setGravity(Gravity.CENTER);
        foot.setPadding(0, Ui.dp(this, 18), 0, 0);
        root.addView(foot);

        setContentView(pageShell);
        Ui.applyEdgeToEdgeBar(this, pageShell, 0xFF047857, false);
    }

    private void renderRecentServers() {
        recentRow.removeAllViews();
        for (String url : store.getRecentServers()) {
            TextView ch = Ui.chip(this, url.replaceFirst("^https?://", ""), false);
            ch.setTextSize(12);
            ch.setOnClickListener(v -> {
                etServer.setText(url);
                probeUrlSilent(url);
            });
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-2, -2);
            lp.rightMargin = Ui.dp(this, 6);
            recentRow.addView(ch, lp);
        }
    }

    private void discoverLan() {
        ProgressDialog pd = ProgressDialog.show(this, null, "正在局域网查找 x.erp 服务器…", true, false);
        new Thread(() -> {
            List<String> found = ApiClient.discoverLanServers();
            runOnUiThread(() -> {
                pd.dismiss();
                if (found.isEmpty()) {
                    Ui.toast(this, "当前 Wi-Fi 网段未发现 8686 端口的 x.erp 服务");
                } else if (found.size() == 1) {
                    etServer.setText(found.get(0));
                    Ui.toast(this, "已找到：" + found.get(0));
                    probeUrlSilent(found.get(0));
                } else {
                    String[] arr = found.toArray(new String[0]);
                    new AlertDialog.Builder(this).setTitle("找到多个服务器")
                            .setItems(arr, (d, w) -> {
                                etServer.setText(arr[w]);
                                probeUrlSilent(arr[w]);
                            }).show();
                }
            });
        }).start();
    }

    private void probeUrlSilent(String rawUrl) {
        List<String> cands = ApiClient.candidateUrls(rawUrl);
        if (cands.isEmpty()) return;
        new Thread(() -> {
            String okUrl = null;
            for (String u : cands) {
                if (ApiClient.ping(u, 3000) == null) { okUrl = u; break; }
            }
            if (okUrl == null) return;
            JSONObject info = ApiClient.probePortal(okUrl);
            applyPortalProbe(okUrl, info);
        }).start();
    }

    private void applyPortalProbe(String url, JSONObject info) {
        probedUrl = url;
        probedPortal = info != null && info.optBoolean("portal", false);
        portalCompanies.clear();
        if (info != null) {
            JSONArray cs = info.optJSONArray("companies");
            if (cs != null) {
                for (int i = 0; i < cs.length(); i++) {
                    JSONObject o = cs.optJSONObject(i);
                    if (o != null) portalCompanies.add(Models.Company.fromJson(o));
                }
            }
        }
        runOnUiThread(() -> {
            if (probedPortal && portalCompanies.size() > 1) {
                if (selectedCompanyCode.isEmpty()) {
                    selectedCompanyCode = portalCompanies.get(0).code;
                    coPick.setText(portalCompanies.get(0).name + " ▾");
                }
                coBox.setVisibility(View.VISIBLE);
            } else {
                selectedCompanyCode = "";
                coBox.setVisibility(View.GONE);
            }
        });
    }

    private void showCompanyChoices() {
        if (portalCompanies.isEmpty()) return;
        String[] labels = new String[portalCompanies.size()];
        for (int i = 0; i < portalCompanies.size(); i++) {
            labels[i] = portalCompanies.get(i).name + " (" + portalCompanies.get(i).code + ")";
        }
        new AlertDialog.Builder(this).setTitle("选择账套 / 公司")
                .setItems(labels, (d, w) -> {
                    Models.Company c = portalCompanies.get(w);
                    selectedCompanyCode = c.code;
                    coPick.setText(c.name + " ▾");
                }).show();
    }

    private void doConnectAndLogin() {
        List<String> cands = ApiClient.candidateUrls(etServer.getText().toString());
        String user = etUser.getText().toString().trim();
        String pass = etPass.getText().toString();
        if (cands.isEmpty()) { Ui.toast(this, "请填写服务器地址"); return; }
        if (user.isEmpty() || pass.isEmpty()) { Ui.toast(this, "请填写用户名和密码"); return; }

        bLogin.setEnabled(false);
        bLogin.setText("正在连接…");
        new Thread(() -> {
            try {
                String url = null, firstErr = null;
                for (String cand : cands) {
                    String err = ApiClient.ping(cand, 6000);
                    if (err == null) { url = cand; break; }
                    if (firstErr == null) firstErr = err;
                }
                if (url == null) throw new Exception(firstErr != null ? firstErr : "无法连接服务器");

                if (!url.equals(probedUrl)) {
                    JSONObject info = ApiClient.probePortal(url);
                    probedUrl = url;
                    probedPortal = info != null && info.optBoolean("portal", false);
                    portalCompanies.clear();
                    if (info != null) {
                        JSONArray cs = info.optJSONArray("companies");
                        if (cs != null) for (int i = 0; i < cs.length(); i++) {
                            JSONObject o = cs.optJSONObject(i);
                            if (o != null) portalCompanies.add(Models.Company.fromJson(o));
                        }
                    }
                    if (probedPortal && portalCompanies.size() > 1 && selectedCompanyCode.isEmpty()) {
                        selectedCompanyCode = portalCompanies.get(0).code;
                    }
                }

                JSONObject res = ApiClient.login(url, probedPortal, user, pass, selectedCompanyCode);
                store.server = url;
                store.token = res.getString("token");
                store.isPortal = probedPortal;
                store.username = user;
                store.companies.clear();
                if (probedPortal) {
                    JSONObject co = res.optJSONObject("company");
                    if (co != null) {
                        store.companyCode = co.optString("code", "default");
                        store.companyName = co.optString("name", "");
                    }
                    JSONArray cs = res.optJSONArray("companies");
                    if (cs != null) for (int i = 0; i < cs.length(); i++) {
                        JSONObject o = cs.optJSONObject(i);
                        if (o != null) store.companies.add(Models.Company.fromJson(o));
                    }
                }
                JSONObject data = ApiClient.fetchData(store);
                store.reloadFromJson(data);
                store.saveRecentServer(url);

                runOnUiThread(() -> {
                    Ui.toast(this, "登录成功");
                    startActivity(new Intent(this, MainActivity.class));
                    finish();
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    bLogin.setEnabled(true);
                    bLogin.setText("连接并登录");
                    Ui.toast(this, ApiClient.friendlyError(e));
                });
            }
        }).start();
    }

    private void onLogoClick() {
        if (!store.hasCustomLogo()) {
            launchLogoPicker();
            return;
        }
        new AlertDialog.Builder(this)
                .setTitle("公司 Logo")
                .setItems(new String[]{"更换公司 Logo", "恢复默认 x.erp Logo"}, (d, w) -> {
                    if (w == 0) launchLogoPicker();
                    else {
                        store.clearCustomLogo();
                        logoView.reload();
                        Ui.toast(this, "已恢复默认 x.erp Logo");
                    }
                }).show();
    }

    private void launchLogoPicker() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.setType("image/*");
        try { startActivityForResult(Intent.createChooser(i, "选择公司 Logo"), REQ_PICK_LOGO); }
        catch (Exception e) { Ui.toast(this, "没有可选择图片的相册应用"); }
    }

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_PICK_LOGO && res == RESULT_OK && data != null && data.getData() != null) {
            Uri uri = data.getData();
            new Thread(() -> {
                try {
                    Bitmap bmp = AppStore.decodeSampledUri(this, uri, 512);
                    store.saveCustomLogo(bmp);
                    runOnUiThread(() -> {
                        logoView.reload();
                        Ui.toast(this, "公司 Logo 已更新");
                    });
                } catch (Exception e) {
                    runOnUiThread(() -> Ui.toast(this, ApiClient.friendlyError(e)));
                }
            }).start();
        }
    }

    private static final class HeroArcBackdrop extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path arc = new Path();

        HeroArcBackdrop(android.content.Context ctx) {
            super(ctx);
        }

        @Override
        protected void onDraw(Canvas c) {
            int w = getWidth(), h = getHeight();
            if (w <= 0 || h <= 0) return;
            paint.setShader(new LinearGradient(0, 0, w, h,
                    new int[]{0xFF047857, 0xFF059669, 0xFF0284C7}, null, Shader.TileMode.CLAMP));
            arc.reset();
            arc.moveTo(0, 0);
            arc.lineTo(w, 0);
            arc.lineTo(w, h * 0.78f);
            arc.quadTo(w * 0.5f, h * 1.04f, 0, h * 0.78f);
            arc.close();
            c.drawPath(arc, paint);
        }
    }
}
