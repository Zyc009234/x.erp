package com.xerp.scanner;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.ProgressDialog;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

public class LoginActivity extends Activity {
    private AppStore store;
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

        ScrollView sv = new ScrollView(this);
        sv.setBackgroundColor(Ui.BG);
        sv.setFillViewport(true);

        LinearLayout root = Ui.col(this);
        root.setPadding(Ui.dp(this, 20), Ui.dp(this, 28), Ui.dp(this, 20), Ui.dp(this, 24));
        sv.addView(root);

        // Header
        TextView brand = Ui.tv(this, "x.erp 盘点助手", 26, Ui.PRIMARY, true);
        TextView sub = Ui.tv(this, "单手扫码盘点 · 快速建档录新 · 全功能条码工具", 13, Ui.MUTED, false);
        sub.setPadding(0, Ui.dp(this, 4), 0, Ui.dp(this, 20));
        root.addView(brand);
        root.addView(sub);

        // Login Card
        LinearLayout card = Ui.card(this, 16);

        card.addView(Ui.tv(this, "服务器地址（局域网 IP 或远程域名）", 12, Ui.MUTED, true));
        LinearLayout srvRow = Ui.row(this);
        etServer = Ui.input(this, "例如 192.168.1.10:8686");
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
        slp.topMargin = Ui.dp(this, 4);
        card.addView(srvRow, slp);

        // Recent servers
        HorizontalScrollView hsv = new HorizontalScrollView(this);
        hsv.setHorizontalScrollBarEnabled(false);
        recentRow = Ui.row(this);
        hsv.addView(recentRow);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(-1, -2);
        rlp.topMargin = Ui.dp(this, 6);
        card.addView(hsv, rlp);
        renderRecentServers();

        // Company Selector (shown when portal has multiple companies)
        coBox = Ui.col(this);
        coBox.setVisibility(View.GONE);
        coBox.addView(Ui.tv(this, "选择账套 / 公司", 12, Ui.MUTED, true));
        coPick = Ui.tv(this, "默认公司 ▾", 14, Ui.INK, true);
        coPick.setBackground(Ui.outlined(this, Ui.BG, Ui.LINE, 1, 10));
        coPick.setPadding(Ui.dp(this, 12), Ui.dp(this, 10), Ui.dp(this, 12), Ui.dp(this, 10));
        coPick.setOnClickListener(v -> showCompanyChoices());
        LinearLayout.LayoutParams colp = new LinearLayout.LayoutParams(-1, -2);
        colp.topMargin = Ui.dp(this, 4);
        coBox.addView(coPick, colp);
        LinearLayout.LayoutParams cblp = new LinearLayout.LayoutParams(-1, -2);
        cblp.topMargin = Ui.dp(this, 10);
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

        bLogin = Ui.btn(this, "连接并登录", Ui.PRIMARY, Color.WHITE);
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

        setContentView(sv);
        Ui.applyEdgeToEdge(this, sv);
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
        String url = ApiClient.normalizeUrl(rawUrl);
        if (url.isEmpty()) return;
        new Thread(() -> {
            if (ApiClient.ping(url, 3000) != null) return;
            JSONObject info = ApiClient.probePortal(url);
            applyPortalProbe(url, info);
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
        String url = ApiClient.normalizeUrl(etServer.getText().toString());
        String user = etUser.getText().toString().trim();
        String pass = etPass.getText().toString();
        if (url.isEmpty()) { Ui.toast(this, "请填写服务器地址"); return; }
        if (user.isEmpty() || pass.isEmpty()) { Ui.toast(this, "请填写用户名和密码"); return; }

        bLogin.setEnabled(false);
        bLogin.setText("正在连接…");
        new Thread(() -> {
            try {
                String pingErr = ApiClient.ping(url, 6000);
                if (pingErr != null) throw new Exception(pingErr);

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
                    Ui.toast(this, e.getMessage());
                });
            }
        }).start();
    }
}
