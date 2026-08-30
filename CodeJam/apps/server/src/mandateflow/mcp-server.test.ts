import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config.js";
import { JsonStore } from "../store.js";
import type { Agent, AgentRun } from "../types.js";
import { generateCapabilityToken } from "./crypto.js";
import { MandateFlowKernel, PLATFORM_PERMISSION_CEILING } from "./kernel.js";
import {
  MandateFlowReadiness,
  createMandateFlowMcpApp,
} from "./mcp-server.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function makeAgent(id: string, now: string): Agent {
  return {
    id,
    name: "Gateway test",
    description: "",
    instructions: "",
    status: "ready",
    workspacePath: "/tmp/gateway-test",
    codexThreadId: null,
    activePolicyContextId: null,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeRun(id: string, agentId: string, now: string): AgentRun {
  return {
    id,
    agentId,
    status: "queued",
    prompt: "test protected boundary",
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
    createdAt: now,
  };
}

async function setup(
  onFatalRun: (runId: string) => void = () => undefined,
  clock?: () => string,
) {
  const root = await mkdtemp(path.join(tmpdir(), "mandateflow-mcp-test-"));
  temporaryDirectories.push(root);
  const readiness = new MandateFlowReadiness();
  const store = new JsonStore(path.join(root, "db.json"), {
    onPersistenceFailure: (error) => readiness.fail(error),
  });
  await store.initialize();
  const config = loadConfig({
    NODE_ENV: "test",
    MANDATEFLOW_ENABLED: "true",
    MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:3001",
    APP_AUTH_TOKEN: "a".repeat(43),
    CODEX_TIMEOUT_MS: "10000",
    MANDATEFLOW_CAPABILITY_TTL_MS: "600000",
  });
  const kernel = new MandateFlowKernel({
    capabilityTtlMs: config.mandateFlowCapabilityTtlMs,
  });
  const capability = generateCapabilityToken();
  const agentId = randomUUID();
  const runId = randomUUID();
  const now = new Date().toISOString();
  await store.mutate((database) => {
    database.agents.push(makeAgent(agentId, now));
    database.runs.push(makeRun(runId, agentId, now));
    kernel.issueRun(database, {
      agentId,
      runId,
      capability,
      requestedPermissions: PLATFORM_PERMISSION_CEILING,
      retryOfRunId: null,
      policyContextId: null,
      now,
    });
    kernel.activateRun(database, runId, now);
  });
  const app = await createMandateFlowMcpApp(
    config,
    store,
    kernel,
    readiness,
    onFatalRun,
    clock,
  );
  return { app, capability, kernel, readiness, root, runId, store };
}

function headers(capability?: string) {
  return {
    host: "host.docker.internal:3001",
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...(capability ? { authorization: `Bearer ${capability}` } : {}),
  };
}

function rpc(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: randomUUID(),
    method,
    ...(params ? { params } : {}),
  };
}

function toolPayload(responseBody: string): Record<string, unknown> {
  const parsed = responseEnvelope(responseBody) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(parsed.result.content[0]!.text) as Record<string, unknown>;
}

function responseEnvelope(responseBody: string): Record<string, unknown> {
  if (responseBody.startsWith("event:")) {
    const data = responseBody
      .split(/\r?\n/)
      .find((line) => line.startsWith("data: "))
      ?.slice(6);
    if (!data) throw new Error("MCP SSE response did not contain a data event");
    return JSON.parse(data) as Record<string, unknown>;
  }
  return JSON.parse(responseBody) as Record<string, unknown>;
}

