import type { ProvenanceLabel } from "./types.js";

export interface SourceFixtureResult {
  count: number;
  privateTargetId: string;
  labels: ProvenanceLabel[];
}

export interface CaseFixtureResult {
  caseStatus: "open";
  privateTargetId: string;
}

export interface CrmFixtureResult {
  displayName: string;
  email: string;
  contactStatus: "follow-up-allowed";
}

export interface AggregateFixtureResult {
  failedPayments: number;
  totalAmountCents: number;
  currency: "USD";
}

export function listSupportTickets(): SourceFixtureResult {
  return {
    count: 1,
    privateTargetId: "synthetic-customer-support-001",
    labels: ["SUPPORT_FOLLOWUP_ALLOWED"],
  };
}

export function listPaymentFailures(): SourceFixtureResult {
  return {
    count: 3,
    privateTargetId: "synthetic-customer-payment-001",
    labels: ["PAYMENT_AGGREGATE_ONLY"],
  };
}

export function lookupSubject(privateTargetId: string): CaseFixtureResult {
  return { caseStatus: "open", privateTargetId };
}

export function resolveCustomer(privateTargetId: string): CrmFixtureResult {
  if (privateTargetId === "synthetic-customer-support-001") {
    return {
      displayName: "Taylor Example",
      email: "taylor.support@example.test",
      contactStatus: "follow-up-allowed",
    };
  }
  return {
    displayName: "Morgan Example",
    email: "morgan.payment@example.test",
    contactStatus: "follow-up-allowed",
  };
}

export function aggregatePaymentFailures(): AggregateFixtureResult {
  return {
    failedPayments: 3,
    totalAmountCents: 124_500,
    currency: "USD",
  };
}
