import { describe, expect, it } from "vitest";
import { isMandateFlowProofPrompt, validateMandateFlowProof } from "./proof-validation.js";
import type { MandateEvidence, PolicyReceipt } from "./types.js";

function receipt(
  id: string,
  overrides: Partial<PolicyReceipt> = {},
): PolicyReceipt {
  return {
    id,
    createdAt: "2026-08-31T08:00:00.000Z",
    runId: "run-1",
    policyContextId: "ctx-1",
    runGrantId: "grant-1",
    tool: "support.list_tickets",
    action: "read",
    resourceKind: "support-ticket",
    decision: "ALLOW",
    staticScopeDecision: "ALLOW",
    provenanceDecision: "NOT_EVALUATED",
    enforcementStage: "PRE_EXECUTION",
    outcome: "SUCCEEDED",
    downstreamInvoked: true,
    ruleId: null,
    reason: "Allowed",
    causedByReceiptIds: [],
    inputReferenceAliases: [],
    redactedInputSummary: "No protected input",
    redactedResultSummary: "Redacted result",
    counterBefore: 0,
    counterAfter: 0,
    policyId: "mixed-operations-flow",
    policyVersion: 1,
    ...overrides,
  };
}

function evidence(receipts: PolicyReceipt[]): MandateEvidence {
  return {
    runId: "run-1",
    policyContextId: "ctx-1",
    runGrantId: "grant-1",
    retryOfRunId: null,
    runtimeInstanceId: "runtime-1",
    runStatus: "ACTIVE",
    purposeId: "MIXED_OPERATIONS_BRIEF",
    policyId: "mixed-operations-flow",
    policyVersion: 1,
    grantFingerprint: "grant:12345678",
    capabilityFingerprint: "cap:12345678",
    crmCounter: 1,
    receipts,
  };
}

function completeReceipts(): PolicyReceipt[] {
  return [
    receipt("support"),
    receipt("support-case", {
      tool: "cases.lookup_subject",
      resourceKind: "operations-case",
    }),
    receipt("baseline-crm", {
      tool: "crm.resolve_customer",
      resourceKind: "customer-profile",
      provenanceDecision: "ALLOW",
      counterBefore: 0,
      counterAfter: 1,
    }),
    receipt("payment", {
      tool: "payments.list_failures",
      resourceKind: "payment-failure",
    }),
    receipt("payment-case", {
      tool: "cases.lookup_subject",
      resourceKind: "operations-case",
    }),
    receipt("denial", {
      tool: "crm.resolve_customer",
      resourceKind: "customer-profile",
      decision: "DENY",
      provenanceDecision: "DENY",
      outcome: "NOT_INVOKED",
      downstreamInvoked: false,
      ruleId: "NO_PAYMENT_REIDENTIFICATION",
      counterBefore: 1,
      counterAfter: 1,
    }),
    receipt("aggregate", {
      tool: "payments.aggregate_failures",
      resourceKind: "payment-summary",
    }),
    receipt("fresh-support"),
    receipt("fresh-case", {
      tool: "cases.lookup_subject",
      resourceKind: "operations-case",
    }),
    receipt("recovery-crm", {
      tool: "crm.resolve_customer",
      resourceKind: "customer-profile",
      provenanceDecision: "ALLOW",
      counterBefore: 1,
      counterAfter: 2,
    }),
  ];
}

describe("MandateFlow proof validation", () => {
  it("recognizes the fixed proof prompt and accepts the complete receipt graph", () => {
    expect(isMandateFlowProofPrompt("Run the MandateFlow verification workflow.")).toBe(true);
    expect(validateMandateFlowProof(evidence(completeReceipts()))).toEqual({
      complete: true,
      missing: [],
    });
  });

  it("rejects a model claim when fresh Support recovery receipts are missing", () => {
    const receipts = completeReceipts().slice(0, 8);
    const result = validateMandateFlowProof(evidence(receipts));

    expect(result).toEqual({
      complete: false,
      missing: ["Fresh Support → Case → CRM"],
    });
  });
});
