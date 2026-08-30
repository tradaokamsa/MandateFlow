import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Agent, AgentRun } from "../types.js";
import { generateCapabilityToken, sha256 } from "./crypto.js";
import { MandateFlowKernel, PLATFORM_PERMISSION_CEILING } from "./kernel.js";
import type {
  DatabaseV2,
  PermissionTuple,
  ToolResult,
} from "./types.js";

const initialTime = "2026-08-30T00:00:00.000Z";
const laterTime = "2026-08-30T00:01:00.000Z";

function agent(id = randomUUID()): Agent {
  return {
    id,
    name: "MandateFlow demo",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/tmp/workspace",
    codexThreadId: null,
    activePolicyContextId: null,
    lastError: null,
    createdAt: initialTime,
    updatedAt: initialTime,
  };
}

function run(agentId: string, id = randomUUID(), retryOfRunId: string | null = null): AgentRun {
  return {
    id,
    agentId,
    status: "queued",
    prompt: "Prepare the morning operations brief",
    output: null,
    error: null,
    usage: null,
    startedAt: null,
    completedAt: null,
    policyContextId: null,
    runGrantId: null,
    retryOfRunId,
    capabilityFingerprint: null,
    runtimeFingerprint: null,
    createdAt: initialTime,
  };
}

function database(): DatabaseV2 {
  return {
    version: 2,
    agents: [],
    messages: [],
    runs: [],
    policyContexts: [],
    runGrants: [],
    protectedReferences: [],
    policyReceipts: [],
    fixtureCounters: [],
  };
}

function issueActive(
  db: DatabaseV2,
  kernel: MandateFlowKernel,
  requestedPermissions: readonly PermissionTuple[] = PLATFORM_PERMISSION_CEILING,
) {
  const createdAgent = agent();
  const createdRun = run(createdAgent.id);
  const capability = generateCapabilityToken();
  db.agents.push(createdAgent);
  db.runs.push(createdRun);
  const issued = kernel.issueRun(db, {
    agentId: createdAgent.id,
    runId: createdRun.id,
    capability,
    requestedPermissions,
    retryOfRunId: null,
    policyContextId: null,
    now: initialTime,
  });
  kernel.activateRun(db, createdRun.id, initialTime);
  const principal = kernel.authenticateActiveGrant(
    db,
    sha256(capability),
    laterTime,
  );
  if (!principal) throw new Error("expected active principal");
  return { createdAgent, createdRun, capability, issued, principal };
}

function requireReference(result: ToolResult, key: "subject" | "case"): string {
  expect(result.isError).toBe(false);
  if (result.isError) throw new Error(result.message);
  const value = result.data[key] as { reference?: unknown };
  expect(value.reference).toMatch(/^ref1_/);
  return value.reference as string;
}

