#!/usr/bin/env python3
"""Step 2: Generate images for each segment using Nano Banana 2 (Gemini image API).

Usage:
    python3 generate_image.py video-01
    python3 generate_image.py video-02
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent
BUILD_DIR = ROOT / "build"
PROMPTS_DIR = ROOT / "prompts"

# Fallback model list — tried in order until one works
DEFAULT_IMAGE_MODELS = [
    "gemini-2.0-flash-preview-image-generation",
    "gemini-2.5-flash-preview-image-generation",
    "nano-banana-2.0",
    "nano-banana-pro-preview",
]


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


def detect_working_model(client, model_list: list[str]) -> str | None:
    """Try models in order, return first that can generate an image."""
    from google.genai import types

    test_prompt = "A simple gold coin on dark navy background, minimal, no text"
    for model_name in model_list:
        print(f"  Trying model: {model_name} ...", end=" ", flush=True)
        try:
            resp = client.models.generate_content(
                model=model_name,
                contents=test_prompt,
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                ),
            )
            for candidate in resp.candidates or []:
                for part in candidate.content.parts or []:
                    if part.inline_data and "image" in part.inline_data.mime_type:
                        print("✓")
                        return model_name
            print("✗ (no image returned)")
        except Exception as e:
            print(f"✗ ({e})")
    return None


def generate_one_image(client, model: str, prompt: str, retries: int = 2) -> tuple[bytes, str] | None:
    """Generate a single image. Returns (raw_bytes, extension) or None."""
    from google.genai import types

    MIME_TO_EXT = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}

    for attempt in range(retries + 1):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE"],
                ),
            )
            for candidate in resp.candidates or []:
                for part in candidate.content.parts or []:
                    if part.inline_data and part.inline_data.data:
                        mime = part.inline_data.mime_type or "image/jpeg"
                        ext = MIME_TO_EXT.get(mime, "jpg")
                        # data is already raw bytes — no base64 decode needed
                        return (part.inline_data.data, ext)
        except Exception as e:
            if attempt < retries:
                print(f"\n    Retry {attempt + 1}/{retries} after error: {e}")
                time.sleep(4)
            else:
                raise
    return None


def main(video_id: str) -> None:
    env = load_env()
    api_key = env.get("GOOGLE_API_KEY")
    if not api_key:
        print("ERROR: GOOGLE_API_KEY not set in .env")
        sys.exit(1)

    model_list_raw = env.get("IMAGE_MODEL_LIST", "")
    model_list = [m.strip() for m in model_list_raw.split(",") if m.strip()] or DEFAULT_IMAGE_MODELS

    plan_path = BUILD_DIR / video_id / "plan.json"
    script_path = BUILD_DIR / video_id / "script.json"

    if not plan_path.exists():
        print(f"ERROR: {plan_path} not found. Run `npm run plan` first.")
        sys.exit(1)

    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    script = json.loads(script_path.read_text(encoding="utf-8")) if script_path.exists() else None

    # Build narration lookup for enriching prompts
    narrations: dict[str, str] = {}
    if script:
        for seg in script["segments"]:
            narrations[seg["segmentId"]] = seg.get("narration", "")

    img_dir = BUILD_DIR / video_id / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    from google import genai

    client = genai.Client(api_key=api_key)

    print(f"\n[generate_image] {video_id}")
    print(f"  Detecting working image model from list: {model_list}\n")

    working_model = detect_working_model(client, model_list)
    if not working_model:
        print("\nERROR: No image model worked. Check your GOOGLE_API_KEY and model availability.")
        sys.exit(1)

    print(f"\n  Using model: {working_model}")
    negative = plan["style"]["visualNegativePrompt"]

    for i, shot in enumerate(plan["shots"]):
        seg_id = shot["segmentId"]
        # Check if any image already exists for this segment (any naming, any extension)
        existing = list(img_dir.glob(f"{i:02d}_{seg_id}.*")) + list(img_dir.glob(f"*{seg_id}*"))
        existing = [f for f in existing if f.stat().st_size > 10_000]  # only real images > 10KB
        if existing:
            print(f"  [{i+1}/{len(plan['shots'])}] {seg_id} — already exists ({existing[0].name}), skip")
            continue

        narration_snippet = narrations.get(seg_id, "")[:80]

        # Build a rich, specific image prompt
        prompt = (
            f"{shot['imagePromptBrief']}"
            f". Narration context: {narration_snippet}"
            f". Format: vertical portrait 9:16, 1080x1920."
            f" Negative: {negative}"
        )

        print(f"  [{i+1}/{len(plan['shots'])}] {seg_id} ...", end=" ", flush=True)
        try:
            result = generate_one_image(client, working_model, prompt)
            if result:
                img_bytes, ext = result
                # Use correct extension based on actual mime type returned
                actual_out = img_dir / f"{i:02d}_{seg_id}.{ext}"
                actual_out.write_bytes(img_bytes)
                print(f"✓  ({len(img_bytes) // 1024} KB → {actual_out.name})")
            else:
                print("✗  (no image data returned)")
        except Exception as e:
            print(f"✗  ERROR: {e}")

        # Small delay to avoid rate limiting
        time.sleep(1)

    print(f"\n✅ Images saved → {img_dir}")


if __name__ == "__main__":
    vid = sys.argv[1] if len(sys.argv) > 1 else "video-01"
    main(vid)
