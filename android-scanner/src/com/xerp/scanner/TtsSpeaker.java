package com.xerp.scanner;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.media.AudioAttributes;
import android.media.AudioManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Dual-engine voice announcer:
 * 1. Automatically probes all installed Android TTS engines for usable Chinese support
 *    (explicitly rejecting English-only Pico TTS or engines with missing Chinese data).
 * 2. Seamlessly uses / falls back to the bundled offline G.711 u-law Chinese voice pack
 *    (VoiceClipPlayer + R.raw.voice_zh_pack) so MIUI / HyperOS / China ROM phones speak
 *    out-of-the-box with zero external dependencies or setup.
 */
public final class TtsSpeaker {
    private final Context appCtx;
    private final AppStore store;
    private final VoiceClipPlayer builtin;
    private final Handler main = new Handler(Looper.getMainLooper());

    private TextToSpeech sysEngine;
    private boolean sysProbing = false;
    private boolean sysProbed = false;
    private boolean systemChineseReady = false;
    private boolean shutdownRequested = false;

    private String activeSysPkg = "";
    private String activeSysLabel = "";
    private final List<String> probeQueue = new ArrayList<>();
    private final Map<String, String> engineLabels = new LinkedHashMap<>();

    private String lastSysUtteranceId = "";
    private List<String> lastFallbackTokens = Collections.emptyList();
    private int seq = 0;

    public TtsSpeaker(Context ctx, AppStore store) {
        this.appCtx = ctx.getApplicationContext();
        this.store = store;
        this.builtin = new VoiceClipPlayer(this.appCtx);
        if (store.ttsEnabled) {
            warmUp();
        }
    }

    public synchronized void warmUp() {
        if (shutdownRequested) return;
        builtin.warmUpAsync();
        if ("auto".equals(store.ttsEngineMode) && !sysProbing && !sysProbed && !systemChineseReady) {
            startSystemProbe();
        }
    }

    private void startSystemProbe() {
        synchronized (this) {
            if (shutdownRequested || sysProbing || systemChineseReady || sysProbed) return;
            sysProbing = true;
            activeSysPkg = "";
            activeSysLabel = "";
            probeQueue.clear();
            engineLabels.clear();
        }
        main.post(() -> {
            synchronized (TtsSpeaker.this) {
                if (shutdownRequested) { sysProbing = false; return; }
                shutdownSysOnly();
                try {
                    sysEngine = new TextToSpeech(appCtx, this::onDefaultEngineInit);
                } catch (Throwable t) {
                    sysEngine = null;
                    collectInstalledTtsPackages(null, null);
                    tryNextEngineInQueue();
                }
            }
        });
    }

    private synchronized void onDefaultEngineInit(int status) {
        if (shutdownRequested) {
            shutdownSysOnly();
            sysProbing = false;
            return;
        }
        String defaultPkg = null;
        TextToSpeech eng = sysEngine;
        if (eng != null) {
            try { defaultPkg = eng.getDefaultEngine(); } catch (Throwable ignored) { }
            if (status == TextToSpeech.SUCCESS) {
                collectEngineListFromApi(eng);
                if (!isPicoPackage(defaultPkg) && tryBindChineseLanguage(eng)) {
                    attachSysConfig(eng);
                    activeSysPkg = defaultPkg != null ? defaultPkg : "";
                    activeSysLabel = lookupLabel(activeSysPkg);
                    systemChineseReady = true;
                    sysProbing = false;
                    sysProbed = true;
                    return;
                }
            }
        }
        collectInstalledTtsPackages(eng, defaultPkg);
        shutdownSysOnly();
        tryNextEngineInQueue();
    }

