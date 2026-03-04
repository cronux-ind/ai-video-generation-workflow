# Workflow Guide

## End-to-End

1. Prepare topic files in `content/topics/`.
2. Run `npm run build:all`.
3. Run `npm run script:gen`.
4. Run `npm run slides:prepare`.
5. Generate PPT in NotebookLM and export pages.
6. Place slide images in `external-slides/video-xx/`.
7. Run `npm run slides:import`.
8. Run `npm run voice:gen`.
9. Run `npm run video:render`.

## Partial Rerun Matrix

- Script issue only: rerun `script:gen` -> `voice:gen` -> `video:render`
- Slides issue only: rerun `slides:import` -> `video:render`
- Voice issue only: rerun `voice:gen` -> `video:render`
- Subtitle style issue only: adjust style/config -> rerun `video:render`

## Provider Notes

- Voice providers: `edge`, `elevenlabs`, `gemini`, or `auto`.
- For Chinese voice naturalness, `edge` is often strong and stable.
- Keep provider keys in `.env` only, never commit real values.
