# Contributing

Thanks for contributing to AI Video Generation Workflow.

## Development Setup

1. Node.js >= 20
2. `npm install`
3. `cp .env.example .env`

## Pull Request Rules

- Keep changes focused and minimal.
- Add/update docs for behavior changes.
- Never commit secrets or large generated media.
- Prefer reproducible scripts over manual steps.

## Recommended Validation

```bash
npm run build:all
```

If your PR touches rendering logic, include a short note describing expected subtitle/audio/image sync behavior.
