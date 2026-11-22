package com.xerp.scanner;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.os.SystemClock;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;

import java.util.Locale;

/**
 * Pure Android native TextToSpeech wrapper for zero-network, zero-dependency
 * warehouse barcode voice announcements.
 */
public final class TtsSpeaker {
    private final Context appCtx;
    private final AppStore store;

    private TextToSpeech engine;
    private boolean initialized = false;
    private boolean ready = false;
    private boolean initFailed = false;
    private boolean langOk = false;

    private String pendingText = "";
    private long pendingAt = 0;
    private int seq = 0;

    public TtsSpeaker(Context ctx, AppStore store) {
        this.appCtx = ctx.getApplicationContext();
        this.store = store;
        if (store.ttsEnabled) {
            warmUp();
        }
    }

    public synchronized void warmUp() {
        ensureInit();
    }

    private synchronized void ensureInit() {
        if (initialized) return;
        initialized = true;
        initFailed = false;
        try {
            engine = new TextToSpeech(appCtx, this::onInit);
        } catch (Throwable t) {
            engine = null;
            initFailed = true;
            ready = false;
        }
    }

    private synchronized void onInit(int status) {
        if (status != TextToSpeech.SUCCESS || engine == null) {
            ready = false;
            initFailed = true;
            return;
        }
        try {
            engine.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
        } catch (Throwable ignored) { }

        langOk = tryLocale(Locale.SIMPLIFIED_CHINESE)
                || tryLocale(Locale.CHINESE)
                || tryLocale(Locale.getDefault());
        try {
            engine.setSpeechRate(store.ttsRate);
        } catch (Throwable ignored) { }

        ready = true;
        initFailed = false;

        if (!pendingText.isEmpty() && SystemClock.uptimeMillis() - pendingAt <= 2000L) {
            String text = pendingText;
            pendingText = "";
            doSpeak(text);
        } else {
            pendingText = "";
        }
    }

    private boolean tryLocale(Locale locale) {
        if (engine == null || locale == null) return false;
        try {
            int res = engine.setLanguage(locale);
            return res != TextToSpeech.LANG_MISSING_DATA && res != TextToSpeech.LANG_NOT_SUPPORTED;
        } catch (Throwable t) {
            return false;
        }
    }

    public synchronized void speak(String text) {
        if (!store.ttsEnabled || text == null) return;
        String clean = text.trim();
        if (clean.isEmpty()) return;
        if (!initialized) {
            pendingText = clean;
            pendingAt = SystemClock.uptimeMillis();
            ensureInit();
            return;
        }
        if (ready && engine != null) {
            doSpeak(clean);
        } else if (!initFailed) {
            pendingText = clean;
            pendingAt = SystemClock.uptimeMillis();
        }
    }

    public synchronized void speakForce(String text) {
        if (text == null) return;
        String clean = text.trim();
        if (clean.isEmpty()) return;
        if (!initialized || initFailed) {
            initialized = false;
            ready = false;
            initFailed = false;
            pendingText = clean;
            pendingAt = SystemClock.uptimeMillis();
            ensureInit();
            return;
        }
        if (ready && engine != null) {
            doSpeak(clean);
        } else {
            pendingText = clean;
            pendingAt = SystemClock.uptimeMillis();
        }
    }

    private void doSpeak(String text) {
        if (engine == null) return;
        try {
            engine.setSpeechRate(store.ttsRate);
            engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, "xerp_" + (++seq));
        } catch (Throwable ignored) { }
    }

    public void speakTest(Activity act) {
        if (act == null || act.isFinishing()) return;
        try {
            AudioManager am = (AudioManager) act.getSystemService(Context.AUDIO_SERVICE);
            if (am != null && am.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) {
                Ui.toast(act, "当前手机媒体音量为 0，请按音量+键调大媒体音量");
            }
        } catch (Throwable ignored) { }

        boolean noChineseEngine;
        synchronized (this) {
            noChineseEngine = initFailed || (ready && !langOk && !hasTtsEngines());
        }
        if (noChineseEngine) {
            new AlertDialog.Builder(act)
                    .setTitle("未检测到中文语音引擎")
                    .setMessage("当前手机未启用中文语音引擎，请在系统设置 → 无障碍 / 文字转语音 中开启后重试。")
                    .setPositiveButton("去系统设置", (d, w) -> openSystemTtsSettings(act))
                    .setNegativeButton("取消", null)
                    .show();
            return;
        }
        speakForce("语音播报已开启，示例商品，加1，共15");
        Ui.toast(act, "正在试听语音播报…");
    }

    private boolean hasTtsEngines() {
        try {
            return engine != null && engine.getEngines() != null && !engine.getEngines().isEmpty();
        } catch (Throwable t) {
            return true;
        }
    }

    private void openSystemTtsSettings(Activity act) {
        try {
            Intent intent = new Intent("com.android.settings.TTS_SETTINGS");
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            act.startActivity(intent);
        } catch (Throwable t) {
            try {
                Intent fallback = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                act.startActivity(fallback);
            } catch (Throwable t2) {
                Ui.toast(act, "无法打开系统设置，请手动前往设置开启文字转语音");
            }
        }
    }

    public synchronized void stop() {
        pendingText = "";
        if (engine != null) {
            try { engine.stop(); } catch (Throwable ignored) { }
        }
    }

    public synchronized void shutdown() {
        pendingText = "";
        ready = false;
        initialized = false;
        if (engine != null) {
            try { engine.stop(); } catch (Throwable ignored) { }
            try { engine.shutdown(); } catch (Throwable ignored) { }
            engine = null;
        }
    }

    public static String shortName(String name) {
        if (name == null) return "";
        String s = name.trim();
        if (s.length() > 10) {
            String stripped = s.replaceAll("\\([^)]*\\)|（[^）]*）", "").trim();
            if (!stripped.isEmpty()) s = stripped;
        }
        s = s.replaceAll("\\s+", " ").trim();
        if (s.length() > 12) {
            s = s.substring(0, 12);
        }
        return s;
    }
}
