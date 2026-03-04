# AI Video Generation Workflow

An open-source workflow for generating short finance explainer videos with **script + slides + voice + subtitles + render**.

`AI Video Generation Workflow` focuses on reliability for batch production (e.g., 3 themed videos with consistent style), instead of relying purely on text-to-video models with unstable output quality.

## Why This Project

- Stable, reproducible pipeline for short-form finance content.
- Modular reruns: regenerate only the failed stage (script/image/voice/render).
- Strong sync control across voice, subtitles, and image transitions.
- Works well with NotebookLM slide workflow (PPT -> slide images -> final video).

## Core Workflow

1. Generate script by structured segments (`hook`, `definition`, `example`, etc.).
2. Prepare NotebookLM input to generate PPT slides.
3. Import slide images per video (`video-01`, `video-02`, `video-03`).
4. Generate voice (Edge / ElevenLabs / Gemini fallback).
5. Build subtitles from real audio durations.
6. Render final MP4 with synchronized timeline.

## Tech Stack

- Node.js + TypeScript (`tsx`)
- FFmpeg (render and audio concat)
- Optional Python (`edge-tts`) for Chinese natural voice
- Gemini / ElevenLabs APIs (configurable)

## Quick Start

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Fill `.env`

At minimum, configure one text/image provider and one voice path.

### 3. Generate plans

```bash
npm run build:all
```

### 4. Generate scripts

```bash
npm run script:gen
```

### 5. NotebookLM route (recommended for slide quality)

```bash
npm run slides:prepare
```

Then use generated markdown files in `build/video-xx/notebooklm-input.md` to generate PPT in NotebookLM, export each page as images, and place them under:

- `external-slides/video-01/`
- `external-slides/video-02/`
- `external-slides/video-03/`

Import slides:

```bash
npm run slides:import
```

### 6. Generate voice

```bash
npm run voice:gen
```

### 7. Render video

```bash
npm run video:render
```

## Commands

- `npm run build:all` -> plan + QA checks
- `npm run script:gen` -> generate scripts
- `npm run image:gen` -> generate images from prompts
- `npm run slides:prepare` -> prepare NotebookLM prompts
- `npm run slides:import` -> import exported slide images
- `npm run voice:gen` -> generate TTS audio
- `npm run video:render` -> render final mp4
- `npm run run:all` -> full pipeline

## Repository Layout

```text
src/
  lib/
  scripts/
config/
content/topics/
prompts/
examples/
  scripts/
  notebooklm-inputs/
docs/
```

## What Is Included in This Open-Source Copy

Included:
- Pipeline source code
- Config templates
- Prompt templates
- Example scripts and NotebookLM inputs
- Documentation and contribution templates

Not included:
- Private API keys
- Generated media assets (mp4/mp3/wav/png)
- Private/uncleared PDFs

## Project Name

This repository is named **AI Video Generation Workflow**.

## Security Note

If API keys were ever exposed in your local environment before open-sourcing, rotate them before publishing.

## Pre-publish Check

```bash
./scripts/publish-check.sh
```

## License

MIT
