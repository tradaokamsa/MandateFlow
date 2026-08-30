# MandateFlow

### TikTok TechJam 2026 · Track 1 — Agent Launchpad middleware

**Stop unsafe data composition before an Agent reaches a protected tool.**

MandateFlow is a hackathon-scale proof of concept built on the provided Agent
Launchpad starter. It adds a provenance-sensitive authorization gateway to a
working Agent platform: a Support-derived Case may reach CRM, while a
Payment-derived Case is denied before CRM is invoked—even when both calls use
the same public resource type and the same CRM method.

The proof is functional end to end:

```text
Browser → React Playground → Fastify → AgentService
        → disposable Codex Runtime → Go MCP Gateway → protected fixtures
```

The Go gateway owns the policy decision, server-side reference lineage, and
redacted receipts. The browser and the model never decide whether a protected
cross-tool flow is safe.

## Judge's fast path

The intended judging path is one local command, one browser scenario, and less
than three minutes of live interaction.

### Requirements

- macOS or Linux
- Node.js 22+ and npm 10+
- Docker, Colima, or rootless Podman
- A Groq API key for a Responses-capable model

### Start the proof of concept

```bash
git clone https://github.com/tradaokamsa/MandateFlow.git
cd MandateFlow/CodeJam

export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require(\"node:crypto\").randomBytes(24).toString(\"base64url\"))')"
GROQ_API_KEY=your-groq-api-key npm run poc
```

The launcher installs dependencies when needed, builds the Go sidecar and
disposable Runtime image, creates a private instance network, and starts the
production Web/API bundle at <http://localhost:3000>. Enter the generated
`APP_AUTH_TOKEN` in the browser unlock screen. The script automatically selects
Docker, Colima, or Podman; set `CONTAINER_ENGINE=podman` to force Podman.

### The three-minute scenario

1. Create an Agent in the browser and select **New secure workflow**.
2. Run the first starter prompt:

   ```text
   Run the MandateFlow verification workflow. First, list the open Support ticket,
   transform its subject reference with cases.lookup_subject, and resolve that Case
   reference through CRM. Next, list Payment failures, transform one Payment reference
   with the same Case tool, and attempt the same CRM resolution. If policy denies it,
   use payments.aggregate_failures and finish the brief. Report policy outcomes, not
   protected identifiers.
   ```

3. Open the Run's decision journal and show the contrast:

   | Flow | Expected result | Judge-visible proof |
   | --- | --- | --- |
   | `Support → Case → CRM` | `ALLOW` | CRM counter changes `0 → 1`. |
   | `Payment → Case → CRM` | `FLOW_DENIED` | Denied at `PRE_EXECUTION`; CRM counter stays `1 → 1`; fixture is not invoked. |
   | `Payment → aggregate` | `ALLOW` | Safe in-scope recovery completes the brief. |
   | Retry the denied call | `FLOW_DENIED` | New Run, Runtime, grant, and capability; same policy context and lineage; denial remains. |

The important comparison is deliberately narrow: the Agent, grant shape,
intermediate `operations-case` type, and CRM method are the same. Only the
trusted transitive provenance differs. The UI also exposes the redacted receipt
timeline, mandate summary, and an explicit **Revoke mandate** control.

For the exact acceptance walkthrough, see
[CodeJam/docs/DEMO.md](CodeJam/docs/DEMO.md).

## What problem is solved?

An Agent may legitimately need several tools in one workflow, but a tool
allowlist alone cannot express every data-flow rule. In the demo, Support cases
may be re-identified for follow-up, while Payment failures may be reported only
in aggregate. A naive tool-scope check sees that both workflows are allowed to
call `cases.lookup_subject` and `crm.resolve_customer`; it does not know where
the Case reference came from after the transformation.

MandateFlow changes the authorization unit from an isolated tool call to:

```text
typed tool call + immutable Run grant + server-owned reference lineage
```

Each secure workflow receives a root mandate, each Run receives an attenuated
grant and short-lived capability, and each protected reference is minted and
resolved only by the Go gateway. The gateway evaluates static scope and
provenance before invoking the fixture. Authenticated denials are persisted as
redacted receipts; unauthenticated or expired capabilities receive a generic
HTTP `401` without policy disclosure.

## Why this is middleware

The middleware is not a screen or a hard-coded demo message. It executes at a
trusted boundary in the real Agent path:

- **Fastify / AgentService:** prepares, activates, finishes, retries, and
  revokes authority around real Agent Runs.
- **AgentRunner / Runtime:** injects only the matching per-Run capability and
  connects the disposable Runtime to the private MCP network.
- **Go MandateFlow Gateway:** authenticates the capability, loads immutable
  grants and reference ancestry from SQLite, evaluates policy, and blocks
  forbidden calls before the protected fixture runs.
