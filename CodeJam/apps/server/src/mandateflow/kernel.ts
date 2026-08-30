import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentRun } from "../types.js";
import { CAPABILITY_AUDIENCE } from "../config.js";
import {
  fingerprint,
  generateReferenceToken,
  isCapabilityToken,
  referenceAlias,
  sha256,
} from "./crypto.js";
import {
  aggregatePaymentFailures,
  listPaymentFailures,
  listSupportTickets,
  lookupSubject,
  resolveCustomer,
} from "./fixtures.js";
import {
  MIXED_OPERATIONS_POLICY,
  MIXED_OPERATIONS_POLICY_SHA256,
  evaluateProvenance,
  isPackagedPolicyAvailable,
} from "./policy.js";
import type {
  DatabaseV2,
  PermissionTuple,
  PolicyContext,
  PolicyReceipt,
  ProtectedReference,
  ProvenanceLabel,
  RunGrant,
  SafeReceiptEvidence,
  SafeRunEvidence,
  ToolDenial,
  ToolName,
  ToolResult,
} from "./types.js";

const PURPOSE_SUMMARY =
  "Prepare a mixed operations brief: Support follow-up may identify customers; Payment failures remain aggregate-only.";
const DEFAULT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;

const platformPermissionCeiling: PermissionTuple[] = [
  {
    tool: "support.list_tickets",
    action: "read",
    resourceKind: "support-ticket",
  },
  {
    tool: "payments.list_failures",
    action: "read",
    resourceKind: "payment-failure",
  },
  {
    tool: "cases.lookup_subject",
    action: "read",
    resourceKind: "operations-case",
  },
  {
    tool: "crm.resolve_customer",
    action: "resolve",
    resourceKind: "customer-resolution",
  },
  {
    tool: "payments.aggregate_failures",
    action: "aggregate",
    resourceKind: "payment-aggregate",
  },
];
for (const permission of platformPermissionCeiling) Object.freeze(permission);
export const PLATFORM_PERMISSION_CEILING: readonly PermissionTuple[] =
  Object.freeze(platformPermissionCeiling);

const emptyInputSchema = z.object({}).strict();
const referenceInputSchema = z
  .object({ reference: z.string().regex(/^ref1_[A-Za-z0-9_-]{43}$/) })
  .strict();

interface ToolRegistration {
  permission: PermissionTuple;
  inputSchema: z.ZodType;
  referenceKind: ProtectedReference["kind"] | null;
}

export const TOOL_REGISTRY: Record<ToolName, ToolRegistration> = {
  "support.list_tickets": {
    permission: PLATFORM_PERMISSION_CEILING[0]!,
    inputSchema: emptyInputSchema,
    referenceKind: null,
  },
  "payments.list_failures": {
    permission: PLATFORM_PERMISSION_CEILING[1]!,
    inputSchema: emptyInputSchema,
    referenceKind: null,
  },
  "cases.lookup_subject": {
    permission: PLATFORM_PERMISSION_CEILING[2]!,
    inputSchema: referenceInputSchema,
    referenceKind: "customer-subject",
  },
  "crm.resolve_customer": {
    permission: PLATFORM_PERMISSION_CEILING[3]!,
    inputSchema: referenceInputSchema,
    referenceKind: "operations-case",
  },
  "payments.aggregate_failures": {
    permission: PLATFORM_PERMISSION_CEILING[4]!,
    inputSchema: emptyInputSchema,
    referenceKind: null,
  },
};

export interface AuthenticatedPrincipal {
  runId: string;
  runGrantId: string;
  agentId: string;
  policyContextId: string;
  mandateId: string;
  permissions: PermissionTuple[];
}

export interface IssueRunInput {
  agentId: string;
  runId: string;
  capability: string;
  requestedPermissions: readonly PermissionTuple[];
  retryOfRunId: string | null;
  policyContextId: string | null;
  now: string;
}

export interface IssuedAuthority {
  policyContextId: string;
  mandateId: string;
  runGrantId: string;
  capabilityFingerprint: string;
  expiresAt: string;
}

export interface AuthenticatedToolCall {
  principal: AuthenticatedPrincipal;
  tool: ToolName;
  argumentsValue: unknown;
  now: string;
}

interface KernelOptions {
  capabilityTtlMs: number;
  contextTtlMs?: number;
}

