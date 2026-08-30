import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import type { AgentService } from "./agent-service.js";

const service = {
  listAgents: () => [],
  systemInfo: async () => ({}),
} as unknown as AgentService;

describe("HTTP boundary", () => {
  it("protects API routes with the configured shared token", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "a-strong-test-token" }),
      service,
    );
    const denied = await app.inject({ method: "GET", url: "/api/agents" });
    expect(denied.statusCode).toBe(401);

    const encodedDenied = await app.inject({
      method: "GET",
      url: "/%61pi/agents",
    });
    expect(encodedDenied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "GET",
      url: "/api/agents",
      headers: { authorization: "Bearer a-strong-test-token" },
    });
    expect(allowed.statusCode).toBe(200);
    await app.close();
  });

  it("preserves Fastify client error status codes", async () => {
    const app = await createApp(loadConfig({ NODE_ENV: "test" }), service);
    const malformed = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: "{not-json",
    });
    expect(malformed.statusCode).toBe(400);

    const oversized = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ name: "x".repeat(1_100_000) }),
    });
    expect(oversized.statusCode).toBe(413);
    await app.close();
  });

  it("keeps production SPA fallback disjoint from MCP-shaped routes", async () => {
    const app = await createApp(
      loadConfig({ NODE_ENV: "production", HOST: "127.0.0.1" }),
      service,
    );

    for (const request of [
      {
        method: "POST" as const,
        url: "/mcp",
        headers: { accept: "text/html" },
      },
      {
        method: "GET" as const,
        url: "/mcp",
        headers: { accept: "text/html" },
      },
      {
        method: "GET" as const,
        url: "/%6dcp",
        headers: { accept: "text/html" },
      },
      {
        method: "GET" as const,
        url: "/healthz",
        headers: { accept: "text/html" },
      },
    ]) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Route not found" });
    }

    const browserNavigation = await app.inject({
      method: "GET",
      url: "/agents/demo",
      headers: { accept: "text/html" },
    });
    expect(browserNavigation.statusCode).toBe(200);
    expect(browserNavigation.headers["content-type"]).toContain("text/html");
    await app.close();
  });

  it("exposes authenticated safe evidence and bodyless Retry routes", async () => {
    const calls: string[] = [];
    const runId = "11111111-1111-4111-8111-111111111111";
    const routeService = {
      mandateFlowEvidence: (id: string) => {
        calls.push(`evidence:${id}`);
        return { runId: id, receipts: [] };
      },
      retryRun: async (id: string) => {
        calls.push(`retry:${id}`);
        return { run: { id: "retry" }, message: { id: "message" } };
      },
    } as unknown as AgentService;
    const app = await createApp(
      loadConfig({ NODE_ENV: "test", APP_AUTH_TOKEN: "control-token" }),
      routeService,
    );
    const authorization = { authorization: "Bearer control-token" };

    const evidence = await app.inject({
      method: "GET",
      url: `/api/runs/${runId}/mandateflow`,
      headers: authorization,
    });
    const retry = await app.inject({
      method: "POST",
      url: `/api/runs/${runId}/retry`,
      headers: authorization,
    });

    expect(evidence.statusCode).toBe(200);
    expect(evidence.json()).toMatchObject({ evidence: { runId } });
    expect(retry.statusCode).toBe(202);
    expect(calls).toEqual([`evidence:${runId}`, `retry:${runId}`]);
    await app.close();
  });
});
