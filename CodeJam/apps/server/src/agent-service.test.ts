import { access, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { AgentService, RETRY_PROMPT } from "./agent-service.js";
import { loadConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import {
  fingerprint,
  generateCapabilityToken,
  sha256,
} from "./mandateflow/crypto.js";
import { MandateFlowKernel, PLATFORM_PERMISSION_CEILING } from "./mandateflow/kernel.js";
import { MandateFlowReadiness } from "./mandateflow/mcp-server.js";
import { JsonStore } from "./store.js";
import type { AgentRun, AgentRunner, RunnerRequest, RunnerResult } from "./types.js";
import { WorkspaceManager } from "./workspace.js";

class FakeRunner implements AgentRunner {
  async run(request: RunnerRequest): Promise<RunnerResult> {
    return {
      output: "Completed: " + request.prompt,
      threadId: request.threadId ?? "fake-thread",
      usage: { inputTokens: 12, outputTokens: 5 },
      runtimeId: "fake-runtime",
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

async function makeHarness(
  runner: AgentRunner = new FakeRunner(),
  mandateFlowEnabled = false,
) {
  const root = await mkdtemp(path.join(tmpdir(), "launchpad-test-"));
  temporaryDirectories.push(root);
  const config = loadConfig({
    NODE_ENV: "test",
    APP_DATA_DIR: path.join(root, "data"),
    AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
    CODEX_HOME: path.join(root, "codex"),
    ARK_API_KEY: "test-key",
    ARK_MODEL: "ep-test",
    ...(mandateFlowEnabled
      ? {
          MANDATEFLOW_ENABLED: "true",
          MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:3001",
          APP_AUTH_TOKEN: "a".repeat(43),
          CODEX_TIMEOUT_MS: "10000",
          MANDATEFLOW_CAPABILITY_TTL_MS: "600000",
        }
      : {}),
  });
  const readiness = new MandateFlowReadiness();
  const store = new JsonStore(path.join(root, "data", "db.json"), {
    onPersistenceFailure: (error) => readiness.fail(error),
  });
  const workspaces = new WorkspaceManager(path.join(root, "workspaces"));
  const kernel = mandateFlowEnabled
    ? new MandateFlowKernel({
        capabilityTtlMs: config.mandateFlowCapabilityTtlMs,
      })
    : null;
  const service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    kernel,
    readiness,
  );
  await service.initialize();
  return { config, kernel, readiness, root, runner, service, store, workspaces };
}

async function makeService(runner: AgentRunner = new FakeRunner()): Promise<AgentService> {
  return (await makeHarness(runner)).service;
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

    finish({ output: "done", threadId: "thread", usage: null, runtimeId: "fake" });
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

    finish({ output: "done", threadId: "thread", usage: null, runtimeId: "fake" });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
  });

  it("invalidates and cancels the exact Run before ignoring a late success", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const cancelledIds: string[] = [];
    const service = await makeService({
      run: () => pending,
      cancel: async (runId) => {
        cancelledIds.push(runId);
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Cancelable" });
    const { run } = await service.sendMessage(agent.id, "long task");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");

    const stopping = service.stopAgent(agent.id);
    await expect.poll(() => cancelledIds).toEqual([run.id]);
    expect(service.getAgent(agent.id).status).toBe("busy");
    finish({
      output: "must not persist",
      threadId: "late-thread",
      usage: null,
      runtimeId: "late-runtime",
    });
    await stopping;

    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      output: null,
      runtimeFingerprint: null,
    });
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
    ]);
    expect(service.getAgent(agent.id).status).toBe("stopped");
  });

  it("atomically issues secure authority and keeps the raw capability ephemeral", async () => {
    const requests: RunnerRequest[] = [];
    const runner: AgentRunner = {
      run: async (request) => {
        requests.push(request);
        return {
          output: `completed with ${request.mandateFlowCapability}`,
          threadId: "secure-thread",
          usage: null,
          runtimeId: "runtime-secure-1",
        };
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { service, store } = await makeHarness(runner, true);
    const agent = await service.createAgent({ name: "Secure" });
    await store.mutate((database) => {
      database.agents[0]!.codexThreadId = "unbound-legacy-thread";
    });

    const { run } = await service.sendMessage(agent.id, "secure task");
    expect(run).toMatchObject({
      policyContextId: expect.any(String),
      runGrantId: expect.any(String),
      capabilityFingerprint: expect.any(String),
    });
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    const request = requests[0]!;
    expect(request.threadId).toBeNull();
    expect(request.mandateFlowCapability).toMatch(
      /^mfr1_[A-Za-z0-9_-]{43}$/,
    );
    const snapshot = store.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain(
      request.mandateFlowCapability!,
    );
    expect(snapshot.runGrants[0]).toMatchObject({ status: "completed" });
    expect(snapshot.policyContexts[0]?.codexThreadIdSha256).toBe(
      sha256("secure-thread"),
    );
    expect(service.getRun(run.id)).toMatchObject({
      output: "completed with [REDACTED_CAPABILITY]",
      runtimeFingerprint: fingerprint("runtime", "runtime-secure-1"),
    });
  });

  it("does not start a Runtime when secure issuance persistence fails", async () => {
    let runnerCalls = 0;
    const { readiness, service, store } = await makeHarness(
      {
        run: async () => {
          runnerCalls += 1;
          throw new Error("must not start");
        },
        cancel: async () => false,
        isAvailable: async () => true,
      },
      true,
    );
    const agent = await service.createAgent({ name: "Fail closed" });
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    mutableStore.persist = async () => {
      const error = new Error("simulated rename failure");
      readiness.fail(error);
      throw error;
    };

    await expect(service.sendMessage(agent.id, "must not run")).rejects.toThrow(
      /rename failure/,
    );
    expect(runnerCalls).toBe(0);
    expect(readiness.isReady()).toBe(false);
    expect(store.snapshot()).toMatchObject({ messages: [], runs: [] });
  });

  it("recovers active secure authority as restart-interrupted before serving", async () => {
    const { config, kernel, readiness, service, store, workspaces } =
      await makeHarness(new FakeRunner(), true);
    if (!kernel) throw new Error("expected secure kernel");
    const agent = await service.createAgent({ name: "Recovery" });
    const capability = generateCapabilityToken();
    const timestamp = new Date().toISOString();
    const run: AgentRun = {
      id: crypto.randomUUID(),
      agentId: agent.id,
      status: "queued",
      prompt: "interrupted",
      output: null,
      error: null,
      usage: null,
      startedAt: null,
      completedAt: null,
      policyContextId: null,
      runGrantId: null,
      retryOfRunId: null,
      capabilityFingerprint: null,
      runtimeFingerprint: null,
      createdAt: timestamp,
    };
    await store.mutate((database) => {
      database.runs.push(run);
      kernel.issueRun(database, {
        agentId: agent.id,
        runId: run.id,
        capability,
        requestedPermissions: PLATFORM_PERMISSION_CEILING,
        retryOfRunId: null,
        policyContextId: null,
        now: timestamp,
      });
      kernel.activateRun(database, run.id, timestamp);
    });

    const recovered = new AgentService(
      config,
      store,
      workspaces,
      new FakeRunner(),
      kernel,
      readiness,
    );
    await recovered.initialize();

    expect(store.snapshot().runGrants[0]).toMatchObject({
      status: "restart_interrupted",
      capabilityInvalidReason: "restart_interrupted",
    });
    expect(recovered.getRun(run.id).status).toBe("cancelled");
    expect(recovered.getAgent(agent.id).status).toBe("ready");
    expect(
      kernel.authenticateActiveGrant(
        store.snapshot(),
        sha256(capability),
        new Date().toISOString(),
      ),
    ).toBeNull();
  });

  it("creates one narrow same-context Retry with a new capability and Runtime", async () => {
    const requests: RunnerRequest[] = [];
    let finishFirst!: (result: RunnerResult) => void;
    const firstExecution = new Promise<RunnerResult>((resolve) => {
      finishFirst = resolve;
    });
    const runner: AgentRunner = {
      run: (request) => {
        requests.push(request);
        return requests.length === 1
          ? firstExecution
          : Promise.resolve({
              output: "done",
              threadId: "retry-thread",
              usage: null,
              runtimeId: `runtime-${requests.length}`,
            });
      },
      cancel: async () => false,
      isAvailable: async () => true,
    };
    const { kernel, service, store } = await makeHarness(runner, true);
    if (!kernel) throw new Error("expected secure kernel");
    const agent = await service.createAgent({ name: "Retry" });
    const first = await service.sendMessage(agent.id, "hero task");
    await expect.poll(() => requests).toHaveLength(1);
    await store.mutate((database) => {
      const principal = kernel.authenticateActiveGrant(
        database,
        sha256(requests[0]!.mandateFlowCapability!),
        new Date().toISOString(),
      );
      if (!principal) throw new Error("expected active first-run authority");
      const payment = kernel.executeTool(database, {
        principal,
        tool: "payments.list_failures",
        argumentsValue: {},
        now: new Date().toISOString(),
      });
      if (payment.isError) throw new Error(payment.message);
      const subject = (payment.data.subject as { reference: string }).reference;
      const paymentCase = kernel.executeTool(database, {
        principal,
        tool: "cases.lookup_subject",
        argumentsValue: { reference: subject },
        now: new Date().toISOString(),
      });
      if (paymentCase.isError) throw new Error(paymentCase.message);
      const caseReference = (
        paymentCase.data.case as { reference: string }
      ).reference;
      const denied = kernel.executeTool(database, {
        principal,
        tool: "crm.resolve_customer",
        argumentsValue: { reference: caseReference },
        now: new Date().toISOString(),
      });
      if (!denied.isError || denied.code !== "FLOW_DENIED") {
        throw new Error("expected Payment-flow denial");
      }
    });
    finishFirst({
      output: "done",
      threadId: "retry-thread",
      usage: null,
      runtimeId: "runtime-1",
    });
    await expect.poll(() => service.getRun(first.run.id).status).toBe("completed");
    const retried = await service.retryRun(first.run.id);
    expect(retried.message.content).toBe(RETRY_PROMPT);
    await expect.poll(() => service.getRun(retried.run.id).status).toBe("completed");

    const snapshot = store.snapshot();
    const firstRun = snapshot.runs.find((run) => run.id === first.run.id)!;
    const retryRun = snapshot.runs.find((run) => run.id === retried.run.id)!;
    const retryGrant = snapshot.runGrants.find(
      (grant) => grant.id === retryRun.runGrantId,
    )!;
    expect(retryRun).toMatchObject({
      retryOfRunId: firstRun.id,
      policyContextId: firstRun.policyContextId,
      runtimeFingerprint: fingerprint("runtime", "runtime-2"),
    });
    expect(retryGrant.permissions).toEqual([
      PLATFORM_PERMISSION_CEILING[3],
      PLATFORM_PERMISSION_CEILING[4],
    ]);
    expect(requests[1]).toMatchObject({
      threadId: "retry-thread",
      prompt: RETRY_PROMPT,
    });
    expect(requests[1]!.mandateFlowCapability).not.toBe(
      requests[0]!.mandateFlowCapability,
    );
    expect(
      kernel.authenticateActiveGrant(
        snapshot,
        sha256(requests[0]!.mandateFlowCapability!),
        new Date().toISOString(),
      ),
    ).toBeNull();
    await expect(service.retryRun(first.run.id)).rejects.toThrow(/successor/i);
  });

  it("cascades secure state when an Agent is deleted", async () => {
    const { service, store } = await makeHarness(new FakeRunner(), true);
    const agent = await service.createAgent({ name: "Disposable" });
    const { run } = await service.sendMessage(agent.id, "secure task");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");

    await service.deleteAgent(agent.id);

    const snapshot = store.snapshot();
    expect(snapshot).toMatchObject({
      agents: [],
      messages: [],
      runs: [],
      policyContexts: [],
      runGrants: [],
      protectedReferences: [],
      policyReceipts: [],
      fixtureCounters: [],
    });
  });

  it("restores the archived workspace when deletion persistence fails", async () => {
    const { readiness, service, store } = await makeHarness(new FakeRunner(), true);
    const agent = await service.createAgent({ name: "Recoverable delete" });
    const { run } = await service.sendMessage(agent.id, "secure task");
    await expect.poll(() => service.getRun(run.id).status).toBe("completed");
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    const originalPersist = mutableStore.persist.bind(store);
    let failOnce = true;
    mutableStore.persist = async (database) => {
      if (failOnce) {
        failOnce = false;
        const error = new Error("delete cascade persistence failed");
        readiness.fail(error);
        throw error;
      }
      await originalPersist(database);
    };

    await expect(service.deleteAgent(agent.id)).rejects.toThrow(
      /cascade persistence failed/,
    );
    await expect(access(agent.workspacePath)).resolves.toBeUndefined();
    expect(service.getAgent(agent.id).id).toBe(agent.id);

    await service.deleteAgent(agent.id);
    expect(service.listAgents()).toEqual([]);
  });

  it("waits for an in-flight issuance before shutdown cancels its exact Run", async () => {
    let rejectRun: ((error: Error) => void) | null = null;
    const cancelledIds: string[] = [];
    const { service, store } = await makeHarness({
      run: () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      cancel: async (runId) => {
        cancelledIds.push(runId);
        rejectRun?.(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Shutdown race" });
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    const originalPersist = mutableStore.persist.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistenceEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let blockOnce = true;
    mutableStore.persist = async (database) => {
      if (blockOnce) {
        blockOnce = false;
        entered();
        await gate;
      }
      await originalPersist(database);
    };

    const sending = service.sendMessage(agent.id, "accepted before shutdown");
    await persistenceEntered;
    let shutdownSettled = false;
    const shuttingDown = service.shutdown().then(() => {
      shutdownSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(shutdownSettled).toBe(false);
    release();
    const accepted = await sending;
    await shuttingDown;

    expect(cancelledIds).toEqual([accepted.run.id]);
    expect(service.getRun(accepted.run.id).status).toBe("cancelled");
    await expect(service.sendMessage(agent.id, "too late")).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("waits for an in-flight issuance before stopping the Agent", async () => {
    let rejectRun: ((error: Error) => void) | null = null;
    const cancelledIds: string[] = [];
    const { service, store } = await makeHarness({
      run: () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      cancel: async (runId) => {
        cancelledIds.push(runId);
        rejectRun?.(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Stop race" });
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    const originalPersist = mutableStore.persist.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistenceEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let blockOnce = true;
    mutableStore.persist = async (database) => {
      if (blockOnce) {
        blockOnce = false;
        entered();
        await gate;
      }
      await originalPersist(database);
    };

    const sending = service.sendMessage(agent.id, "accepted before stop");
    await persistenceEntered;
    const stopping = service.stopAgent(agent.id);
    release();
    const accepted = await sending;
    await stopping;

    expect(cancelledIds).toEqual([accepted.run.id]);
    expect(service.getRun(accepted.run.id).status).toBe("cancelled");
    expect(service.getAgent(agent.id).status).toBe("stopped");
  });

  it("waits for an in-flight issuance before deleting the Agent", async () => {
    let rejectRun: ((error: Error) => void) | null = null;
    const cancelledIds: string[] = [];
    const { service, store } = await makeHarness({
      run: () =>
        new Promise<RunnerResult>((_resolve, reject) => {
          rejectRun = reject;
        }),
      cancel: async (runId) => {
        cancelledIds.push(runId);
        rejectRun?.(new RunCancelledError());
        return true;
      },
      isAvailable: async () => true,
    });
    const agent = await service.createAgent({ name: "Delete race" });
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    const originalPersist = mutableStore.persist.bind(store);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const persistenceEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let blockOnce = true;
    mutableStore.persist = async (database) => {
      if (blockOnce) {
        blockOnce = false;
        entered();
        await gate;
      }
      await originalPersist(database);
    };

    const sending = service.sendMessage(agent.id, "accepted before delete");
    await persistenceEntered;
    const deleting = service.deleteAgent(agent.id);
    release();
    const accepted = await sending;
    await deleting;

    expect(cancelledIds).toEqual([accepted.run.id]);
    expect(service.listAgents()).toEqual([]);
    expect(store.snapshot()).toMatchObject({
      agents: [],
      messages: [],
      runs: [],
      policyContexts: [],
      runGrants: [],
      protectedReferences: [],
      policyReceipts: [],
      fixtureCounters: [],
    });
  });

  it("does not persist late success when cancellation persistence fails", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { readiness, service, store } = await makeHarness(
      {
        run: () => pending,
        cancel: async () => false,
        isAvailable: async () => true,
      },
      true,
    );
    const agent = await service.createAgent({ name: "Failed cancel write" });
    const { run } = await service.sendMessage(agent.id, "long secure task");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    const originalPersist = mutableStore.persist.bind(store);
    let failOnce = true;
    mutableStore.persist = async (database) => {
      if (failOnce) {
        failOnce = false;
        const error = new Error("cancel transition persistence failed");
        readiness.fail(error);
        throw error;
      }
      await originalPersist(database);
    };

    const stopping = service.stopAgent(agent.id);
    await new Promise<void>((resolve) => setImmediate(resolve));
    finish({
      output: "must not persist",
      threadId: "late-thread",
      usage: null,
      runtimeId: "late-runtime",
    });
    await expect(stopping).rejects.toThrow(/persistence failed/);

    expect(service.getRun(run.id)).toMatchObject({
      status: "cancelled",
      output: null,
      runtimeFingerprint: null,
    });
    expect(service.getMessages(agent.id).map((message) => message.role)).toEqual([
      "user",
    ]);
  });

  it("makes the Agent ready when terminal authority wins just before Runner settlement", async () => {
    let finish!: (result: RunnerResult) => void;
    const pending = new Promise<RunnerResult>((resolve) => {
      finish = resolve;
    });
    const { kernel, service, store } = await makeHarness(
      {
        run: () => pending,
        cancel: async () => false,
        isAvailable: async () => true,
      },
      true,
    );
    if (!kernel) throw new Error("expected secure kernel");
    const agent = await service.createAgent({ name: "Expiry race" });
    const { run } = await service.sendMessage(agent.id, "long secure task");
    await expect.poll(() => service.getRun(run.id).status).toBe("running");
    await store.mutate((database) => {
      kernel.terminalizeRun(
        database,
        run.id,
        "expired",
        new Date().toISOString(),
      );
    });

    finish({
      output: "must not persist",
      threadId: "late-thread",
      usage: null,
      runtimeId: "late-runtime",
    });
    await expect.poll(() => service.getAgent(agent.id).status).toBe("ready");

    expect(await service.cancelRun(run.id)).toBe(false);
    expect(service.getRun(run.id)).toMatchObject({
      status: "failed",
      output: null,
      runtimeFingerprint: null,
    });
  });
});