function addMilliseconds(timestamp: string, milliseconds: number): string {
  return new Date(new Date(timestamp).getTime() + milliseconds).toISOString();
}

function timestampMilliseconds(timestamp: string): number {
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) throw new Error("Invalid authority timestamp");
  return value;
}

function earliestTimestamp(...timestamps: string[]): string {
  return timestamps.reduce((earliest, timestamp) =>
    timestampMilliseconds(timestamp) < timestampMilliseconds(earliest)
      ? timestamp
      : earliest,
  );
}

function hasReached(now: string, deadline: string): boolean {
  return timestampMilliseconds(now) >= timestampMilliseconds(deadline);
}

function tupleKey(tuple: PermissionTuple): string {
  return `${tuple.tool}\0${tuple.action}\0${tuple.resourceKind}`;
}

function includesPermission(
  permissions: readonly PermissionTuple[],
  permission: PermissionTuple,
): boolean {
  const expected = tupleKey(permission);
  return permissions.some((candidate) => tupleKey(candidate) === expected);
}

function runStatusForTerminalReason(
  reason: Exclude<RunGrant["status"], "queued" | "active">,
): AgentRun["status"] {
  if (reason === "completed") return "completed";
  if (reason === "cancelled" || reason === "restart_interrupted") {
    return "cancelled";
  }
  return "failed";
}

export class MandateFlowKernel {
  private readonly contextTtlMs: number;

  constructor(private readonly options: KernelOptions) {
    if (options.capabilityTtlMs <= 0) {
      throw new Error("Capability TTL must be positive");
    }
    this.contextTtlMs = options.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
  }