describe("MandateFlow kernel authority", () => {
  it("refuses to issue authority for a non-ready Agent or non-queued Run", () => {
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const stoppedDatabase = database();
    const stoppedAgent = agent();
    stoppedAgent.status = "stopped";
    const queuedRun = run(stoppedAgent.id);
    stoppedDatabase.agents.push(stoppedAgent);
    stoppedDatabase.runs.push(queuedRun);
    expect(() =>
      kernel.issueRun(stoppedDatabase, {
        agentId: stoppedAgent.id,
        runId: queuedRun.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: null,
        policyContextId: null,
        now: initialTime,
      }),
    ).toThrow(/ready Agent/i);

    const completedDatabase = database();
    const readyAgent = agent();
    const completedRun = run(readyAgent.id);
    completedRun.status = "completed";
    completedDatabase.agents.push(readyAgent);
    completedDatabase.runs.push(completedRun);
    expect(() =>
      kernel.issueRun(completedDatabase, {
        agentId: readyAgent.id,
        runId: completedRun.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: null,
        policyContextId: null,
        now: initialTime,
      }),
    ).toThrow(/queued Run/i);
  });

  it("issues one immutable no-broader grant and stores only the capability hash", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const requested = [PLATFORM_PERMISSION_CEILING[3]!];
    const { capability, createdRun, issued } = issueActive(db, kernel, requested);
    const grant = db.runGrants[0]!;

    expect(grant.permissions).toEqual(requested);
    expect(grant.capabilitySha256).toBe(sha256(capability));
    expect(JSON.stringify(db)).not.toContain(capability);
    expect(createdRun.runGrantId).toBe(grant.id);
    expect(createdRun.policyContextId).toBe(issued.policyContextId);
    expect(db.fixtureCounters).toEqual([
      {
        policyContextId: issued.policyContextId,
        tool: "crm.resolve_customer",
        count: 0,
      },
    ]);

    kernel.terminalizeRun(db, createdRun.id, "completed", laterTime);
    expect(() => kernel.activateRun(db, createdRun.id, laterTime)).toThrow(
      /terminal|transition/i,
    );
    expect(() =>
      kernel.issueRun(db, {
        agentId: createdRun.agentId,
        runId: createdRun.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: null,
        policyContextId: null,
        now: laterTime,
      }),
    ).toThrow(/one grant/i);
  });

  it("does not activate expired, closed or revoked authority", () => {
    const makeQueuedAuthority = () => {
      const db = database();
      const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
      const createdAgent = agent();
      const createdRun = run(createdAgent.id);
      db.agents.push(createdAgent);
      db.runs.push(createdRun);
      kernel.issueRun(db, {
        agentId: createdAgent.id,
        runId: createdRun.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: null,
        policyContextId: null,
        now: initialTime,
      });
      return { db, kernel, createdRun };
    };

    const expired = makeQueuedAuthority();
    expect(() =>
      expired.kernel.activateRun(
        expired.db,
        expired.createdRun.id,
        "2026-08-30T00:03:00.000Z",
      ),
    ).toThrow(/expired|available/i);
    expect(expired.db.runGrants[0]?.status).toBe("queued");

    const closed = makeQueuedAuthority();
    closed.db.policyContexts[0]!.closedAt = initialTime;
    expect(() =>
      closed.kernel.activateRun(closed.db, closed.createdRun.id, laterTime),
    ).toThrow(/closed|available/i);

    const revoked = makeQueuedAuthority();
    revoked.db.policyContexts[0]!.mandate.revokedAt = initialTime;
    expect(() =>
      revoked.kernel.activateRun(revoked.db, revoked.createdRun.id, laterTime),
    ).toThrow(/revoked|available/i);
  });

  it("invalidates authority without declaring the Runtime settled", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const { createdAgent, createdRun } = issueActive(db, kernel);

    kernel.terminalizeRun(db, createdRun.id, "cancelled", laterTime);

    expect(db.runGrants[0]).toMatchObject({
      status: "cancelled",
      capabilityInvalidReason: "cancelled",
    });
    expect(createdAgent.status).toBe("busy");
  });

  it("compares offset timestamps by instant when expiring authority", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const createdAgent = agent();
    const createdRun = run(createdAgent.id);
    const capability = generateCapabilityToken();
    db.agents.push(createdAgent);
    db.runs.push(createdRun);
    kernel.issueRun(db, {
      agentId: createdAgent.id,
      runId: createdRun.id,
      capability,
      requestedPermissions: PLATFORM_PERMISSION_CEILING,
      retryOfRunId: null,
      policyContextId: null,
      now: initialTime,
    });
    kernel.activateRun(db, createdRun.id, initialTime);
    db.policyContexts[0]!.expiresAt = "2026-08-30T08:00:30+08:00";
    db.policyContexts[0]!.mandate.expiresAt = "2026-08-30T08:00:30+08:00";

    expect(
      kernel.authenticateActiveGrant(db, sha256(capability), laterTime),
    ).toBeNull();
    expect(db.runGrants[0]?.status).toBe("expired");
  });

  it("rejects active grants with broken Agent, Run, context or mandate links", () => {
    const authenticateAfter = (
      corrupt: (db: DatabaseV2) => void,
    ): ReturnType<MandateFlowKernel["authenticateActiveGrant"]> => {
      const db = database();
      const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
      const { capability } = issueActive(db, kernel);
      corrupt(db);
      return kernel.authenticateActiveGrant(db, sha256(capability), laterTime);
    };

    expect(authenticateAfter(() => undefined)).not.toBeNull();
    expect(authenticateAfter((db) => db.agents.splice(0))).toBeNull();
    expect(authenticateAfter((db) => db.runs.splice(0))).toBeNull();
    expect(
      authenticateAfter((db) => {
        db.runs[0]!.status = "completed";
      }),
    ).toBeNull();
    expect(
      authenticateAfter((db) => {
        db.runs[0]!.runGrantId = randomUUID();
      }),
    ).toBeNull();
    expect(
      authenticateAfter((db) => {
        db.policyContexts[0]!.mandate.id = randomUUID();
      }),
    ).toBeNull();
  });

  it("issues Retry only from one completed same-thread predecessor and narrows it", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const first = issueActive(db, kernel);
    const payment = kernel.executeTool(db, {
      principal: first.principal,
      tool: "payments.list_failures",
      argumentsValue: {},
      now: laterTime,
    });
    const paymentSubject = requireReference(payment, "subject");
    const paymentCase = kernel.executeTool(db, {
      principal: first.principal,
      tool: "cases.lookup_subject",
      argumentsValue: { reference: paymentSubject },
      now: laterTime,
    });
    const paymentCaseReference = requireReference(paymentCase, "case");
    expect(
      kernel.executeTool(db, {
        principal: first.principal,
        tool: "crm.resolve_customer",
        argumentsValue: { reference: paymentCaseReference },
        now: laterTime,
      }),
    ).toMatchObject({ isError: true, code: "FLOW_DENIED" });
    const threadId = "thread-for-retry";
    kernel.bindThread(db, first.issued.policyContextId, threadId);
    first.createdAgent.codexThreadId = threadId;
    kernel.terminalizeRun(db, first.createdRun.id, "completed", laterTime);
    first.createdAgent.status = "ready";

    const retryRun = run(
      first.createdAgent.id,
      randomUUID(),
      first.createdRun.id,
    );
    db.runs.push(retryRun);
    kernel.issueRun(db, {
      agentId: first.createdAgent.id,
      runId: retryRun.id,
      capability: generateCapabilityToken(),
      requestedPermissions: PLATFORM_PERMISSION_CEILING,
      retryOfRunId: first.createdRun.id,
      policyContextId: first.issued.policyContextId,
      now: laterTime,
    });

    expect(db.runGrants.at(-1)?.permissions).toEqual([
      PLATFORM_PERMISSION_CEILING[3],
      PLATFORM_PERMISSION_CEILING[4],
    ]);
    expect(retryRun.policyContextId).toBe(first.createdRun.policyContextId);

    kernel.terminalizeRun(db, retryRun.id, "failed", laterTime);
    first.createdAgent.status = "ready";
    const duplicate = run(
      first.createdAgent.id,
      randomUUID(),
      first.createdRun.id,
    );
    db.runs.push(duplicate);
    expect(() =>
      kernel.issueRun(db, {
        agentId: first.createdAgent.id,
        runId: duplicate.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: first.createdRun.id,
        policyContextId: first.issued.policyContextId,
        now: laterTime,
      }),
    ).toThrow(/successor|Retry/i);
  });

  it("rejects Retry from an unknown or non-completed predecessor", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const createdAgent = agent();
    db.agents.push(createdAgent);
    const retryRun = run(createdAgent.id, randomUUID(), randomUUID());
    db.runs.push(retryRun);

    expect(() =>
      kernel.issueRun(db, {
        agentId: createdAgent.id,
        runId: retryRun.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: retryRun.retryOfRunId,
        policyContextId: null,
        now: initialTime,
      }),
    ).toThrow(/completed predecessor/i);
  });

  it("rejects Retry when the predecessor has no persisted Payment-flow denial", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const first = issueActive(db, kernel);
    kernel.bindThread(db, first.issued.policyContextId, "thread-without-denial");
    first.createdAgent.codexThreadId = "thread-without-denial";
    kernel.terminalizeRun(db, first.createdRun.id, "completed", laterTime);
    first.createdAgent.status = "ready";
    const retry = run(first.createdAgent.id, randomUUID(), first.createdRun.id);
    db.runs.push(retry);

    expect(() =>
      kernel.issueRun(db, {
        agentId: first.createdAgent.id,
        runId: retry.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: first.createdRun.id,
        policyContextId: first.issued.policyContextId,
        now: laterTime,
      }),
    ).toThrow(/denied|denial/i);
  });

  it("does not resume an Agent thread that is not bound to its context", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const first = issueActive(db, kernel);
    kernel.terminalizeRun(db, first.createdRun.id, "completed", laterTime);
    first.createdAgent.status = "ready";
    first.createdAgent.codexThreadId = "unbound-thread";
    const followUp = run(first.createdAgent.id);
    db.runs.push(followUp);

    expect(() =>
      kernel.issueRun(db, {
        agentId: first.createdAgent.id,
        runId: followUp.id,
        capability: generateCapabilityToken(),
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: null,
        policyContextId: first.issued.policyContextId,
        now: laterTime,
      }),
    ).toThrow(/thread|context/i);
  });

  it("allows Support-derived CRM disclosure and records counter 0 to 1", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const { principal } = issueActive(db, kernel);

    const support = kernel.executeTool(db, {
      principal,
      tool: "support.list_tickets",
      argumentsValue: {},
      now: laterTime,
    });
    const subjectReference = requireReference(support, "subject");
    const lookedUp = kernel.executeTool(db, {
      principal,
      tool: "cases.lookup_subject",
      argumentsValue: { reference: subjectReference },
      now: laterTime,
    });
    const caseReference = requireReference(lookedUp, "case");
    const resolved = kernel.executeTool(db, {
      principal,
      tool: "crm.resolve_customer",
      argumentsValue: { reference: caseReference },
      now: laterTime,
    });

    expect(resolved).toMatchObject({
      isError: false,
      data: {
        displayName: "Taylor Example",
        email: "taylor.support@example.test",
        contactStatus: "follow-up-allowed",
      },
    });
    expect(db.fixtureCounters[0]?.count).toBe(1);
    expect(db.policyReceipts.at(-1)).toMatchObject({
      decision: "ALLOW",
      staticScopeDecision: "ALLOW",
      provenanceDecision: "ALLOW",
      outcome: "SUCCEEDED",
      downstreamInvoked: true,
      counterBefore: 0,
      counterAfter: 1,
    });
  });

  it("denies Payment-derived CRM before invocation and offers aggregate recovery", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const { principal } = issueActive(db, kernel);

    const payment = kernel.executeTool(db, {
      principal,
      tool: "payments.list_failures",
      argumentsValue: {},
      now: laterTime,
    });
    const subjectReference = requireReference(payment, "subject");
    const lookedUp = kernel.executeTool(db, {
      principal,
      tool: "cases.lookup_subject",
      argumentsValue: { reference: subjectReference },
      now: laterTime,
    });
    const caseReference = requireReference(lookedUp, "case");
    const denied = kernel.executeTool(db, {
      principal,
      tool: "crm.resolve_customer",
      argumentsValue: { reference: caseReference },
      now: laterTime,
    });

    expect(denied).toMatchObject({
      isError: true,
      code: "FLOW_DENIED",
      safeAlternative: "payments.aggregate_failures",
    });
    expect(db.fixtureCounters[0]?.count).toBe(0);
    expect(db.policyReceipts.at(-1)).toMatchObject({
      decision: "DENY",
      staticScopeDecision: "ALLOW",
      provenanceDecision: "DENY",
      ruleId: "NO_PAYMENT_REIDENTIFICATION",
      enforcementStage: "PRE_EXECUTION",
      outcome: "NOT_INVOKED",
      downstreamInvoked: false,
      counterBefore: 0,
      counterAfter: 0,
    });
    expect(db.policyReceipts.at(-1)?.causedByReceiptIds).toEqual([
      payment.receiptId,
      lookedUp.receiptId,
    ]);

    const aggregate = kernel.executeTool(db, {
      principal,
      tool: "payments.aggregate_failures",
      argumentsValue: {},
      now: laterTime,
    });
    expect(aggregate).toMatchObject({
      isError: false,
      data: { failedPayments: 3, currency: "USD" },
    });
  });

  it("rejects forged, wrong-kind, cross-context and client-authored metadata", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const first = issueActive(db, kernel);
    const support = kernel.executeTool(db, {
      principal: first.principal,
      tool: "support.list_tickets",
      argumentsValue: {},
      now: laterTime,
    });
    const subjectReference = requireReference(support, "subject");

    const wrongKind = kernel.executeTool(db, {
      principal: first.principal,
      tool: "crm.resolve_customer",
      argumentsValue: { reference: subjectReference },
      now: laterTime,
    });
    expect(wrongKind).toMatchObject({ isError: true, code: "INVALID_REFERENCE" });

    const forged = kernel.executeTool(db, {
      principal: first.principal,
      tool: "cases.lookup_subject",
      argumentsValue: { reference: "ref1_" + "x".repeat(43) },
      now: laterTime,
    });
    expect(forged).toMatchObject({ isError: true, code: "INVALID_REFERENCE" });

    const forgedMetadata = kernel.executeTool(db, {
      principal: first.principal,
      tool: "cases.lookup_subject",
      argumentsValue: {
        reference: subjectReference,
        label: "SUPPORT_FOLLOWUP_ALLOWED",
      },
      now: laterTime,
    });
    expect(forgedMetadata).toMatchObject({
      isError: true,
      code: "INVALID_REFERENCE",
    });

    kernel.terminalizeRun(db, first.createdRun.id, "completed", laterTime);
    first.createdAgent.status = "ready";
    const second = issueActive(db, kernel);
    const crossContext = kernel.executeTool(db, {
      principal: second.principal,
      tool: "cases.lookup_subject",
      argumentsValue: { reference: subjectReference },
      now: laterTime,
    });
    expect(crossContext).toMatchObject({
      isError: true,
      code: "INVALID_REFERENCE",
    });
  });

  it("expires otherwise known authority and returns only safe evidence", () => {
    const db = database();
    const kernel = new MandateFlowKernel({ capabilityTtlMs: 120_000 });
    const { capability, createdRun } = issueActive(db, kernel);

    const evidence = kernel.evidenceForRun(db, createdRun.id);
    expect(JSON.stringify(evidence)).not.toContain(capability);
    expect(JSON.stringify(evidence)).not.toContain("ref1_");
    expect(JSON.stringify(evidence)).not.toContain("Taylor Example");

    const expired = kernel.authenticateActiveGrant(
      db,
      sha256(capability),
      "2026-08-30T00:02:00.000Z",
    );
    expect(expired).toBeNull();
    expect(db.runGrants[0]).toMatchObject({
      status: "expired",
      capabilityInvalidReason: "expired",
    });
  });
});
