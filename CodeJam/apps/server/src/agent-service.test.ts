import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import type { MandateFlowControl } from "./mandateflow-client.js";
import { JsonStore } from "./store.js";
import type {
  AgentRunner,
  MandateEvidence,
  MandateSummary,
  MandatePrepareRequest,
  MandatePrepareResult,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    request.onProgress?.({
      stage: "tool",
      label: "Running a workspace command",
      detail: "The Agent is running a test command in the selected workspace.",
    });
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
      runtimeInstanceId: "fake-runtime-" + request.runId,
    };
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async isAvailable(): Promise<boolean> {
    return true;
  }
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function makeService(
  runner: AgentRunner = new FakeRunner(),
  mandateFlow: MandateFlowControl | null = null,
  environment: Record<string, string> = {},
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    GROQ_API_KEY: "gsk-test-key",
    GROQ_MODEL: "",
    ...(mandateFlow
      ? {
          MANDATEFLOW_ENABLED: "true",
          MANDATEFLOW_CONTROL_TOKEN:
            "mfc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          APP_AUTH_TOKEN: "a-secure-local-test-token",
        }
      : {}),
    ...environment,
  });
  const service = new AgentService(
    config,
    new JsonStore(path.join(root, "data", "db.json")),
    new WorkspaceManager(path.join(root, "workspaces")),
    runner,
    mandateFlow,
  );
  await service.initialize();
  return service;
}