  issueRun(database: DatabaseV2, input: IssueRunInput): IssuedAuthority {
    const agent = database.agents.find((candidate) => candidate.id === input.agentId);
    const run = database.runs.find((candidate) => candidate.id === input.runId);
    if (!agent || !run || run.agentId !== input.agentId) {
      throw new Error("Run authority requires an existing matching Agent and Run");
    }
    if (database.runGrants.some((grant) => grant.runId === input.runId)) {
      throw new Error("One Run can have only one grant");
    }
    if (agent.status !== "ready") {
      throw new Error("Run authority requires a ready Agent");
    }
    if (run.status !== "queued") {
      throw new Error("Run authority requires a queued Run");
    }
    if (run.retryOfRunId !== input.retryOfRunId) {
      throw new Error("Run Retry linkage does not match authority input");
    }
    if (
      database.runGrants.some(
        (grant) =>
          grant.agentId === input.agentId &&
          (grant.status === "queued" || grant.status === "active"),
      )
    ) {
      throw new Error("Agent already has nonterminal Run authority");
    }
    if (!isCapabilityToken(input.capability)) {
      throw new Error("Capability must be a generated MandateFlow token");
    }
    const capabilitySha256 = sha256(input.capability);
    if (
      database.runGrants.some(
        (grant) => grant.capabilitySha256 === capabilitySha256,
      )
    ) {
      throw new Error("Capability hash must be unique");
    }

    let retryGrant: RunGrant | null = null;
    if (input.retryOfRunId) {
      const predecessor = database.runs.find(
        (candidate) => candidate.id === input.retryOfRunId,
      );
      const predecessorGrant = predecessor?.runGrantId
        ? database.runGrants.find(
            (candidate) => candidate.id === predecessor.runGrantId,
          )
        : undefined;
      const predecessorContext = predecessor?.policyContextId
        ? database.policyContexts.find(
            (candidate) => candidate.id === predecessor.policyContextId,
          )
        : undefined;
      if (
        !predecessor ||
        !predecessorGrant ||
        !predecessorContext ||
        predecessor.status !== "completed" ||
        predecessorGrant.status !== "completed" ||
        predecessor.agentId !== input.agentId ||
        predecessorGrant.agentId !== input.agentId ||
        predecessorGrant.runId !== predecessor.id ||
        predecessorGrant.policyContextId !== predecessorContext.id ||
        predecessorContext.agentId !== input.agentId ||
        input.policyContextId !== predecessorContext.id ||
        !agent.codexThreadId ||
        predecessorContext.codexThreadIdSha256 !== sha256(agent.codexThreadId)
      ) {
        throw new Error(
          "Retry requires a completed predecessor in the same context and thread",
        );
      }
      if (
        database.runs.some(
          (candidate) =>
            candidate.id !== input.runId &&
            candidate.retryOfRunId === predecessor.id,
        )
      ) {
        throw new Error("Retry predecessor already has a successor");
      }
      const hasPersistedFlowDenial = database.policyReceipts.some(
        (receipt) =>
          receipt.runId === predecessor.id &&
          receipt.runGrantId === predecessorGrant.id &&
          receipt.policyContextId === predecessorContext.id &&
          receipt.tool === "crm.resolve_customer" &&
          receipt.decision === "DENY" &&
          receipt.staticScopeDecision === "ALLOW" &&
          receipt.provenanceDecision === "DENY" &&
          receipt.enforcementStage === "PRE_EXECUTION" &&
          receipt.outcome === "NOT_INVOKED" &&
          receipt.downstreamInvoked === false &&
          receipt.ruleId === "NO_PAYMENT_REIDENTIFICATION",
      );
      if (!hasPersistedFlowDenial) {
        throw new Error(
          "Retry requires a persisted Payment-flow CRM denial in the predecessor",
        );
      }
      retryGrant = predecessorGrant;
    }

    const context = this.selectOrCreateContext(database, agent.id, input);
    const ceiling = new Set(PLATFORM_PERMISSION_CEILING.map(tupleKey));
    const requested = new Set(input.requestedPermissions.map(tupleKey));
    const retryTools = new Set<ToolName>([
      "crm.resolve_customer",
      "payments.aggregate_failures",
    ]);
    const authoritySource = retryGrant
      ? retryGrant.permissions.filter((permission) =>
          retryTools.has(permission.tool),
        )
      : context.mandate.permissions;
    const permissions = authoritySource.filter(
      (permission) =>
        ceiling.has(tupleKey(permission)) &&
        (retryGrant !== null || requested.has(tupleKey(permission))),
    );
    const expiresAt = earliestTimestamp(
      addMilliseconds(input.now, this.options.capabilityTtlMs),
      context.expiresAt,
      context.mandate.expiresAt,
    );
    const grant: RunGrant = {
      id: randomUUID(),
      runId: run.id,
      agentId: agent.id,
      policyContextId: context.id,
      mandateId: context.mandate.id,
      retryOfRunId: input.retryOfRunId,
      permissions: permissions.map((permission) => ({ ...permission })),
      policyId: context.mandate.policyId,
      policyVersion: context.mandate.policyVersion,
      policySha256: context.mandate.policySha256,
      status: "queued",
      issuedAt: input.now,
      activatedAt: null,
      expiresAt,
      terminalAt: null,
      capabilitySha256,
      capabilityFingerprint: fingerprint("capability", input.capability),
      capabilityAudience: CAPABILITY_AUDIENCE,
      capabilityInvalidatedAt: null,
      capabilityInvalidReason: null,
    };
    database.runGrants.push(grant);
    run.policyContextId = context.id;
    run.runGrantId = grant.id;
    run.retryOfRunId = input.retryOfRunId;
    run.capabilityFingerprint = grant.capabilityFingerprint;
    agent.activePolicyContextId = context.id;
    agent.status = "busy";
    agent.lastError = null;
    agent.updatedAt = input.now;

    return {
      policyContextId: context.id,
      mandateId: context.mandate.id,
      runGrantId: grant.id,
      capabilityFingerprint: grant.capabilityFingerprint,
      expiresAt,
    };
  }

  activateRun(database: DatabaseV2, runId: string, now: string): void {
    const run = database.runs.find((candidate) => candidate.id === runId);
    const grant = run?.runGrantId
      ? database.runGrants.find((candidate) => candidate.id === run.runGrantId)
      : undefined;
    if (!run || !grant || run.status !== "queued" || grant.status !== "queued") {
      throw new Error("Invalid queued-to-active authority transition");
    }
    const context = database.policyContexts.find(
      (candidate) => candidate.id === grant.policyContextId,
    );
    if (!context) throw new Error("Policy context is not available");
    if (context.closedAt !== null) throw new Error("Policy context is closed");
    if (context.mandate.revokedAt !== null) throw new Error("Mandate is revoked");
    if (
      [grant.expiresAt, context.expiresAt, context.mandate.expiresAt].some(
        (expiresAt) => hasReached(now, expiresAt),
      )
    ) {
      throw new Error("Run authority is expired and cannot be activated");
    }
    if (
      !isPackagedPolicyAvailable(
        grant.policyId,
        grant.policyVersion,
        grant.policySha256,
      )
    ) {
      throw new Error("Pinned policy is not available");
    }
    grant.status = "active";
    grant.activatedAt = now;
    run.status = "running";
    run.startedAt = now;
  }

