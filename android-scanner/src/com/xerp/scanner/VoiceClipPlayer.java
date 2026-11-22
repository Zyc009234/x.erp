package com.xerp.scanner;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.media.PlaybackParams;

import java.io.DataInputStream;
import java.io.InputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Zero-dependency offline Chinese voice synthesizer built on top of a compact
 * G.711 u-law phrase pack (res/raw/voice_zh_pack.bin) played via AudioTrack.
 */
public final class VoiceClipPlayer {
    private static final short[] ULAW_TABLE = new short[256];

    static {
        for (int i = 0; i < 256; i++) {
            int u = (~i) & 0xFF;
            int sign = u & 0x80;
            int exp = (u >> 4) & 0x07;
            int mant = u & 0x0F;
            int sample = ((mant << 3) + 0x84) << exp;
            sample -= 0x84;
            ULAW_TABLE[i] = (short) (sign != 0 ? -sample : sample);
        }
    }

    private final Context appCtx;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final AtomicInteger playGen = new AtomicInteger(0);

    private Map<String, byte[]> clips;
    private int sampleRate = 16000;
    private boolean loadAttempted = false;
    private volatile AudioTrack activeTrack;
    private volatile boolean released = false;

    public VoiceClipPlayer(Context ctx) {
        this.appCtx = ctx.getApplicationContext();
    }

    private synchronized void ensureLoaded() {
        if (loadAttempted) return;
        loadAttempted = true;
        Map<String, byte[]> map = new HashMap<>();
        try (InputStream raw = appCtx.getResources().openRawResource(R.raw.voice_zh_pack);
             DataInputStream dis = new DataInputStream(raw)) {
            byte[] magic = new byte[4];
            dis.readFully(magic);
            if (magic[0] != 'X' || magic[1] != 'V' || magic[2] != 'P' || magic[3] != 'K') {
                return;
            }
            sampleRate = dis.readUnsignedShort();
            if (sampleRate < 8000 || sampleRate > 48000) sampleRate = 16000;
            int count = dis.readUnsignedShort();
            for (int i = 0; i < count; i++) {
                String key = dis.readUTF();
                int len = dis.readInt();
                if (len < 0 || len > 1024 * 1024) break;
                byte[] buf = new byte[len];
                dis.readFully(buf);
                map.put(key, buf);
            }
            clips = map;
        } catch (Throwable ignored) {
            clips = null;
        }
    }

    public boolean isAvailable() {
        ensureLoaded();
        return clips != null && !clips.isEmpty();
    }

    public void warmUpAsync() {
        if (released || loadAttempted) return;
        try {
            exec.execute(this::ensureLoaded);
        } catch (Throwable ignored) { }
    }

    public void play(final List<String> keys, final float speed) {
        if (released || keys == null || keys.isEmpty()) return;
        final int gen = playGen.incrementAndGet();
        AudioTrack prev = activeTrack;
        if (prev != null) {
            try {
                prev.pause();
                prev.flush();
            } catch (Throwable ignored) { }
        }
        try {
            exec.execute(() -> playInternal(keys, speed, gen));
        } catch (Throwable ignored) { }
    }

