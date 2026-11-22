#!/usr/bin/env python3
"""
Generate bundled offline Chinese voice pack for x.erp Android Scanner:
  android-scanner/res/raw/voice_zh_pack.bin

Format (big-endian):
  4 bytes  magic "XVPK"
  uint16   sampleRate (16000)
  uint16   entryCount
  For each entry:
    uint16 + UTF-8 bytes  key (Java DataOutput.writeUTF)
    int32                 ulawByteLen
    byte[ulawByteLen]     ITU-T G.711 u-law 8-bit samples
"""

import audioop
import os
import shutil
import struct
import subprocess
import wave

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_PATH = os.path.join(ROOT, "res", "raw", "voice_zh_pack.bin")
TMP_DIR = "/Users/wenhuzhao/.gemini/antigravity/brain/501cb56a-1edb-488c-b37e-ee6d53983be6/scratch/voice_tmp"

SAMPLE_RATE = 16000
VOICE_NAME = "Tingting"
SPEECH_RATE = "200"

PHRASES = [
    # Digits
    ("d0", "零"),
    ("d1", "一"),
    ("d2", "二"),
    ("d3", "三"),
    ("d4", "四"),
    ("d5", "五"),
    ("d6", "六"),
    ("d7", "七"),
    ("d8", "八"),
    ("d9", "九"),
    ("ten", "十"),
    ("hundred", "百"),
    ("thousand", "千"),
    ("wan", "万"),
    ("dot", "点"),
    # Actions & units
    ("plus", "加"),
    ("minus", "减"),
    ("total", "共"),
    ("box", "箱"),
    ("piece", "件"),
    ("in", "入库"),
    ("out", "出库"),
    ("transfer", "调拨"),
    ("counted", "实盘"),
    ("stock", "库存"),
    # Warehouse status phrases
    ("low_stock", "库存不足，仅剩"),
    ("not_found", "未找到条码"),
    ("not_recorded", "未收录条码"),
    ("undo", "已撤销"),
    ("restore", "恢复为"),
    ("saved", "盘点已保存"),
    ("posted", "盘点已审核"),
    ("submitted", "单据已提交"),
    ("sn_ok", "序列号已扫"),
    ("sn_dup", "重复序列号"),
    ("sn_err", "序列号异常"),
    ("sn_scan", "请扫序列号"),
    ("blind_on", "已开启盲盘模式"),
    ("blind_off", "已关闭盲盘模式"),
    ("tts_on", "语音播报已开启"),
    ("batch_found", "找到批次记录"),
    ("serial_in", "序列号在库"),
    ("serial_out", "序列号已出库"),
]


def verify_java_ulaw_table():
    """Verify Java's G.711 u-law decoder matches Python audioop.ulaw2lin for all 256 bytes."""
    for i in range(256):
        u = (~i) & 0xFF
        sign = u & 0x80
        exp = (u >> 4) & 0x07
        mant = u & 0x0F
        sample = ((mant << 3) + 0x84) << exp
        sample -= 0x84
        java_val = -sample if sign != 0 else sample
        py_val = struct.unpack("<h", audioop.ulaw2lin(bytes([i]), 2))[0]
        if java_val != py_val:
            raise AssertionError(f"u-law mismatch at {i}: java={java_val}, py={py_val}")
    print("Verified: Java ULAW_TABLE matches ITU-T G.711 u-law 100% (256/256).")


def read_pcm16_mono_16k(wav_path):
    with wave.open(wav_path, "rb") as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
    if ch == 1 and sw == 2 and sr == SAMPLE_RATE:
        return list(struct.unpack(f"<{len(raw) // 2}h", raw))
    return None


