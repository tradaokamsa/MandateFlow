export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type DemoOwnerPrincipal = "user-a" | "user-b";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  ownerPrincipal: DemoOwnerPrincipal;
  agentPrincipal: string;
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
  mandateId: string | null;
  ownerPrincipal: DemoOwnerPrincipal | null;
  agentPrincipal: string | null;
  retryOfRunId: string | null;
  mandateStatus:
    | "pending"
    | "active"
    | "finalizing"
    | "revoked"
    | "closed"
    | "security-finalization-pending";
  capabilityFingerprint: string | null;
  grantFingerprint: string | null;
  runtimeInstanceId: string | null;
  createdAt: string;
}

export interface PolicyReceipt {
  id: string;
  createdAt: string;
  runId: string;
  policyContextId: string;
  runGrantId: string;
  tool: string;
  action: string;
  resourceKind: string;
  decision: "ALLOW" | "DENY";
  staticScopeDecision: "ALLOW" | "DENY";
  provenanceDecision: "ALLOW" | "DENY" | "NOT_EVALUATED";
  enforcementStage: "PRE_EXECUTION";
  outcome: "SUCCEEDED" | "FAILED" | "NOT_INVOKED";
  downstreamInvoked: boolean;
  ruleId: string | null;
  reason: string;
  causedByReceiptIds: string[];
  inputReferenceAliases: string[];
  redactedInputSummary: string;
  redactedResultSummary: string;
  counterBefore: number;
  counterAfter: number;
  policyId: string;
  policyVersion: number;
}

export interface MandateEvidence {
  runId: string;
  policyContextId: string;
  runGrantId: string;
  retryOfRunId: string | null;
  runtimeInstanceId: string;
  runStatus: string;
  purposeId: string;
  policyId: string;
  policyVersion: number;
  grantFingerprint: string;
  capabilityFingerprint: string;
  crmCounter: number;
  receipts: PolicyReceipt[];
  mandateId?: string;
  mandateStatus?: string;
  ownerPrincipal?: DemoOwnerPrincipal;
  agentPrincipal?: string;
  issuedAt?: string;
  expiresAt?: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
}

export interface MandatePermission {
  tool: string;
  action: string;
  resourceKind: string;
}

export interface MandateSummary {
  mandateId: string;
  status: "ACTIVE" | "REVOKED" | "CLOSED";
  ownerPrincipal: DemoOwnerPrincipal;
  agentPrincipal: string;
  policyContextId: string;
  purposeId: string;
  policyId: string;
  policyVersion: number;
  grantedPermissions: MandatePermission[];
  issuedAt: string;
  expiresAt: string;
  mandateFingerprint: string;
  revokedAt?: string;
  revokedBy?: string;
  revocationReason?: string;
}

export interface SystemInfo {
  groqConfigured: boolean;
  groqBaseUrl: string;
  groqModel: string | null;
  codexAvailable: boolean;
  codexSandboxMode: string;
  runtimeProvider: "local-process" | "container" | "fixture";
  containerEngine: string | null;
  runtime: string;
  mandateFlowEnabled: boolean;
  mandateFlowReady: boolean;
  mandateFlowPolicy: string | null;
}
