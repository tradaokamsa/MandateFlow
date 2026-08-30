import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });
const nullableTimestampSchema = timestampSchema.nullable();

export const agentStatusSchema = z.enum(["ready", "busy", "stopped", "error"]);
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

const legacyAgentSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    description: z.string(),
    instructions: z.string(),
    status: agentStatusSchema,
    workspacePath: z.string(),
    codexThreadId: z.string().nullable(),
    lastError: z.string().nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

const agentSchema = legacyAgentSchema.extend({
  activePolicyContextId: z.string().uuid().nullable(),
});

const messageSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    runId: z.string(),
    role: z.enum(["user", "assistant"]),
    content: z.string(),
    createdAt: timestampSchema,
  })
  .strict();

const runUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

const legacyRunSchema = z
  .object({
    id: z.string(),
    agentId: z.string(),
    status: runStatusSchema,
    prompt: z.string(),
    output: z.string().nullable(),
    error: z.string().nullable(),
    usage: runUsageSchema.nullable(),
    startedAt: nullableTimestampSchema,
    completedAt: nullableTimestampSchema,
    createdAt: timestampSchema,
  })
  .strict();

const runSchema = legacyRunSchema.extend({
  policyContextId: z.string().uuid().nullable(),
  runGrantId: z.string().uuid().nullable(),
  retryOfRunId: z.string().uuid().nullable(),
  capabilityFingerprint: z.string().nullable(),
  runtimeFingerprint: z.string().nullable(),
});

export const toolNameSchema = z.enum([
  "support.list_tickets",
  "payments.list_failures",
  "cases.lookup_subject",
  "crm.resolve_customer",
  "payments.aggregate_failures",
]);
export const actionSchema = z.enum(["read", "resolve", "aggregate"]);
export const resourceKindSchema = z.enum([
  "support-ticket",
  "payment-failure",
  "customer-subject",
  "operations-case",
  "customer-resolution",
  "payment-aggregate",
]);
export const provenanceLabelSchema = z.enum([
  "SUPPORT_FOLLOWUP_ALLOWED",
  "PAYMENT_AGGREGATE_ONLY",
  "CASE_DERIVED",
]);
export const permissionTupleSchema = z
  .object({
    tool: toolNameSchema,
    action: actionSchema,
    resourceKind: resourceKindSchema,
  })
  .strict();

export const mixedOperationsPolicySchema = z
  .object({
    id: z.literal("mixed-operations-flow"),
    version: z.literal(1),
    purposeId: z.literal("MIXED_OPERATIONS_BRIEF"),
    defaultEffect: z.literal("ALLOW_IF_STATIC_SCOPE"),
    rules: z
      .array(
        z
          .object({
            id: z.literal("NO_PAYMENT_REIDENTIFICATION"),
            when: z
              .object({
                anyAncestorLabel: z.literal("PAYMENT_AGGREGATE_ONLY"),
                destinationTool: z.literal("crm.resolve_customer"),
              })
              .strict(),
            effect: z.literal("DENY"),
            safeAlternative: z.literal("payments.aggregate_failures"),
          })
          .strict(),
      )
      .length(1),
  })
  .strict();

const frozenMandateSchema = z
  .object({
    id: z.string().uuid(),
    version: z.literal(1),
    subjectPrincipalId: z.string(),
    purposeId: z.literal("MIXED_OPERATIONS_BRIEF"),
    purposeSummary: z.string(),
    permissions: z.array(permissionTupleSchema),
    policyId: z.literal("mixed-operations-flow"),
    policyVersion: z.literal(1),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    revokedAt: nullableTimestampSchema,
  })
  .strict();

const policyContextSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    initiatingActorId: z.literal("local-demo-operator"),
    codexThreadIdSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    mandate: frozenMandateSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    closedAt: nullableTimestampSchema,
  })
  .strict();

const terminalReasonSchema = z.enum([
  "completed",
  "failed",
  "cancelled",
  "expired",
  "restart_interrupted",
]);
const grantStatusSchema = z.enum([
  "queued",
  "active",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "restart_interrupted",
]);

