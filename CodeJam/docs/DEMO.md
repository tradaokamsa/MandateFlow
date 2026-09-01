# MandateFlow three-minute demo

## Start the live Agent demo

Use Node.js 22+ and a running Docker, Colima, or Podman engine:

Create a free Groq API key at [groq.com](https://groq.com/) before starting the
live Agent demo.

> **Test this on your own key before the live demo.** On a free/on-demand
> Groq tier, `gpt-oss-120b` can return `413 Request too large` (a single
> Codex turn needs ~9,100 tokens, above that tier's 8,000 TPM cap) —
> `gpt-oss-20b` fit under that specific cap in our testing. This is a
> per-account rate limit, not a code defect, so a higher tier or different
> key may not hit it.

From the repository root, the preferred judge path is:

```bash
make demo
```

`make demo` runs the single launcher, `CodeJam/scripts/start-local-poc.sh`,
after `make shutdown`. It uses port `3100`, frees known ports, removes stale
MandateFlow containers/networks, generates the browser unlock token, and keeps
Docker/npm build logs quiet while showing concise progress steps. The startup
banner prints the unlock token and the URL; do not show either credential in a
recording.

To force the live Agent profile, provide a usable Groq key through the
environment or store it as a raw value in `../api_key.txt`:

```bash
RUNTIME_PROVIDER=container \
GROQ_API_KEY='your-real-groq-api-key' \
GROQ_MODEL='openai/gpt-oss-120b' \
make demo
```

The live Agent profile is the recommended path for the demo and supports
general coding tasks in the disposable Runtime.

Supported alternatives:

```bash
./CodeJam/scripts/start-local-poc.sh       # direct launcher; defaults to :3000
make demo-verbose                          # full Docker/npm logs
make demo VERBOSE=1                        # full logs via an environment override
cd CodeJam && POC_QUIET=1 npm --silent run poc
```

The direct launcher and `npm run poc` default to `POC_QUIET=0` and port `3000`
unless `PORT` is set. `--quiet` or `POC_QUIET=1` enables the concise progress
output; `--verbose`, `VERBOSE=1`, `POC_VERBOSE=1`, or `POC_QUIET=0` restores
full build logs. In quiet mode, the launcher's internal `_poc_run` wrapper
captures Docker/npm output and prints it on failure; use a verbose rerun for
the complete live log.
`npm --silent run poc` suppresses npm's wrapper messages only; it does not set
`POC_QUIET` by itself. `run-poc.sh` remains a backwards-compatible root shim;
prefer `make demo`.

Open <http://localhost:3100>, unlock with the token printed by `make demo`,
create an Agent, and select **Start**. First run the coding prompt:

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

> This prompt calls five protected tools in one turn. In one test run this
> tripped `output_parse_failed` on `gpt-oss-20b` via the live `container`
> Runtime — consistent with community reports of `tool_use_failed` on long
> tool chains for Groq's gpt-oss models, though it was only reproduced once
> and may be model/tier/account dependent. If it happens on your key,
> `RUNTIME_PROVIDER=fixture` drives the identical Go Gateway/SQLite path
> deterministically and is the fallback for judging if the live model path
> is flaky on the day.

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

Run the automated checks with:

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
MANDATEFLOW_E2E_BASE_URL=http://127.0.0.1:3100 \
APP_AUTH_TOKEN='paste-the-token-from-the-make-demo-banner' \
npm run check:mandateflow:e2e
```

Use port `3000` instead when the POC was started through direct `npm run poc`,
or set `MANDATEFLOW_E2E_BASE_URL` to the chosen `PORT`.

The E2E script prints the initial/retry Run IDs, shared policy-context ID,
unchanged CRM counter, denial receipt IDs, and reset context. It is intentionally
separate from `npm run check`; the live `container` path consumes model tokens.

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
