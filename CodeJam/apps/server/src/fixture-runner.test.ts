import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { DeterministicMandateFlowRunner } from "./fixture-runner.js";
import type { RunnerRequest } from "./types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function makeRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
  return {
    runId: "run-1",
    agentId: "agent-1",
    workspacePath: "/tmp/workspace",
    prompt: "Run the MandateFlow verification workflow",
    threadId: null,
    mandateFlowCapability: "mfr1_test-capability",
    ...overrides,
  };
}

function jsonRpc(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function toolResult(
  tool: string,
  callNumber: number,
  overrides: Record<string, unknown> = {},
): Response {
  const isDenied = tool === "crm.resolve_customer" && [2, 6].includes(callNumber);
  return jsonRpc({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: !isDenied,
          code: isDenied ? "FLOW_DENIED" : undefined,
          message: isDenied ? "Payment-derived references are aggregate-only" : "Allowed",
          receiptId: `receipt-${callNumber}`,
          ruleId: isDenied ? "NO_PAYMENT_REIDENTIFICATION" : undefined,
          reference:
            tool !== "crm.resolve_customer" && tool !== "payments.aggregate_failures"
              ? { reference: `ref-${callNumber}`, kind: "operations-case" }
              : undefined,
          ...overrides,
        }),
      },
    ],
  });
}

describe("DeterministicMandateFlowRunner", () => {
  it("executes the complete proof choreography through MCP without a model credential", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mandateflow-fixture-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "fixture",
      MANDATEFLOW_RUNTIME_MCP_URL: "http://127.0.0.1:3001/mcp",
    });
    const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    let toolCallNumber = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          method: string;
          params: Record<string, unknown>;
        };
        requests.push(body);
        if (body.method === "initialize" || body.method === "tools/list") {
          return jsonRpc(
            body.method === "initialize"
              ? { protocolVersion: "2025-06-18", capabilities: {} }
              : {
                  tools: [
                    { name: "support.list_tickets" },
                    { name: "payments.list_failures" },
                    { name: "cases.lookup_subject" },
                    { name: "crm.resolve_customer" },
                    { name: "payments.aggregate_failures" },
                  ],
                },
          );
        }
        const tool = String(body.params.name);
        toolCallNumber += 1;
        return toolResult(tool, toolCallNumber);
      }),
    );

    const result = await new DeterministicMandateFlowRunner(config).run(
      makeRequest({ codexHomePath: root }),
    );

    expect(result.output).toContain("Payment → Case → CRM: BLOCKED before CRM.");
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "tools/list",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
      "tools/call",
    ]);
    expect(requests.filter((request) => request.method === "tools/call")).toHaveLength(10);
    expect(await readFile(path.join(root, "mandateflow-fixture-state.json"), "utf8")).toContain(
      "paymentCaseReference",
    );
  });

  it("retries from durable opaque state without repeating Payment derivation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mandateflow-fixture-retry-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig({
      NODE_ENV: "test",
      RUNTIME_PROVIDER: "fixture",
      MANDATEFLOW_RUNTIME_MCP_URL: "http://127.0.0.1:3001/mcp",
    });
    await writeFile(
      path.join(root, "mandateflow-fixture-state.json"),
      JSON.stringify({ paymentCaseReference: "ref-payment-case" }),
      "utf8",
    );
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { method: string };
        calls += 1;
        if (body.method === "initialize") return jsonRpc({});
        return toolResult("crm.resolve_customer", 2);
      }),
    );
    await expect(
      new DeterministicMandateFlowRunner(config).run(
        makeRequest({
          runId: "run-retry",
          prompt: "Retry only the previously denied protected call",
          codexHomePath: root,
        }),
      ),
    ).resolves.toMatchObject({ output: expect.stringContaining("fixture retry complete") });
    expect(calls).toBe(2);
  });
});
