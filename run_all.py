#!/usr/bin/env python3
"""One-click pipeline: runs all 4 steps for one or all videos.

Usage:
    python3 run_all.py                  # all 3 videos
    python3 run_all.py video-01         # single video
    python3 run_all.py video-01 video-02  # specific videos
"""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).parent

STEPS = [
    ("generate_script.py",  "Script generation (Gemini)"),
    ("generate_image.py",   "Image generation (Nano Banana 2)"),
    ("generate_audio.py",   "Audio generation (ElevenLabs)"),
    ("render_video.py",     "Video render (FFmpeg)"),
]

ALL_VIDEOS = ["video-01", "video-02", "video-03"]


def run_step(script_name: str, video_id: str) -> bool:
    script_path = ROOT / script_name
    print(f"\n{'─'*60}")
    print(f"  {script_name}  [{video_id}]")
    print(f"{'─'*60}")
    result = subprocess.run(
        [sys.executable, str(script_path), video_id],
        cwd=str(ROOT),
    )
    return result.returncode == 0


def main() -> None:
    args = sys.argv[1:]
    videos = args if args else ALL_VIDEOS

    print(f"\n{'='*60}")
    print("  Finance Video Pipeline")
    print(f"  Videos: {', '.join(videos)}")
    print(f"{'='*60}")

    for video_id in videos:
        print(f"\n\n{'#'*60}")
        print(f"  Processing: {video_id}")
        print(f"{'#'*60}")

        for script_name, desc in STEPS:
            print(f"\n→ {desc}")
            if not run_step(script_name, video_id):
                print(f"\n✗ Pipeline stopped: {script_name} failed for {video_id}")
                print("  Fix the issue above and re-run.")
                sys.exit(1)

    print(f"\n\n{'='*60}")
    print("  ✅ All videos generated!")
    print(f"{'='*60}")
    for vid in videos:
        out = ROOT / "build" / vid / "final.mp4"
        status = "✓" if out.exists() else "✗ missing"
        print(f"  {vid}: build/{vid}/final.mp4  {status}")


if __name__ == "__main__":
    main()
