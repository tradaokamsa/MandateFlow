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

This runs TypeScript checks, server/web tests, production builds, and middleware
tests.

## Containerized middleware test

From the workspace root:

```bash
docker build \
  --target test \
  --file middleware/mandateflow/Dockerfile \
  middleware/mandateflow
```

Replace `docker` with `podman` if applicable.

## End-to-end test

The default E2E path is credential-free and requires Docker, Colima, or Podman
only for the Go sidecar. It traverses the real Fastify → Streamable HTTP MCP →
Go → SQLite → API path. Use the explicit `container` profile below when you
want to rehearse the live Codex/Groq path.

In terminal 1:

```bash
cd CodeJam
export APP_AUTH_TOKEN='mandateflow-local-e2e-token-2026'
npm run poc
```

For the optional live model profile, add:

```bash
export RUNTIME_PROVIDER=container
export GROQ_API_KEY='your-groq-api-key'
```

In terminal 2:

```bash
cd CodeJam
export APP_AUTH_TOKEN='mandateflow-local-e2e-token-2026'

curl -fsS http://localhost:3000/api/system
curl -fsS http://localhost:3002/healthz

npm run check:mandateflow:e2e
```

The E2E test validates the Support allow, Payment provenance denial before CRM,
unchanged CRM counter, aggregate and fresh Support recovery, retry continuity,
and revoked-mandate reset into a fresh context.

## Related documentation

- [`middleware/mandateflow/README.md`](middleware/mandateflow/README.md)
- [`CodeJam/docs/LOCAL_POC.md`](CodeJam/docs/LOCAL_POC.md)
- [`CodeJam/docs/DEMO.md`](CodeJam/docs/DEMO.md)
