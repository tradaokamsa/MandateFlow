# Local POC

The local profile runs the React/Fastify control plane on macOS or Linux and
starts every Codex turn in a disposable Docker, Colima, or Podman container.
Only the Volcengine Ark model API is remote.

## Start

Requirements:

- Node.js 22+
- Docker, Colima, or Podman
- An Ark API key and Responses-capable endpoint

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Open <http://localhost:3000>. Press `Ctrl+C` to stop the server and remove this
instance's remaining Runtime containers.

Force an engine with `CONTAINER_ENGINE=docker` or
`CONTAINER_ENGINE=podman`. Colima uses the Docker CLI.

## Start MandateFlow

Use the dedicated launcher for a rehearsal. It creates a new temporary data
root on every invocation, enables MandateFlow, and then calls the normal POC
launcher:

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run demo:mandateflow
```

The startup output prints the fresh state path, browser URL, and a generated
256-bit browser access token. Enter that token in the UI. The launcher builds
the Runtime with Codex CLI `0.111.0`, starts the browser/API listener at
loopback `:3000` and the MCP-only listener at container-reachable `:3001`, then
checks both health endpoints and MCP reachability from the Runtime image.

One Node process owns both Fastify listeners and their shared `JsonStore`,
`AgentService`, `MandateFlowKernel`, and readiness state. The browser listener
never exposes `/mcp`; the MCP listener exposes only `/healthz` and `/mcp` and
requires the current Run's private capability for MCP. The MCP Server, Node,
and Fastify SDK packages are exact-pinned at `2.0.0`.

Use the exact Agent instructions and user prompt in [DEMO.md](DEMO.md). The
expected protected path is Support allow (`CRM 0 → 1`), Payment denial before
CRM (`1 → 1`), aggregate recovery, and a narrow Retry denial under a new
Runtime/capability (`1 → 1`).

The launcher selects Runtime routing as follows:

| Engine | Runtime-visible MCP origin | Host mapping |
| --- | --- | --- |
| Docker Desktop / Colima | `http://host.docker.internal:3001` | Built in |
| Podman | `http://host.containers.internal:3001` | Built in |
| Linux Docker | `http://host.docker.internal:3001` | Adds `host.docker.internal:host-gateway` |

To override those detected values, set `MANDATEFLOW_RUNTIME_MCP_URL` to an
origin with no path and set `MANDATEFLOW_CONTAINER_ADD_HOST` when Linux Docker
needs an explicit mapping. `MANDATEFLOW_MCP_PORT` must match the URL port and
must differ from `PORT`. MandateFlow requires the browser `HOST` to be a
loopback address.

## Data and Runtime

Persistent state defaults to:

- macOS: `~/.volc-agent-launchpad/`
- Linux: `.local/`

Set `LOCAL_POC_DATA_ROOT` to use another directory.

Each turn mounts only the selected Agent workspace and Codex session directory.
Default limits are 2 CPUs, 2 GiB memory, 256 processes, dropped capabilities,
and `no-new-privileges`.

The MandateFlow demo launcher intentionally does not reuse this normal
persistent state. Set `MANDATEFLOW_DEMO_ROOT` only when its fresh temporary
directory must live under a container-engine shared path. Stop the launcher
with `Ctrl+C`; it stops Node and removes only Runtime containers carrying this
instance's labels. The printed fresh state directory is not automatically
deleted.

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
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

This flow was verified on veLinux 2 with rootless Podman 4.3.1. A `vfs` storage
driver works but needs more disk space; keep at least 5 GiB free for a cold
build.

## Common options

```bash
CONTAINER_RUNTIME_APT_PACKAGES='ca-certificates git ripgrep python3 build-essential' \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

For restricted networks, configure:

- `CONTAINER_RUNTIME_BASE_IMAGE`
- `CONTAINER_APT_MIRROR`
- `CONTAINER_APT_SECURITY_MIRROR`

Resource limits are controlled by `CONTAINER_CPU_LIMIT`,
`CONTAINER_MEMORY_LIMIT`, and `CONTAINER_PIDS_LIMIT`.

## Real MandateFlow compatibility gate

The regular `npm run check` uses deterministic unit/integration tests and does
not consume Ark or require a container engine. Run the real Codex/container/MCP
gate separately on the intended demo host:

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
CONTAINER_ENGINE=docker \
npm run test:mandateflow:e2e
```

Use `CONTAINER_ENGINE=podman` for Podman. On Linux Docker, set
`MANDATEFLOW_CONTAINER_ADD_HOST=host.docker.internal:host-gateway` if the
engine does not supply it. This gate performs actual MCP negotiation and the
allow/deny/aggregate/Retry path. It was not executable in the current
implementation environment because no container engine was available, so it
must be run before the live demo.

## Troubleshooting

Check Runtime readiness:

```bash
docker info                       # Or: podman info
docker image inspect volc-agent-runtime:local
curl -H 'Authorization: Bearer <browser-token>' http://localhost:3000/api/system
curl http://localhost:3001/healthz # MandateFlow mode only
```

If `/api/system` reports `mandateFlowReady: false`, or MCP `/healthz` returns
`503`, stop and restart with `npm run demo:mandateflow`; new secure messages and
Retry intentionally fail closed. If startup cannot reach MCP from the Runtime,
verify the engine-specific host above and any Linux Docker add-host mapping.

If a bind mount is rejected, set `LOCAL_POC_DATA_ROOT` to a directory shared
with the container VM. On Linux, the startup script automatically uses the host
UID/GID and validates workspace write access.

Remove only the default Runtime image:

```bash
podman image rm volc-agent-runtime:local
```

MandateFlow remains a single-process/single-writer JSON P0 over embedded
fixtures. It has no `fsync` durability, tamper evidence, replay or exactly-once
guarantees, general DLP, multi-user isolation, or TLS. See
[DEMO.md#p0-boundaries](DEMO.md#p0-boundaries) before using it.
