# Security Policy

## Supported Versions

This project currently supports the latest `main` branch.

## Reporting a Vulnerability

Please do not open public issues for sensitive vulnerabilities.

Report privately with:
- impact summary
- reproduction steps
- suggested mitigation (if available)

## Secret Handling

- Use `.env` for all runtime keys.
- Commit only `.env.example` placeholders.
- Rotate keys immediately if accidental exposure occurs.
