import { describe, expect, it } from "vitest";
import { deriveProofSnapshot } from "./proof";
import type { AgentRun, MandateEvidence, PolicyReceipt } from "./types";

function receipt(overrides: Partial<PolicyReceipt> = {}): PolicyReceipt {
  return {
    id: "receipt-1",
    createdAt: "2026-08-30T12:00:00.000Z",
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

function evidence(receipts: PolicyReceipt[], overrides: Partial<MandateEvidence> = {}): MandateEvidence {
  return {
    runId: "run-1",
    policyContextId: "ctx-1",
    runGrantId: "grant-1",
    retryOfRunId: null,
    runtimeInstanceId: "runtime-1",
    runStatus: "COMPLETED",
    purposeId: "MIXED_OPERATIONS_BRIEF",
    policyId: "mixed-operations-flow",
    policyVersion: 1,
    grantFingerprint: "grant:12345678",
    capabilityFingerprint: "cap:12345678",
    crmCounter: 2,
    receipts,
    ...overrides,
  };
}

function run(id: string): AgentRun {
  return {
    id,
    agentId: "agent-1",
    status: "completed",
    prompt: "proof",
    output: "done",
    error: null,
    usage: null,
    startedAt: "2026-08-30T12:00:00.000Z",
    completedAt: "2026-08-30T12:01:00.000Z",
    policyContextId: "ctx-1",
    runGrantId: "grant-2",
    mandateId: "mnd-1",
    ownerPrincipal: "user-a",
    agentPrincipal: "agent:agent-1",
    retryOfRunId: "run-1",
    mandateStatus: "closed",
    capabilityFingerprint: "cap:retry",
    grantFingerprint: "grant:retry",
    runtimeInstanceId: "runtime-retry",
    progress: [],
    createdAt: "2026-08-30T12:00:00.000Z",
  };
}

describe("deriveProofSnapshot", () => {
  it("verifies the allow, denial, fresh recovery, and non-execution claims from receipts", () => {
    const denial = receipt({
      id: "receipt-denial",
      tool: "crm.resolve_customer",
      resourceKind: "customer-profile",
      decision: "DENY",
      provenanceDecision: "DENY",
      outcome: "NOT_INVOKED",
      downstreamInvoked: false,
      ruleId: "NO_PAYMENT_REIDENTIFICATION",
      counterBefore: 1,
      counterAfter: 1,
    });
    const snapshot = deriveProofSnapshot(
      evidence([
        receipt({ id: "support" }),
        receipt({
          id: "support-case",
          tool: "cases.lookup_subject",
          resourceKind: "operations-case",
        }),
        receipt({
          id: "baseline-crm",
          tool: "crm.resolve_customer",
          resourceKind: "customer-profile",
          provenanceDecision: "ALLOW",
          outcome: "SUCCEEDED",
          counterBefore: 0,
          counterAfter: 1,
        }),
        receipt({ id: "payment", tool: "payments.list_failures", resourceKind: "payment-failure" }),
        receipt({
          id: "payment-case",
          tool: "cases.lookup_subject",
          resourceKind: "operations-case",
        }),
        denial,
        receipt({
          id: "aggregate",
          tool: "payments.aggregate_failures",
          resourceKind: "payment-aggregate",
        }),
        receipt({ id: "fresh-support" }),
        receipt({
          id: "fresh-case",
          tool: "cases.lookup_subject",
          resourceKind: "operations-case",
        }),
        receipt({
          id: "recovery-crm",
          tool: "crm.resolve_customer",
          resourceKind: "customer-profile",
          provenanceDecision: "ALLOW",
          outcome: "SUCCEEDED",
          counterBefore: 1,
          counterAfter: 2,
        }),
      ]),
      null,
    );

    expect(snapshot.rows.map((row) => row.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "pending",
    ]);
    expect(snapshot.denial?.ruleId).toBe("NO_PAYMENT_REIDENTIFICATION");
    expect(snapshot.recovery?.id).toBe("recovery-crm");
    expect(snapshot.nonExecution).toBe("CRM counter unchanged · 1 → 1");
  });

  it("marks retry persistence complete only for a new run's denied CRM decision", () => {
    const snapshot = deriveProofSnapshot(
      evidence(
        [
          receipt({
            id: "original-denial",
            tool: "crm.resolve_customer",
            resourceKind: "customer-profile",
            decision: "DENY",
            provenanceDecision: "DENY",
            outcome: "NOT_INVOKED",
            downstreamInvoked: false,
            ruleId: "NO_PAYMENT_REIDENTIFICATION",
            counterBefore: 0,
            counterAfter: 0,
          }),
          receipt({
            id: "retry-denial",
            runId: "run-2",
            runGrantId: "grant-2",
            tool: "crm.resolve_customer",
            resourceKind: "customer-profile",
            decision: "DENY",
            provenanceDecision: "DENY",
            outcome: "NOT_INVOKED",
            downstreamInvoked: false,
            ruleId: "NO_PAYMENT_REIDENTIFICATION",
            counterBefore: 0,
            counterAfter: 0,
          }),
        ],
        { retryOfRunId: "run-1" },
      ),
      run("run-2"),
    );

    expect(snapshot.rows[3]).toMatchObject({
      state: "complete",
      receiptId: "retry-denial",
    });
  });

  it("keeps an empty proof truthful and does not invent a policy rule", () => {
    const snapshot = deriveProofSnapshot(null, null);

    expect(snapshot.rows.every((row) => row.state === "pending")).toBe(true);
    expect(snapshot.ruleId).toBeNull();
    expect(snapshot.nonExecution).toBeNull();
  });
});
