# MandateFlow — hackathon showcase diagrams

> **Same tool. Same public type. Different trusted provenance. Different authorization outcome.**

Use **Diagram 1** as the architecture slide: it shows exactly where MandateFlow
extends CodeJam and makes the trust boundary explicit. Use **Diagram 2** for the
live proof or as the next slide: it makes the allow/deny result understandable
without requiring the audience to know MCP or capability terminology.

## 1. Where MandateFlow fits into CodeJam

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, ui-sans-serif, system-ui, sans-serif","primaryTextColor":"#0f172a","lineColor":"#475569","clusterBkg":"#f8fafc","clusterBorder":"#cbd5e1"},"flowchart":{"curve":"basis","nodeSpacing":30,"rankSpacing":38}}}%%
flowchart TB
  classDef baseline fill:#ffffff,stroke:#64748b,color:#0f172a,stroke-width:1.5px
  classDef untrusted fill:#fff7ed,stroke:#ea580c,color:#7c2d12,stroke-width:1.8px
  classDef external fill:#ffffff,stroke:#94a3b8,color:#475569,stroke-width:1.2px,stroke-dasharray:5 4
  classDef middleware fill:#eff6ff,stroke:#2563eb,color:#1e3a8a,stroke-width:1.8px
  classDef gateway fill:#ede9fe,stroke:#7c3aed,color:#3b0764,stroke-width:2.5px
  classDef state fill:#ecfeff,stroke:#0891b2,color:#164e63,stroke-width:1.8px
  classDef protected fill:#ecfdf5,stroke:#059669,color:#064e3b,stroke-width:1.8px

  subgraph codejam["CODEJAM BASELINE"]
    direction LR
    ui["React Playground<br/>run proof · inspect evidence"]:::baseline
    host["Fastify + AgentService<br/>trusted Run lifecycle"]:::baseline
    runner["AgentRunner<br/>per-Run bootstrap"]:::baseline
    runtime["Agent execution<br/>Codex Runtime (live) or fixture Runner<br/>UNTRUSTED for authorization"]:::untrusted
    groq["Groq Responses API<br/>live profile"]:::external

    ui --> host --> runner --> runtime
    runtime -.->|existing inference path| groq
  end

  seams["MANDATEFLOW EXTENSION SEAMS<br/>CONTROL · AgentService ↔ authority lifecycle + redacted evidence<br/>PROTECTED DATA · Runner / Runtime ↔ MCP Gateway with a short-lived capability"]:::middleware

  subgraph mandateflow["TRUSTED MANDATEFLOW"]
    direction LR
    control["Authority lifecycle<br/>prepare · activate · finish<br/>retry · revoke"]:::middleware
    sqlite[("Go-owned SQLite<br/>mandates · immutable grants<br/>lineage · counters · receipts")]:::state
    gateway["Go MCP Gateway<br/>authenticate · exact scope<br/>reference lineage · pinned policy"]:::gateway
    fixtures["Protected fixtures (POC)<br/>Support · Payments · Cases · CRM<br/>invoked only after ALLOW"]:::protected

    control <--> sqlite
    gateway <--> sqlite
    gateway ==>|only protected route| fixtures
  end

  codejam --> seams ==> mandateflow

  style codejam fill:#f8fafc,stroke:#94a3b8,stroke-width:1.2px
  style mandateflow fill:#faf5ff,stroke:#a78bfa,stroke-width:1.5px
```

**Presenter cue:** CodeJam still owns the user experience, Agent lifecycle, and
Runtime. MandateFlow adds an authenticated control path and one exclusive
protected-tool path. The model can request a call; only the Go Gateway can
authorize and execute it. Node keeps only safe IDs and fingerprints; authority,
lineage, and receipt state remain Go-owned.

## 2. The proof judges should remember

```mermaid
%%{init: {"theme":"base","themeVariables":{"fontFamily":"Inter, ui-sans-serif, system-ui, sans-serif","primaryTextColor":"#0f172a","lineColor":"#475569","clusterBkg":"#ffffff","clusterBorder":"#cbd5e1"},"flowchart":{"curve":"basis","nodeSpacing":28,"rankSpacing":38}}}%%
flowchart LR
  classDef constant fill:#0f172a,stroke:#0f172a,color:#ffffff,stroke-width:2px
  classDef support fill:#ecfdf5,stroke:#059669,color:#064e3b,stroke-width:1.8px
  classDef payment fill:#fff1f2,stroke:#e11d48,color:#881337,stroke-width:1.8px
  classDef gateway fill:#fff7ed,stroke:#ea580c,color:#7c2d12,stroke-width:2.2px
  classDef allow fill:#ecfdf5,stroke:#059669,color:#064e3b,stroke-width:2px
  classDef deny fill:#fff1f2,stroke:#e11d48,color:#881337,stroke-width:2px
  classDef safe fill:#f0fdfa,stroke:#0f766e,color:#134e4a,stroke-width:1.8px
  classDef evidence fill:#f5f3ff,stroke:#7c3aed,color:#4c1d95,stroke-width:1.8px

  same["SAME AGENT · SAME RUN GRANT<br/>Same public operations-case type<br/>Same crm.resolve_customer call<br/>Static scope: ALLOW"]:::constant

  support["SUPPORT → CASES<br/>opaque Case reference<br/>stored lineage: Support"]:::support
  payment["PAYMENTS → CASES<br/>same public Case type<br/>stored lineage: PAYMENT_<br/>AGGREGATE_ONLY"]:::payment

  gate{"MANDATEFLOW<br/>GATEWAY<br/>Where did this protected<br/>reference come from?"}:::gateway

  allowed["ALLOW · SUCCEEDED<br/>CRM invoked<br/>counter 0 → 1"]:::allow
  denied["DENY · PRE_EXECUTION<br/>FLOW_DENIED · NOT_INVOKED<br/>CRM counter 1 → 1"]:::deny
  recovery["SAFE RECOVERY<br/>aggregate Payment failures<br/>then fresh Support reaches CRM<br/>counter 1 → 2"]:::safe
  evidence[("TRUSTED SQLITE PROOF<br/>server-owned lineage<br/>redacted receipts · counters")]:::evidence

  same -.->|authority for both paths| gate
  support ==>|same-looking CRM call| gate
  payment ==>|same-looking CRM call| gate
  gate -->|Provenance: ALLOW| allowed
  gate -->|Provenance: DENY| denied
  allowed --> evidence
  denied --> evidence
  denied --> recovery --> evidence
```

**Presenter cue:** A normal allowlist sees two permitted calls to the same CRM
method. MandateFlow resolves where each opaque Case reference came from. The
Support-derived call executes; the Payment-derived call is stopped before CRM,
and the unchanged counter proves non-invocation. The blocking rule is
`NO_PAYMENT_REIDENTIFICATION`.

**Persistence proof:** Explicit Retry creates a new Run, Runtime, immutable
grant, and capability, but keeps the same policy context and stored Payment
lineage. The same CRM request is denied again without replaying the lookups.

---

**Scope boundary:** This proof covers five typed fixture operations placed
exclusively behind MandateFlow. It is a single-host POC, not general DLP for raw
text, files, arbitrary network calls, or production multi-tenant isolation.
