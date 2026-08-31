import type { AgentRun, MandateEvidence, PolicyReceipt } from "./types";

export type ProofRowState = "pending" | "complete";

export interface ProofRow {
  id: "baseline" | "denial" | "recovery" | "persistence";
  label: string;
  state: ProofRowState;
  detail: string;
  receiptId?: string;
}

export interface ProofSnapshot {
  rows: ProofRow[];
  denial: PolicyReceipt | null;
  recovery: PolicyReceipt | null;
  nonExecution: string | null;
  ruleId: string | null;
}

const crmTool = "crm.resolve_customer";

export function deriveProofSnapshot(
  evidence: MandateEvidence | null,
  activeRun: AgentRun | null,
): ProofSnapshot {
  const receipts = evidence?.receipts ?? [];
  const baseline = receipts.find(
    (receipt) =>
      receipt.tool === crmTool &&
      receipt.decision === "ALLOW" &&
      receipt.counterBefore === 0 &&
      receipt.counterAfter === 1,
  );
  const denialIndex = receipts.findIndex(
    (receipt) =>
      receipt.tool === crmTool &&
      receipt.decision === "DENY" &&
      receipt.provenanceDecision === "DENY" &&
      !receipt.downstreamInvoked,
  );
  const denial = denialIndex >= 0 ? receipts[denialIndex] : null;
  const receiptsAfterDenial = denial ? receipts.slice(denialIndex + 1) : [];
  const freshSupportIndex = receiptsAfterDenial.findIndex(
    (receipt) => receipt.tool === "support.list_tickets" && receipt.decision === "ALLOW",
  );
  const freshCaseIndex = freshSupportIndex >= 0
    ? receiptsAfterDenial.findIndex(
        (receipt, index) =>
          index > freshSupportIndex &&
          receipt.tool === "cases.lookup_subject" &&
          receipt.decision === "ALLOW",
      )
    : -1;
  const recovery = freshCaseIndex >= 0
    ? receiptsAfterDenial.slice(freshCaseIndex + 1).find(
        (receipt) =>
          receipt.tool === crmTool &&
          receipt.decision === "ALLOW" &&
          receipt.outcome === "SUCCEEDED" &&
          receipt.counterBefore >= (denial?.counterAfter ?? 0),
      ) ?? null
    : null;
  const retryDenial = activeRun
    ? receipts.find(
        (receipt) =>
          receipt.runId === activeRun.id &&
          receipt.tool === crmTool &&
          receipt.decision === "DENY" &&
          receipt.provenanceDecision === "DENY" &&
          !receipt.downstreamInvoked,
      )
    : undefined;
  const persistenceComplete = Boolean(evidence?.retryOfRunId && retryDenial);

  return {
    rows: [
      {
        id: "baseline",
        label: "Support → Case → CRM",
        state: baseline ? "complete" : "pending",
        detail: baseline ? "Allowed · CRM completed" : "Waiting for the live Support route",
        receiptId: baseline?.id,
      },
      {
        id: "denial",
        label: "Payment → Case → CRM",
        state: denial ? "complete" : "pending",
        detail: denial
          ? "Blocked before CRM · fixture not invoked"
          : "Waiting for the tainted Payment route",
        receiptId: denial?.id,
      },
      {
        id: "recovery",
        label: "Fresh Support → Case → CRM",
        state: recovery ? "complete" : "pending",
        detail: recovery
          ? "Recovered · fresh Support lineage allowed"
          : "Waiting for safe recovery after the block",
        receiptId: recovery?.id,
      },
      {
        id: "persistence",
        label: "Persistent after retry",
        state: persistenceComplete ? "complete" : "pending",
        detail: persistenceComplete
          ? "Still blocked with a fresh Run capability"
          : denial
            ? "Run Retry denied call to verify context continuity"
            : "Available after the first denied call",
        receiptId: retryDenial?.id,
      },
    ],
    denial,
    recovery,
    nonExecution:
      denial && denial.counterBefore === denial.counterAfter
        ? `CRM counter unchanged · ${denial.counterBefore} → ${denial.counterAfter}`
        : null,
    ruleId: denial?.ruleId ?? null,
  };
}
