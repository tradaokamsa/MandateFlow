import { chmod, readFile, writeFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import type { AgentRunner, RunnerRequest, RunnerResult } from "./types.js";

const FIXTURE_STATE_FILENAME = "mandateflow-fixture-state.json";

interface FixtureToolResult {
  ok: boolean;
  code?: string;
  message: string;
  receiptId: string;
  ruleId?: string;
  reference?: {
    reference: string;
    kind: string;
  };
}

interface JsonRpcResponse {
  result?: unknown;
  error?: {
    message?: string;
  };
}

interface FixtureState {
  paymentCaseReference: string;
}

/**
 * Runs the same proof choreography as the live Codex Runtime without a model
 * or external credentials. Every step still crosses the real MCP gateway.
 */
export class DeterministicMandateFlowRunner implements AgentRunner {
  private readonly paymentCaseReferences = new Map<string, string>();
  private requestNumber = 0;

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async cancel(): Promise<boolean> {
    return false;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (!request.mandateFlowCapability) {
      throw new Error("MandateFlow fixture Runtime requires a Run capability");
    }

    if (request.prompt.toLowerCase().includes("retry only the previously denied")) {
      await this.initializeSession(request.mandateFlowCapability);
      const paymentCaseReference = await this.loadPaymentCaseReference(request);
      const retryDenial = await this.callTool(
        request.mandateFlowCapability,
        "crm.resolve_customer",
        { reference: paymentCaseReference },
      );
      if (
        retryDenial.ok ||
        retryDenial.code !== "FLOW_DENIED" ||
        retryDenial.ruleId !== "NO_PAYMENT_REIDENTIFICATION"
      ) {
        throw new Error("Deterministic retry did not remain provenance-denied");
      }
      return this.result(
        request,
        [
          "MandateFlow fixture retry complete.",
          "Payment → Case → CRM: BLOCKED before CRM.",
          `Policy: ${retryDenial.ruleId}.`,
          "The retry used the prior opaque Case reference with a fresh Run capability.",
        ].join("\n"),
      );
    }

    await this.initializeSession(request.mandateFlowCapability);
    await this.assertFullGrantDiscovery(request.mandateFlowCapability);

    const support = await this.callTool(
      request.mandateFlowCapability,
      "support.list_tickets",
      {},
    );
    const supportReference = requireReference(support, "Support lookup");
    const supportCase = await this.callTool(
      request.mandateFlowCapability,
      "cases.lookup_subject",
      { reference: supportReference },
    );
    const supportCaseReference = requireReference(supportCase, "Support Case transform");
    const supportCRM = await this.callTool(
      request.mandateFlowCapability,
      "crm.resolve_customer",
      { reference: supportCaseReference },
    );
    requireSuccess(supportCRM, "Support CRM recovery");

    const payment = await this.callTool(
      request.mandateFlowCapability,
      "payments.list_failures",
      {},
    );
    const paymentReference = requireReference(payment, "Payment lookup");
    const paymentCase = await this.callTool(
      request.mandateFlowCapability,
      "cases.lookup_subject",
      { reference: paymentReference },
    );
    const paymentCaseReference = requireReference(paymentCase, "Payment Case transform");
    await this.savePaymentCaseReference(request, paymentCaseReference);

    const paymentDenial = await this.callTool(
      request.mandateFlowCapability,
      "crm.resolve_customer",
      { reference: paymentCaseReference },
    );
    if (
      paymentDenial.ok ||
      paymentDenial.code !== "FLOW_DENIED" ||
      paymentDenial.ruleId !== "NO_PAYMENT_REIDENTIFICATION"
    ) {
      throw new Error("Deterministic payment flow did not produce the expected policy denial");
    }

    const aggregate = await this.callTool(
      request.mandateFlowCapability,
      "payments.aggregate_failures",
      {},
    );
    requireSuccess(aggregate, "Payment aggregate recovery");

    const freshSupport = await this.callTool(
      request.mandateFlowCapability,
      "support.list_tickets",
      {},
    );
    const freshSupportReference = requireReference(freshSupport, "Fresh Support lookup");
    const freshSupportCase = await this.callTool(
      request.mandateFlowCapability,
      "cases.lookup_subject",
      { reference: freshSupportReference },
    );
    const freshSupportCaseReference = requireReference(
      freshSupportCase,
      "Fresh Support Case transform",
    );
    const freshSupportCRM = await this.callTool(
      request.mandateFlowCapability,
      "crm.resolve_customer",
      { reference: freshSupportCaseReference },
    );
    requireSuccess(freshSupportCRM, "Fresh Support CRM recovery");

    return this.result(
      request,
      [
        "MandateFlow fixture proof complete.",
        "Support → Case → CRM: ALLOWED.",
        "Payment → Case → CRM: BLOCKED before CRM.",
        "Payment aggregate recovery: ALLOWED.",
        "Fresh Support → Case → CRM recovery: ALLOWED.",
        "All outcomes came from the Go gateway and SQLite-backed receipts.",
      ].join("\n"),
    );
  }

  private async initializeSession(capability: string): Promise<void> {
    await this.mcpRequest(capability, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mandateflow-fixture-runner", version: "1.0.0" },
    });
  }

  private async assertFullGrantDiscovery(capability: string): Promise<void> {
    const result = (await this.mcpRequest(capability, "tools/list", {})) as {
      tools?: Array<{ name?: unknown }>;
    };
    const names = new Set(
      (result.tools ?? [])
        .map((tool) => (typeof tool.name === "string" ? tool.name : ""))
        .filter(Boolean),
    );
    const expected = [
      "support.list_tickets",
      "payments.list_failures",
      "cases.lookup_subject",
      "crm.resolve_customer",
      "payments.aggregate_failures",
    ];
    if (expected.some((name) => !names.has(name))) {
      throw new Error("MandateFlow fixture Runtime did not discover the full granted tool set");
    }
  }

  private async callTool(
    capability: string,
    name: string,
    argumentsValue: Record<string, unknown>,
  ): Promise<FixtureToolResult> {
    const result = (await this.mcpRequest(capability, "tools/call", {
      name,
      arguments: argumentsValue,
    })) as {
      content?: Array<{ type?: unknown; text?: unknown }>;
    };
    const text = result.content?.find(
      (content) => content.type === "text" && typeof content.text === "string",
    )?.text;
    if (typeof text !== "string") {
      throw new Error(`MandateFlow fixture tool ${name} returned no structured result`);
    }
    const parsed = JSON.parse(text) as FixtureToolResult;
    if (typeof parsed.ok !== "boolean" || typeof parsed.message !== "string") {
      throw new Error(`MandateFlow fixture tool ${name} returned an invalid result`);
    }
    return parsed;
  }

  private async mcpRequest(
    capability: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    const response = await fetch(this.config.mandateFlowRuntimeMcpUrl, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        Authorization: "Bearer " + capability,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++this.requestNumber,
        method,
        params,
      }),
      signal: AbortSignal.timeout(Math.min(this.config.codexTimeoutMs, 15_000)),
    });
    const payload = (await response.json().catch(() => ({}))) as JsonRpcResponse;
    if (!response.ok) {
      throw new Error(`MandateFlow fixture MCP request failed with HTTP ${response.status}`);
    }
    if (payload.error) {
      throw new Error(payload.error.message ?? "MandateFlow fixture MCP request failed");
    }
    if (payload.result === undefined) {
      throw new Error("MandateFlow fixture MCP response did not contain a result");
    }
    return payload.result;
  }

  private async loadPaymentCaseReference(request: RunnerRequest): Promise<string> {
    const inMemory = this.paymentCaseReferences.get(request.agentId);
    if (inMemory) return inMemory;
    if (!request.codexHomePath) {
      throw new Error("Deterministic retry state is unavailable after the Runtime restart");
    }
    try {
      const state = JSON.parse(
        await readFile(this.statePath(request), "utf8"),
      ) as Partial<FixtureState>;
      if (typeof state.paymentCaseReference !== "string") {
        throw new Error("missing payment Case reference");
      }
      this.paymentCaseReferences.set(request.agentId, state.paymentCaseReference);
      return state.paymentCaseReference;
    } catch {
      throw new Error("Deterministic retry state is unavailable after the Runtime restart");
    }
  }

  private async savePaymentCaseReference(
    request: RunnerRequest,
    reference: string,
  ): Promise<void> {
    this.paymentCaseReferences.set(request.agentId, reference);
    if (!request.codexHomePath) return;
    const statePath = this.statePath(request);
    await writeFile(statePath, JSON.stringify({ paymentCaseReference: reference }) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(statePath, 0o600);
  }

  private statePath(request: RunnerRequest): string {
    if (!request.codexHomePath) {
      throw new Error("Deterministic fixture state path is unavailable");
    }
    return request.codexHomePath + "/" + FIXTURE_STATE_FILENAME;
  }

  private result(request: RunnerRequest, output: string): RunnerResult {
    return {
      output,
      threadId: request.threadId ?? "fixture-thread-" + request.agentId,
      usage: null,
      runtimeInstanceId: "fixture-runtime-" + request.runId,
    };
  }
}

function requireReference(result: FixtureToolResult, label: string): string {
  if (!result.ok || !result.reference?.reference) {
    throw new Error(`${label} did not return an opaque protected reference`);
  }
  return result.reference.reference;
}

function requireSuccess(result: FixtureToolResult, label: string): void {
  if (!result.ok) {
    throw new Error(`${label} was denied: ${result.code ?? "unknown"}`);
  }
}
