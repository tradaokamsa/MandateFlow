# Middleware Testing Commands

Run these commands from the MandateFlow workspace.

## Fast middleware test

```bash
cd CodeJam
npm run check:mandateflow
```

This runs all Go middleware tests using the local Go toolchain, or Docker/Podman if Go is unavailable.

## Verbose Go tests

```bash
cd middleware/mandateflow
GOCACHE="${TMPDIR:-/tmp}/mandateflow-go-cache" go test -v ./...
```

Run individual middleware areas:

```bash
go test -v ./internal/mandateflow
go test -v ./internal/httpapi
go test -v ./internal/mcpserver
```

## Full application and middleware validation

```bash
cd CodeJam
npm ci
npm run check
```

This runs type checking, server tests, production builds, and middleware tests.

## Containerized middleware test

From the workspace root:

```bash
docker build \
  --target test \
  --file middleware/mandateflow/Dockerfile \
  middleware/mandateflow
```

Replace `docker` with `podman` if applicable.

## Live end-to-end test

The E2E test consumes Groq model tokens and requires Docker, Colima, or Podman.

In terminal 1:

```bash
cd CodeJam
export APP_AUTH_TOKEN='mandateflow-local-e2e-token-2026'
export GROQ_API_KEY='your-groq-api-key'
npm run poc
```

In terminal 2:

```bash
cd CodeJam
export APP_AUTH_TOKEN='mandateflow-local-e2e-token-2026'

curl -fsS http://localhost:3000/api/system
curl -fsS http://localhost:3002/healthz

npm run check:mandateflow:e2e
```

The E2E test validates the allow, provenance denial, safe recovery, and retry-continuity paths.

## Related documentation

- [`middleware/mandateflow/README.md`](middleware/mandateflow/README.md)
- [`CodeJam/docs/LOCAL_POC.md`](CodeJam/docs/LOCAL_POC.md)
- [`CodeJam/docs/DEMO.md`](CodeJam/docs/DEMO.md)
