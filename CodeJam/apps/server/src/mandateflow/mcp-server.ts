import {
  hostHeaderValidation,
  originValidation,
} from "@modelcontextprotocol/fastify";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import Fastify, { LogController, type FastifyInstance } from "fastify";
import type { AppConfig } from "../config.js";
import { MCP_PATH, MCP_SERVER_NAME } from "../config.js";
import { JsonStore } from "../store.js";
import { isCapabilityToken, sha256 } from "./crypto.js";
import {
  MandateFlowKernel,
  TOOL_REGISTRY,
  type AuthenticatedPrincipal,
} from "./kernel.js";
import type { ToolName, ToolResult } from "./types.js";

const INVALID_TOKEN_CHALLENGE = 'Bearer error="invalid_token"';

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  "support.list_tickets":
    "List synthetic open Support tickets and return an opaque customer-subject reference.",
  "payments.list_failures":
    "List synthetic Payment failures and return an opaque aggregate-only customer-subject reference.",
  "cases.lookup_subject":
    "Transform one opaque customer-subject reference into an opaque operations-case reference.",
  "crm.resolve_customer":
    "Resolve one permitted operations-case reference to synthetic contact data.",
  "payments.aggregate_failures":
    "Return safe aggregate Payment failure counts without customer identities.",
};

export class MandateFlowReadiness {
  private ready = true;

  isReady(): boolean {
    return this.ready;
  }

  fail(_error: Error): void {
    this.ready = false;
  }
}

function parseBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer (mfr1_[A-Za-z0-9_-]{43})$/.exec(header);
  if (!match?.[1] || !isCapabilityToken(match[1])) return null;
  return match[1];
}

function parseSingleBearer(rawHeaders: readonly string[]): string | null {
  const values: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]?.toLowerCase() === "authorization") {
      values.push(rawHeaders[index + 1] ?? "");
    }
  }
  return values.length === 1 ? parseBearer(values[0]) : null;
}

function hostname(value: string): string {
  return new URL("http://" + value).hostname;
}

function invalidToken(reply: {
  code(statusCode: number): {
    header(name: string, value: string): {
      send(payload: unknown): unknown;
    };
  };
}) {
  return reply
    .code(401)
    .header("WWW-Authenticate", INVALID_TOKEN_CHALLENGE)
    .send({ error: "invalid_token" });
}

function mcpToolResult(result: ToolResult) {
  if (result.isError) {
    const safe = {
      code: result.code,
      message: result.message,
      receiptId: result.receiptId,
      safeAlternative: result.safeAlternative,
    };
    return {
      isError: true,
      content: [{ type: "text" as const, text: JSON.stringify(safe) }],
    };
  }
  const safe = { ...result.data, receiptId: result.receiptId };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safe) }],
    structuredContent: safe,
  };
}

