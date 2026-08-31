# MandateFlow three-minute demo

## Start the live Agent demo

Use Node.js 22+ and a running Docker, Colima, or Podman engine:

```bash
export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
export RUNTIME_PROVIDER=container
export GROQ_API_KEY='your-real-groq-api-key'
export GROQ_MODEL='openai/gpt-oss-120b'
npm run poc
```

The startup log must say `Runtime provider: container`. This is the path that
demonstrates the real Codex Agent through Groq. If the key is stored as a raw
value in `../api_key.txt`, load it without printing it:

```bash
export GROQ_API_KEY="$(tr -d '\r\n' < ../api_key.txt)"
```

To verify only the middleware without using model tokens, restart with
`RUNTIME_PROVIDER=fixture`. Fixture mode is intentionally proof-only and does
not demonstrate a general coding Agent.

Open <http://localhost:3000>, unlock with `APP_AUTH_TOKEN`, create an Agent, and
select **Start**. First run the coding prompt:

```text
Create a small TypeScript CLI that prints a weather summary from sample JSON.
```

Show the timestamped **Runtime activity** timeline, assistant response, and
workspace change. Then select **New secure workflow**. In the proof console,
select **Run MandateFlow proof**, or choose the first starter prompt to run the
same security workflow manually:

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

1. **Demonstrate the Agent:** show the live coding prompt, Runtime activity,
   assistant response, and workspace result.
2. **Establish trust:** the header reports `MandateFlow ready`; create a fresh
   secure workflow and show its Mandate Summary.
3. **Trusted Support path:** the decision journal shows Support → Case → CRM as
   `ALLOW`; the CRM counter changes from `0` to `1`.
4. **Unsafe Payment path:** the same public Case kind reaches the same CRM
   method, but static scope is `ALLOW`, provenance is `DENY`, outcome is
   `NOT_INVOKED`, and the counter stays `1 → 1`.
5. **Safe recovery:** `payments.aggregate_failures` succeeds, followed by a
   fresh Support ticket, Case transformation, and CRM resolution. The counter
   changes from `1` to `2`.
6. **Retry without inherited trust:** **Retry denied call** keeps the policy
   context and prior causal receipts but uses a different Runtime, Run-grant
   ID, and capability fingerprint. CRM is denied again without repeating
   Payment or Case lookup.
7. **Revoke and reset:** **Revoke mandate** locks the workflow; **New secure
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