  terminalizeRun(
    database: DatabaseV2,
    runId: string,
    reason: Exclude<RunGrant["status"], "queued" | "active">,
    now: string,
  ): void {
    const run = database.runs.find((candidate) => candidate.id === runId);
    const grant = run?.runGrantId
      ? database.runGrants.find((candidate) => candidate.id === run.runGrantId)
      : undefined;
    if (!run || !grant) throw new Error("Run grant not found");
    if (grant.status !== "queued" && grant.status !== "active") {
      throw new Error("Terminal Run authority cannot transition again");
    }
    if (grant.status === "queued" && reason === "completed") {
      throw new Error("Queued authority cannot transition directly to completed");
    }
    grant.status = reason;
    grant.terminalAt = now;
    grant.capabilityInvalidatedAt = now;
    grant.capabilityInvalidReason = reason;
    run.status = runStatusForTerminalReason(reason);
    run.completedAt = now;
  }

  bindThread(
    database: DatabaseV2,
    contextId: string,
    threadId: string,
  ): void {
    const context = database.policyContexts.find(
      (candidate) => candidate.id === contextId,
    );
    if (!context) throw new Error("Policy context not found");
    const digest = sha256(threadId);
    if (context.codexThreadIdSha256 && context.codexThreadIdSha256 !== digest) {
      throw new Error("Codex thread does not match the policy context");
    }
    context.codexThreadIdSha256 = digest;
  }

  authenticateActiveGrant(
    database: DatabaseV2,
    capabilitySha256: string,
    now: string,
  ): AuthenticatedPrincipal | null {
    const grant = database.runGrants.find(
      (candidate) => candidate.capabilitySha256 === capabilitySha256,
    );
    if (!grant || grant.capabilityAudience !== CAPABILITY_AUDIENCE) return null;
    const context = database.policyContexts.find(
      (candidate) => candidate.id === grant.policyContextId,
    );
    const run = database.runs.find((candidate) => candidate.id === grant.runId);
    const agent = database.agents.find(
      (candidate) => candidate.id === grant.agentId,
    );
    if (
      !context ||
      !run ||
      !agent ||
      context.agentId !== grant.agentId ||
      context.mandate.id !== grant.mandateId ||
      context.mandate.subjectPrincipalId !== `agent:${grant.agentId}` ||
      context.mandate.policyId !== grant.policyId ||
      context.mandate.policyVersion !== grant.policyVersion ||
      context.mandate.policySha256 !== grant.policySha256 ||
      run.agentId !== grant.agentId ||
      run.policyContextId !== grant.policyContextId ||
      run.runGrantId !== grant.id ||
      run.retryOfRunId !== grant.retryOfRunId ||
      run.status !== "running" ||
      agent.activePolicyContextId !== grant.policyContextId ||
      agent.status !== "busy"
    ) {
      return null;
    }
    const expired = [grant.expiresAt, context.expiresAt, context.mandate.expiresAt].some(
      (expiresAt) => hasReached(now, expiresAt),
    );
    if (expired && (grant.status === "queued" || grant.status === "active")) {
      this.terminalizeRun(database, grant.runId, "expired", now);
      return null;
    }
    if (
      grant.status !== "active" ||
      grant.capabilityInvalidatedAt !== null ||
      context.closedAt !== null ||
      context.mandate.revokedAt !== null ||
      !isPackagedPolicyAvailable(
        grant.policyId,
        grant.policyVersion,
        grant.policySha256,
      )
    ) {
      return null;
    }
    return {
      runId: grant.runId,
      runGrantId: grant.id,
      agentId: grant.agentId,
      policyContextId: grant.policyContextId,
      mandateId: grant.mandateId,
      permissions: grant.permissions.map((permission) => ({ ...permission })),
    };
  }