export async function createMandateFlowMcpApp(
  config: AppConfig,
  store: JsonStore,
  kernel: MandateFlowKernel,
  readiness: MandateFlowReadiness,
  onFatalRun: (runId: string) => void | Promise<void> = () => undefined,
  clock: () => string = () => new Date().toISOString(),
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.logLevel,
      redact: [
        "req.headers.authorization",
        "request.headers.authorization",
        "headers.authorization",
      ],
    },
    bodyLimit: 262_144,
    requestTimeout: 30_000,
    logController: new LogController({ disableRequestLogging: true }),
  });
  const exactHosts = new Set(
    config.mandateFlowAllowedHosts.map((value) => value.toLowerCase()),
  );
  const exactOrigins = new Set(
    config.mandateFlowAllowedOrigins.map((value) => value.toLowerCase()),
  );
  const validateHost = hostHeaderValidation(
    Array.from(new Set(config.mandateFlowAllowedHosts.map(hostname))),
  );
  const validateOrigin = originValidation(
    Array.from(
      new Set(
        config.mandateFlowAllowedOrigins.map(
          (value) => new URL(value).hostname,
        ),
      ),
    ),
  );
  const stopFatalRun = async (runId: string): Promise<void> => {
    try {
      await onFatalRun(runId);
    } catch (error) {
      readiness.fail(error instanceof Error ? error : new Error(String(error)));
    }
  };

  app.get("/healthz", async (_request, reply) => {
    if (!readiness.isReady()) {
      return reply
        .code(503)
        .send({ ok: false, service: "mandateflow-mcp" });
    }
    return { ok: true, service: "mandateflow-mcp" };
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.url !== MCP_PATH) return;
    const requestHost = request.headers.host?.toLowerCase() ?? "";
    if (!exactHosts.has(requestHost)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    const requestOrigin = request.headers.origin?.toLowerCase();
    if (requestOrigin && !exactOrigins.has(requestOrigin)) {
      return reply.code(403).send({ error: "forbidden" });
    }
    await validateHost(request, reply);
    if (reply.sent) return;
    await validateOrigin(request, reply);
    if (reply.sent) return;
    if (!readiness.isReady()) {
      return reply.code(503).send({ error: "gateway_unavailable" });
    }
    const token = parseSingleBearer(request.raw.rawHeaders);
    if (!token) return invalidToken(reply);

    const digest = sha256(token);
    const requestNow = clock();
    const snapshot = store.snapshot();
    const knownPotentiallyLive = snapshot.runGrants.find(
      (grant) =>
        grant.capabilitySha256 === digest &&
        (grant.status === "queued" || grant.status === "active"),
    );
    const principal = kernel.authenticateActiveGrant(
      snapshot,
      digest,
      requestNow,
    );
    if (!principal) {
      if (knownPotentiallyLive) {
        try {
          const expiredRunId = await store.mutate((database) => {
            const grant = database.runGrants.find(
              (candidate) => candidate.capabilitySha256 === digest,
            );
            const wasPotentiallyLive =
              grant?.status === "queued" || grant?.status === "active";
            kernel.authenticateActiveGrant(database, digest, requestNow);
            return wasPotentiallyLive && grant?.status === "expired"
              ? grant.runId
              : null;
          });
          if (expiredRunId) await stopFatalRun(expiredRunId);
        } catch (error) {
          readiness.fail(error instanceof Error ? error : new Error(String(error)));
          await stopFatalRun(knownPotentiallyLive.runId);
          return reply.code(503).send({ error: "gateway_unavailable" });
        }
      }
      return invalidToken(reply);
    }
  });

  const handler = createMcpHandler(({ requestInfo }) => {
    const token = parseBearer(
      requestInfo?.headers.get("authorization") ?? undefined,
    );
    const capabilitySha256 = token ? sha256(token) : "";
    const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" });

    const register = (tool: ToolName): void => {
      server.registerTool(
        tool,
        {
          description: TOOL_DESCRIPTIONS[tool],
          inputSchema: TOOL_REGISTRY[tool].inputSchema,
        },
        async (argumentsValue: unknown) => {
          let principalRunId: string | null = null;
          let affectedRunId: string | null = null;
          try {
            const result = await store.mutate((database) => {
              const callNow = clock();
              const grant = database.runGrants.find(
                (candidate) =>
                  candidate.capabilitySha256 === capabilitySha256,
              );
              const wasPotentiallyLive =
                grant?.status === "queued" || grant?.status === "active";
              if (wasPotentiallyLive && grant) affectedRunId = grant.runId;
              if (!readiness.isReady()) {
                throw new Error("MandateFlow Gateway is unavailable");
              }
              const principal: AuthenticatedPrincipal | null =
                kernel.authenticateActiveGrant(
                  database,
                  capabilitySha256,
                  callNow,
                );
              if (!principal) {
                return {
                  dispatch: null,
                  expiredRunId:
                    wasPotentiallyLive && grant?.status === "expired"
                      ? grant.runId
                      : null,
                };
              }
              principalRunId = principal.runId;
              return {
                dispatch: kernel.executeTool(database, {
                  principal,
                  tool,
                  argumentsValue,
                  now: callNow,
                }),
                expiredRunId: null,
              };
            });
            if (result.expiredRunId) await stopFatalRun(result.expiredRunId);
            if (!result.dispatch) {
              return {
                isError: true,
                content: [
                  {
                    type: "text" as const,
                    text: JSON.stringify({ code: "INVALID_AUTHORITY" }),
                  },
                ],
              };
            }
            return mcpToolResult(result.dispatch);
          } catch (error) {
            const failure =
              error instanceof Error ? error : new Error(String(error));
            readiness.fail(failure);
            const fatalRunId = principalRunId ?? affectedRunId;
            if (fatalRunId) await stopFatalRun(fatalRunId);
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({ code: "GATEWAY_UNAVAILABLE" }),
                },
              ],
            };
          }
        },
      );
    };

    for (const tool of Object.keys(TOOL_REGISTRY) as ToolName[]) register(tool);
    return server;
  }, { responseMode: "json" });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (error) => app.log.error({ err: error }, "MCP adapter error"),
  });

  app.all(MCP_PATH, async (request, reply) => {
    reply.hijack();
    await nodeHandler(
      request.raw as unknown as Parameters<typeof nodeHandler>[0],
      reply.raw,
      request.body,
    );
    return reply;
  });

  app.addHook("onClose", async () => handler.close());
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: "not_found" }),
  );
  return app;
}
