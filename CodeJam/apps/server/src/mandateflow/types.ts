import type { Agent, AgentRun, Message } from "../types.js";

export type PurposeId = "MIXED_OPERATIONS_BRIEF";

export type ToolName =
  | "support.list_tickets"
  | "payments.list_failures"
  | "cases.lookup_subject"
  | "crm.resolve_customer"
  | "payments.aggregate_failures";

export type Action = "read" | "resolve" | "aggregate";

export type ResourceKind =
  | "support-ticket"
  | "payment-failure"
  | "customer-subject"
  | "operations-case"
  | "customer-resolution"
  | "payment-aggregate";

export type ProvenanceLabel =
  | "SUPPORT_FOLLOWUP_ALLOWED"
  | "PAYMENT_AGGREGATE_ONLY"
  | "CASE_DERIVED";

export interface PermissionTuple {
  tool: ToolName;
  action: Action;
  resourceKind: ResourceKind;
}

export interface FrozenMandate {
  id: string;
  version: 1;
  subjectPrincipalId: string;
  purposeId: PurposeId;
  purposeSummary: string;
  permissions: PermissionTuple[];
  policyId: "mixed-operations-flow";
  policyVersion: 1;
  policySha256: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

export interface PolicyContext {
  id: string;
  agentId: string;
  initiatingActorId: "local-demo-operator";
  codexThreadIdSha256: string | null;
  mandate: FrozenMandate;
  createdAt: string;
  expiresAt: string;
  closedAt: string | null;
}

export type GrantStatus =
  | "queued"
  | "active"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired"
  | "restart_interrupted";

export type CapabilityInvalidReason = Exclude<
  GrantStatus,
  "queued" | "active"
>;

export interface RunGrant {
  id: string;
  runId: string;
  agentId: string;
  policyContextId: string;
  mandateId: string;
  retryOfRunId: string | null;
  permissions: PermissionTuple[];
  policyId: "mixed-operations-flow";
  policyVersion: 1;
  policySha256: string;
  status: GrantStatus;
  issuedAt: string;
  activatedAt: string | null;
  expiresAt: string;
  terminalAt: string | null;
  capabilitySha256: string;
  capabilityFingerprint: string;
  capabilityAudience: "launchpad-mcp-gateway";
  capabilityInvalidatedAt: string | null;
  capabilityInvalidReason: CapabilityInvalidReason | null;
}

export interface ProtectedReference {
  referenceSha256: string;
  displayAlias: string;
  policyContextId: string;
  kind: "customer-subject" | "operations-case";
  privateTargetId: string;
  effectiveLabels: ProvenanceLabel[];
  parentReferenceSha256: string | null;
  producedByReceiptId: string;
  issuedAt: string;
  expiresAt: string;
  status: "active" | "expired" | "revoked";
}

export interface PolicyReceipt {
  id: string;
  sequence: number;
  createdAt: string;
  policyContextId: string;
  runId: string;
  runGrantId: string;
  initiatingActorId: string;
  agentPrincipalId: string;
  mandateId: string;
  tool: ToolName;
  action: Action;
  resourceKind: ResourceKind;
  decision: "ALLOW" | "DENY";
  staticScopeDecision: "ALLOW" | "DENY";
  provenanceDecision: "ALLOW" | "DENY" | "NOT_EVALUATED";
  enforcementStage: "PRE_EXECUTION";
  outcome: "SUCCEEDED" | "NOT_INVOKED";
  policyId: "mixed-operations-flow";
  policyVersion: 1;
  downstreamInvoked: boolean;
  ruleId: "NO_PAYMENT_REIDENTIFICATION" | null;
  reason: string;
  causedByReceiptIds: string[];
  inputReferenceAliases: string[];
  producedReferenceAliases: string[];
  counterBefore: number | null;
  counterAfter: number | null;
  redactedInputSummary: string;
  redactedResultSummary: string | null;
}

export interface FixtureCounter {
  policyContextId: string;
  tool: "crm.resolve_customer";
  count: number;
}

export interface DatabaseV2 {
  version: 2;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
  policyContexts: PolicyContext[];
  runGrants: RunGrant[];
  protectedReferences: ProtectedReference[];
  policyReceipts: PolicyReceipt[];
  fixtureCounters: FixtureCounter[];
}

export interface SafeReceiptEvidence extends Omit<
  PolicyReceipt,
  "initiatingActorId" | "agentPrincipalId" | "mandateId"
> {
  safeAlternative: ToolName | null;
}

export interface SafeRunEvidence {
  runId: string;
  retryOfRunId: string | null;
  purposeId: PurposeId;
  purposeSummary: string;
  permissions: PermissionTuple[];
  contextFingerprint: string;
  grantFingerprint: string;
  runtimeFingerprint: string | null;
  capabilityFingerprint: string;
  policyFingerprint: string;
  receipts: SafeReceiptEvidence[];
}

export interface ToolSuccess {
  isError: false;
  receiptId: string;
  data: Record<string, unknown>;
}

export interface ToolDenial {
  isError: true;
  code: "SCOPE_DENIED" | "INVALID_REFERENCE" | "FLOW_DENIED";
  receiptId: string;
  message: string;
  safeAlternative: ToolName | null;
}

export type ToolResult = ToolSuccess | ToolDenial;
