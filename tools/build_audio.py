#!/usr/bin/env python3
"""Pre-generate session audio for the Slovenian walking trainer.

For every sentence in content/week*.json this writes two baked files:
  <id>.intro.m4a   English meaning, Slovenian normal, slow, backward build-up, full, spoken note
  <id>.recall.m4a  English prompt, silence to answer, Slovenian answer, silence to repeat
plus one shadowing file per dialogue and a few spoken cues, and audio/manifest.json.

Silences are baked into the files so the phone only switches clips about every 10-30 s
(M0 showed each switch costs ~0.6 s with the screen locked).

Voices: currently the macOS `say` voices as a stand-in. To move to a neural provider,
replace synth() only; everything else works on raw PCM.

Usage: python3 tools/build_audio.py
"""
import array, hashlib, json, re, subprocess, sys, wave
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache"
OUT = ROOT / "audio"
SR = 22050
ENGINE = "macos-say-standin"
VOICE = {"sl": "Tina", "en": "Samantha"}
RATE = {("sl", False): 150, ("sl", True): 105, ("en", False): 175, ("en", True): 150}


def synth(text: str, lang: str, slow: bool = False, speaker: str = "f") -> bytes:
    """Return trimmed 16-bit mono PCM at SR for `text`. `speaker` is unused until there are two voices."""
    voice, rate = VOICE[lang], RATE[(lang, slow)]
    key = hashlib.sha1(f"{ENGINE}|{voice}|{rate}|{text}".encode()).hexdigest()
    f = CACHE / f"{key}.wav"
    if not f.exists():
        subprocess.run(["say", "-v", voice, "-r", str(rate), "-o", str(f), "--file-format=WAVE",
                        f"--data-format=LEI16@{SR}", text], check=True)
    with wave.open(str(f)) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        pcm = w.readframes(w.getnframes())
    return trim(pcm)


def trim(pcm: bytes, thresh: int = 300) -> bytes:
    a = array.array("h"); a.frombytes(pcm)
    i, j = 0, len(a)
    while i < j and abs(a[i]) < thresh: i += 1
    while j > i and abs(a[j - 1]) < thresh: j -= 1
    pad = int(0.03 * SR)
    return a[max(0, i - pad):min(len(a), j + pad)].tobytes()


def sil(sec: float) -> bytes:
    return bytes(int(sec * SR) * 2)


def dur(pcm: bytes) -> float:
    return len(pcm) / 2 / SR


def mixed(note: str) -> bytes:
    """English text with {Slovenian} spans, each spoken by the right voice."""
    out = b""
    for part in re.split(r"(\{[^}]*\})", note):
        part = part.strip()
        if not part or not re.search(r"\w", part):
            continue
        if part.startswith("{"):
            out += sil(0.15) + synth(part[1:-1], "sl", slow=True) + sil(0.2)
        else:
            out += synth(part, "en")
    return out


def answer_gap(sl_pcm: bytes) -> float:   # time to produce the sentence from memory
    return max(2.5, dur(sl_pcm) * 1.6 + 1.5)


def repeat_gap(sl_pcm: bytes) -> float:   # time to repeat what was just heard
    return max(1.8, dur(sl_pcm) * 1.25 + 0.8)


def write(name: str, pcm: bytes) -> dict:
    tmp = CACHE / "_tmp.wav"
    with wave.open(str(tmp), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
    subprocess.run(["afconvert", "-f", "m4af", "-d", "aac", "-b", "32000", str(tmp), str(OUT / name)], check=True)
    return {"file": name, "dur": round(dur(pcm), 2)}


def build_recall(s: dict) -> dict:
    prompt = s["en"] + (f" {s['hint'].capitalize()}." if s.get("hint") else "")
    en, sl = synth(prompt, "en"), synth(s["sl"], "sl", speaker=s["speaker"])
    g1 = answer_gap(sl)
    pcm = sil(0.3) + en + sil(g1) + sl + sil(repeat_gap(sl))
    info = write(f"{s['id']}.recall.m4a", pcm)
    info["reveal"] = round(0.3 + dur(en) + g1, 2)
    return info


def build_intro(s: dict) -> dict:
    en = synth(s["en"], "en")
    sl = synth(s["sl"], "sl", speaker=s["speaker"])
    slow = synth(s["sl"], "sl", slow=True, speaker=s["speaker"])
    pcm = sil(0.3) + en + sil(0.7) + sl + sil(repeat_gap(sl)) + slow + sil(repeat_gap(slow))
    for ch in s.get("chunks", []):
        if ch.strip() == s["sl"].strip():
            continue
        c = synth(ch, "sl", slow=True, speaker=s["speaker"])
        pcm += c + sil(repeat_gap(c))
    pcm += sl + sil(repeat_gap(sl))
    if s.get("grammar_note"):
        pcm += sil(0.3) + mixed(s["grammar_note"]) + sil(0.5) + sl + sil(repeat_gap(sl))
    return write(f"{s['id']}.intro.m4a", pcm)


def build_shadow(did: str, sents: list) -> dict:
    once = b"".join(synth(s["sl"], "sl", speaker=s["speaker"]) + sil(0.45) for s in sents)
    return write(f"{did}.shadow.m4a", sil(0.4) + once + sil(1.5) + once + sil(0.8))


def main():
    CACHE.mkdir(parents=True, exist_ok=True); OUT.mkdir(exist_ok=True)
    for old in OUT.glob("*.m4a"):
        old.unlink()
    manifest = {"engine": ENGINE, "dialogues": [], "cards": {}, "cues": {}}
    for f in sorted((ROOT / "content").glob("week*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        for d in data["dialogues"]:
            sents = [s for s in data["sentences"] if s["dialogue"] == d["id"]]
            for s in sents:
                manifest["cards"][s["id"]] = {
                    "sl": s["sl"], "en": s["en"], "hint": s.get("hint"),
                    "note": re.sub(r"[{}]", "", s["grammar_note"]) if s.get("grammar_note") else None,
                    "intro": build_intro(s), "recall": build_recall(s),
                }
                print(".", end="", flush=True)
            manifest["dialogues"].append({
                "id": d["id"], "title": d["title"], "week": data["week"], "sentences": [s["id"] for s in sents],
                "shadow": build_shadow(d["id"], sents),
                "cue": write(f"{d['id']}.cue.m4a", sil(0.4) + synth(f"New dialogue. {d['title']}.", "en") + sil(0.8)),
            })
    cues = {
        "review": "Review. Say each sentence in Slovenian before you hear it.",
        "recall": "Now from memory.",
        "again": "Once more, in a different order.",
        "shadow": "Now the whole dialogue, twice. Speak along.",
        "done": "Session complete.",
    }
    for k, text in cues.items():
        manifest["cues"][k] = write(f"cue.{k}.m4a", sil(0.4) + synth(text, "en") + sil(0.8))
    (OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")
    files = list(OUT.glob("*.m4a"))
    total = sum(c["intro"]["dur"] + c["recall"]["dur"] for c in manifest["cards"].values())
    print(f"\n{len(files)} files, {sum(p.stat().st_size for p in files)/1e6:.1f} MB, {len(manifest['cards'])} cards, {total/60:.1f} min of card audio")


if __name__ == "__main__":
    sys.exit(main())
