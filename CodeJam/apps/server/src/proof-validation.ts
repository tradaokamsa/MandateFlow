import type { MandateEvidence, PolicyReceipt } from "./types.js";

const PROOF_PROMPT_MARKER = "mandateflow verification workflow";

export interface MandateFlowProofValidation {
  complete: boolean;
  missing: string[];
}

function receiptAfter(
  receipts: PolicyReceipt[],
  startIndex: number,
  predicate: (receipt: PolicyReceipt) => boolean,
): number {
  return receipts.findIndex(
    (receipt, index) => index > startIndex && predicate(receipt),
  );
}

function allowedReceipt(tool: string, receipt: PolicyReceipt): boolean {
  return (
    receipt.tool === tool &&
    receipt.decision === "ALLOW" &&
    receipt.outcome === "SUCCEEDED" &&
    receipt.downstreamInvoked
  );
}

function deniedCrmReceipt(receipt: PolicyReceipt): boolean {
  return (
    receipt.tool === "crm.resolve_customer" &&
    receipt.decision === "DENY" &&
    receipt.provenanceDecision === "DENY" &&
    receipt.outcome === "NOT_INVOKED" &&
    !receipt.downstreamInvoked
  );
}

export function isMandateFlowProofPrompt(prompt: string): boolean {
  return prompt.toLowerCase().includes(PROOF_PROMPT_MARKER);
}

/**
 * A model response is not proof. The gateway receipts must contain the
 * complete, ordered choreography before the control plane can close a proof
 * Run as successful.
 */
export function validateMandateFlowProof(
  evidence: MandateEvidence,
): MandateFlowProofValidation {
  const receipts = evidence.receipts;
  const missing: string[] = [];

  const supportIndex = receipts.findIndex((receipt) =>
    allowedReceipt("support.list_tickets", receipt),
  );
  const supportCaseIndex = receiptAfter(
    receipts,
    supportIndex,
    (receipt) => allowedReceipt("cases.lookup_subject", receipt),
  );
  const baselineCrmIndex = receiptAfter(
    receipts,
    supportCaseIndex,
    (receipt) =>
      allowedReceipt("crm.resolve_customer", receipt) &&
      receipt.counterBefore === 0 &&
      receipt.counterAfter === 1,
  );
  if (supportIndex < 0 || supportCaseIndex < 0 || baselineCrmIndex < 0) {
    missing.push("Support → Case → CRM");
  }

  const paymentIndex = receipts.findIndex((receipt) =>
    allowedReceipt("payments.list_failures", receipt),
  );
  const paymentCaseIndex = receiptAfter(
    receipts,
    paymentIndex,
    (receipt) => allowedReceipt("cases.lookup_subject", receipt),
  );
  const denialIndex = receiptAfter(receipts, paymentCaseIndex, deniedCrmReceipt);
  if (paymentIndex < 0 || paymentCaseIndex < 0 || denialIndex < 0) {
    missing.push("Payment → Case → CRM denial");
  }

  const aggregateIndex = receiptAfter(
    receipts,
    denialIndex,
    (receipt) => allowedReceipt("payments.aggregate_failures", receipt),
  );
  if (aggregateIndex < 0) {
    missing.push("Payment aggregate recovery");
  }

  const freshSupportIndex = receiptAfter(
    receipts,
    denialIndex,
    (receipt) => allowedReceipt("support.list_tickets", receipt),
  );
  const freshCaseIndex = receiptAfter(
    receipts,
    freshSupportIndex,
    (receipt) => allowedReceipt("cases.lookup_subject", receipt),
  );
  const denialCounter = denialIndex >= 0 ? receipts[denialIndex]?.counterAfter ?? -1 : -1;
  const recoveryCrmIndex = receiptAfter(
    receipts,
    freshCaseIndex,
    (receipt) =>
      allowedReceipt("crm.resolve_customer", receipt) &&
      receipt.counterBefore >= denialCounter &&
      receipt.counterAfter > receipt.counterBefore,
  );
  if (freshSupportIndex < 0 || freshCaseIndex < 0 || recoveryCrmIndex < 0) {
    missing.push("Fresh Support → Case → CRM");
  }

  return { complete: missing.length === 0, missing };
}