    private void playInternal(List<String> keys, float speed, int gen) {
        if (released || gen != playGen.get()) return;
        ensureLoaded();
        if (clips == null || clips.isEmpty()) return;

        int leadSamples = (sampleRate * 40) / 1000;
        int gapSamples = (sampleRate * 25) / 1000;
        int pauseSamples = (sampleRate * 90) / 1000;
        int tailSamples = (sampleRate * 80) / 1000;

        int audioSamples = 0;
        boolean hasPrevClip = false;
        for (String key : keys) {
            if ("pause".equals(key)) {
                if (hasPrevClip) audioSamples += pauseSamples;
                hasPrevClip = false;
                continue;
            }
            byte[] u = clips.get(key);
            if (u == null || u.length == 0) continue;
            if (hasPrevClip) audioSamples += gapSamples;
            audioSamples += u.length;
            hasPrevClip = true;
        }
        if (audioSamples == 0) return;

        int total = leadSamples + audioSamples + tailSamples;
        short[] pcm = new short[total];
        int pos = leadSamples;
        hasPrevClip = false;
        for (String key : keys) {
            if ("pause".equals(key)) {
                if (hasPrevClip) pos += pauseSamples;
                hasPrevClip = false;
                continue;
            }
            byte[] u = clips.get(key);
            if (u == null || u.length == 0) continue;
            if (hasPrevClip) pos += gapSamples;
            for (int i = 0; i < u.length; i++) {
                pcm[pos++] = ULAW_TABLE[u[i] & 0xFF];
            }
            hasPrevClip = true;
        }

        if (released || gen != playGen.get()) return;

        AudioTrack track = null;
        try {
            int minBuf = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT);
            int bufBytes = Math.max(minBuf > 0 ? minBuf : 2048, 4096);
            track = new AudioTrack.Builder()
                    .setAudioAttributes(new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build())
                    .setAudioFormat(new AudioFormat.Builder()
                            .setSampleRate(sampleRate)
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                            .build())
                    .setBufferSizeInBytes(bufBytes)
                    .setTransferMode(AudioTrack.MODE_STREAM)
                    .build();

            float sp = Math.max(0.75f, Math.min(2.0f, speed));
            if (Math.abs(sp - 1.0f) > 0.02f) {
                try {
                    PlaybackParams pp = new PlaybackParams();
                    pp.setSpeed(sp);
                    track.setPlaybackParams(pp);
                } catch (Throwable ignored) { }
            }

            activeTrack = track;
            track.play();
            int off = 0;
            while (off < total && !released && gen == playGen.get()) {
                int chunk = Math.min(1024, total - off);
                int written = track.write(pcm, off, chunk);
                if (written <= 0) break;
                off += written;
            }
            if (!released && gen == playGen.get()) {
                try { track.stop(); } catch (Throwable ignored) { }
            } else {
                try {
                    track.pause();
                    track.flush();
                } catch (Throwable ignored) { }
            }
        } catch (Throwable ignored) {
        } finally {
            if (track != null) {
                if (activeTrack == track) activeTrack = null;
                try { track.release(); } catch (Throwable ignored) { }
            }
        }
    }

    public void stop() {
        playGen.incrementAndGet();
        AudioTrack prev = activeTrack;
        if (prev != null) {
            try {
                prev.pause();
                prev.flush();
            } catch (Throwable ignored) { }
        }
    }

    public void shutdown() {
        released = true;
        stop();
        try { exec.shutdownNow(); } catch (Throwable ignored) { }
    }

    public static void appendNumberTokens(List<String> out, double val) {
        long hundredths = Math.round(Math.max(0, val) * 100.0);
        long intPart = hundredths / 100;
        int dec = (int) (hundredths % 100);

        if (intPart == 0) {
            out.add("d0");
        } else if (intPart >= 1000000) {
            String s = String.valueOf(intPart);
            for (int i = 0; i < s.length(); i++) {
                out.add("d" + s.charAt(i));
            }
        } else {
            int wan = (int) (intPart / 10000);
            int rem = (int) (intPart % 10000);
            if (wan > 0) {
                appendUnder10000(out, wan, false);
                out.add("wan");
                if (rem > 0) {
                    if (rem < 1000) out.add("d0");
                    appendUnder10000(out, rem, true);
                }
            } else {
                appendUnder10000(out, rem, false);
            }
        }

        if (dec > 0) {
            out.add("dot");
            int d1 = dec / 10;
            int d2 = dec % 10;
            out.add("d" + d1);
            if (d2 > 0) out.add("d" + d2);
        }
    }

    private static void appendUnder10000(List<String> out, int n, boolean hasHigherWan) {
        int th = n / 1000;
        int hu = (n / 100) % 10;
        int te = (n / 10) % 10;
        int on = n % 10;
        boolean needZero = false;

        if (th > 0) {
            out.add("d" + th);
            out.add("thousand");
        }

        if (hu > 0) {
            out.add("d" + hu);
            out.add("hundred");
        } else if (th > 0 && (te > 0 || on > 0)) {
            needZero = true;
        }

        if (te > 0) {
            if (needZero) {
                out.add("d0");
                needZero = false;
            }
            if (!(te == 1 && th == 0 && hu == 0 && !hasHigherWan)) {
                out.add("d" + te);
            }
            out.add("ten");
        } else if ((th > 0 || hu > 0) && on > 0) {
            needZero = true;
        }

        if (on > 0) {
            if (needZero) out.add("d0");
            out.add("d" + on);
        }
    }
}
