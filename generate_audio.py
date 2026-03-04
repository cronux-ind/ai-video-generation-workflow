#!/usr/bin/env python3
"""Step 3: Generate audio for each segment using ElevenLabs TTS.

Usage:
    python3 generate_audio.py video-01            # generate audio
    python3 generate_audio.py --list-voices       # list available voices (set VOICE_ID after)
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).parent
BUILD_DIR = ROOT / "build"


def load_env() -> dict:
    env: dict = {}
    env_path = ROOT / ".env"
    if env_path.exists():
        for line in env_path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, _, v = line.partition("=")
                env[k.strip()] = v.strip()
    return env


def get_audio_duration(mp3_path: Path) -> float:
    """Return duration in seconds using mutagen."""
    try:
        from mutagen.mp3 import MP3
        return MP3(str(mp3_path)).info.length
    except Exception:
        return 0.0


def list_voices(api_key: str) -> None:
    """Print available ElevenLabs voices. Filter to find Chinese-capable ones."""
    from elevenlabs import ElevenLabs

    client = ElevenLabs(api_key=api_key)
    voices = client.voices.get_all()

    print(f"\n{'='*70}")
    print("Available ElevenLabs Voices")
    print(f"{'='*70}")
    print(f"{'Name':<30} {'Voice ID':<36} Labels")
    print("-" * 70)

    for v in voices.voices:
        labels = v.labels or {}
        label_str = ", ".join(f"{k}={val}" for k, val in labels.items())
        print(f"{v.name:<30} {v.voice_id:<36} {label_str}")

    print(f"\n→ Copy a voice_id above and set ELEVENLABS_VOICE_ID in .env")
    print(f"  Recommended for Chinese: look for 'language=zh' or try 'Charlotte'")


def main(video_id: str) -> None:
    env = load_env()
    api_key = env.get("ELEVENLABS_API_KEY")
    if not api_key:
        print("ERROR: ELEVENLABS_API_KEY not set in .env")
        sys.exit(1)

    voice_id = env.get("ELEVENLABS_VOICE_ID", "").strip()
    if not voice_id:
        print("ELEVENLABS_VOICE_ID is not set.")
        print("Running --list-voices to help you choose...\n")
        list_voices(api_key)
        sys.exit(0)

    model_id = env.get("ELEVENLABS_MODEL_ID", "eleven_multilingual_v2")
    stability = float(env.get("ELEVENLABS_STABILITY", "0.45"))
    similarity = float(env.get("ELEVENLABS_SIMILARITY", "0.75"))
    style_val = float(env.get("ELEVENLABS_STYLE", "0.25"))

    script_path = BUILD_DIR / video_id / "script.json"
    if not script_path.exists():
        print(f"ERROR: {script_path} not found. Run generate_script.py first.")
        sys.exit(1)

    script = json.loads(script_path.read_text(encoding="utf-8"))
    audio_dir = BUILD_DIR / video_id / "audio"
    audio_dir.mkdir(parents=True, exist_ok=True)

    from elevenlabs import ElevenLabs
    from elevenlabs.types import VoiceSettings

    client = ElevenLabs(api_key=api_key)

    print(f"\n[generate_audio] {video_id}")
    print(f"  Voice: {voice_id}  Model: {model_id}\n")

    timings = []

    for i, seg in enumerate(script["segments"]):
        seg_id = seg["segmentId"]
        out_path = audio_dir / f"{i:02d}_{seg_id}.mp3"

        if out_path.exists():
            dur = get_audio_duration(out_path)
            print(f"  [{i+1}/{len(script['segments'])}] {seg_id} — skip (exists, {dur:.1f}s)")
            timings.append({"segmentId": seg_id, "duration": dur, "file": out_path.name})
            continue

        # Use ttsText if available (voice-optimised), else narration
        text = seg.get("ttsText") or seg.get("narration", "")
        if not text:
            print(f"  [{i+1}] {seg_id} — WARNING: no text, skipping")
            continue

        print(f"  [{i+1}/{len(script['segments'])}] {seg_id} ({len(text)} chars) ...", end=" ", flush=True)

        audio_stream = client.text_to_speech.convert(
            voice_id=voice_id,
            text=text,
            model_id=model_id,
            voice_settings=VoiceSettings(
                stability=stability,
                similarity_boost=similarity,
                style=style_val,
                use_speaker_boost=True,
            ),
            output_format="mp3_44100_128",
        )

        audio_data = b"".join(audio_stream)
        out_path.write_bytes(audio_data)

        dur = get_audio_duration(out_path)
        timings.append({"segmentId": seg_id, "duration": dur, "file": out_path.name})
        print(f"✓  ({dur:.1f}s, {len(audio_data) // 1024} KB)")

    # Save timings for the render step
    timings_path = BUILD_DIR / video_id / "audio_timings.json"
    timings_path.write_text(json.dumps(timings, ensure_ascii=False, indent=2), encoding="utf-8")

    total_dur = sum(t["duration"] for t in timings)
    print(f"\n✅ Audio saved → {audio_dir}")
    print(f"   Total duration: {total_dur:.1f}s  ({len(timings)} segments)")
    print(f"   Timings → {timings_path}")


if __name__ == "__main__":
    if "--list-voices" in sys.argv:
        env = load_env()
        api_key = env.get("ELEVENLABS_API_KEY", "")
        if not api_key:
            print("ERROR: ELEVENLABS_API_KEY not set in .env")
            sys.exit(1)
        list_voices(api_key)
    else:
        vid = sys.argv[1] if len(sys.argv) > 1 else "video-01"
        main(vid)
