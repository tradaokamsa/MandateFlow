# Local POC

The submitted local profile runs React/Fastify plus a Go MandateFlow sidecar on
macOS or Linux. Create a free Groq API key at [groq.com](https://groq.com/)
before starting the live Agent profile. With the key configured, every Codex
turn runs in a disposable Docker, Colima, or Podman container and uses the Groq
model API.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- A free Groq API key for the live Agent profile. Create one at
  [groq.com](https://groq.com/)

From the repository root, use the preferred one-command demo path:

```bash
make demo
```

`make demo` runs `make shutdown` first, then invokes
`CodeJam/scripts/start-local-poc.sh` directly with the demo defaults:
`PORT=3100`, `MANDATEFLOW_CONTROL_HOST_PORT=3102`, a dedicated instance data
root (`RUNTIME_INSTANCE_ID=first-commit-explore` and
`~/.mandateflow-first-commit-explore` by default), and `POC_QUIET=1`. It frees
known ports and removes stale MandateFlow containers/networks. The launcher
repeats that cleanup idempotently, auto-loads a usable `../api_key.txt` when
present, and auto-generates `APP_AUTH_TOKEN`. Copy the token from the startup
banner and open <http://localhost:3100>.

To use the live Codex path explicitly, set the provider and key on `make`:

```bash
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
make demo
```

Use the `container` profile when the Agent must inspect or change workspace
code.

The available launcher commands are:

```bash
make demo                         # quiet demo on :3100
make demo-verbose                 # full Docker/npm logs
make demo VERBOSE=1               # full logs via an environment override
make shutdown                     # free ports and remove stale resources
make stop                         # alias for shutdown
make kill-ports                   # alias for shutdown
```

Override the demo identity or ports when running more than one local instance:

```bash
PORT=3200 \
MANDATEFLOW_CONTROL_HOST_PORT=3202 \
MANDATEFLOW_RUNTIME_MCP_HOST_PORT=3201 \
RUNTIME_INSTANCE_ID=second-demo \
make demo
```

`make shutdown` accepts an overridable `PORTS` list, for example
`make PORTS='3200 3201 3202' shutdown`.

The single launcher is also available directly. From the repository root:

```bash
./CodeJam/scripts/start-local-poc.sh --quiet
```

Or from `CodeJam/`:

```bash
POC_QUIET=1 npm --silent run poc
```

Direct `start-local-poc.sh` and raw `npm run poc` default to `POC_QUIET=0`
and `PORT=3000` unless overridden. `--quiet` or `POC_QUIET=1` enables the
concise progress output and token banner; `--verbose`, `VERBOSE=1`, or
`POC_VERBOSE=1` (or `POC_QUIET=0`) restores full build logs. In quiet mode,
the launcher's internal `_poc_run` wrapper captures Docker/npm output and
prints it on failure; use a verbose rerun for the complete live log.
`npm --silent run poc` suppresses
npm's wrapper messages only; it does not set `POC_QUIET` by itself.
`run-poc.sh` is a backwards-compatible root shim with the `make demo` defaults;
prefer `make demo` for new runs.

For a direct run, open the configured `PORT` (the default is
<http://localhost:3000>) and unlock with the token printed by a quiet run or
the token supplied in `APP_AUTH_TOKEN`. Press `Ctrl+C` to stop the server and
remove this instance's remaining Runtime containers, MandateFlow sidecar, and
private network.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

MandateFlow stores its database at `data/mandateflow/mandateflow.db`. The Go
process is the only application component that opens this database. Node's
`launchpad.json` contains only safe foreign IDs and fingerprints.

Set `LOCAL_POC_DATA_ROOT` to use another directory.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

The startup script creates an instance-specific bridge network. The Go control
listener is published only on `127.0.0.1:3002`. In the live `container` profile,
the MCP listener is private to the network and reachable by Runtime containers
through the `mandateflow-gateway` alias. The MCP listener is also available on a
loopback-only host port for deterministic middleware verification. Live
Runtime containers receive the per-Run capability environment variable but not
the Go control token or browser token.

Codex requests `workspace-write`. If the Linux kernel lacks Landlock, startup
warns and disables only the inner Codex sandbox. The outer container limits
remain active, but this fallback is not tenant isolation.

## Rootless Podman on Linux

This path requires no Docker or Compose. It supports Ubuntu 22.04/24.04, Debian
12, and veLinux 2.

Install Podman:

```bash
sudo apt-get update
sudo apt-get install -y podman uidmap slirp4netns fuse-overlayfs
```

Install Node.js 22 if needed. Inspect the downloaded setup script before
running it:

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x \
  -o /tmp/nodesource_setup_22.sh
less /tmp/nodesource_setup_22.sh
sudo -E bash /tmp/nodesource_setup_22.sh
sudo apt-get install -y nodejs
```

Check subordinate UID/GID ranges:

```bash
grep "^$USER:" /etc/subuid
grep "^$USER:" /etc/subgid
```

If both are missing, assign unused ranges and log in again:

```bash
sudo usermod --add-subuids 100000-165535 "$USER"
sudo usermod --add-subgids 100000-165535 "$USER"
```

Verify rootless Podman:

```bash
podman info
podman run --rm docker.io/library/alpine:3.20 echo PODMAN_OK
```

`podman info` must report `rootless: true`. Start the POC:

```bash
CONTAINER_ENGINE=podman \
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
make demo
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' \
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
make demo
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Troubleshooting

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl http://localhost:3100/api/system
```

The `:3100` check assumes the preferred `make demo` path. For direct
`npm run poc`, use `http://localhost:${PORT:-3000}/api/system` instead.

The system response must report `mandateFlowEnabled: true` and
`mandateFlowReady: true`. If the Go sidecar is unavailable, Agent CRUD/history
remain visible but new secure Runs and retries fail with `503`; no Runtime is
started.

During a Run, the Playground polls the persisted safe activity timeline rather
than showing only a spinner. It reports secure preparation, Runtime start,
protected-tool work, and finalization. If a live model provider returns `429`
or the Runtime stops responding, the Run explains the recovery and offers
`Try again` or `Stop run` as appropriate.

Run the acceptance check against an already running POC:

```bash
MANDATEFLOW_E2E_BASE_URL=http://127.0.0.1:3100 \
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" \
npm run check:mandateflow:e2e
```

Use port `3000` in `MANDATEFLOW_E2E_BASE_URL` when the POC was started through
the direct `npm run poc` path, or provide the matching `PORT` override.

The check creates a dedicated Agent, validates the Support allow, Payment
provenance denial and unchanged CRM counter, proves aggregate and fresh Support
recovery, retries the denied call without repeating derivation, then revokes the
mandate and proves a fresh context can run again. The live `container` profile
consumes Groq tokens.

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