  executeTool(database: DatabaseV2, input: AuthenticatedToolCall): ToolResult {
    const registration = TOOL_REGISTRY[input.tool];
    const grant = database.runGrants.find(
      (candidate) => candidate.id === input.principal.runGrantId,
    );
    if (
      !grant ||
      grant.status !== "active" ||
      grant.runId !== input.principal.runId ||
      grant.policyContextId !== input.principal.policyContextId
    ) {
      throw new Error("Tool execution requires active authority");
    }

    const parsed = registration.inputSchema.safeParse(input.argumentsValue);
    if (!includesPermission(grant.permissions, registration.permission)) {
      return this.appendDenial(database, input, registration, {
        code: "SCOPE_DENIED",
        reason: "The exact tool permission tuple is outside this Run grant.",
        reference: null,
        ruleId: null,
      });
    }
    if (!parsed.success) {
      return this.appendDenial(database, input, registration, {
        code: "INVALID_REFERENCE",
        reason: "The protected input is invalid.",
        reference: null,
        ruleId: null,
      });
    }

    let reference: ProtectedReference | null = null;
    if (registration.referenceKind) {
      const referenceValue = (parsed.data as { reference: string }).reference;
      reference = this.resolveReference(
        database,
        referenceValue,
        registration.referenceKind,
        input.principal.policyContextId,
        input.now,
      );
      if (!reference) {
        return this.appendDenial(database, input, registration, {
          code: "INVALID_REFERENCE",
          reason: "The protected reference is invalid.",
          reference: null,
          ruleId: null,
        });
      }
    }

    const provenance = evaluateProvenance(
      input.tool,
      reference?.effectiveLabels ?? [],
    );
    if (!provenance.allowed) {
      return this.appendDenial(database, input, registration, {
        code: "FLOW_DENIED",
        reason:
          "Payment-derived subjects may not be reidentified; use aggregate recovery.",
        reference,
        ruleId: provenance.ruleId,
      });
    }

    return this.executeAllowed(database, input, registration, reference);
  }

  evidenceForRun(database: DatabaseV2, runId: string): SafeRunEvidence {
    const run = database.runs.find((candidate) => candidate.id === runId);
    const grant = run?.runGrantId
      ? database.runGrants.find((candidate) => candidate.id === run.runGrantId)
      : undefined;
    const context = grant
      ? database.policyContexts.find(
          (candidate) => candidate.id === grant.policyContextId,
        )
      : undefined;
    if (!run || !grant || !context) throw new Error("Run evidence not found");

    const included = new Map<string, PolicyReceipt>();
    const visit = (receipt: PolicyReceipt): void => {
      if (receipt.policyContextId !== context.id || included.has(receipt.id)) return;
      for (const causedById of receipt.causedByReceiptIds) {
        const cause = database.policyReceipts.find(
          (candidate) => candidate.id === causedById,
        );
        if (cause) visit(cause);
      }
      included.set(receipt.id, receipt);
    };
    for (const receipt of database.policyReceipts) {
      if (receipt.runId === runId) visit(receipt);
    }

    const receipts: SafeReceiptEvidence[] = Array.from(included.values())
      .sort((left, right) => left.sequence - right.sequence)
      .map((receipt) => {
        const {
          initiatingActorId: _initiatingActorId,
          agentPrincipalId: _agentPrincipalId,
          mandateId: _mandateId,
          ...safeReceipt
        } = receipt;
        const receiptGrant = database.runGrants.find(
          (candidate) => candidate.id === receipt.runGrantId,
        );
        const safeAlternative =
          receipt.ruleId === "NO_PAYMENT_REIDENTIFICATION" &&
          receiptGrant &&
          includesPermission(receiptGrant.permissions, PLATFORM_PERMISSION_CEILING[4]!)
            ? "payments.aggregate_failures"
            : null;
        return { ...safeReceipt, safeAlternative };
      });

    return {
      runId: run.id,
      retryOfRunId: run.retryOfRunId,
      purposeId: context.mandate.purposeId,
      purposeSummary: context.mandate.purposeSummary,
      permissions: grant.permissions.map((permission) => ({ ...permission })),
      contextFingerprint: fingerprint("context", context.id),
      grantFingerprint: fingerprint("grant", grant.id),
      runtimeFingerprint: run.runtimeFingerprint,
      capabilityFingerprint: grant.capabilityFingerprint,
      policyFingerprint: fingerprint("policy", grant.policySha256),
      receipts,
    };
  }

