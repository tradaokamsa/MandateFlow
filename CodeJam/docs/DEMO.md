# MandateFlow three-minute demo

## Start

Use Node.js 22+ and a running Docker, Colima, or Podman engine:

```bash
export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
npm run poc
```

No model credential is needed: the launcher selects the deterministic fixture
Runtime when `GROQ_API_KEY` is absent or a placeholder. For the optional live
Codex rehearsal, use `RUNTIME_PROVIDER=container GROQ_API_KEY=...`.

The credential-free fixture profile is intentionally proof-only: it exercises
the full MandateFlow gateway path but does not pretend to be a general coding
Agent. Use the live Codex profile for workspace inspection, edits, and command
execution.

Open <http://localhost:3000>, unlock with `APP_AUTH_TOKEN`, create an Agent, and
select **New secure workflow**. In the proof console, select **Run MandateFlow
proof**, or choose the first starter prompt to run the same workflow manually:

```text
Run the MandateFlow verification workflow. First, list the open Support ticket,
transform its subject reference with cases.lookup_subject, and resolve that Case
reference through CRM. Next, list Payment failures, transform one Payment reference
with the same Case tool, and attempt the same CRM resolution. If policy denies it,
use payments.aggregate_failures, then fetch a fresh Support ticket, transform it,
and resolve it through CRM. Report policy outcomes, not protected identifiers.
```

While a Run is active, the proof console shows a timestamped **Runtime
activity** timeline for secure preparation, Agent work, protected-tool checks,
and finalization. If no Runtime event arrives for 12 seconds, the UI explains
that the Agent may be waiting on the model or a command and offers **Stop run**.
After a failure, **Try again** keeps the request visible and turns common
provider rate-limit and timeout errors into plain-language recovery guidance.

## User flows for the demo

1. **Establish trust:** the header reports `MandateFlow ready`; create a fresh
   secure workflow and show its Mandate Summary.
2. **Trusted Support path:** the decision journal shows Support → Case → CRM as
   `ALLOW`; the CRM counter changes from `0` to `1`.
3. **Unsafe Payment path:** the same public Case kind reaches the same CRM
   method, but static scope is `ALLOW`, provenance is `DENY`, outcome is
   `NOT_INVOKED`, and the counter stays `1 → 1`.
4. **Safe recovery:** `payments.aggregate_failures` succeeds, followed by a
   fresh Support ticket, Case transformation, and CRM resolution. The counter
   changes from `1` to `2`.
5. **Retry without inherited trust:** **Retry denied call** keeps the policy
   context and prior causal receipts but uses a different Runtime, Run-grant
   ID, and capability fingerprint. CRM is denied again without repeating
   Payment or Case lookup.
6. **Revoke and reset:** **Revoke mandate** locks the workflow; **New secure
   workflow** creates a fresh policy context, and old references cannot cross
   into it. The locked mandate keeps a **Start new secure workflow** action next
   to the recovery explanation.

The contrast is the proof: identical Agent, grant shape, public Case type, and
CRM method; only trusted transitive provenance changes the decision. The demo
takeaway is: **same tool, same public type, different trusted provenance —
different authorization outcome.**

## Automated evidence

Fast checks do not call Groq:

```bash
npm run test:server
npm run check:fast
npm run check
```

Use `npm run test:server:watch` for the interactive server-test loop. The
fast check requires a local Go 1.23+ toolchain, runs `gofmt`, `go vet`, and
race-enabled Go tests, and does not build production bundles or Docker images.

Against an already running POC, run the full API/Go/SQLite acceptance workflow:

```bash
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" npm run check:mandateflow:e2e
```

The E2E script prints the initial/retry Run IDs, shared policy-context ID,
unchanged CRM counter, denial receipt IDs, and reset context. It is intentionally
separate from `npm run check`; the default fixture path is credential-free, while
the live `container` path consumes model tokens.

## Failure and recovery

- Stop the Go sidecar (or make it unavailable) and try to start a secure Run.
  Fastify returns `503` before a Runtime starts; history remains readable.
- A completed, failed, cancelled, expired, or gateway-restarted Run bearer gets
  the same generic MCP `401`.
- If terminalization cannot be confirmed, Node publishes no clean assistant
  result and starts no later Runtime for that Agent until exact-Run
  reconciliation succeeds.
- Start **New secure workflow** to close the old context, clear the thread
  association, and create a clean deterministic demo context. The UI keeps the
  old redacted receipts visible until the new Run produces its own evidence.

## Honest P0 boundary

This demo protects only the five embedded typed fixtures behind MandateFlow. It
does not claim general DLP, production identity, protection for arbitrary text
or files, immediate revocation after sudden Node death, replay prevention, or
multi-tenant container isolation. Docker Compose and ECS are not the submitted
MandateFlow path.
