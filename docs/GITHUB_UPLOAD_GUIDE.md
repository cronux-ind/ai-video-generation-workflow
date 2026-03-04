# GitHub Upload Guide

## 1) Initialize Repository

```bash
cd ai-video-generation-workflow
git init
git add .
git commit -m "chore: initial open-source release"
```

## 2) Create Remote (GitHub)

Create an empty GitHub repo first, then run:

```bash
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

## 3) Before Every Push

```bash
rg -n --hidden -S "AIza|sk-|ELEVENLABS_API_KEY=|GOOGLE_API_KEY=|GEMINI_API_KEY=" . -g'!.git/**'
```

Ensure output is empty or only appears in `.env.example` placeholders.
