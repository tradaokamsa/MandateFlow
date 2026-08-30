# Go MandateFlow sidecar

`mandateflowd` is the P0 reference monitor. It exposes two separate listeners:

- `:3001/mcp` — stateless Streamable HTTP MCP authenticated by a per-Run
  `mfr1_` bearer.
- `:3002/control/v1/*` — lifecycle and redacted evidence operations
  authenticated by the boot-time `mfc1_` bearer. `/healthz` is public.

Go exclusively owns the SQLite database and the fixed five-tool protected
fixture registry. Node sends lifecycle facts through the control API and never
opens the database or evaluates provenance policy.

Run the focused suite from the `CodeJam` application directory:

```bash
cd CodeJam
npm run check:mandateflow
```

Or from this directory with a host Go toolchain:

```bash
GOCACHE=/tmp/mandateflow-go-cache go test ./...
```

The multi-stage [Dockerfile](Dockerfile) has a `test` target and a non-root,
read-only-compatible final image. The normal local entry point is
`npm run poc`, which generates the control token, mounts the persistent database
directory, and attaches the sidecar and disposable Runtime containers to one
instance-specific private bridge network.
