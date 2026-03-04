# Open-Source Checklist

## Before Publish

- [ ] `.env` is not included
- [ ] API keys are not present in any committed file
- [ ] Generated media assets are excluded
- [ ] Private PDFs and copyrighted assets are excluded
- [ ] README, LICENSE, CONTRIBUTING, SECURITY are present
- [ ] `package.json` metadata is updated (repo URL, homepage)

## Recommended Verification

```bash
rg -n --hidden -S "AIza|sk-|ELEVENLABS_API_KEY=.+|GOOGLE_API_KEY=.+|GEMINI_API_KEY=.+" . -g'!.git/**'
```

Expected: no real key values.

## Post Publish

- [ ] Enable GitHub secret scanning
- [ ] Enable Dependabot alerts
- [ ] Add branch protection for `main`
