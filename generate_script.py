#!/usr/bin/env python3
"""Step 1: Generate narration script for each video using Gemini.

Calls Gemini ONCE per video (all segments together) for coherent output.

Usage:
    python3 generate_script.py video-01
    python3 generate_script.py video-02
    python3 generate_script.py video-03
"""

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).parent
BUILD_DIR = ROOT / "build"
PROMPTS_DIR = ROOT / "prompts"


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


def call_gemini_with_retry(client, model: str, system_prompt: str, user_msg: str) -> str:
    from google.genai import types

    for attempt in range(4):
        try:
            resp = client.models.generate_content(
                model=model,
                contents=user_msg,
                config=types.GenerateContentConfig(
                    system_instruction=system_prompt,
                    response_mime_type="application/json",
                ),
            )
            return resp.text.strip()
        except Exception as e:
            err = str(e)
            if "429" in err and attempt < 3:
                wait = 20 * (attempt + 1)
                print(f"  Rate limited, waiting {wait}s ...", flush=True)
                time.sleep(wait)
            else:
                raise
    raise RuntimeError("Failed after retries")


def parse_script_response(raw: str, plan: dict) -> list[dict]:
    """Parse Gemini response into a flat list of segments."""
    # Strip markdown code fences if present
    if raw.startswith("```"):
        parts = raw.split("```")
        raw = parts[1] if len(parts) > 1 else raw
        if raw.startswith("json"):
            raw = raw[4:]
    raw = raw.strip()

    data = json.loads(raw)

    # Gemini may return: {"title": "...", "segments": [...]}
    # or just: [{"segmentId": ...}, ...]
    if isinstance(data, dict) and "segments" in data:
        return data["segments"]
    if isinstance(data, list):
        return data

    raise ValueError(f"Unexpected response structure: {list(data.keys())}")


def main(video_id: str) -> None:
    env = load_env()
    api_key = env.get("GOOGLE_API_KEY") or env.get("GEMINI_API_KEY")
    if not api_key:
        print("ERROR: GOOGLE_API_KEY not set in .env")
        sys.exit(1)

    model = env.get("SCRIPT_MODEL", "gemini-2.5-flash")

    plan_path = BUILD_DIR / video_id / "plan.json"
    if not plan_path.exists():
        print(f"ERROR: {plan_path} not found. Run `npm run plan` first.")
        sys.exit(1)

    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    system_prompt = (PROMPTS_DIR / "script-system.md").read_text(encoding="utf-8")

    from google import genai
    client = genai.Client(api_key=api_key)

    print(f"\n[generate_script] {video_id} — model: {model}")
    print(f"  Term: {plan['term']}")
    print(f"  Shots: {len(plan['shots'])}")
    print(f"  Calling Gemini (one request for all segments)...\n")

    # Build a single comprehensive user message with all shots
    shots_desc = "\n\n".join(
        f"分镜 {i+1} — segmentId: \"{s['segmentId']}\"\n"
        f"  目标: {s['goal']}\n"
        f"  时长: {s['seconds']} 秒\n"
        f"  要求: {s['narrationBrief']}"
        for i, s in enumerate(plan["shots"])
    )

    user_msg = f"""视频主题: {plan['term']}
受众: {plan['targetAudience']}

请为以下 {len(plan['shots'])} 个分镜写逐字稿，输出完整 JSON（所有段落放在 segments 数组中）：

{shots_desc}

输出格式（严格遵守，segmentId 必须与上面完全一致）：
{{
  "title": "视频标题",
  "segments": [
    {{
      "segmentId": "hook",
      "seconds": 6,
      "narration": "完整口播文字（按时长控制字数，6秒约24字）",
      "onscreenText": "屏幕关键词（最多8字）"
    }},
    ...更多段落
  ]
}}"""

    raw = call_gemini_with_retry(client, model, system_prompt, user_msg)

    segments = parse_script_response(raw, plan)

    # Validate all expected segments are present
    expected_ids = {s["segmentId"] for s in plan["shots"]}
    got_ids = {s.get("segmentId", "") for s in segments}
    missing = expected_ids - got_ids
    if missing:
        print(f"  WARNING: Missing segments: {missing}")

    script = {
        "videoId": video_id,
        "title": plan["title"],
        "term": plan["term"],
        "segments": segments,
    }

    out_path = BUILD_DIR / video_id / "script.json"
    out_path.write_text(json.dumps(script, ensure_ascii=False, indent=2), encoding="utf-8")

    print(f"✅ Script saved → {out_path}")
    print(f"\n  Segments generated:")
    total_chars = 0
    for seg in segments:
        narration = seg.get("narration", "")
        total_chars += len(narration)
        print(f"    [{seg.get('segmentId','?')}] {narration[:50]}{'...' if len(narration)>50 else ''}")

    print(f"\n  Total narration: {total_chars} chars (~{total_chars/4:.0f}s at 4 chars/sec)")


if __name__ == "__main__":
    vid = sys.argv[1] if len(sys.argv) > 1 else "video-01"
    main(vid)