const runGrantSchema = z
  .object({
    id: z.string().uuid(),
    runId: z.string().uuid(),
    agentId: z.string().uuid(),
    policyContextId: z.string().uuid(),
    mandateId: z.string().uuid(),
    retryOfRunId: z.string().uuid().nullable(),
    permissions: z.array(permissionTupleSchema),
    policyId: z.literal("mixed-operations-flow"),
    policyVersion: z.literal(1),
    policySha256: z.string().regex(/^[a-f0-9]{64}$/),
    status: grantStatusSchema,
    issuedAt: timestampSchema,
    activatedAt: nullableTimestampSchema,
    expiresAt: timestampSchema,
    terminalAt: nullableTimestampSchema,
    capabilitySha256: z.string().regex(/^[a-f0-9]{64}$/),
    capabilityFingerprint: z.string(),
    capabilityAudience: z.literal("launchpad-mcp-gateway"),
    capabilityInvalidatedAt: nullableTimestampSchema,
    capabilityInvalidReason: terminalReasonSchema.nullable(),
  })
  .strict();

const protectedReferenceSchema = z
  .object({
    referenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    displayAlias: z.string(),
    policyContextId: z.string().uuid(),
    kind: z.enum(["customer-subject", "operations-case"]),
    privateTargetId: z.string(),
    effectiveLabels: z.array(provenanceLabelSchema),
    parentReferenceSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    producedByReceiptId: z.string().uuid(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    status: z.enum(["active", "expired", "revoked"]),
  })
  .strict();

const policyReceiptSchema = z
  .object({
    id: z.string().uuid(),
    sequence: z.number().int().positive(),
    createdAt: timestampSchema,
    policyContextId: z.string().uuid(),
    runId: z.string().uuid(),
    runGrantId: z.string().uuid(),
    initiatingActorId: z.string(),
    agentPrincipalId: z.string(),
    mandateId: z.string().uuid(),
    tool: toolNameSchema,
    action: actionSchema,
    resourceKind: resourceKindSchema,
    decision: z.enum(["ALLOW", "DENY"]),
    staticScopeDecision: z.enum(["ALLOW", "DENY"]),
    provenanceDecision: z.enum(["ALLOW", "DENY", "NOT_EVALUATED"]),
    enforcementStage: z.literal("PRE_EXECUTION"),
    outcome: z.enum(["SUCCEEDED", "NOT_INVOKED"]),
    policyId: z.literal("mixed-operations-flow"),
    policyVersion: z.literal(1),
    downstreamInvoked: z.boolean(),
    ruleId: z.literal("NO_PAYMENT_REIDENTIFICATION").nullable(),
    reason: z.string(),
    causedByReceiptIds: z.array(z.string().uuid()),
    inputReferenceAliases: z.array(z.string()),
    producedReferenceAliases: z.array(z.string()),
    counterBefore: z.number().int().nonnegative().nullable(),
    counterAfter: z.number().int().nonnegative().nullable(),
    redactedInputSummary: z.string(),
    redactedResultSummary: z.string().nullable(),
  })
  .strict();

const fixtureCounterSchema = z
  .object({
    policyContextId: z.string().uuid(),
    tool: z.literal("crm.resolve_customer"),
    count: z.number().int().nonnegative(),
  })
  .strict();

export const databaseV1Schema = z
  .object({
    version: z.literal(1),
    agents: z.array(legacyAgentSchema),
    messages: z.array(messageSchema),
    runs: z.array(legacyRunSchema),
  })
  .strict();

export const databaseV2Schema = z
  .object({
    version: z.literal(2),
    agents: z.array(agentSchema),
    messages: z.array(messageSchema),
    runs: z.array(runSchema),
    policyContexts: z.array(policyContextSchema),
    runGrants: z.array(runGrantSchema),
    protectedReferences: z.array(protectedReferenceSchema),
    policyReceipts: z.array(policyReceiptSchema),
    fixtureCounters: z.array(fixtureCounterSchema),
  })
  .strict();

export type DatabaseV1 = z.infer<typeof databaseV1Schema>;
