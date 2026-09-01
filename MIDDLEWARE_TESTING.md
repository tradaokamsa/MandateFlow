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

Create a free Groq API key at [groq.com](https://groq.com/) before running the
live Agent path. The E2E path requires Docker, Colima, or Podman and traverses
the real Fastify → Streamable HTTP MCP → Go → SQLite → API path.

In terminal 1:

```bash
make demo
```

For the live model profile, add:

```bash
RUNTIME_PROVIDER=container GROQ_API_KEY='your-groq-api-key' make demo
```

In terminal 2:

```bash
cd CodeJam
export APP_AUTH_TOKEN='paste-the-token-from-the-make-demo-banner'

curl -fsS http://localhost:3100/api/system
curl -fsS http://localhost:3102/healthz

MANDATEFLOW_E2E_BASE_URL=http://127.0.0.1:3100 \
npm run check:mandateflow:e2e
```

The `make demo` path generates and prints an unlock token and defaults to
ports `3100` (Web/API) and `3102` (Go control). For a direct `npm run poc`
run, the defaults remain `3000` and `3002`; set
`MANDATEFLOW_E2E_BASE_URL` to the matching Web/API port.

The E2E test validates the Support allow, Payment provenance denial before CRM,
unchanged CRM counter, aggregate and fresh Support recovery, retry continuity,
and revoked-mandate reset into a fresh context.

## Related documentation

- [`middleware/mandateflow/README.md`](middleware/mandateflow/README.md)
- [`CodeJam/docs/LOCAL_POC.md`](CodeJam/docs/LOCAL_POC.md)
- [`CodeJam/docs/DEMO.md`](CodeJam/docs/DEMO.md)