  private selectOrCreateContext(
    database: DatabaseV2,
    agentId: string,
    input: IssueRunInput,
  ): PolicyContext {
    const agent = database.agents.find((candidate) => candidate.id === agentId)!;
    const selectedContextId = input.policyContextId ?? agent.activePolicyContextId;
    if (selectedContextId) {
      const existing = database.policyContexts.find(
        (candidate) => candidate.id === selectedContextId,
      );
      const threadBindingMatches = existing
        ? existing.codexThreadIdSha256 === null
          ? agent.codexThreadId === null
          : agent.codexThreadId !== null &&
            sha256(agent.codexThreadId) === existing.codexThreadIdSha256
        : false;
      if (
        !existing ||
        existing.agentId !== agentId ||
        !threadBindingMatches ||
        existing.closedAt !== null ||
        existing.mandate.revokedAt !== null ||
        hasReached(input.now, existing.expiresAt) ||
        !isPackagedPolicyAvailable(
          existing.mandate.policyId,
          existing.mandate.policyVersion,
          existing.mandate.policySha256,
        )
      ) {
        throw new Error("Policy context is not available for this Run");
      }
      return existing;
    }

    if (agent.codexThreadId) agent.codexThreadId = null;
    const expiresAt = addMilliseconds(input.now, this.contextTtlMs);
    const context: PolicyContext = {
      id: randomUUID(),
      agentId,
      initiatingActorId: "local-demo-operator",
      codexThreadIdSha256: null,
      mandate: {
        id: randomUUID(),
        version: 1,
        subjectPrincipalId: `agent:${agentId}`,
        purposeId: MIXED_OPERATIONS_POLICY.purposeId,
        purposeSummary: PURPOSE_SUMMARY,
        permissions: PLATFORM_PERMISSION_CEILING.map((permission) => ({
          ...permission,
        })),
        policyId: MIXED_OPERATIONS_POLICY.id,
        policyVersion: MIXED_OPERATIONS_POLICY.version,
        policySha256: MIXED_OPERATIONS_POLICY_SHA256,
        issuedAt: input.now,
        expiresAt,
        revokedAt: null,
      },
      createdAt: input.now,
      expiresAt,
      closedAt: null,
    };
    database.policyContexts.push(context);
    database.fixtureCounters.push({
      policyContextId: context.id,
      tool: "crm.resolve_customer",
      count: 0,
    });
    return context;
  }

  private resolveReference(
    database: DatabaseV2,
    rawReference: string,
    expectedKind: ProtectedReference["kind"],
    policyContextId: string,
    now: string,
  ): ProtectedReference | null {
    const reference = database.protectedReferences.find(
      (candidate) => candidate.referenceSha256 === sha256(rawReference),
    );
    if (
      !reference ||
      reference.policyContextId !== policyContextId ||
      reference.kind !== expectedKind ||
      reference.status !== "active"
    ) {
      return null;
    }
    if (hasReached(now, reference.expiresAt)) {
      reference.status = "expired";
      return null;
    }
    return reference;
  }

