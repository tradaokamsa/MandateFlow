# UX Contract

## Product context

- Audience: Hackathon builders operating coding Agents in a local Playground.
- Primary jobs: Create an Agent, run a secure workflow, inspect redacted evidence, and stop or revoke authority safely.
- Target market(s): Global developer tooling; bounded demo identity only.
- Active locales: English; browser locale is used for timestamps.
- Language/content register: Plain, operational, sentence case.
- Timezone/calendar policy: Absolute timestamps are formatted in the browser locale.
- Accessibility target: WCAG 2.2 AA

## Business-context sources

| Domain / scope | Authoritative source | Source type | Reviewed date |
|---|---|---|---|
| Mandate and ownership model | `mandateflow_docs/MANDATEFLOW.md` | Product / security design | 2026-08-30 |
| P1 hardening requirements | GitHub issue #8, `tradaokamsa/MandateFlow` | Product issue | 2026-08-30 |
| Agent lifecycle | `README.md` | Product documentation | 2026-08-30 |

## Visual contract

- Project `DESIGN.md`: `DESIGN.md`
- Token ownership model: Existing runtime CSS is canonical; `DESIGN.md` records semantic roles.
- Runtime design-system/token source: `apps/web/src/styles.css`
- Mapping/export/adapters: UI classes consume the existing CSS variables and button styles.
- Token drift gate: `designmd lint DESIGN.md` and the premium project audit.
- Supported themes: Warm paper workspace with dark utility rail; no alternate theme.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
|---|---|---|---|---|
| Select/Listbox | Native `select` in the create-Agent form | This contract and browser semantics | native | keyboard + popup |
| Form | Native labeled fields with server-side Zod validation | `apps/server/src/app.ts` and this contract | create / edit | validation + API tests |
| Scrollbar | Global application stylesheet | `apps/web/src/styles.css` | geometry exceptions | computed style |
| CRUD | `AgentService` and existing Playground controls | `apps/server/src/agent-service.ts` | return / stay | full-flow tests |
| Destructive confirmation | App-owned modal dialog | `apps/web/src/App.tsx` | revoke / delete | keyboard + failure-path tests |
| Status feedback | Inline `role=status` and `role=alert` regions | `apps/web/src/App.tsx` | success / warning / error | DOM-level test |
| Proof console | `ProofPanel` plus pure receipt derivation | `apps/web/src/ProofPanel.tsx`, `proof.ts` | pending / verified | receipt-backed state tests |
| Run activity | `ProofPanel` activity rail backed by `AgentRun.progress` | `apps/server/src/types.ts`, runner event parsing | queued / active / terminal | progress persistence + stale-state recovery |
| Receipt detail | Native `details` disclosure | `apps/web/src/ReceiptCard.tsx` | compact / expanded / missing parent | redaction + causal-link tests |

## Component behavior

| Component | Default | Hover | Focus | Active | Disabled | Busy | Error |
|---|---|---|---|---|---|---|---|
| Button | Existing emphasis and semantic intent styles | Preserve existing lift/contrast | Visible outline | Existing pressed treatment | Reduced contrast and no action | Stable footprint with spinner | Inline alert when needed |
| Input | Labeled and server-validated | Existing border transition | Visible outline | n/a | Native disabled | n/a | Preserve input and show alert |
| Textarea | Fixed resize behavior | Existing border transition | Visible outline | n/a | Native disabled | n/a | Preserve input and show alert |
| Mandate summary | Safe server-derived metadata only | n/a | Buttons are keyboard reachable | Revoke requires confirmation | Send and Retry disabled after revoke; start-new-workflow remains available | Revoke button retains size | Inline recovery copy |

## Flow ledger

| Operation | Trigger | Pending | Success destination | Success feedback | Failure recovery | Focus outcome | Source ref |
|---|---|---|---|---|---|---|---|
| Create Agent | Create Agent form | Disable submit | Selected Agent Playground | Agent appears in sidebar | Preserve form and show alert | Modal remains open on failure | `apps/web/src/App.tsx` |
| Edit Agent | Settings form | Disable submit | Same Playground | Updated configuration | Preserve form and show alert | Keep settings open on failure | `apps/web/src/App.tsx` |
| Revoke mandate | Mandate Summary action | App-owned confirmation, then disable action | Same Playground with evidence retained | Inline revoked/cancelled status | Keep summary and explain failure | Return focus to summary action | GitHub issue #8 |
| Run activity | Send / proof / retry action | Timestamped queued, authorization, Runtime, tool, and finalization events | Same Playground with result or recovery state | Current phase, recent activity, and terminal status | Explain stale Runtime and offer Stop run | Keep activity region in view | `apps/server/src/types.ts` |
| New secure workflow | Explicit header action | Disable while busy or an active Run exists | Same Playground with cleared thread association | Fresh-workflow status; proof returns to pending | Keep prior evidence until action succeeds | Focus remains in header | GitHub issue #8 |
| Delete Agent | Delete action | Existing confirmation flow | Agent list | Agent removed and workspace archived | Show error | Focus moves to selected list item | `apps/web/src/App.tsx` |

## Navigation and responsive behavior

- The dark sidebar becomes a compact header strip on narrow screens; the
  accessible Agent switcher opens as a bounded dialog with a visible close action
  and focus restoration.
- Mandate metadata wraps from four columns to two; long principals use a truncated visible value with a full-value tooltip.
- The Playground keeps evidence visible after cancellation or revocation.
- The proof rows collapse from four columns to one without hiding their labels or
  pending/verified state.

## Overlays and feedback

- Dialog primitive: app-owned modal backdrop with `role="dialog"`, `aria-modal`, title, description, Escape, and explicit cancel/action buttons.
- Destructive confirmation: name the mandate and state that Runtime cancellation and future authority invalidation will occur.
- Alert/banner scope: inline beneath the workspace header; critical revocation state remains in the summary.

## Async and resilience

- Mutations are pessimistic and serialized by the service/store.
- Duplicate revoke submissions are prevented in the UI and the sidecar operation is idempotent.
- Sidecar persistence precedes Runtime cancellation; an unavailable sidecar fails closed.
- Polling refreshes Agent state, messages, evidence, mandate summary, and the
  persisted Run activity timeline while a Run is active. If no Runtime event is
  received for 12 seconds, the UI names the possible stall and offers Stop run.

## Validation

- Schema layer: Fastify Zod schemas and Go strict JSON decoding.
- Trigger timing: on submit; native browser bubbles are disabled with `noValidate`.
- Sensitive-value handling: capabilities, private references, customer data, credentials, and fixture IDs are never rendered in the summary or receipts.

## Permission and clipboard

- Permission UI strategy: disable Send and Retry after revocation and retain redacted evidence.
- Disabled-state explanation: the summary states that the mandate is revoked,
  explains that the workflow is locked, and keeps a Start new secure workflow
  action beside that message.
- Proof claims are derived only from API receipts: the policy rule, CRM counter,
  downstream invocation state, context continuity, and causal parents are shown
  as pending when evidence is absent rather than inferred from prompt text.

## Verification

- Required static commands: `npm run typecheck`, `npm run test`, `npm run build`, `npm run check:go`, and the premium project audit.
- Accessibility checks: semantic controls, visible focus, live status/error regions, responsive narrow layout, and reduced-motion-safe existing styles.
- Canonical sibling flow used for comparison: existing Settings and Delete Agent controls.
