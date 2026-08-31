import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ReceiptCard } from "./ReceiptCard";
import type { PolicyReceipt } from "./types";

function receipt(overrides: Partial<PolicyReceipt> = {}): PolicyReceipt {
  return {
    id: "receipt-denied-12345678",
    createdAt: "2026-08-30T12:00:00.000Z",
    runId: "run-12345678",
    policyContextId: "ctx-12345678",
    runGrantId: "grant-12345678",
    tool: "crm.resolve_customer",
    action: "read",
    resourceKind: "customer-profile",
    decision: "DENY",
    staticScopeDecision: "ALLOW",
    provenanceDecision: "DENY",
    enforcementStage: "PRE_EXECUTION",
    outcome: "NOT_INVOKED",
    downstreamInvoked: false,
    ruleId: "NO_PAYMENT_REIDENTIFICATION",
    reason: "Payment-derived references are aggregate-only",
    causedByReceiptIds: ["receipt-payment-12345678"],
    inputReferenceAliases: ["ref:12345678"],
    redactedInputSummary: "Protected reference ref:12345678",
    redactedResultSummary: "Protected fixture was not invoked",
    counterBefore: 1,
    counterAfter: 1,
    policyId: "mixed-operations-flow",
    policyVersion: 1,
    ...overrides,
  };
}

describe("ReceiptCard", () => {
  it("renders the authoritative rule ID and navigable causal parent", () => {
    const markup = renderToStaticMarkup(
      <ReceiptCard
        receipt={receipt()}
        receipts={[receipt(), receipt({
          id: "receipt-payment-12345678",
          tool: "payments.list_failures",
          decision: "ALLOW",
          provenanceDecision: "NOT_EVALUATED",
          outcome: "SUCCEEDED",
          downstreamInvoked: true,
          ruleId: null,
          causedByReceiptIds: [],
        })]}
        expanded={true}
        onToggle={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(markup).toContain("Rule: NO_PAYMENT_REIDENTIFICATION");
    expect(markup).toContain("Policy rule");
    expect(markup).toContain("payments.list_failures");
    expect(markup).toContain("CRM 1 → 1 · not invoked");
    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain("Hide");
  });

  it("does not invent a rule label for an allowed receipt", () => {
    const markup = renderToStaticMarkup(
      <ReceiptCard
        receipt={receipt({
          id: "receipt-allowed-12345678",
          decision: "ALLOW",
          provenanceDecision: "ALLOW",
          outcome: "SUCCEEDED",
          downstreamInvoked: true,
          ruleId: null,
          reason: "Immutable grant and provenance policy allowed the protected operation",
          causedByReceiptIds: [],
          counterBefore: 0,
          counterAfter: 1,
        })}
        receipts={[]}
        expanded={false}
        onToggle={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(markup).not.toContain("Rule:");
    expect(markup).not.toContain("Policy rule");
    expect(markup).toContain("CRM 0 → 1 · invoked");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("Details");
  });

  it("shows a deliberate unavailable state for missing causal evidence", () => {
    const markup = renderToStaticMarkup(
      <ReceiptCard
        receipt={receipt()}
        receipts={[]}
        expanded={true}
        onToggle={vi.fn()}
        onNavigate={vi.fn()}
      />,
    );

    expect(markup).toContain("Unavailable receipt");
  });
});