    private void collectEngineListFromApi(TextToSpeech eng) {
        try {
            List<TextToSpeech.EngineInfo> list = eng.getEngines();
            if (list != null) {
                for (TextToSpeech.EngineInfo info : list) {
                    if (info != null && info.name != null && !info.name.isEmpty()) {
                        String lbl = info.label != null ? info.label.trim() : info.name;
                        engineLabels.put(info.name, lbl);
                    }
                }
            }
        } catch (Throwable ignored) { }
    }

    private void collectInstalledTtsPackages(TextToSpeech eng, String excludePkg) {
        if (eng != null) collectEngineListFromApi(eng);
        try {
            PackageManager pm = appCtx.getPackageManager();
            List<ResolveInfo> services = pm.queryIntentServices(new Intent(TextToSpeech.Engine.INTENT_ACTION_TTS_SERVICE), 0);
            if (services != null) {
                for (ResolveInfo ri : services) {
                    if (ri.serviceInfo != null && ri.serviceInfo.packageName != null) {
                        String pkg = ri.serviceInfo.packageName;
                        if (!engineLabels.containsKey(pkg)) {
                            CharSequence cs = ri.loadLabel(pm);
                            engineLabels.put(pkg, cs != null ? cs.toString().trim() : pkg);
                        }
                    }
                }
            }
        } catch (Throwable ignored) { }

        List<String> candidates = new ArrayList<>();
        for (String pkg : engineLabels.keySet()) {
            if (pkg == null || pkg.isEmpty()) continue;
            if (pkg.equals(excludePkg)) continue;
            if (isPicoPackage(pkg)) continue;
            candidates.add(pkg);
        }
        Collections.sort(candidates, (a, b) -> Integer.compare(vendorPriority(a), vendorPriority(b)));
        probeQueue.clear();
        probeQueue.addAll(candidates);
    }

    private static boolean isPicoPackage(String pkg) {
        return pkg != null && pkg.toLowerCase(Locale.ROOT).contains("svox.pico");
    }

    private static int vendorPriority(String pkg) {
        String p = pkg.toLowerCase(Locale.ROOT);
        if (p.contains("xiaomi") || p.contains("xiaoai") || p.contains("mibrain")) return 1;
        if (p.contains("iflytek")) return 2;
        if (p.contains("huawei") || p.contains("hihonor") || p.contains("honor")) return 3;
        if (p.contains("oppo") || p.contains("heytap") || p.contains("coloros")) return 4;
        if (p.contains("vivo")) return 5;
        if (p.contains("samsung")) return 6;
        if (p.contains("baidu")) return 7;
        if (p.contains("google")) return 8;
        return 20;
    }

    private synchronized void tryNextEngineInQueue() {
        if (shutdownRequested) {
            shutdownSysOnly();
            sysProbing = false;
            return;
        }
        if (probeQueue.isEmpty()) {
            shutdownSysOnly();
            systemChineseReady = false;
            sysProbing = false;
            sysProbed = true;
            return;
        }
        final String pkg = probeQueue.remove(0);
        main.post(() -> {
            synchronized (TtsSpeaker.this) {
                if (shutdownRequested) { sysProbing = false; return; }
                shutdownSysOnly();
                try {
                    sysEngine = new TextToSpeech(appCtx, st -> onCandidateEngineInit(pkg, st), pkg);
                } catch (Throwable t) {
                    sysEngine = null;
                    tryNextEngineInQueue();
                }
            }
        });
    }

    private synchronized void onCandidateEngineInit(String pkg, int status) {
        if (shutdownRequested) {
            shutdownSysOnly();
            sysProbing = false;
            return;
        }
        TextToSpeech eng = sysEngine;
        if (status == TextToSpeech.SUCCESS && eng != null && tryBindChineseLanguage(eng)) {
            attachSysConfig(eng);
            activeSysPkg = pkg;
            activeSysLabel = lookupLabel(pkg);
            systemChineseReady = true;
            sysProbing = false;
            sysProbed = true;
            return;
        }
        shutdownSysOnly();
        tryNextEngineInQueue();
    }

