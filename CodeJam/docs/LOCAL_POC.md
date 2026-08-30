# Local POC

The submitted local profile runs React/Fastify plus a Go MandateFlow sidecar on
macOS or Linux. With no usable Groq key, it runs a deterministic fixture Runtime
that still crosses the Node → Streamable HTTP MCP → Go → SQLite → UI/API path.
With a key, it can start every Codex turn in a disposable Docker, Colima, or
Podman container and use the Groq model API.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- A Groq API key only for the optional live `container` profile

```bash
export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
npm run poc
```

The launcher selects `fixture` when `GROQ_API_KEY` is missing or still a
placeholder. To use the live Codex path, set both values explicitly:

```bash
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
npm run poc
```

Open <http://localhost:3000> and unlock with `APP_AUTH_TOKEN`. Press `Ctrl+C` to
stop the server and remove this instance's remaining Runtime containers,
MandateFlow sidecar, and private network.

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
through the `mandateflow-gateway` alias. In the credential-free `fixture`
profile, the MCP listener is additionally published on a loopback-only host
port so the Node fixture runner can traverse the same HTTP boundary. Live
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
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" \
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' \
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" \
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
npm run poc
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
curl http://localhost:3000/api/system
```

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
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" npm run check:mandateflow:e2e
```

The check creates a dedicated Agent, validates the Support allow, Payment
provenance denial and unchanged CRM counter, proves aggregate and fresh Support
recovery, retries the denied call without repeating derivation, then revokes the
mandate and proves a fresh context can run again. The default fixture path uses
no model credential; the `container` profile consumes Groq tokens.

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```