describe("Agent lifecycle", () => {
  it("creates, updates, stops, starts and deletes an Agent", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Builder" });
    expect(service.listAgents()).toHaveLength(1);
    expect((await service.updateAgent(agent.id, { description: "Builds apps" })).description)
      .toBe("Builds apps");
    expect((await service.stopAgent(agent.id)).status).toBe("stopped");
    expect((await service.startAgent(agent.id)).status).toBe("ready");
    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toHaveLength(0);
  });

  it("persists a playground conversation", async () => {
    const service = await makeService();
    const agent = await service.createAgent({ name: "Coder" });
    const { run } = await service.sendMessage(agent.id, "write hello world");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    expect(service.getRun(run.id).progress.map((event) => event.label)).toContain(
      "Run complete",
    );
    expect(service.getRun(run.id).progress.map((event) => event.label)).toContain(
      "Running a workspace command",
    );
    const activity = service.getRun(run.id).progress;
    expect(activity.every((event) => event.runId === run.id)).toBe(true);
    expect(activity.map((event) => event.sequence)).toEqual(
      activity.map((event) => event.sequence).sort((left, right) => left - right),
    );
    expect(activity.some((event) => event.kind === "command" && event.state === "started")).toBe(true);
    expect(activity.at(-1)).toMatchObject({
      kind: "status",
      state: "completed",
      title: "Run complete",
    });
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
  });

  it("reports Groq system information without exposing the API key", async () => {
    const service = await makeService();
    const system = await service.systemInfo();

    expect(system).toMatchObject({
      groqConfigured: true,
      groqBaseUrl: "https://api.groq.com/openai/v1",
      groqModel: "openai/gpt-oss-120b",
      codexAvailable: true,
    });
    expect(JSON.stringify(system)).not.toContain("gsk-test-key");
    expect(system).not.toHaveProperty("arkConfigured");
  });

  it("runs the credential-free fixture provider without requiring Groq", async () => {
    const service = await makeService(new FakeRunner(), null, {
      RUNTIME_PROVIDER: "fixture",
      GROQ_API_KEY: "",
    });
    const system = await service.systemInfo();
    expect(system).toMatchObject({
      groqConfigured: false,
      runtimeProvider: "fixture",
      runtime: "Deterministic MandateFlow fixture Runtime",
    });

    const agent = await service.createAgent({ name: "Fixture Agent" });
    await expect(service.sendMessage(agent.id, "write a TypeScript CLI")).rejects.toMatchObject({
      statusCode: 409,
    });
    const { run } = await service.sendMessage(
      agent.id,
      "Run the MandateFlow verification workflow.",
    );
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("atomically accepts only one concurrent run per Agent", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const runner: AgentRunner = {
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Concurrent" });
    const attempts = await Promise.allSettled([
      service.sendMessage(agent.id, "first"),
      service.sendMessage(agent.id, "second"),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected).toMatchObject({ reason: { statusCode: 409 } });
    expect(service.getMessages(agent.id)).toHaveLength(1);

    finish({
      output: "done",
      threadId: "thread",
      usage: null,
      runtimeInstanceId: "fake-runtime",
    });
    const accepted = attempts.find((attempt) => attempt.status === "fulfilled");
    if (accepted?.status === "fulfilled") {
      await expect.poll(() => service.getRun(accepted.value.run.id).status).toBe("completed");
    }
  });

  it("does not let start reset a busy Agent and admit a second run", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const service = await makeService({
      run: () => pending,
      cancel: async () => false,
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Busy" });
    const { run } = await service.sendMessage(agent.id, "first");

    await expect(service.startAgent(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.newDemoWorkflow(agent.id)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.sendMessage(agent.id, "second")).rejects.toMatchObject({
      statusCode: 409,
    });

    finish({
      output: "done",
      threadId: "thread",
      usage: null,
      runtimeInstanceId: "fake-runtime",
    });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });
});

class FakeMandateFlow implements MandateFlowControl {
  readonly events: string[] = [];
  readonly prepared: Array<{ runId: string; request: MandatePrepareRequest }> = [];
  failFinish = false;
  hasRetryableDenial = true;
  evidenceRunStatus = "COMPLETED";
  revoked = false;
  private workflowNumber = 0;
  private currentContextId = "ctx-1";
  private currentMandateId = "mnd-1";

  async ready(): Promise<boolean> {
    this.events.push("ready");
    return true;
  }

  async prepare(
    runId: string,
    request: MandatePrepareRequest,
  ): Promise<MandatePrepareResult> {
    this.events.push("prepare:" + request.mode);
    this.prepared.push({ runId, request });
    if (request.mode === "NEW") {
      this.workflowNumber += 1;
      this.currentContextId = "ctx-" + this.workflowNumber;
      this.currentMandateId = "mnd-" + this.workflowNumber;
      this.revoked = false;
    }
    return {
      runGrantId: "grant-" + this.prepared.length,
      policyContextId:
        request.mode === "NEW"
          ? this.currentContextId
          : (request.policyContextId ?? this.currentContextId),
      grantFingerprint: "grant:1234567" + this.prepared.length,
      capabilityFingerprint: "cap:1234567" + this.prepared.length,
      mandateId: this.currentMandateId,
      ownerPrincipal: request.ownerPrincipal,
      agentPrincipal: "agent:" + request.agentId,
      issuedAt: new Date().toISOString(),
      status: "PREPARED",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      grantedPermissions: request.requestedPermissions,
    };
  }

  async activate(runId: string): Promise<void> {
    this.events.push("activate:" + runId);
  }

  async finish(runId: string, status: "COMPLETED" | "FAILED" | "CANCELLED" | "ABANDONED"): Promise<void> {
    this.events.push("finish:" + status + ":" + runId);
    if (this.failFinish) throw new Error("finish unavailable");
  }

  async evidence(runId: string): Promise<MandateEvidence> {
    return {
      runId,
      policyContextId: "ctx-1",
      runGrantId: "grant-1",
      retryOfRunId: null,
      runtimeInstanceId: "runtime-1",
      runStatus: this.evidenceRunStatus,
      purposeId: "MIXED_OPERATIONS_BRIEF",
      policyId: "mixed-operations-flow",
      policyVersion: 1,
      grantFingerprint: "grant:12345678",
      capabilityFingerprint: "cap:12345678",
      crmCounter: 1,
      receipts: this.hasRetryableDenial ? [
        {
          id: "receipt-denied",
          createdAt: new Date().toISOString(),
          runId,
          policyContextId: "ctx-1",
          runGrantId: "grant-1",
          tool: "crm.resolve_customer",
          action: "read",
          resourceKind: "customer-profile",
          decision: "DENY",
          staticScopeDecision: "ALLOW",
          provenanceDecision: "DENY",
          enforcementStage: "PRE_EXECUTION",
          outcome: "NOT_INVOKED",
          downstreamInvoked: false,
          ruleId: "NO_PAYMENT_REIDENTIFICATION",
          reason: "Payment-derived references are aggregate-only",
          causedByReceiptIds: ["receipt-payment", "receipt-case"],
          inputReferenceAliases: ["ref:12345678"],
          redactedInputSummary: "Protected reference ref:12345678",
          redactedResultSummary: "Protected fixture was not invoked",
          counterBefore: 1,
          counterAfter: 1,
          policyId: "mixed-operations-flow",
          policyVersion: 1,
        },
      ] : [],
    };
  }

  async summary(): Promise<MandateSummary> {
    return {
      mandateId: this.currentMandateId,
      status: this.revoked ? "REVOKED" : "ACTIVE",
      ownerPrincipal: "user-a",
      agentPrincipal: "agent:secure",
      policyContextId: this.currentContextId,
      purposeId: "MIXED_OPERATIONS_BRIEF",
      policyId: "mixed-operations-flow",
      policyVersion: 1,
      grantedPermissions: [],
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      mandateFingerprint: "mandate:12345678",
    };
  }

  async revoke(): Promise<{ mandate: MandateSummary; affectedRunIds: string[] }> {
    this.events.push("revoke");
    this.revoked = true;
    return {
      mandate: await this.summary(),
      affectedRunIds: this.prepared.map((item) => item.runId),
    };
  }
}

describe("MandateFlow lifecycle", () => {
  it("prepares, activates, runs and terminalizes authority in order", async () => {
    const events: string[] = [];
    let runnerRequest: RunnerRequest | null = null;
    const runner: AgentRunner = {
      run: async (request) => {
        runnerRequest = request;
        events.push("run:" + request.runId);
        return {
          output: "secure result",
          threadId: "thread-secure",
          usage: null,
          runtimeInstanceId: "runtime-secure",
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const mandateFlow = new FakeMandateFlow();
    const originalPrepare = mandateFlow.prepare.bind(mandateFlow);
    mandateFlow.prepare = async (runId, request) => {
      events.push("prepare");
      return originalPrepare(runId, request);
    };
    const originalActivate = mandateFlow.activate.bind(mandateFlow);
    mandateFlow.activate = async (runId) => {
      events.push("activate");
      return originalActivate(runId);
    };
    const originalFinish = mandateFlow.finish.bind(mandateFlow);
    mandateFlow.finish = async (runId, status) => {
      events.push("finish:" + status);
      return originalFinish(runId, status);
    };

    const service = await makeService(runner, mandateFlow);
    const agent = await service.createAgent({ name: "Secure Agent" });
    const { run } = await service.sendMessage(agent.id, "verify policy");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    expect(events).toEqual(["prepare", "activate", "run:" + run.id, "finish:COMPLETED"]);
    expect(runnerRequest).not.toBeNull();
    const capability = (runnerRequest as RunnerRequest | null)?.mandateFlowCapability ?? "";
    expect(capability).toMatch(/^mfr1_/);
    expect(mandateFlow.prepared[0]?.request.capabilitySha256).not.toContain(capability);
    expect(JSON.stringify(service.getRun(run.id))).not.toContain(capability);
    expect(service.getRun(run.id)).toMatchObject({
      policyContextId: "ctx-1",
      runGrantId: "grant-1",
      mandateStatus: "closed",
      runtimeInstanceId: "runtime-secure",
    });
  });

  it("retries with fresh authority, the same context and no duplicate user message", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          output: requests.length === 1 ? "first result" : "retry denied",
          threadId: "thread-secure",
          usage: null,
          runtimeInstanceId: "runtime-" + requests.length,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const mandateFlow = new FakeMandateFlow();
    const service = await makeService(runner, mandateFlow);
    const agent = await service.createAgent({ name: "Retry Agent" });
    const first = await service.sendMessage(agent.id, "run hero flow");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    expect(service.getMessages(agent.id)).toHaveLength(2);

    const retry = await service.retryRun(first.run.id);
    await expect.poll(() => service.getRun(retry.id).status).toBe("completed");
    expect(service.getMessages(agent.id)).toHaveLength(3);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.threadId).toBe("thread-secure");
    expect(requests[1]?.mandateFlowCapability).not.toBe(
      requests[0]?.mandateFlowCapability,
    );
    expect(mandateFlow.prepared[1]?.request).toMatchObject({
      mode: "RETRY",
      policyContextId: "ctx-1",
      retryOfRunId: first.run.id,
    });
  });

  it("fails closed when a proof response omits required gateway evidence", async () => {
    const mandateFlow = new FakeMandateFlow();
    const service = await makeService(new FakeRunner(), mandateFlow);
    const agent = await service.createAgent({ name: "Incomplete Proof Agent" });
    const { run } = await service.sendMessage(
      agent.id,
      "Run the MandateFlow verification workflow.",
    );

    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id)).toMatchObject({
      output: null,
      error: expect.stringContaining("MandateFlow proof is incomplete"),
    });
    expect(service.getRun(run.id).progress).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Proof evidence incomplete",
          state: "failed",
        }),
      ]),
    );
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
    ]);
    expect(mandateFlow.events.some((event) => event.startsWith("finish:FAILED"))).toBe(true);
  });

  it("rejects Retry when the completed Run has no provenance-denied CRM call", async () => {
    const mandateFlow = new FakeMandateFlow();
    const service = await makeService(new FakeRunner(), mandateFlow);
    const agent = await service.createAgent({ name: "Non-hero Agent" });
    const first = await service.sendMessage(agent.id, "ordinary task");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    mandateFlow.hasRetryableDenial = false;

    await expect(service.retryRun(first.run.id)).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(service.getMessages(agent.id)).toHaveLength(2);
    expect(mandateFlow.prepared).toHaveLength(1);
  });

  it("does not publish a clean completion while capability finalization is unconfirmed", async () => {
    const mandateFlow = new FakeMandateFlow();
    mandateFlow.failFinish = true;
    mandateFlow.evidenceRunStatus = "ACTIVE";
    const service = await makeService(new FakeRunner(), mandateFlow);
    const agent = await service.createAgent({ name: "Fail Closed Agent" });
    const { run } = await service.sendMessage(agent.id, "finish safely");
    await expect.poll(() => service.getRun(run.id).status).toBe("failed");
    expect(service.getRun(run.id)).toMatchObject({
      output: null,
      mandateStatus: "security-finalization-pending",
    });
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
    ]);

    await expect(service.sendMessage(agent.id, "must remain blocked")).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(mandateFlow.prepared).toHaveLength(1);

    mandateFlow.failFinish = false;
    mandateFlow.evidenceRunStatus = "COMPLETED";
    const recovered = await service.sendMessage(agent.id, "continue after reconciliation");
    await expect.poll(() => service.getRun(recovered.run.id).status).toBe("completed");
    expect(service.getRun(run.id).mandateStatus).toBe("closed");
  });

  it("persists revocation before cancelling an active Runtime", async () => {
    const events: string[] = [];
    let rejectRun!: (error: unknown) => void;
    const runner: AgentRunner = {
      run: async () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
          events.push("run");
        }),
      cancel: async () => {
        events.push("cancel");
        rejectRun(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    };
    const mandateFlow = new FakeMandateFlow();
    const originalRevoke = mandateFlow.revoke!.bind(mandateFlow);
    mandateFlow.revoke = async (...args) => {
      const result = await originalRevoke(...args);
      events.push("revoked");
      return result;
    };
    const service = await makeService(runner, mandateFlow);
    const agent = await service.createAgent({ name: "Revoke Agent" });
    const { run } = await service.sendMessage(agent.id, "hold open");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    const revoked = await service.revokeMandate("mnd-1");
    expect(revoked.mandate.status).toBe("REVOKED");
    expect(events.indexOf("revoked")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("cancel")).toBeGreaterThan(events.indexOf("revoked"));
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");
    expect(service.getAgent(agent.id).status).toBe("ready");
  });

  it("keeps a Runtime cancel rejection from breaking the stop flow", async () => {
    let rejectRun!: (error: unknown) => void;
    const runner: AgentRunner = {
      run: async () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      cancel: async () => {
        rejectRun(new RunCancelledError());
        throw new Error("Runtime cancel endpoint failed");
      },
      isAvailable: async () => true,
    };
    const service = await makeService(runner);
    const agent = await service.createAgent({ name: "Cancel Failure Agent" });
    const { run } = await service.sendMessage(agent.id, "hold open");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    await expect(service.stopAgent(agent.id)).resolves.toMatchObject({ status: "stopped" });
    await expect.poll(() => service.getRun(run.id).status).toBe("cancelled");
  });

  it("resets a revoked workflow into fresh authority that can start again", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          output: "secure result",
          threadId: "thread-" + requests.length,
          usage: null,
          runtimeInstanceId: "runtime-" + requests.length,
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const mandateFlow = new FakeMandateFlow();
    const service = await makeService(runner, mandateFlow);
    const agent = await service.createAgent({ name: "Recovery Agent" });

    const first = await service.sendMessage(agent.id, "run the protected proof");
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const firstAuthority = service.getRun(first.run.id);
    expect(firstAuthority.policyContextId).toBe("ctx-1");

    const revoked = await service.revokeMandate("mnd-1");
    expect(revoked.mandate.status).toBe("REVOKED");

    const reset = await service.newDemoWorkflow(agent.id);
    expect(reset.activePolicyContextId).toBeNull();
    expect(reset.codexThreadId).toBeNull();

    const recovered = await service.sendMessage(agent.id, "run the support recovery flow");
    await expect.poll(() => service.getRun(recovered.run.id).status).toBe("completed");
    const recoveredAuthority = service.getRun(recovered.run.id);
    expect(mandateFlow.prepared[1]?.request.mode).toBe("NEW");
    expect(recoveredAuthority.policyContextId).toBe("ctx-2");
    expect(recoveredAuthority.mandateId).toBe("mnd-2");
    expect(recoveredAuthority.runGrantId).not.toBe(firstAuthority.runGrantId);
    expect(recoveredAuthority.capabilityFingerprint).not.toBe(firstAuthority.capabilityFingerprint);
    expect(requests).toHaveLength(2);
  });
});
