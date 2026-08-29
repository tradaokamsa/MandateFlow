import { z } from "zod";
import { HttpError } from "./errors.js";
import type {
  MandateEvidence,
  MandatePermission,
  MandatePrepareRequest,
  MandatePrepareResult,
} from "./types.js";

export const MANDATE_PERMISSIONS: MandatePermission[] = [
  { tool: "support.list_tickets", action: "read", resourceKind: "support-ticket" },
  {
    tool: "payments.list_failures",
    action: "read",
    resourceKind: "payment-failure",
  },
  { tool: "cases.lookup_subject", action: "derive", resourceKind: "operations-case" },
  { tool: "crm.resolve_customer", action: "read", resourceKind: "customer-profile" },
  {
    tool: "payments.aggregate_failures",
    action: "aggregate",
    resourceKind: "payment-summary",
  },
];

const prepareResultSchema = z.object({
  runGrantId: z.string().min(1),
  policyContextId: z.string().min(1),
  grantFingerprint: z.string().min(1),
  capabilityFingerprint: z.string().min(1),
  status: z.enum(["PREPARED", "ACTIVE"]),
  expiresAt: z.string().min(1),
  grantedPermissions: z.array(
    z.object({
      tool: z.string(),
      action: z.string(),
      resourceKind: z.string(),
    }).strict(),
  ),
}).strict();

const lifecycleResultSchema = z.object({
  runId: z.string().min(1),
  status: z.string().min(1),
  expiresAt: z.string().min(1),
  terminalAt: z.string().min(1).optional(),
}).strict();

const receiptSchema = z.object({
  id: z.string(),
  createdAt: z.string(),
  runId: z.string(),
  policyContextId: z.string(),
  runGrantId: z.string(),
  tool: z.string(),
  action: z.string(),
  resourceKind: z.string(),
  decision: z.enum(["ALLOW", "DENY"]),
  staticScopeDecision: z.enum(["ALLOW", "DENY"]),
  provenanceDecision: z.enum(["ALLOW", "DENY", "NOT_EVALUATED"]),
  enforcementStage: z.literal("PRE_EXECUTION"),
  outcome: z.enum(["SUCCEEDED", "FAILED", "NOT_INVOKED"]),
  downstreamInvoked: z.boolean(),
  ruleId: z.string().nullable(),
  reason: z.string(),
  causedByReceiptIds: z.array(z.string()),
  inputReferenceAliases: z.array(z.string()),
  redactedInputSummary: z.string(),
  redactedResultSummary: z.string(),
  counterBefore: z.number().int(),
  counterAfter: z.number().int(),
  policyId: z.string(),
  policyVersion: z.number().int(),
}).strict();

const evidenceSchema = z.object({
  runId: z.string(),
  policyContextId: z.string(),
  runGrantId: z.string(),
  retryOfRunId: z.string().nullable().optional().transform((value) => value ?? null),
  runtimeInstanceId: z.string(),
  runStatus: z.string(),
  purposeId: z.string(),
  policyId: z.string(),
  policyVersion: z.number().int(),
  grantFingerprint: z.string(),
  capabilityFingerprint: z.string(),
  crmCounter: z.number().int().nonnegative(),
  receipts: z.array(receiptSchema),
}).strict();

export interface MandateFlowControl {
  ready(): Promise<boolean>;
  prepare(runId: string, request: MandatePrepareRequest): Promise<MandatePrepareResult>;
  activate(runId: string): Promise<void>;
  finish(
    runId: string,
    status: "COMPLETED" | "FAILED" | "CANCELLED" | "ABANDONED",
  ): Promise<void>;
  evidence(runId: string): Promise<MandateEvidence>;
}

export class MandateFlowClient implements MandateFlowControl {
  constructor(
    private readonly baseUrl: string,
    private readonly controlToken: string,
  ) {}

  async ready(): Promise<boolean> {
    try {
      const response = await fetch(this.baseUrl + "/healthz", {
        signal: AbortSignal.timeout(1_500),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { ok?: unknown };
      return body.ok === true;
    } catch {
      return false;
    }
  }

  async prepare(
    runId: string,
    request: MandatePrepareRequest,
  ): Promise<MandatePrepareResult> {
    const body = await this.request(
      "/control/v1/runs/" + encodeURIComponent(runId) + "/prepare",
      { method: "PUT", body: JSON.stringify(request) },
    );
    return prepareResultSchema.parse(body) as MandatePrepareResult;
  }

  async activate(runId: string): Promise<void> {
    const body = await this.request(
      "/control/v1/runs/" + encodeURIComponent(runId) + "/activate",
      { method: "POST" },
    );
    lifecycleResultSchema.parse(body);
  }

  async finish(
    runId: string,
    status: "COMPLETED" | "FAILED" | "CANCELLED" | "ABANDONED",
  ): Promise<void> {
    const body = await this.request(
      "/control/v1/runs/" + encodeURIComponent(runId) + "/finish",
      { method: "POST", body: JSON.stringify({ status }) },
    );
    lifecycleResultSchema.parse(body);
  }

  async evidence(runId: string): Promise<MandateEvidence> {
    const body = await this.request(
      "/control/v1/runs/" + encodeURIComponent(runId) + "/evidence",
      { method: "GET" },
    );
    return evidenceSchema.parse(body) as MandateEvidence;
  }

  private async request(path: string, options: RequestInit): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(this.baseUrl + path, {
        ...options,
        headers: {
          Authorization: "Bearer " + this.controlToken,
          ...(options.body ? { "Content-Type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new HttpError(503, "MandateFlow control plane is unavailable");
    }
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok) {
      const message =
        typeof body.error === "string" ? body.error : "MandateFlow request failed";
      throw new HttpError(response.status, message);
    }
    return body;
  }
}