describe("MandateFlow MCP boundary", () => {
  it("exposes only generic health and the MCP route", async () => {
    const { app, capability } = await setup();
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ ok: true, service: "mandateflow-mcp" });

    const browserRoute = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: headers(capability),
    });
    expect(browserRoute.statusCode).toBe(404);
    await app.close();
  });

  it("returns the same generic challenge for missing, forged and terminal tokens", async () => {
    const { app, capability, kernel, runId, store } = await setup();
    const payload = rpc("tools/list");
    const missing = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(),
      payload,
    });
    const forged = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers("mfr1_" + "x".repeat(43)),
      payload,
    });
    await store.mutate((database) =>
      kernel.terminalizeRun(database, runId, "completed", new Date().toISOString()),
    );
    const terminal = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload,
    });

    for (const response of [missing, forged, terminal]) {
      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBe(
        'Bearer error="invalid_token"',
      );
      expect(response.body).toBe('{"error":"invalid_token"}');
    }
    expect(store.snapshot().policyReceipts).toEqual([]);
    await app.close();
  });

  it("persists expiry before returning the generic invalid-token response", async () => {
    const cancelledRuns: string[] = [];
    const { app, capability, runId, store } = await setup((expiredRunId) => {
      cancelledRuns.push(expiredRunId);
    });
    await store.mutate((database) => {
      database.runGrants[0]!.expiresAt = "2020-01-01T00:00:00.000Z";
    });

    const expired = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/list"),
    });

    expect(expired.statusCode).toBe(401);
    expect(expired.body).toBe('{"error":"invalid_token"}');
    expect(store.snapshot().runGrants[0]).toMatchObject({
      status: "expired",
      capabilityInvalidReason: "expired",
    });
    expect(cancelledRuns).toEqual([runId]);
    await app.close();
  });

  it("rejects duplicate Authorization fields even when both bearers are valid", async () => {
    const { app, capability } = await setup();
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        ...headers(),
        authorization: [`Bearer ${capability}`, `Bearer ${capability}`],
      },
      payload: rpc("tools/list"),
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).toBe('{"error":"invalid_token"}');
    await app.close();
  });

  it("enforces exact Host and present-Origin allowlists", async () => {
    const { app, capability } = await setup();
    const badHost = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers(capability), host: "host.docker.internal:9999" },
      payload: rpc("tools/list"),
    });
    const badOrigin = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers(capability), origin: "https://evil.example" },
      payload: rpc("tools/list"),
    });

    expect(badHost.statusCode).toBe(403);
    expect(badOrigin.statusCode).toBe(403);
    await app.close();
  });

  it("cannot bypass authentication or readiness with an encoded MCP path", async () => {
    const { app, capability, readiness } = await setup();
    const encodedWithoutBearer = await app.inject({
      method: "POST",
      url: "/%6dcp",
      headers: headers(),
      payload: rpc("tools/list"),
    });
    expect(encodedWithoutBearer.statusCode).toBe(401);

    readiness.fail(new Error("simulated failure"));
    const encodedWhileUnready = await app.inject({
      method: "POST",
      url: "/%6dcp",
      headers: headers(capability),
      payload: rpc("tools/list"),
    });
    expect(encodedWhileUnready.statusCode).toBe(503);
    await app.close();
  });

  it("negotiates the pinned SDK's current stateless protocol version", async () => {
    const { app, capability } = await setup();
    const initialized = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("initialize", {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "mandateflow-test", version: "1.0.0" },
      }),
    });

    expect(initialized.statusCode).toBe(200);
    expect(responseEnvelope(initialized.body)).toMatchObject({
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "launchpad_gateway", version: "1.0.0" },
      },
    });
    await app.close();
  });

  it("lists exactly five tools and dispatches an authenticated protected call", async () => {
    const { app, capability, store } = await setup();
    const listed = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/list"),
    });
    expect(listed.statusCode).toBe(200);
    const listResult = responseEnvelope(listed.body) as unknown as {
      result: { tools: Array<{ name: string }> };
    };
    expect(listResult.result.tools.map((tool) => tool.name).sort()).toEqual(
      [
        "support.list_tickets",
        "payments.list_failures",
        "cases.lookup_subject",
        "crm.resolve_customer",
        "payments.aggregate_failures",
      ].sort(),
    );

    const called = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/call", {
        name: "support.list_tickets",
        arguments: {},
      }),
    });
    expect(called.statusCode).toBe(200);
    const output = toolPayload(called.body);
    expect(output.subject).toMatchObject({ kind: "customer-subject" });
    expect((output.subject as { reference: string }).reference).toMatch(/^ref1_/);
    expect(store.snapshot().policyReceipts).toHaveLength(1);
    await app.close();
  });

  it("proves the full allow, deny-before-invocation and aggregate recovery paths", async () => {
    const { app, capability, store } = await setup();
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const response = await app.inject({
        method: "POST",
        url: "/mcp",
        headers: headers(capability),
        payload: rpc("tools/call", { name, arguments: args }),
      });
      expect(response.statusCode).toBe(200);
      return toolPayload(response.body);
    };

    const support = await call("support.list_tickets");
    const supportCase = await call("cases.lookup_subject", {
      reference: (support.subject as { reference: string }).reference,
    });
    const supportCrm = await call("crm.resolve_customer", {
      reference: (supportCase.case as { reference: string }).reference,
    });
    expect(supportCrm).toMatchObject({
      displayName: "Taylor Example",
      contactStatus: "follow-up-allowed",
    });

    const payment = await call("payments.list_failures");
    const paymentCase = await call("cases.lookup_subject", {
      reference: (payment.subject as { reference: string }).reference,
    });
    const denied = await call("crm.resolve_customer", {
      reference: (paymentCase.case as { reference: string }).reference,
    });
    expect(denied).toMatchObject({
      code: "FLOW_DENIED",
      safeAlternative: "payments.aggregate_failures",
    });
    expect(store.snapshot().policyReceipts.at(-1)).toMatchObject({
      decision: "DENY",
      outcome: "NOT_INVOKED",
      downstreamInvoked: false,
      counterBefore: 1,
      counterAfter: 1,
    });

    const aggregate = await call("payments.aggregate_failures");
    expect(aggregate).toMatchObject({ failedPayments: 3, currency: "USD" });
    expect(store.snapshot().fixtureCounters[0]?.count).toBe(1);
    await app.close();
  });

  it("rejects protected calls with 503 after readiness fails", async () => {
    const { app, capability, readiness } = await setup();
    readiness.fail(new Error("simulated durable-state failure"));

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/list"),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ error: "gateway_unavailable" });
    await app.close();
  });

  it("does not execute a queued protected call after an earlier persistence failure", async () => {
    const cancelledRuns: string[] = [];
    const { app, capability, readiness, runId, store } = await setup(
      (fatalRunId) => {
        cancelledRuns.push(fatalRunId);
      },
    );
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    const originalPersist = mutableStore.persist.bind(store);
    let releaseFailure!: () => void;
    let persistenceEntered!: () => void;
    const failureGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      persistenceEntered = resolve;
    });
    let failOnce = true;
    mutableStore.persist = async (database) => {
      if (failOnce) {
        failOnce = false;
        persistenceEntered();
        await failureGate;
        const error = new Error("simulated rename failure");
        readiness.fail(error);
        throw error;
      }
      await originalPersist(database);
    };

    const first = app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/call", {
        name: "support.list_tickets",
        arguments: {},
      }),
    });
    await entered;
    const second = app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/call", {
        name: "support.list_tickets",
        arguments: {},
      }),
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseFailure();

    for (const response of await Promise.all([first, second])) {
      if (response.statusCode === 200) {
        expect(toolPayload(response.body)).toMatchObject({
          code: "GATEWAY_UNAVAILABLE",
        });
      } else {
        expect(response.statusCode).toBe(503);
      }
      expect(response.body).not.toContain("ref1_");
    }
    expect(store.snapshot().protectedReferences).toEqual([]);
    expect(store.snapshot().policyReceipts).toEqual([]);
    expect(cancelledRuns).toEqual([runId, runId]);
    await app.close();
  });

  it("cancels the exact Run when inner expiry persistence fails", async () => {
    const beforeExpiry = "2026-08-30T00:00:00.000Z";
    const afterExpiry = "2026-08-30T00:00:02.000Z";
    let clockCalls = 0;
    const cancelledRuns: string[] = [];
    const { app, capability, readiness, runId, store } = await setup(
      (fatalRunId) => {
        cancelledRuns.push(fatalRunId);
      },
      () => (clockCalls++ === 0 ? beforeExpiry : afterExpiry),
    );
    await store.mutate((database) => {
      database.runGrants[0]!.expiresAt = "2026-08-30T00:00:01.000Z";
      database.policyContexts[0]!.expiresAt = "2026-08-30T00:10:00.000Z";
      database.policyContexts[0]!.mandate.expiresAt =
        "2026-08-30T00:10:00.000Z";
    });
    const mutableStore = store as unknown as {
      persist(database: ReturnType<JsonStore["snapshot"]>): Promise<void>;
    };
    mutableStore.persist = async () => {
      throw new Error("simulated expiry rename failure");
    };

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: headers(capability),
      payload: rpc("tools/call", {
        name: "support.list_tickets",
        arguments: {},
      }),
    });

    expect(response.statusCode).toBe(200);
    expect(toolPayload(response.body)).toMatchObject({
      code: "GATEWAY_UNAVAILABLE",
    });
    expect(readiness.isReady()).toBe(false);
    expect(cancelledRuns).toEqual([runId]);
    expect(store.snapshot().runGrants[0]?.status).toBe("active");
    expect(store.snapshot().policyReceipts).toEqual([]);
    await app.close();
  });
});