  private executeAllowed(
    database: DatabaseV2,
    input: AuthenticatedToolCall,
    registration: ToolRegistration,
    reference: ProtectedReference | null,
  ): ToolResult {
    const receiptId = randomUUID();
    const causes = reference ? this.causalReceiptIds(database, reference) : [];
    const produced: ProtectedReference[] = [];
    let data: Record<string, unknown>;
    let resultSummary: string;
    let counterBefore: number | null = null;
    let counterAfter: number | null = null;

    switch (input.tool) {
      case "support.list_tickets": {
        const fixture = listSupportTickets();
        const minted = this.mintReference(database, {
          principal: input.principal,
          kind: "customer-subject",
          privateTargetId: fixture.privateTargetId,
          labels: fixture.labels,
          parent: null,
          receiptId,
          now: input.now,
        });
        produced.push(minted.record);
        data = {
          ticketCount: fixture.count,
          subject: { reference: minted.raw, kind: minted.record.kind },
        };
        resultSummary = "Returned Support tickets and one opaque subject reference.";
        break;
      }
      case "payments.list_failures": {
        const fixture = listPaymentFailures();
        const minted = this.mintReference(database, {
          principal: input.principal,
          kind: "customer-subject",
          privateTargetId: fixture.privateTargetId,
          labels: fixture.labels,
          parent: null,
          receiptId,
          now: input.now,
        });
        produced.push(minted.record);
        data = {
          failureCount: fixture.count,
          subject: { reference: minted.raw, kind: minted.record.kind },
        };
        resultSummary = "Returned Payment failures and one opaque subject reference.";
        break;
      }
      case "cases.lookup_subject": {
        if (!reference) throw new Error("Validated Case input reference is missing");
        const fixture = lookupSubject(reference.privateTargetId);
        const labels = Array.from(
          new Set<ProvenanceLabel>([
            ...reference.effectiveLabels,
            "CASE_DERIVED",
          ]),
        );
        const minted = this.mintReference(database, {
          principal: input.principal,
          kind: "operations-case",
          privateTargetId: fixture.privateTargetId,
          labels,
          parent: reference,
          receiptId,
          now: input.now,
        });
        produced.push(minted.record);
        data = {
          case: {
            reference: minted.raw,
            kind: minted.record.kind,
            status: fixture.caseStatus,
          },
        };
        resultSummary = "Returned one opaque Case reference with inherited labels.";
        break;
      }
      case "crm.resolve_customer": {
        if (!reference) throw new Error("Validated CRM input reference is missing");
        const counter = this.requireCounter(database, input.principal.policyContextId);
        counterBefore = counter.count;
        counter.count += 1;
        counterAfter = counter.count;
        data = { ...resolveCustomer(reference.privateTargetId) };
        resultSummary = "Returned one authorized synthetic customer resolution.";
        break;
      }
      case "payments.aggregate_failures": {
        data = { ...aggregatePaymentFailures() };
        resultSummary = "Returned aggregate Payment failure counts only.";
        break;
      }
    }

    const receipt = this.receipt(database, input, registration, {
      id: receiptId,
      decision: "ALLOW",
      staticScopeDecision: "ALLOW",
      provenanceDecision: "ALLOW",
      outcome: "SUCCEEDED",
      downstreamInvoked: true,
      ruleId: null,
      reason: "The exact grant tuple and stored provenance allow this call.",
      causedByReceiptIds: causes,
      inputReferenceAliases: reference ? [reference.displayAlias] : [],
      producedReferenceAliases: produced.map((item) => item.displayAlias),
      counterBefore,
      counterAfter,
      redactedInputSummary: reference
        ? `One opaque ${reference.kind} reference.`
        : "No protected input.",
      redactedResultSummary: resultSummary,
    });
    database.policyReceipts.push(receipt);
    return { isError: false, receiptId, data };
  }

  private appendDenial(
    database: DatabaseV2,
    input: AuthenticatedToolCall,
    registration: ToolRegistration,
    denial: {
      code: ToolDenial["code"];
      reason: string;
      reference: ProtectedReference | null;
      ruleId: PolicyReceipt["ruleId"];
    },
  ): ToolDenial {
    const counter =
      input.tool === "crm.resolve_customer"
        ? this.requireCounter(database, input.principal.policyContextId).count
        : null;
    const causedByReceiptIds = denial.reference
      ? this.causalReceiptIds(database, denial.reference)
      : [];
    const safeAlternative =
      denial.ruleId === "NO_PAYMENT_REIDENTIFICATION" &&
      includesPermission(
        input.principal.permissions,
        PLATFORM_PERMISSION_CEILING[4]!,
      )
        ? "payments.aggregate_failures"
        : null;
    const receipt = this.receipt(database, input, registration, {
      id: randomUUID(),
      decision: "DENY",
      staticScopeDecision: denial.code === "SCOPE_DENIED" ? "DENY" : "ALLOW",
      provenanceDecision: denial.code === "FLOW_DENIED" ? "DENY" : "NOT_EVALUATED",
      outcome: "NOT_INVOKED",
      downstreamInvoked: false,
      ruleId: denial.ruleId,
      reason: denial.reason,
      causedByReceiptIds,
      inputReferenceAliases: denial.reference
        ? [denial.reference.displayAlias]
        : [],
      producedReferenceAliases: [],
      counterBefore: counter,
      counterAfter: counter,
      redactedInputSummary: denial.reference
        ? `One opaque ${denial.reference.kind} reference.`
        : "Rejected protected input.",
      redactedResultSummary: null,
    });
    database.policyReceipts.push(receipt);
    return {
      isError: true,
      code: denial.code,
      receiptId: receipt.id,
      message: denial.reason,
      safeAlternative,
    };
  }

