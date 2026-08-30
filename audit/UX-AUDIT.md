# MandateFlow workflow audit

Audit date: 2026-08-30  
Surface: Agent Launchpad at `127.0.0.1:3100` in Brave  
Profile exercised: deterministic fixture Runtime + Go gateway

## Verdict

The original flow was not customer-friendly because a long-running Run exposed
only a generic loading message. The backend did not publish Codex activity, so
the browser could not tell whether the Agent was authorizing, thinking, using a
protected tool, waiting on the model, or stuck. Revocation also behaved like a
dead end: the workflow became locked, but the next action was easy to miss.

The implementation now exposes a redacted, timestamped Run activity timeline,
names stale Runtime activity after 12 seconds, provides Stop run while active,
maps common provider failures to plain-language recovery copy, and keeps a
Start new secure workflow action beside the revoked state.

## Captured flow

### 1. Completed proof — healthy after the fix

![Completed proof with Runtime activity](evidence/02-activity-timeline.jpeg)

The completed state now shows the actual sequence: protected-tool discovery,
trusted Support path, Payment path, safe recovery, fresh Support recovery,
security finalization, and completion. This is materially better than a
spinner because it also explains what was verified and keeps the receipt-backed
proof visible.

### 2. Run starts — recoverable while active

![Queued Run with activity rail](evidence/03-run-started.jpeg)

The first visible state is no longer an unexplained loading screen. It shows
`Run queued`, the secure Runtime activity rail, and `Stop run`. The final build
also uses the same latest activity label in the chat composer instead of the
old generic “Codex is reading, editing, or running commands…” copy.

### 3. Revocation confirmation — clear destructive intent

![Revocation confirmation dialog](evidence/04-revoke-confirmation.jpeg)

The dialog explicitly states that the active Runtime stops, the capability is
invalidated, and the journal remains available. Focus lands on `Keep mandate`,
which is the safer default. The action is understandable, although the
revocation copy is intentionally consequential and should remain visually
distinct from normal workflow controls.

### 4. Revoked workflow — healthy recovery after the fix

![Revoked workflow with recovery action](evidence/05-revoked-recovery.jpeg)

The locked state now says `Workflow locked`, preserves the evidence, and puts
`Start new secure workflow` next to the reason. This removes the dead end from
the reported flow. Sending and retrying remain disabled until fresh authority
exists.

### 5. Fresh secure workflow — healthy reset

![Fresh workflow ready to run](evidence/06-fresh-workflow.jpeg)

The reset returns proof rows to pending, shows `Awaiting a live run`, and gives
the user a clear next step. Old evidence remains in the conversation for
context while the new policy context starts cleanly.

## Findings and changes

1. **P0 — No meaningful progress during model-backed work.** The Run model had
   only `queued` / `running`, and Codex JSON was reduced to the final message.
   Added safe progress events across server preparation, mandate
   authorization, Runtime start, Codex item types, fixture proof steps,
   finalization, completion, failure, and cancellation. The UI renders the
   current phase plus recent timestamped activity.

2. **P0 — A stalled Run had no recovery language.** Added a 12-second stale
   activity warning and a visible Stop run action. Cancellation waits are
   bounded so a revoke or stop request cannot wait forever for a Runtime that
   never entered the runner.

3. **P1 — Revocation felt like a terminal dead end.** Added an inline recovery
   action beside the locked mandate and a blocked-state explanation in the
   proof console.

4. **P1 — Provider failures were too technical.** Historical local state
   contained two Docker Runs failing with `429 Too Many Requests`. The UI now
   explains rate limiting, timeout, and empty-response failures in plain terms
   and offers Try again for failed Runs.

5. **P1 — Fixture and live behavior need different expectations.** The Runtime
   card now remains the source of truth for whether the current profile is a
   deterministic fixture or Codex-backed Docker Runtime. This audit exercised
   the fixture profile because no usable Groq credential was available for a
   live model Run; the Codex event mapping is covered by parser tests.

## Accessibility and evidence limits

- The captured states use semantic buttons, a native dialog pattern, live
  status regions, visible focus styling, and responsive activity stacking.
- Screenshots cannot prove full screen-reader output, contrast under every
  theme, or complete keyboard traversal. Those remain code/test verification
  responsibilities.
- A clean initial stale-state screenshot could not be accepted because the
  shared Brave desktop changed focus to a Google Meet window during capture; it
  was rejected and kept outside this audit folder. All screenshots above were
  recaptured, inspected, and accepted from the local app states.
