#!/usr/bin/env python3
"""Step 4: Assemble final video using FFmpeg.

Pipeline per segment:
  image (Ken Burns zoom) + audio → segment_N.mp4

Final assembly:
  concat all segments → add SRT subtitles → mix BGM → final.mp4

Usage:
    python3 render_video.py video-01
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent
BUILD_DIR = ROOT / "build"
ASSETS_DIR = ROOT / "assets"

# Video specs (vertical 9:16 short video)
WIDTH = 1080
HEIGHT = 1920
FPS = 30


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


def find_ffmpeg(env: dict) -> str | None:
    custom = env.get("FFMPEG_PATH", "").strip()
    if custom and Path(custom).exists():
        return custom
    found = shutil.which("ffmpeg")
    if found:
        return found
    for p in [
        "/opt/homebrew/bin/ffmpeg",
        "/usr/local/bin/ffmpeg",
        "/usr/bin/ffmpeg",
        str(ROOT / "bin" / "ffmpeg"),
    ]:
        if Path(p).exists():
            return p
    return None


def find_chinese_font() -> str | None:
    candidates = [
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Supplemental/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/Library/Fonts/Arial Unicode MS.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode MS.ttf",
    ]
    for f in candidates:
        if Path(f).exists():
            return f
    return None


def run_ffmpeg(ffmpeg: str, args: list[str], desc: str) -> bool:
    cmd = [ffmpeg, "-y"] + args
    print(f"    {desc}")
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"    ✗ FFmpeg error:\n{result.stderr[-800:]}")
        return False
    return True


def seconds_to_srt_time(s: float) -> str:
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = int(s % 60)
    ms = int((s - int(s)) * 1000)
    return f"{h:02d}:{m:02d}:{sec:02d},{ms:03d}"


def wrap_chinese(text: str, max_chars: int = 16) -> str:
    """Wrap Chinese text at max_chars per line."""
    if len(text) <= max_chars:
        return text
    lines = []
    while text:
        lines.append(text[:max_chars])
        text = text[max_chars:]
    return "\n".join(lines)


def build_srt(script: dict, timings: dict[str, float]) -> str:
    """Build SRT subtitle content from script segments and audio durations."""
    lines = []
    cursor = 0.0
    for i, seg in enumerate(script["segments"]):
        seg_id = seg["segmentId"]
        dur = timings.get(seg_id, 8.0)
        start = cursor
        end = cursor + dur
        cursor = end

        narration = seg.get("narration", "")
        wrapped = wrap_chinese(narration, 16)

        lines.append(str(i + 1))
        lines.append(f"{seconds_to_srt_time(start)} --> {seconds_to_srt_time(end)}")
        lines.append(wrapped)
        lines.append("")

    return "\n".join(lines)


def make_segment_video(
    ffmpeg: str,
    image_path: Path,
    audio_path: Path,
    duration: float,
    out_path: Path,
) -> bool:
    """Render a single segment: image with Ken Burns + audio."""
    # Ken Burns: slow zoom in (scale up 4% over duration, center crop)
    total_frames = max(int(duration * FPS), 1)
    kb_filter = (
        f"scale={WIDTH + 80}:{HEIGHT + 80}:force_original_aspect_ratio=cover,"
        f"crop={WIDTH}:{HEIGHT},"
        f"zoompan=z='min(zoom+0.0002,1.04)':d={total_frames}:s={WIDTH}x{HEIGHT}:fps={FPS}"
    )

    return run_ffmpeg(
        ffmpeg,
        [
            "-loop", "1", "-i", str(image_path),
            "-i", str(audio_path),
            "-vf", kb_filter,
            "-c:v", "libx264", "-preset", "fast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k",
            "-t", str(duration + 0.1),  # tiny tail buffer
            "-pix_fmt", "yuv420p",
            "-r", str(FPS),
            str(out_path),
        ],
        f"Segment {out_path.stem} ({duration:.1f}s)",
    )


def concat_segments(ffmpeg: str, segment_files: list[Path], out_path: Path) -> bool:
    """Concatenate segment .mp4 files without re-encoding."""
    concat_txt = out_path.parent / "_concat.txt"
    concat_txt.write_text(
        "\n".join(f"file '{p.resolve()}'" for p in segment_files),
        encoding="utf-8",
    )
    ok = run_ffmpeg(
        ffmpeg,
        [
            "-f", "concat", "-safe", "0", "-i", str(concat_txt),
            "-c:v", "libx264", "-preset", "fast", "-crf", "22",
            "-c:a", "aac", "-b:a", "128k",
            "-pix_fmt", "yuv420p",
            str(out_path),
        ],
        f"Concatenating {len(segment_files)} segments",
    )
    concat_txt.unlink(missing_ok=True)
    return ok


def burn_subtitles(ffmpeg: str, video_path: Path, srt_path: Path, font: str | None, out_path: Path) -> bool:
    """Burn SRT subtitles into video."""
    force_style = (
        "Fontname=PingFang SC,Fontsize=42,Bold=1,"
        "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,"
        "BackColour=&H60000000,BorderStyle=3,Outline=3,"
        "Shadow=0,Alignment=2,MarginV=60"
    )
    if font:
        # Use fontsdir approach for custom font
        font_dir = str(Path(font).parent)
        sub_filter = f"subtitles={srt_path}:fontsdir={font_dir}:force_style='{force_style}'"
    else:
        sub_filter = f"subtitles={srt_path}:force_style='{force_style}'"

    return run_ffmpeg(
        ffmpeg,
        [
            "-i", str(video_path),
            "-vf", sub_filter,
            "-c:v", "libx264", "-preset", "fast", "-crf", "22",
            "-c:a", "copy",
            "-pix_fmt", "yuv420p",
            str(out_path),
        ],
        "Burning subtitles",
    )


def mix_bgm(ffmpeg: str, video_path: Path, bgm_path: Path, out_path: Path) -> bool:
    """Mix background music at 30% volume."""
    if not bgm_path.exists():
        print("    [skip] No bgm.mp3 in assets/ — video has no background music")
        shutil.copy(video_path, out_path)
        return True

    return run_ffmpeg(
        ffmpeg,
        [
            "-i", str(video_path),
            "-stream_loop", "-1", "-i", str(bgm_path),
            "-filter_complex",
            "[0:a][1:a]amix=inputs=2:weights=1 0.3:duration=first[aout]",
            "-map", "0:v", "-map", "[aout]",
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "160k",
            str(out_path),
        ],
        "Mixing background music (30% volume)",
    )


def main(video_id: str) -> None:
    env = load_env()
    ffmpeg = find_ffmpeg(env)
    if not ffmpeg:
        print("ERROR: ffmpeg not found.")
        print("Download from https://evermeet.cx/ffmpeg/ (macOS static build)")
        print("Then either:")
        print("  1. Place binary at ./bin/ffmpeg  (chmod +x ./bin/ffmpeg)")
        print("  2. Set FFMPEG_PATH=/path/to/ffmpeg in .env")
        sys.exit(1)

    font = find_chinese_font()
    print(f"\n[render_video] {video_id}")
    print(f"  ffmpeg: {ffmpeg}")
    print(f"  font:   {font or 'not found (subtitles may not render Chinese correctly)'}\n")

    plan_path = BUILD_DIR / video_id / "plan.json"
    script_path = BUILD_DIR / video_id / "script.json"
    timings_path = BUILD_DIR / video_id / "audio_timings.json"

    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    script = json.loads(script_path.read_text(encoding="utf-8"))

    # Load audio timings
    timings: dict[str, float] = {}
    if timings_path.exists():
        for t in json.loads(timings_path.read_text(encoding="utf-8")):
            timings[t["segmentId"]] = t["duration"]

    img_dir = BUILD_DIR / video_id / "images"
    audio_dir = BUILD_DIR / video_id / "audio"
    tmp_dir = BUILD_DIR / video_id / "_tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # --- Step A: Render each segment ---
    segment_files: list[Path] = []

    for i, shot in enumerate(plan["shots"]):
        seg_id = shot["segmentId"]

        # Find image file
        img_matches = sorted(img_dir.glob(f"{i:02d}_{seg_id}.*"))
        if not img_matches:
            img_matches = sorted(img_dir.glob(f"*{seg_id}*"))
        if not img_matches:
            print(f"  [{i+1}] WARNING: No image for {seg_id}, skipping")
            continue

        # Find audio file
        aud_matches = sorted(audio_dir.glob(f"{i:02d}_{seg_id}.*"))
        if not aud_matches:
            aud_matches = sorted(audio_dir.glob(f"*{seg_id}*"))
        if not aud_matches:
            print(f"  [{i+1}] WARNING: No audio for {seg_id}, skipping")
            continue

        # Use actual audio duration (+ 0.4s buffer) or fall back to planned
        duration = timings.get(seg_id, shot["seconds"])
        if duration <= 0:
            duration = shot["seconds"]

        seg_out = tmp_dir / f"{i:02d}_{seg_id}.mp4"
        print(f"\n  [{i+1}/{len(plan['shots'])}] {seg_id} ({duration:.1f}s)")

        if seg_out.exists():
            print("    [skip] already rendered")
            segment_files.append(seg_out)
            continue

        ok = make_segment_video(ffmpeg, img_matches[0], aud_matches[0], duration, seg_out)
        if ok:
            segment_files.append(seg_out)

    if not segment_files:
        print("\nERROR: No segments rendered successfully.")
        sys.exit(1)

    # --- Step B: Concatenate ---
    concat_out = BUILD_DIR / video_id / "_concat.mp4"
    print(f"\n  Concatenating {len(segment_files)} segments ...")
    if not concat_segments(ffmpeg, segment_files, concat_out):
        sys.exit(1)

    # --- Step C: Build and burn SRT subtitles ---
    srt_content = build_srt(script, timings)
    srt_path = BUILD_DIR / video_id / "subtitles.srt"
    srt_path.write_text(srt_content, encoding="utf-8")
    print(f"\n  SRT file → {srt_path}")

    sub_out = BUILD_DIR / video_id / "_with_subs.mp4"
    print("  Burning subtitles ...")
    if not burn_subtitles(ffmpeg, concat_out, srt_path, font, sub_out):
        print("  WARNING: Subtitle burning failed. Continuing without subtitles.")
        shutil.copy(concat_out, sub_out)

    # --- Step D: Mix BGM ---
    final_out = BUILD_DIR / video_id / "final.mp4"
    print("\n  Mixing BGM ...")
    mix_bgm(ffmpeg, sub_out, ASSETS_DIR / "bgm.mp3", final_out)

    # Clean up intermediates
    concat_out.unlink(missing_ok=True)
    sub_out.unlink(missing_ok=True)

    print(f"\n{'='*50}")
    print(f"✅ Final video → {final_out}")
    print(f"{'='*50}")


if __name__ == "__main__":
    vid = sys.argv[1] if len(sys.argv) > 1 else "video-01"
    main(vid)