  private receipt(
    database: DatabaseV2,
    input: AuthenticatedToolCall,
    registration: ToolRegistration,
    detail: Pick<
      PolicyReceipt,
      | "id"
      | "decision"
      | "staticScopeDecision"
      | "provenanceDecision"
      | "outcome"
      | "downstreamInvoked"
      | "ruleId"
      | "reason"
      | "causedByReceiptIds"
      | "inputReferenceAliases"
      | "producedReferenceAliases"
      | "counterBefore"
      | "counterAfter"
      | "redactedInputSummary"
      | "redactedResultSummary"
    >,
  ): PolicyReceipt {
    const context = database.policyContexts.find(
      (candidate) => candidate.id === input.principal.policyContextId,
    );
    if (!context) throw new Error("Policy context not found");
    const sequence =
      database.policyReceipts.reduce(
        (highest, receipt) => Math.max(highest, receipt.sequence),
        0,
      ) + 1;
    return {
      ...detail,
      sequence,
      createdAt: input.now,
      policyContextId: context.id,
      runId: input.principal.runId,
      runGrantId: input.principal.runGrantId,
      initiatingActorId: context.initiatingActorId,
      agentPrincipalId: context.mandate.subjectPrincipalId,
      mandateId: context.mandate.id,
      tool: registration.permission.tool,
      action: registration.permission.action,
      resourceKind: registration.permission.resourceKind,
      enforcementStage: "PRE_EXECUTION",
      policyId: context.mandate.policyId,
      policyVersion: context.mandate.policyVersion,
    };
  }

  private mintReference(
    database: DatabaseV2,
    input: {
      principal: AuthenticatedPrincipal;
      kind: ProtectedReference["kind"];
      privateTargetId: string;
      labels: ProvenanceLabel[];
      parent: ProtectedReference | null;
      receiptId: string;
      now: string;
    },
  ): { raw: string; record: ProtectedReference } {
    let raw = generateReferenceToken();
    let digest = sha256(raw);
    while (
      database.protectedReferences.some(
        (candidate) => candidate.referenceSha256 === digest,
      )
    ) {
      raw = generateReferenceToken();
      digest = sha256(raw);
    }
    const grant = database.runGrants.find(
      (candidate) => candidate.id === input.principal.runGrantId,
    )!;
    const context = database.policyContexts.find(
      (candidate) => candidate.id === input.principal.policyContextId,
    )!;
    const record: ProtectedReference = {
      referenceSha256: digest,
      displayAlias: referenceAlias(digest),
      policyContextId: context.id,
      kind: input.kind,
      privateTargetId: input.privateTargetId,
      effectiveLabels: Array.from(new Set(input.labels)),
      parentReferenceSha256: input.parent?.referenceSha256 ?? null,
      producedByReceiptId: input.receiptId,
      issuedAt: input.now,
      expiresAt: earliestTimestamp(grant.expiresAt, context.expiresAt),
      status: "active",
    };
    database.protectedReferences.push(record);
    return { raw, record };
  }

  private causalReceiptIds(
    database: DatabaseV2,
    reference: ProtectedReference,
  ): string[] {
    const reverse: string[] = [];
    let current: ProtectedReference | undefined = reference;
    for (let depth = 0; current && depth < 2; depth += 1) {
      reverse.push(current.producedByReceiptId);
      current = current.parentReferenceSha256
        ? database.protectedReferences.find(
            (candidate) =>
              candidate.referenceSha256 === current?.parentReferenceSha256 &&
              candidate.policyContextId === reference.policyContextId,
          )
        : undefined;
    }
    return reverse.reverse();
  }

  private requireCounter(database: DatabaseV2, policyContextId: string) {
    const counter = database.fixtureCounters.find(
      (candidate) =>
        candidate.policyContextId === policyContextId &&
        candidate.tool === "crm.resolve_customer",
    );
    if (!counter) throw new Error("CRM fixture counter not found");
    return counter;
  }
}
