# MandateFlow

A provenance-sensitive mandate gateway built into Agent Launchpad for TikTok
TechJam 2026 Track 1. The baseline still provides Agent CRUD, a browser
Playground, persistent workspaces, and Codex CLI backed by the Groq
Responses API. MandateFlow adds a Go reference monitor that stops forbidden
cross-tool data flows before a protected operation runs.

Run it locally with Docker, Colima, or rootless Podman, or deploy it to
Volcengine ECS.

> [!WARNING]
> This is a single-user proof of concept, not a production authorization or DLP
> system. Its claim applies only to the five typed fixture operations that are
> exclusively reachable through the gateway. Do not use production data or
> credentials. See [SECURITY.md](SECURITY.md).

## Screenshots

### Agent Playground

![Agent Playground showing lifecycle controls, starter prompts, and the Codex Runtime](docs/assets/playground.jpg)

### Create an Agent

![Create Agent form with name, description, and workspace instructions](docs/assets/create-agent.jpg)

## Features

- React and TypeScript Web UI
- Agent create, edit, start, stop, delete, and multi-turn chat
- Fastify control plane with asynchronous Run state
- Persistent Agent workspaces and Codex sessions
- Disposable Docker, Colima, or Podman container for each local turn
- Go Streamable HTTP MCP gateway with per-Run bearer capabilities
- Immutable Run grants, server-owned reference lineage, and a pinned flow policy
- Go-owned SQLite receipts proving pre-execution allow/deny decisions
- Explicit retry with fresh authority and durable provenance continuity
- Bounded `user-a` / `user-b` demo ownership enforced by the Go sidecar
- Durable mandate summaries, idempotent revocation, and active Runtime cancellation
- Agent-specific Codex homes under `CODEX_HOME/agents/<agent-id>`
- Docker and Terraform deployment paths for Volcengine ECS

## Requirements