def synth_clip(key, text):
    raw_wav = os.path.join(TMP_DIR, f"{key}_raw.wav")
    conv_wav = os.path.join(TMP_DIR, f"{key}_16k.wav")
    subprocess.run(
        ["say", "-v", VOICE_NAME, "-r", SPEECH_RATE,
         "--file-format=WAVE", f"--data-format=LEI16@{SAMPLE_RATE}",
         "-o", raw_wav, text],
        check=True,
    )
    samples = read_pcm16_mono_16k(raw_wav)
    if samples is None:
        subprocess.run(
            ["afconvert", "-f", "WAVE", "-d", f"LEI16@{SAMPLE_RATE}", "-c", "1",
             raw_wav, conv_wav],
            check=True,
        )
        samples = read_pcm16_mono_16k(conv_wav)
    if not samples:
        raise RuntimeError(f"Empty PCM for {key} ({text})")

    # 1. Trim leading/trailing silence (threshold > 350, keep 12ms lead / 25ms tail)
    thresh = 350
    first = None
    last = None
    for idx, s in enumerate(samples):
        if abs(s) > thresh:
            if first is None:
                first = idx
            last = idx
    if first is None or last is None:
        raise RuntimeError(f"Silent clip for {key} ({text}), peak={max(abs(s) for s in samples)}")

    lead_pad = int(SAMPLE_RATE * 0.012)
    tail_pad = int(SAMPLE_RATE * 0.025)
    start = max(0, first - lead_pad)
    end = min(len(samples), last + 1 + tail_pad)
    trimmed = samples[start:end]

    dur_ms = len(trimmed) * 1000.0 / SAMPLE_RATE
    if dur_ms < 80 or dur_ms > 2500:
        raise AssertionError(f"Clip duration out of range for {key} ({text}): {dur_ms:.1f} ms")

    # 2. Peak normalize to 26000
    peak = max(abs(s) for s in trimmed)
    if peak == 0:
        raise RuntimeError(f"Zero peak for {key}")
    scale = 26000.0 / peak
    norm = [max(-32767, min(32767, int(round(s * scale)))) for s in trimmed]

    # 3. 5ms fade-in + 8ms fade-out
    fade_in = min(len(norm), int(SAMPLE_RATE * 0.005))
    fade_out = min(len(norm), int(SAMPLE_RATE * 0.008))
    for i in range(fade_in):
        norm[i] = int(round(norm[i] * (i / float(fade_in))))
    for i in range(fade_out):
        idx = len(norm) - 1 - i
        norm[idx] = int(round(norm[idx] * (i / float(fade_out))))

    pcm_bytes = struct.pack(f"<{len(norm)}h", *norm)
    ulaw_bytes = audioop.lin2ulaw(pcm_bytes, 2)
    return ulaw_bytes, dur_ms, peak


def main():
    verify_java_ulaw_table()
    if os.path.exists(TMP_DIR):
        shutil.rmtree(TMP_DIR)
    os.makedirs(TMP_DIR, exist_ok=True)
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)

    try:
        entries = []
        total_ms = 0.0
        for key, text in PHRASES:
            ulaw, dur_ms, raw_peak = synth_clip(key, text)
            entries.append((key, ulaw))
            total_ms += dur_ms
            print(f"  {key:12s} ({text:8s}): {dur_ms:6.1f} ms | peak={raw_peak:5d} | {len(ulaw):5d} B")

        with open(OUT_PATH, "wb") as f:
            f.write(b"XVPK")
            f.write(struct.pack(">HH", SAMPLE_RATE, len(entries)))
            for key, ulaw in entries:
                kb = key.encode("utf-8")
                f.write(struct.pack(">H", len(kb)))
                f.write(kb)
                f.write(struct.pack(">i", len(ulaw)))
                f.write(ulaw)

        size_kb = os.path.getsize(OUT_PATH) / 1024.0
        print(f"Wrote {OUT_PATH}: {len(entries)} clips, {total_ms / 1000.0:.2f}s audio, {size_kb:.1f} KB")
    finally:
        shutil.rmtree(TMP_DIR, ignore_errors=True)


if __name__ == "__main__":
    main()
