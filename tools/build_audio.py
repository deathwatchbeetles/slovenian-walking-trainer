#!/usr/bin/env python3
"""Pre-generate session audio for the Slovenian walking trainer.

For every sentence in content/week*.json this writes two baked files:
  <id>.intro.m4a   English meaning, Slovenian normal, slow, backward build-up, full, spoken note
  <id>.recall.m4a  English prompt, silence to answer, Slovenian answer, silence to repeat
plus one shadowing file per dialogue and a few spoken cues, and audio/manifest.json.

Silences are baked into the files so the phone only switches clips about every 10-30 s
(M0 showed each switch costs ~0.6 s with the screen locked).

Voices: Azure neural voices (Petra and Rok for Slovenian) when AZURE_SPEECH_KEY is set in
.env or the environment; otherwise the robotic macOS `say` voice as a stand-in.

Usage: python3 tools/build_audio.py [--dry-run]   (--dry-run only reports which voice engine would be used)
"""
import array, hashlib, json, os, re, subprocess, sys, time, urllib.error, urllib.request, wave
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
# Cache lives outside the project: the project folder is on Google Drive, where many small writes are slow.
CACHE = Path.home() / "Library" / "Caches" / "slovenian-walking-trainer"
OUT = ROOT / "audio"
SR = 24000


def read_env() -> dict:
    env = {}
    f = ROOT / ".env"
    if f.exists():
        for line in f.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.strip().startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    return env


ENV = read_env()
AZURE_KEY = os.environ.get("AZURE_SPEECH_KEY") or ENV.get("AZURE_SPEECH_KEY", "")
AZURE_REGION = os.environ.get("AZURE_SPEECH_REGION") or ENV.get("AZURE_SPEECH_REGION", "westeurope")
ENGINE = "azure-neural" if AZURE_KEY else "macos-say-standin"

# macOS stand-in (one Slovenian voice only)
SAY_VOICE = {"sl": "Tina", "en": "Samantha"}
SAY_RATE = {("sl", False): 150, ("sl", True): 105, ("en", False): 175, ("en", True): 150}
# Azure neural voices: Petra (f) and Rok (m) are the two native sl-SI voices.
AZ_VOICE = {("sl", "f"): "sl-SI-PetraNeural", ("sl", "m"): "sl-SI-RokNeural",
            ("en", "f"): "en-GB-SoniaNeural", ("en", "m"): "en-GB-SoniaNeural"}
AZ_RATE = {("sl", False): "-5%", ("sl", True): "-25%", ("en", False): "0%", ("en", True): "0%"}
_last_call = [0.0]


def azure_tts(text: str, lang: str, slow: bool, speaker: str, dest: Path) -> None:
    voice, rate = AZ_VOICE[(lang, speaker)], AZ_RATE[(lang, slow)]
    ssml = (f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{voice[:5]}'>"
            f"<voice name='{voice}'><prosody rate='{rate}'>{escape(text)}</prosody></voice></speak>")
    req = urllib.request.Request(
        f"https://{AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/v1", data=ssml.encode("utf-8"),
        headers={"Ocp-Apim-Subscription-Key": AZURE_KEY, "Content-Type": "application/ssml+xml",
                 "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm", "User-Agent": "walking-trainer-build"})
    for attempt in range(8):
        wait = 3.2 - (time.time() - _last_call[0])   # free tier allows 20 requests a minute
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            # Azure streams the WAV with placeholder sizes in the header; rewrite it properly.
            i = data.find(b"data")
            pcm = data[i + 8:] if i >= 0 else data
            with wave.open(str(dest), "wb") as w:
                w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes(pcm)
            return
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                time.sleep(15 * (attempt + 1)); continue
            if e.code in (401, 403):
                sys.exit(f"\nAzure refused the key (HTTP {e.code}). Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in .env.")
            sys.exit(f"\nAzure error HTTP {e.code} for: {text!r}")
    sys.exit("\nAzure kept rate-limiting; try again later.")


def synth(text: str, lang: str, slow: bool = False, speaker: str = "f") -> bytes:
    """Return trimmed 16-bit mono PCM at SR for `text`."""
    if ENGINE == "azure-neural":
        ident = f"{AZ_VOICE[(lang, speaker)]}|{AZ_RATE[(lang, slow)]}"
    else:
        ident = f"{SAY_VOICE[lang]}|{SAY_RATE[(lang, slow)]}"
    key = hashlib.sha1(f"{ENGINE}|{SR}|{ident}|{text}".encode()).hexdigest()
    f = CACHE / f"{key}.wav"
    if not f.exists():
        if ENGINE == "azure-neural":
            azure_tts(text, lang, slow, speaker, f)
        else:
            subprocess.run(["say", "-v", SAY_VOICE[lang], "-r", str(SAY_RATE[(lang, slow)]), "-o", str(f),
                            "--file-format=WAVE", f"--data-format=LEI16@{SR}", text], check=True)
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
    print(f"Voice engine: {ENGINE}" + (f" (region {AZURE_REGION})" if AZURE_KEY else ""))
    if "--dry-run" in sys.argv:
        return
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