    private String lookupLabel(String pkg) {
        if (pkg == null || pkg.isEmpty()) return "系统中文语音";
        String lbl = engineLabels.get(pkg);
        return (lbl == null || lbl.isEmpty()) ? pkg : lbl;
    }

    private boolean tryBindChineseLanguage(TextToSpeech eng) {
        if (eng == null) return false;
        Locale[] locs = {Locale.SIMPLIFIED_CHINESE, Locale.CHINA, Locale.CHINESE};
        for (Locale loc : locs) {
            try {
                int res = eng.setLanguage(loc);
                if (res >= TextToSpeech.LANG_AVAILABLE) {
                    return true;
                }
            } catch (Throwable ignored) { }
        }
        return false;
    }

    private void attachSysConfig(TextToSpeech eng) {
        try {
            eng.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build());
        } catch (Throwable ignored) { }
        try {
            eng.setSpeechRate(store.ttsRate);
        } catch (Throwable ignored) { }
        try {
            eng.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String utteranceId) { }
                @Override public void onDone(String utteranceId) { }
                @Override public void onError(String utteranceId) {
                    fallbackForUtterance(utteranceId);
                }
                @Override public void onError(String utteranceId, int errorCode) {
                    fallbackForUtterance(utteranceId);
                }
            });
        } catch (Throwable ignored) { }
    }

    private synchronized void fallbackForUtterance(String utteranceId) {
        if (utteranceId == null || !utteranceId.equals(lastSysUtteranceId)) return;
        List<String> tokens = lastFallbackTokens;
        lastFallbackTokens = Collections.emptyList();
        if (tokens != null && !tokens.isEmpty() && store.ttsEnabled) {
            builtin.play(tokens, store.ttsRate);
        }
    }

    /* ---------- Semantic Announcement Methods ---------- */

    public void speakCountAdd(String prodName, String boxUnitName, double addQty, double totalQty) {
        if (!store.ttsEnabled) return;
        String text;
        List<String> tokens = new ArrayList<>();
        tokens.add("plus");
        if (boxUnitName != null && !boxUnitName.isEmpty()) {
            text = shortName(prodName) + "，加1" + boxUnitName + "，共" + Ui.fmtQty(totalQty);
            tokens.add("d1");
            if (boxUnitName.contains("箱")) tokens.add("box");
            else if (boxUnitName.contains("件")) tokens.add("piece");
        } else {
            text = shortName(prodName) + "，加" + Ui.fmtQty(addQty) + "，共" + Ui.fmtQty(totalQty);
            VoiceClipPlayer.appendNumberTokens(tokens, addQty);
        }
        tokens.add("pause");
        tokens.add("total");
        VoiceClipPlayer.appendNumberTokens(tokens, totalQty);
        speakInternal(text, tokens, false);
    }

    public void speakDelta(double delta, double totalQty) {
        if (!store.ttsEnabled) return;
        String text = (delta > 0 ? "加" : "减") + Ui.fmtQty(Math.abs(delta)) + "，共" + Ui.fmtQty(totalQty);
        List<String> tokens = new ArrayList<>();
        tokens.add(delta > 0 ? "plus" : "minus");
        VoiceClipPlayer.appendNumberTokens(tokens, Math.abs(delta));
        tokens.add("pause");
        tokens.add("total");
        VoiceClipPlayer.appendNumberTokens(tokens, totalQty);
        speakInternal(text, tokens, false);
    }

    public void speakCountSet(String prodName, double val) {
        if (!store.ttsEnabled) return;
        String text = shortName(prodName) + "，实盘" + Ui.fmtQty(val);
        List<String> tokens = new ArrayList<>();
        tokens.add("counted");
        VoiceClipPlayer.appendNumberTokens(tokens, val);
        speakInternal(text, tokens, false);
    }

    public void speakUndo(Double prevCount) {
        if (!store.ttsEnabled) return;
        List<String> tokens = new ArrayList<>();
        tokens.add("undo");
        String text;
        if (prevCount == null) {
            text = "已撤销";
        } else {
            text = "已撤销，恢复为" + Ui.fmtQty(prevCount);
            tokens.add("pause");
            tokens.add("restore");
            VoiceClipPlayer.appendNumberTokens(tokens, prevCount);
        }
        speakInternal(text, tokens, false);
    }

    public void speakMove(String prodName, String mode, double qty, String unitName) {
        if (!store.ttsEnabled) return;
        String verb = "in".equals(mode) ? "入库" : "out".equals(mode) ? "出库" : "调拨";
        String text = shortName(prodName) + "，" + verb + Ui.fmtQty(qty) + (unitName == null ? "" : unitName);
        List<String> tokens = new ArrayList<>();
        tokens.add("in".equals(mode) ? "in" : "out".equals(mode) ? "out" : "transfer");
        VoiceClipPlayer.appendNumberTokens(tokens, qty);
        if (unitName != null) {
            if (unitName.contains("箱")) tokens.add("box");
            else if (unitName.contains("件")) tokens.add("piece");
        }
        speakInternal(text, tokens, false);
    }

    public void speakLowStock(String prodName, double avail) {
        if (!store.ttsEnabled) return;
        String text = shortName(prodName) + "，库存不足，仅剩" + Ui.fmtQty(avail);
        List<String> tokens = new ArrayList<>();
        tokens.add("low_stock");
        VoiceClipPlayer.appendNumberTokens(tokens, avail);
        speakInternal(text, tokens, false);
    }

    public void speakLookupStock(String prodName, double qty, String unit) {
        if (!store.ttsEnabled) return;
        String text = shortName(prodName) + "，库存" + Ui.fmtQty(qty) + (unit == null ? "" : unit);
        List<String> tokens = new ArrayList<>();
        tokens.add("stock");
        VoiceClipPlayer.appendNumberTokens(tokens, qty);
        if (unit != null) {
            if (unit.contains("箱")) tokens.add("box");
            else if (unit.contains("件")) tokens.add("piece");
        }
        speakInternal(text, tokens, false);
    }

    public void speakSerialCount(int count) {
        if (!store.ttsEnabled) return;
        String text = "序列号已扫，共" + count + "件";
        List<String> tokens = new ArrayList<>();
        tokens.add("sn_ok");
        tokens.add("pause");
        tokens.add("total");
        VoiceClipPlayer.appendNumberTokens(tokens, count);
        tokens.add("piece");
        speakInternal(text, tokens, false);
    }

    public void speakCue(String fullText, String clipKey) {
        if (!store.ttsEnabled) return;
        List<String> tokens = clipKey != null && !clipKey.isEmpty()
                ? Collections.singletonList(clipKey)
                : Collections.<String>emptyList();
        speakInternal(fullText, tokens, false);
    }

    public void speakForceCue(String fullText, String clipKey) {
        List<String> tokens = clipKey != null && !clipKey.isEmpty()
                ? Collections.singletonList(clipKey)
                : Collections.<String>emptyList();
        speakInternal(fullText, tokens, true);
    }

    private synchronized void speakInternal(String fullText, List<String> fallbackTokens, boolean force) {
        if (shutdownRequested) return;
        if (!force && !store.ttsEnabled) return;

        boolean preferBuiltin = "builtin".equals(store.ttsEngineMode);
        if (preferBuiltin || !systemChineseReady) {
            if (!preferBuiltin && !sysProbed && !sysProbing) {
                startSystemProbe();
            }
            if (fallbackTokens != null && !fallbackTokens.isEmpty()) {
                builtin.play(fallbackTokens, store.ttsRate);
            }
            return;
        }

        if (sysEngine != null && fullText != null && !fullText.trim().isEmpty()) {
            try {
                builtin.stop();
                sysEngine.setSpeechRate(store.ttsRate);
                Bundle params = new Bundle();
                params.putString(TextToSpeech.Engine.KEY_PARAM_STREAM, String.valueOf(AudioManager.STREAM_MUSIC));
                lastSysUtteranceId = "xerp_" + (++seq);
                lastFallbackTokens = fallbackTokens != null
                        ? new ArrayList<>(fallbackTokens)
                        : Collections.<String>emptyList();
                int rc = sysEngine.speak(fullText.trim(), TextToSpeech.QUEUE_FLUSH, params, lastSysUtteranceId);
                if (rc == TextToSpeech.ERROR && fallbackTokens != null && !fallbackTokens.isEmpty()) {
                    lastFallbackTokens = Collections.emptyList();
                    builtin.play(fallbackTokens, store.ttsRate);
                }
                return;
            } catch (Throwable ignored) { }
        }
        if (fallbackTokens != null && !fallbackTokens.isEmpty()) {
            builtin.play(fallbackTokens, store.ttsRate);
        }
    }

    public void speakTest(Activity act) {
        if (act == null || act.isFinishing()) return;
        try {
            AudioManager am = (AudioManager) act.getSystemService(Context.AUDIO_SERVICE);
            if (am != null && am.getStreamVolume(AudioManager.STREAM_MUSIC) == 0) {
                Ui.toast(act, "当前手机媒体音量为 0，请按音量+键调大媒体音量");
            }
        } catch (Throwable ignored) { }

        List<String> testTokens = Arrays.asList("tts_on", "pause", "plus", "d1", "pause", "total", "ten", "d5");
        boolean useSys;
        String label;
        synchronized (this) {
            useSys = !"builtin".equals(store.ttsEngineMode) && systemChineseReady && sysEngine != null;
            label = activeSysLabel;
        }
        if (useSys) {
            speakInternal("语音播报已开启，示例商品，加1，共15", testTokens, true);
            Ui.toast(act, "正在使用系统引擎「" + label + "」试听…");
        } else {
            builtin.play(testTokens, store.ttsRate);
            if ("builtin".equals(store.ttsEngineMode)) {
                Ui.toast(act, "正在使用「内置离线中文语音」试听…");
            } else {
                Ui.toast(act, "本机未检测到中文系统 TTS，已自动使用「内置离线语音」试听");
            }
        }
    }

    public synchronized String statusSummary() {
        if ("builtin".equals(store.ttsEngineMode)) {
            return "当前引擎：内置离线中文语音（播报数量/状态，不依赖手机系统 TTS）";
        }
        if (systemChineseReady) {
            return "当前引擎：系统中文 TTS「" + activeSysLabel + "」（支持念出完整商品名）";
        }
        if (sysProbing) {
            return "正在检测系统中文 TTS…（当前已就绪「内置离线语音」自动发声）";
        }
        return "本机无可用中文系统 TTS，已自动启用「内置离线语音」（无需任何设置即可播报数字与状态）";
    }

    public void openSystemTtsSettings(Activity act) {
        if (act == null || act.isFinishing()) return;
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
                Ui.toast(act, "无法打开系统设置，请手动前往设置查找文字转语音");
            }
        }
    }

    public synchronized void stop() {
        lastFallbackTokens = Collections.emptyList();
        builtin.stop();
        if (sysEngine != null) {
            try { sysEngine.stop(); } catch (Throwable ignored) { }
        }
    }

    private void shutdownSysOnly() {
        if (sysEngine != null) {
            try { sysEngine.stop(); } catch (Throwable ignored) { }
            try { sysEngine.shutdown(); } catch (Throwable ignored) { }
            sysEngine = null;
        }
    }

    public synchronized void shutdown() {
        shutdownRequested = true;
        probeQueue.clear();
        lastFallbackTokens = Collections.emptyList();
        shutdownSysOnly();
        systemChineseReady = false;
        sysProbing = false;
        builtin.shutdown();
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
