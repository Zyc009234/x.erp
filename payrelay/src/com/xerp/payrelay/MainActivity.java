package com.xerp.payrelay;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {
    private EditText base, device, secret;
    private TextView status;

    @Override protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        int pad = (int) (18 * getResources().getDisplayMetrics().density);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(pad, pad, pad, pad);
        root.setBackgroundColor(0xfff6f8fc);

        TextView title = new TextView(this);
        title.setText("x.erp 收款助手");
        title.setTextSize(24);
        title.setTextColor(0xff0f172a);
        root.addView(title);

        TextView tip = new TextView(this);
        tip.setText("把电脑后台「收款助手」里生成的 ID 和密钥填到这里。\n" +
                "1. 保存并启动\n2. 打开通知使用权，勾选本应用\n3. 手机保持联网、微信通知打开\n" +
                "付款到账后会自动回调，电脑上自动发授权码。");
        tip.setTextSize(14);
        tip.setTextColor(0xff475569);
        tip.setPadding(0, pad / 2, 0, pad);
        root.addView(tip);

        base = field(root, "服务器地址", RelayClient.DEFAULT_BASE, InputType.TYPE_CLASS_TEXT);
        device = field(root, "设备 ID", "", InputType.TYPE_CLASS_TEXT);
        secret = field(root, "密钥", "", InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);

        base.setText(RelayClient.prefs(this).getString("base", RelayClient.DEFAULT_BASE));
        device.setText(RelayClient.prefs(this).getString("device", ""));
        secret.setText(RelayClient.prefs(this).getString("secret", ""));

        Button save = button(root, "保存并启动");
        save.setOnClickListener(v -> {
            String b = base.getText().toString().trim();
            String d = device.getText().toString().trim();
            String s = secret.getText().toString().trim();
            if (d.isEmpty() || s.isEmpty()) { toast("请填写设备 ID 和密钥"); return; }
            RelayClient.prefs(this).edit().putString("base", b.isEmpty() ? RelayClient.DEFAULT_BASE : b)
                    .putString("device", d).putString("secret", s).apply();
            RelayService.start(this);
            toast("已保存，收款助手已启动");
            refresh();
        });

        Button access = button(root, "打开通知使用权");
        access.setOnClickListener(v -> {
            try { startActivity(new Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")); }
            catch (Exception e) { try { startActivity(new Intent(Settings.ACTION_SETTINGS)); } catch (Exception x) {} }
        });

        Button test = button(root, "发送测试心跳");
        test.setOnClickListener(v -> {
            status.setText("正在连接服务器…");
            new Thread(() -> {
                String msg;
                try { RelayClient.post(getApplicationContext(), "/api/relay/heartbeat", "heartbeat", 0, ""); msg = "服务器连接成功，收款助手在线"; }
                catch (Exception e) { msg = "连接失败：" + e.getMessage(); }
                final String m = msg;
                runOnUiThread(() -> { status.setText(m); toast(m); });
            }).start();
        });

        status = new TextView(this);
        status.setTextSize(14);
        status.setTextColor(0xff334155);
        status.setPadding(0, pad, 0, 0);
        root.addView(status);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(root);
        setContentView(scroll);
        if (Build.VERSION.SDK_INT >= 33) requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 1);
        refresh();
    }

    @Override protected void onResume() { super.onResume(); refresh(); }

    private void refresh() {
        boolean conf = RelayClient.configured(this);
        String enabled = Settings.Secure.getString(getContentResolver(), "enabled_notification_listeners");
        boolean listening = enabled != null && enabled.contains(getPackageName());
        status.setText("配置：" + (conf ? "已填写" : "未填写") + "\n通知使用权：" + (listening ? "已开启" : "未开启（必须开启才能监听）") +
                "\n服务器：" + RelayClient.base(this));
    }

    private EditText field(LinearLayout root, String label, String value, int type) {
        TextView l = new TextView(this);
        l.setText(label);
        l.setTextSize(13);
        l.setTextColor(0xff64748b);
        l.setPadding(0, 12, 0, 4);
        root.addView(l);
        EditText e = new EditText(this);
        e.setText(value);
        e.setTextSize(15);
        e.setSingleLine(true);
        e.setInputType(type);
        e.setBackgroundColor(0xffffffff);
        e.setPadding(16, 12, 16, 12);
        root.addView(e, new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        return e;
    }

    private Button button(LinearLayout root, String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setAllCaps(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = 18;
        root.addView(b, lp);
        return b;
    }

    private void toast(String s) { Toast.makeText(this, s, Toast.LENGTH_LONG).show(); }
}