- Node.js 22+
- npm 10+
- Docker, Colima, or Podman
- A free Groq API key for the live Agent demonstration. Create one at
  [groq.com](https://groq.com/)

Codex CLI is included in the Runtime image and is not required on the host.

## Local browser SOP

### 1. Check the local tools

Install Node.js 22+ and one supported container engine, then verify them:

```bash
node --version
npm --version
docker --version        # Docker Desktop, Docker Engine, or Colima
podman --version        # Use this instead when running Podman
```

Only one container engine is required. Codex CLI is already included in the
Runtime image.

### 2. Clone the repository

```bash
git clone <repository-url> volc-agent-launchpad
cd volc-agent-launchpad
```

Skip this step when already working from the repository root.

### 3. Start the live Agent demonstration

Run the preferred judge path from the repository root (the directory that
contains `CodeJam/`):

```bash
# Run from the repository root (the directory containing CodeJam/).
make demo
```

`make demo` runs the single `CodeJam/scripts/start-local-poc.sh` engine after
`make shutdown`, using port `3100`, a dedicated demo data root, and quiet build
output. It frees known ports, removes stale MandateFlow containers/networks,
loads a usable `../api_key.txt` automatically when present, and generates the
browser unlock token. Copy the token from the startup banner and open
<http://localhost:3100>. The first run installs dependencies, runs the Go test
target, builds the images, and starts the live Codex Agent through Groq.

For the live Agent profile, create a free Groq API key at
[groq.com](https://groq.com/), then provide it through the environment or
`api_key.txt`:

```bash
RUNTIME_PROVIDER=container \
GROQ_API_KEY='your-real-groq-api-key' \
GROQ_MODEL='openai/gpt-oss-120b' \
make demo
```

The live Agent profile is the recommended path for the demo and supports
general coding tasks in the disposable Runtime.

The launcher loads a raw Groq key from `../api_key.txt` at the repository root
without printing it. To load it manually for a direct run, use:

```bash
export GROQ_API_KEY="$(tr -d '\r\n' < ../api_key.txt)"
```

The deterministic middleware proof still crosses Fastify → Streamable HTTP MCP → Go → SQLite → API/UI,
but it is proof-only and does not demonstrate a general coding Agent.

### 4. Open the browser

For `make demo`, visit <http://localhost:3100>, or open it from the terminal:

```bash
open http://localhost:3100       # macOS
xdg-open http://localhost:3100   # Linux desktop
```

In the Web UI:

1. Select **Create Agent**.
2. Enter a name, description, and workspace instructions.
3. Select **Create Agent** again.
4. Select **Start** for the new Agent.
5. In live `container` mode, select the coding starter prompt:

   ```text
   Create a small TypeScript CLI that prints a weather summary from sample JSON.
   ```

   Watch **Runtime activity** while the real Agent is queued, authorized,
   started, using tools, and finalized. Inspect the assistant response and the
   workspace result.
6. Select **New secure workflow**.
7. In the proof console, select **Run MandateFlow proof**, which runs the
   deterministic security workflow below:

   ```text
   Run the MandateFlow verification workflow. First, list the open Support ticket,
   transform its subject reference with cases.lookup_subject, and resolve that Case
   reference through CRM. Next, list Payment failures, transform one Payment reference
   with the same Case tool, and attempt the same CRM resolution. If policy denies it,
   use payments.aggregate_failures, then fetch a fresh Support ticket, transform
   it, and resolve it through CRM. Report policy outcomes, not protected
   identifiers.
   ```

The create form includes a bounded demo owner selector. `user-a` and `user-b`
are fixed principals for exercising ownership checks; they are not real login
identities. The owner is stored with the Agent and root mandate and cannot be
changed through the edit form. The Go sidecar selects and checks the matching
typed fixture before a protected operation runs.

The proof console and decision journal should show Support → Case → CRM as
`ALLOW`, Payment → Case → CRM as `FLOW_DENIED` with rule
`NO_PAYMENT_REIDENTIFICATION`, the denied CRM counter unchanged, aggregate
recovery, and a fresh Support recovery. The control plane validates those
receipts before accepting a live proof as completed; a model summary cannot
claim a step that the Go gateway did not record. Use **Retry denied call** to
prove that a new Runtime and capability cannot erase the Payment lineage.
Expand a receipt to inspect the redacted decision and follow its causal parent
links.

The selected Playground also shows a server-derived Mandate Summary. **Revoke
mandate** first commits the root mandate's `REVOKED` state in the Go sidecar,
then cancels the active Runtime. Revocation is idempotent; the evidence
timeline remains visible, while Send and Retry stay disabled until **New secure
workflow** explicitly creates a fresh mandate. Starting that workflow clears the
old thread association and creates a fresh policy context; old references fail
under the new capability.

During a Run, the **Runtime activity** rail is the progress surface. It reports
queued, authorization, Runtime/tool work, finalization, terminal, and failure
states with timestamps. A stale active Run offers **Stop run** instead of
leaving the user with an indefinite spinner. The live `container` profile is
required for Codex-backed coding. The `fixture` profile is intentionally
proof-only and exposes only **Run MandateFlow proof**.

Form and recovery behavior is deliberately visible: access-token errors stay
next to the field, Create/Edit errors keep the form open, native owner selection
remains a normal browser select, and receipt **Details** expands in the page
flow. Only the conversation transcript owns a bounded scroll region. Revoke and
Delete confirmations remain open while a mutation is pending and show a
recoverable error in the same dialog when a request fails.

### 5. User flows for the demo

Use the completed Run's proof console and decision journal as the demo surface.
Walk through the story in this order:

1. **Start with a real Agent:** show the coding prompt, the Runtime activity
   rail, the assistant response, and the workspace change.
2. **Establish trust:** show **MandateFlow ready**, **New secure workflow**, and
   the server-derived Mandate Summary.
3. **Trusted Support path:** `Support → Case → CRM` is `ALLOW`; the CRM counter
   moves `0 → 1` and the receipt is `COMPLETED`.
4. **Unsafe Payment path:** the same public Case type and CRM method are
   `FLOW_DENIED` by `NO_PAYMENT_REIDENTIFICATION` at `PRE_EXECUTION`. The
   outcome is `NOT_INVOKED` and the counter stays `1 → 1`.
5. **Safe recovery:** `payments.aggregate_failures` succeeds, followed by a
   fresh Support path that moves the counter `1 → 2`.
6. **Retry without inherited trust:** **Retry denied call** creates fresh Run
   authority but preserves policy context and Payment lineage; it is denied
   again without repeating derivation.
7. **Revoke and reset:** **Revoke mandate** locks Send/Retry, and **New secure
   workflow** creates a fresh context that cannot accept old references.

Expand at least one allowed receipt and the denied receipt so the audience can
see the redacted rule, decision phase, outcome, counter evidence, and causal
parent links. The one-line takeaway is: **same tool, same public type, different
trusted provenance — different authorization outcome.**

### 6. Stop and resume

Press `Ctrl+C` in the startup terminal. The script removes temporary Runtime
containers, the Go sidecar, and its private network, while keeping Agent
workspaces, conversations, and the MandateFlow SQLite journal.

- macOS state: `~/.volc-agent-launchpad/`
- Linux state: `.local/`
- Custom location: set `LOCAL_POC_DATA_ROOT`

Run `make demo` again to continue later. The direct launcher remains available
for contributors:

```bash
./CodeJam/scripts/start-local-poc.sh --quiet   # from repository root; :3000
cd CodeJam && POC_QUIET=1 npm --silent run poc  # direct npm path; :3000
```

Direct `start-local-poc.sh` and raw `npm run poc` default to `POC_QUIET=0` and
port `3000` unless overridden. `--verbose`, `VERBOSE=1`, or `POC_VERBOSE=1`
shows full Docker/npm build logs; `--quiet` or `POC_QUIET=1` shows concise
progress and the generated token banner. `npm --silent run poc` only silences
npm's wrapper messages. `run-poc.sh` is a backwards-compatible root shim;
prefer `make demo`.

If you need another port or another local instance, override the Makefile
values:

```bash
PORT=3200 \
MANDATEFLOW_CONTROL_HOST_PORT=3202 \
MANDATEFLOW_RUNTIME_MCP_HOST_PORT=3201 \
RUNTIME_INSTANCE_ID=second-demo \
make demo
open http://127.0.0.1:3200
```

`make shutdown`, `make stop`, and `make kill-ports` free project ports and
remove stale labeled resources. The cleanup port list can be overridden with
`make PORTS='3200 3201 3202' shutdown`.

For a terminal-only check against that running instance:

```bash
MANDATEFLOW_E2E_BASE_URL=http://127.0.0.1:3100 \
APP_AUTH_TOKEN='paste-the-token-from-the-make-demo-banner' \
npm run check:mandateflow:e2e
```

### Select a specific container engine

Force Podman when multiple engines are installed:

```bash
CONTAINER_ENGINE=podman \
RUNTIME_PROVIDER=container \
GROQ_API_KEY=your-groq-api-key \
make demo
```

Colima uses `CONTAINER_ENGINE=docker` because it exposes the Docker CLI.

For a clean Linux host, follow the
[rootless Podman setup](docs/LOCAL_POC.md#rootless-podman-on-linux).

## Docker Compose (baseline profile)

Docker Compose and ECS retain the starter profile and do not start the
MandateFlow sidecar. The submitted Track 1 path is `make demo`, which starts
the disposable local Runtime containers; direct `npm run poc` remains a
supported contributor path.

Create and edit the configuration:

```bash
./scripts/bootstrap-local.sh
```

Required values in `.env`:

```dotenv
GROQ_API_KEY=your-groq-api-key
GROQ_MODEL=openai/gpt-oss-120b
APP_AUTH_TOKEN=replace-with-at-least-24-random-characters
```

Start the application:

```bash
docker compose up --build
```

Open <http://localhost:3000>. Stop it without deleting Agent data:

```bash
docker compose down
```

## Development

```bash
npm install
cp .env.example .env
npm install --global @openai/codex@0.111.0
npm run dev
```

- Web UI: <http://localhost:5173>
- API: <http://localhost:3000>

Use local paths in `.env` when running outside Docker:

```dotenv
APP_DATA_DIR=.data
AGENT_WORKSPACE_ROOT=workspaces
CODEX_HOME=codex-home
```

Each Agent uses a private home at `CODEX_HOME/agents/<immutable-agent-id>`.
The application creates that directory and writes its Codex configuration
before a Run. Existing records are migrated to a fresh private home and their
legacy shared-home thread is cleared; no legacy home is copied into a new
Agent. The selected home is the only home passed to a local process or mounted
into a Runtime container.

## Deployment

- [Existing Linux ECS with Docker](docs/DEPLOYMENT.md#existing-linux-ecs)
- [Complete Volcengine environment with Terraform](docs/DEPLOYMENT.md#terraform-deployment)
- [Local Docker, Colima, and Podman details](docs/LOCAL_POC.md)

The existing-ECS script deploys from the current source tree:

```bash
cp .env.example .env.production
./scripts/deploy-existing-ecs.sh .env.production
```

The Terraform path provisions VPC, subnet, security group, ECS, and EIP:

```bash
cp deploy/volcengine/terraform.tfvars.example \
  deploy/volcengine/terraform.tfvars
./scripts/deploy-volcengine.sh
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GROQ_API_KEY` | Required for the live Agent demo | Create a free key at [groq.com](https://groq.com/). |
| `GROQ_MODEL` | `openai/gpt-oss-120b` | Responses-capable Groq model. |
| `GROQ_BASE_URL` | `https://api.groq.com/openai/v1` | Groq OpenAI-compatible API URL. |
| `APP_AUTH_TOKEN` | Empty on loopback | Shared demo token; use 24+ random characters remotely. |
| `MANDATEFLOW_ENABLED` | `false` | Enables fail-closed Run lifecycle integration. The local POC launcher sets it to `true`. |
| `MANDATEFLOW_CONTROL_URL` | `http://127.0.0.1:3002` | Host-only Go lifecycle/evidence endpoint. |
| `MANDATEFLOW_RUNTIME_MCP_URL` | `http://mandateflow-gateway:3001/mcp` | MCP URL visible inside the private Runtime network. |
| `RUNTIME_PROVIDER` | `local-process` | `container` for the live disposable Runtime profile or `fixture` for the deterministic middleware proof. |
| `CODEX_SANDBOX_MODE` | `workspace-write` | Codex inner sandbox mode. |
| `CODEX_TIMEOUT_MS` | `600000` | Maximum duration of one turn. |
| `LOCAL_POC_DATA_ROOT` | Platform-specific | Local metadata, workspace, and session directory. |

See [.env.example](.env.example) for all Runtime and resource-limit options.

## How it works

```mermaid
flowchart LR
    UI["React Web UI"] --> API["Fastify control plane"]
    API --> NodeStore["Node JSON metadata"]
    API -->|prepare / activate / finish / evidence| Go["Go MandateFlow sidecar"]
    Go --> SQLite["Go-owned SQLite"]
    API --> Container["Disposable Codex Runtime"]
    Container -->|per-Run bearer + MCP| Go
    Container --> Groq["Groq Responses API (live profile)"]
    Go --> Fixtures["Protected Support / Payments / Cases / CRM fixtures"]
```

Node owns only UI/orchestration metadata. Go exclusively owns grants, capability
digests, reference lineage, fixture counters, and redacted receipts. Raw Run
capabilities are injected only into the matching Runtime process environment.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for component and extension
boundaries.

## Validation

```bash
npm run test:server
npm run check:fast
npm run check
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" npm run check:mandateflow:e2e  # running fixture POC by default
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

Use `npm run test:server:watch` while iterating on the server. `check:fast`
runs TypeScript typechecks, server and web tests, Go formatting, `go vet`, and
race tests without production bundle builds or Docker image builds.
It requires a local Go 1.23+ toolchain. Keep `npm run check` as the complete
local gate before opening a pull request.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Local POC](docs/LOCAL_POC.md)
- [Three-minute demo and acceptance evidence](docs/DEMO.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Hackathon extension guide](docs/HACKATHON_EXTENSION_GUIDE.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

[MIT](LICENSE)
