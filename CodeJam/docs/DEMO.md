# MandateFlow three-minute demo

## Start

Use Node.js 22+ and a running Docker, Colima, or Podman engine:

```bash
export APP_AUTH_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))')"
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

Open <http://localhost:3000>, unlock with `APP_AUTH_TOKEN`, create an Agent, and
select **New secure workflow**. Choose the first starter prompt:

```text
Run the MandateFlow verification workflow. First, list the open Support ticket,
transform its subject reference with cases.lookup_subject, and resolve that Case
reference through CRM. Next, list Payment failures, transform one Payment reference
with the same Case tool, and attempt the same CRM resolution. If policy denies it,
use payments.aggregate_failures and finish the brief. Report policy outcomes, not
protected identifiers.
```

## What to show

1. The header reports `MandateFlow ready` and the Run completes normally.
2. The decision journal shows Support → Case → CRM as `ALLOW`; the CRM counter
   changes from `0` to `1`.
3. The same public Case kind derived from Payments reaches the same CRM method,
   but static scope is `ALLOW`, provenance is `DENY`, outcome is `NOT_INVOKED`,
   and the counter stays `1 → 1`.
4. `payments.aggregate_failures` succeeds as the in-scope recovery.
5. Select **Retry denied call**. The retry keeps the policy-context ID and prior
   causal receipts but has a different Runtime, Run-grant ID, and capability
   fingerprint. CRM is denied again without repeating Payment or Case lookup.

The contrast is the proof: identical Agent, grant shape, public Case type, and
CRM method; only trusted transitive provenance changes the decision.

## Automated evidence

Fast checks do not call Ark:

```bash
npm run check
```

Against an already running POC, run the actual Codex/Ark workflow explicitly:

```bash
APP_AUTH_TOKEN="$APP_AUTH_TOKEN" npm run check:mandateflow:e2e
```

The E2E script prints the initial/retry Run IDs, shared policy-context ID,
unchanged CRM counter, and both denial receipt IDs. It consumes model tokens and
is intentionally separate from `npm run check`.

## Failure and recovery

- Stop the Go sidecar (or make it unavailable) and try to start a secure Run.
  Fastify returns `503` before a Runtime starts; history remains readable.
- A completed, failed, cancelled, expired, or gateway-restarted Run bearer gets
  the same generic MCP `401`.
- If terminalization cannot be confirmed, Node publishes no clean assistant
  result and starts no later Runtime for that Agent until exact-Run
  reconciliation succeeds.
- Start **New secure workflow** to close the old context and create a clean
  deterministic demo context.

## Honest P0 boundary

This demo protects only the five embedded typed fixtures behind MandateFlow. It
does not claim general DLP, production identity, protection for arbitrary text
or files, immediate revocation after sudden Node death, replay prevention, or
multi-tenant container isolation. Docker Compose and ECS are not the submitted
MandateFlow path.
