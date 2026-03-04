#!/usr/bin/env bash
set -euo pipefail

echo "[1/3] secret scan"
rg -n --hidden -S "AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|ELEVENLABS_API_KEY=.+|GOOGLE_API_KEY=.+|GEMINI_API_KEY=.+" . -g'!.git/**' || true

echo "[2/3] absolute path scan"
rg -n --hidden -S "/Users/|C:\\\\|build-pe-remake" . -g'!.git/**' || true

echo "[3/3] basic pipeline check"
npm run build:all

echo "Done. Verify scan outputs above before publish."
