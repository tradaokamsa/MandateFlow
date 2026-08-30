export type AgentStatus = "ready" | "busy" | "stopped" | "error";
export type RunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MessageRole = "user" | "assistant";
export type MandateStatus =
  | "pending"
  | "active"
  | "finalizing"
  | "closed"
  | "revoked"
  | "security-finalization-pending";

export type DemoOwnerPrincipal = "user-a" | "user-b";

export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  status: AgentStatus;
  ownerPrincipal: DemoOwnerPrincipal;
  agentPrincipal: string;
  codexHomeVersion: number;
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
  role: MessageRole;
  content: string;
  createdAt: string;
}

export interface RunUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export interface AgentRun {
  id: string;
  agentId: string;
  status: RunStatus;
  prompt: string;
  output: string | null;
  error: string | null;
  usage: RunUsage | null;
  startedAt: string | null;
  completedAt: string | null;
  policyContextId: string | null;
  runGrantId: string | null;
  mandateId: string | null;
  ownerPrincipal: DemoOwnerPrincipal | null;
  agentPrincipal: string | null;
  retryOfRunId: string | null;
  mandateStatus: MandateStatus;
  capabilityFingerprint: string | null;
  grantFingerprint: string | null;
  runtimeInstanceId: string | null;
  createdAt: string;
}

export interface Database {
  version: 3;
  agents: Agent[];
  messages: Message[];
  runs: AgentRun[];
}

export interface CreateAgentInput {
  name: string;
  ownerPrincipal?: DemoOwnerPrincipal | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface UpdateAgentInput {
  name?: string | undefined;
  description?: string | undefined;
  instructions?: string | undefined;
}

export interface RunnerResult {
  output: string;
  threadId: string | null;
  usage: RunUsage | null;
  runtimeInstanceId: string;
}

export interface RunnerRequest {
  runId: string;
  agentId: string;
  workspacePath: string;
  prompt: string;
  threadId: string | null;
  mandateFlowCapability: string;
  codexHomePath?: string;
}

export interface AgentRunner {
  run(request: RunnerRequest): Promise<RunnerResult>;
  cancel(runId: string): Promise<boolean>;
  isAvailable(): Promise<boolean>;
}

export interface MandatePermission {
  tool: string;
  action: string;
  resourceKind: string;
}

export interface MandatePrepareRequest {
  agentId: string;
  ownerPrincipal: DemoOwnerPrincipal;
  runtimeInstanceId: string;
  mode: "NEW" | "FOLLOW_UP" | "RETRY";
  policyContextId: string | null;
  predecessorRunId: string | null;
  retryOfRunId: string | null;
  mandateTemplateId: "morning-ops-v1";
  requestedPermissions: MandatePermission[];
  capabilitySha256: string;
}

export interface MandatePrepareResult {
  runGrantId: string;
  policyContextId: string;
  grantFingerprint: string;
  capabilityFingerprint: string;
  status: "PREPARED" | "ACTIVE";
  expiresAt: string;
  grantedPermissions: MandatePermission[];
  mandateId?: string;
  ownerPrincipal?: DemoOwnerPrincipal;
  agentPrincipal?: string;
  issuedAt?: string;
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
