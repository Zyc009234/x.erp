package com.xerp.payrelay;

import android.app.Notification;
import android.os.Bundle;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class PayListener extends NotificationListenerService {
    private static final Pattern AMOUNT = Pattern.compile("(?:¥|￥)?\\s*([0-9]+(?:\\.[0-9]{1,2})?)\\s*元");
    private static final Pattern AMOUNT2 = Pattern.compile("(?:¥|￥)\\s*([0-9]+(?:\\.[0-9]{1,2})?)");

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        if (sbn == null || sbn.getNotification() == null) return;
        String pkg = sbn.getPackageName();
        String source;
        if ("com.tencent.mm".equals(pkg)) source = "wechat";
        else if ("com.eg.android.AlipayGphone".equals(pkg)) source = "alipay";
        else return;

        Bundle extras = sbn.getNotification().extras;
        String title = str(extras.getCharSequence(Notification.EXTRA_TITLE));
        String text = str(extras.getCharSequence(Notification.EXTRA_TEXT));
        String big = str(extras.getCharSequence(Notification.EXTRA_BIG_TEXT));
        String all = (title + " " + text + " " + big).trim();
        if (all.isEmpty()) return;
        if (!(all.contains("收款") || all.contains("到账") || all.contains("已收款") || all.contains("支付成功") || all.contains("收到转账"))) return;
        if (all.contains("收款码") && !all.contains("到账") && !all.contains("收款成功")) return;

        long cents = amount(all);
        if (cents <= 0) return;
        final String fSource = source;
        final long fCents = cents;
        final String fText = all;
        new Thread(() -> {
            try { RelayClient.postWithRetry(getApplicationContext(), "/api/relay/notify", fSource, fCents, fText, 3); }
            catch (Exception ignored) {}
        }).start();
    }

    private static String str(CharSequence s) {
        return s == null ? "" : s.toString();
    }

    private static long amount(String s) {
        Matcher m = AMOUNT.matcher(s);
        if (!m.find()) {
            m = AMOUNT2.matcher(s);
            if (!m.find()) return 0;
        }
        try {
            double v = Double.parseDouble(m.group(1));
            return Math.round(v * 100);
        } catch (Exception e) { return 0; }
    }
}