- **Protected data path:** Support, Payments, Cases, and CRM fixtures are
  reachable only through the gateway; a denied call cannot increment the CRM
  counter.
- **Evidence path:** Go atomically records the decision, outcome, counters, and
  derived lineage in a redacted receipt journal.

The original starter experience remains intact: Agent CRUD, lifecycle actions,
Playground chat, persistent workspaces, Codex sessions, and model execution.
Only the UI needed to operate and explain the middleware was added.

## Architecture and trust boundary

![MandateFlow integration architecture](mandateflow_docs/mandateflow-assets/mandateflow-architecture.svg)

The one-page diagram above shows the integration seams and trust boundary. The
short version is:

| Component | Owns |
| --- | --- |
| React / Codex / Runtime inputs | Untrusted prompts, tool arguments, and opaque references. |
| Node `JsonStore` | Agent/message metadata plus safe foreign IDs and fingerprints; it never opens the policy database. |
| Go sidecar + SQLite | Mandates, Run grants, capability digests, ownership-bound fixtures, reference ancestry, receipts, and counters. |
| Gateway | The only enforcement point for the five protected MCP operations. |

The local launcher gives each instance a private bridge network. The MCP port
is not published to the host; the Go control listener is loopback-only. Each
Runtime mounts only its selected Agent workspace and private Codex home.

Read the deeper boundary and lifecycle details in
[CodeJam/docs/ARCHITECTURE.md](CodeJam/docs/ARCHITECTURE.md) and the design
record in [mandateflow_docs/MANDATEFLOW.md](mandateflow_docs/MANDATEFLOW.md).

## Track 1 rubric alignment

The submission is organized around the Track 1 judging weights:

| Weight | Criterion | Evidence in this repository |
| ---: | --- | --- |
| **40%** | End-to-end middleware behavior | Browser-triggered Codex Run → real Streamable HTTP MCP Gateway → allowed protected operation, pre-execution provenance denial, and safe recovery. |
| **25%** | Technical design and integration | Explicit Fastify/AgentService/AgentRunner seams, immutable authority contract, exclusive protected path, trust-boundary diagram, and failure semantics. |
| **20%** | Verification and robustness | Go unit/integration tests for scope, provenance, forged references, ownership, revocation, retry continuity, redaction, non-invocation, and HTTP authentication; TypeScript tests for lifecycle and runtime wiring. |
| **15%** | Demo and reproducibility | `npm run poc`, deterministic typed fixtures, documented Docker/Colima/Podman path, three-minute script, automated checks, and honest limitations. |

Track 1 asks teams to preserve the starter, implement real behavior in a
backend/Runtime/data/infrastructure path, show a normal and failure/denial or
recovery case, add automated tests, keep secrets out, and document a focused
middleware story. MandateFlow is intentionally deep rather than broad.

## Verification

Run from `CodeJam/`:

```bash
# Fast local gate: TypeScript, server tests, gofmt, go vet, and race tests
npm run check:fast

# Complete gate: fast checks plus production Web/API builds
npm run check

# Focused Go middleware check
npm run check:mandateflow

# Against an already running POC; consumes Groq tokens
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" npm run check:mandateflow:e2e
```

The E2E check prints the initial and retry Run IDs, shared policy-context ID,
unchanged CRM counter, and both denial receipt IDs. It is separate from
`npm run check` so ordinary verification does not require a model request.

## Honest scope

This is a single-host, single-user POC and the security claim is intentionally
bounded to the five typed fixture operations exclusively reachable through
MandateFlow. It is not a production identity provider, general DLP engine,
arbitrary MCP proxy, exactly-once system, or hardened multi-tenant sandbox.

Known limits include crash-time revocation, replay prevention, raw values copied
into unprotected files/text/network paths, and platforms where inner Codex
Landlock is unavailable. Docker Compose and ECS retain the starter baseline;
the submitted Track 1 path is the local disposable-Runtime profile.

See [CodeJam/SECURITY.md](CodeJam/SECURITY.md) before using any real data or
credentials. Never commit `.env`, API keys, bearer tokens, or generated runtime
state.

## Repository map

```text
CodeJam/                         React UI, Fastify API, Codex runners, launcher
middleware/mandateflow/          Go sidecar, MCP gateway, policy, SQLite store
mandateflow_docs/                Design rationale, contracts, and diagrams
MIDDLEWARE_TESTING.md            Focused test and live-E2E commands
```

Useful reading order:

1. [Three-minute demo](CodeJam/docs/DEMO.md)
2. [Architecture](CodeJam/docs/ARCHITECTURE.md)
3. [MandateFlow design](mandateflow_docs/MANDATEFLOW.md)
4. [Go gateway README](middleware/mandateflow/README.md)
5. [Local POC details](CodeJam/docs/LOCAL_POC.md)

## License

[MIT](LICENSE)
