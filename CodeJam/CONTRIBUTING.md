# Contributing

Keep changes focused, reproducible, and suitable for a three-day student
hackathon.

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

For container-based Agent execution, follow
[docs/LOCAL_POC.md](docs/LOCAL_POC.md).

## Validate

```bash
npm run check:fast
npm run check
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

Use `npm run test:server:watch` for the shortest feedback loop. `check:fast`
omits production bundle builds and live Groq E2E while still running
TypeScript typechecks plus Go formatting, vet, and race tests; `check` remains
the complete non-live gate.

## Pull requests

- Explain the behavior and reason for the change.
- Add tests for API, lifecycle, persistence, or Runtime changes.
- Update English documentation and `.env.example` when configuration changes.
- Use GitHub Flavored Markdown and relative repository links.
- Never commit credentials, local state, workspaces, build output, or Terraform
  state.
- Report security issues according to [SECURITY.md](SECURITY.md).
