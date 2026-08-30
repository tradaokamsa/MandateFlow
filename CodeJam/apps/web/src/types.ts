export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  workspacePath: string;
  codexThreadId: string | null;
  activePolicyContextId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  agentId: string;
  runId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: {
    inputTokens?: number;
    cachedInputTokens?: number;
    outputTokens?: number;
  } | null;
  startedAt: string | null;
  completedAt: string | null;
  policyContextId: string | null;
  runGrantId: string | null;
  retryOfRunId: string | null;
  capabilityFingerprint: string | null;
  runtimeFingerprint: string | null;
  createdAt: string;
}

export type MandateFlowToolName =
  | "support.list_tickets"
  | "payments.list_failures"
  | "cases.lookup_subject"
  | "crm.resolve_customer"
  | "payments.aggregate_failures";

export interface MandateFlowPermission {
  tool: MandateFlowToolName;
  action: "read" | "resolve" | "aggregate";
  resourceKind:
    | "support-ticket"
    | "payment-failure"
    | "customer-subject"
    | "operations-case"
    | "customer-resolution"
    | "payment-aggregate";
}

export interface MandateFlowReceipt {
  id: string;
  sequence: number;
  createdAt: string;
  policyContextId: string;
  runId: string;
  runGrantId: string;
  tool: MandateFlowToolName;
  action: MandateFlowPermission["action"];
  resourceKind: MandateFlowPermission["resourceKind"];
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
  safeAlternative: MandateFlowToolName | null;
}

export interface MandateFlowEvidence {
  runId: string;
  retryOfRunId: string | null;
  purposeId: "MIXED_OPERATIONS_BRIEF";
  purposeSummary: string;
  permissions: MandateFlowPermission[];
  contextFingerprint: string;
  grantFingerprint: string;
  runtimeFingerprint: string | null;
  capabilityFingerprint: string;
  policyFingerprint: string;
  receipts: MandateFlowReceipt[];
}

export interface SystemInfo {
  arkConfigured: boolean;
  arkBaseUrl: string;
  arkModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container";
  containerEngine: string | null;
  runtime: string;
  mandateFlowEnabled: boolean;
  mandateFlowReady: boolean;
  mandateFlowMcpUrl: string | null;
}
