import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService } from "./agent-service.js";
import { loadConfig } from "./config.js";
import type { MandateFlowControl } from "./mandateflow-client.js";
import { JsonStore } from "./store.js";
import type {
  AgentRunner,
  MandateEvidence,
  MandatePrepareRequest,
  MandatePrepareResult,
  RunnerRequest,
  RunnerResult,
} from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
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
): Promise<AgentService> {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...(mandateFlow
      ? {
          MANDATEFLOW_ENABLED: "true",
          MANDATEFLOW_CONTROL_TOKEN:
            "mfc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          APP_AUTH_TOKEN: "a-secure-local-test-token",
        }
      : {}),
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
    const messages = service.getMessages(agent.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.content).toContain("write hello world");
    expect(service.getAgent(agent.id).codexThreadId).toBe("fake-thread");
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
    return {
      runGrantId: "grant-" + this.prepared.length,
      policyContextId: request.mode === "NEW" ? "ctx-1" : (request.policyContextId ?? "ctx-1"),
      grantFingerprint: "grant:12345678",
      capabilityFingerprint: "cap:12345678",
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
});
