# MandateFlow Product Demo Script

**Product demo duration:** One minute and twenty seconds

**Agent mapping:** State 1 = `Live Build`; State 3 = `MandateFlow Proof`.

## Product demo

### 0:00–0:20 — Launch an Agent

**Screen:** State 1 — create `Live Build`, select `Start`, and enter:

```text
Create a small TypeScript CLI that prints a weather summary from sample JSON.
```

Show the Agent beginning the task and the `Runtime activity` timeline.

> This is the normal Agent experience. We launch an Agent with its own
> workspace, then it can inspect files, write code, and run commands.

### 0:20–0:30 — Switch to the completed MandateFlow run

**Screen:** Immediately select State 3 — `MandateFlow Proof`. Show `Run
complete` and the `Live security proof` panel.

> Now let’s switch to a completed secure run and focus on the decision that
> MandateFlow makes.

### 0:30–0:55 — Show the core decision

**Screen:** State 3 — `MandateFlow Proof`. Point only to:

- `Support → Case → CRM` — allowed;
- `Payment → Case → CRM` — blocked before CRM;
- `NO_PAYMENT_REIDENTIFICATION`;
- `CRM counter unchanged · 1 → 1`.

> Support data is allowed to reach CRM.
>
> The Payment request looks similar, but MandateFlow blocks it before CRM is
> called. The counter stays unchanged, proving that the protected tool never
> ran.

### 0:55–1:10 — Show the blocked receipt

**Screen:** Stay on State 3. In the `Trusted Decision Journal`, expand the red
`crm.resolve_customer` receipt. Point to `scope ALLOW`, `flow DENY`,
`NOT_INVOKED`, and `CRM 1 → 1 · not invoked`.

> The Agent has permission to call CRM, but this particular Payment-derived
> reference is not allowed to go there. The receipt records the rule and proves
> that CRM was not invoked.

### 1:10–1:20 — Conclusion

**Screen:** Remain on the blocked receipt.

> MandateFlow lets safe data through and stops unsafe data before it reaches the
> protected tool.
