import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";

export const MCP_SERVER_NAME = "launchpad_gateway";
export const MCP_PATH = "/mcp";
export const CAPABILITY_ENV = "LAUNCHPAD_RUN_CAPABILITY";
export const CAPABILITY_AUDIENCE = "launchpad-mcp-gateway";

const booleanFromEnvironment = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  MANDATEFLOW_ENABLED: booleanFromEnvironment,
  MANDATEFLOW_MCP_BIND_HOST: z.string().trim().min(1).default("0.0.0.0"),
  MANDATEFLOW_MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  MANDATEFLOW_RUNTIME_MCP_URL: z.string().trim().optional(),
  MANDATEFLOW_CONTAINER_ADD_HOST: z.string().trim().optional(),
  MANDATEFLOW_CAPABILITY_TTL_MS: z.coerce.number().int().positive().optional(),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const mandateFlowEnabled = env.MANDATEFLOW_ENABLED;
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  const browserHost =
    mandateFlowEnabled && environment.HOST === undefined ? "127.0.0.1" : env.HOST;

  if (mandateFlowEnabled && !loopbackHosts.has(browserHost)) {
    throw new Error("MandateFlow browser listener must be loopback-only");
  }
  if (mandateFlowEnabled && env.PORT === env.MANDATEFLOW_MCP_PORT) {
    throw new Error("Browser and MandateFlow MCP ports must differ");
  }
  if (
    mandateFlowEnabled &&
    (!/^[A-Za-z0-9_-]{43,128}$/.test(authToken) ||
      Buffer.from(authToken, "base64url").byteLength < 32)
  ) {
    throw new Error(
      "MandateFlow requires a URL-safe 256-bit APP_AUTH_TOKEN (32 bytes or more)",
    );
  }

  let mandateFlowRuntimeMcpUrl: string | null = null;
  let runtimeUrl: URL | null = null;
  if (mandateFlowEnabled) {
    if (!env.MANDATEFLOW_RUNTIME_MCP_URL) {
      throw new Error("MandateFlow runtime MCP URL is required when enabled");
    }
    runtimeUrl = new URL(env.MANDATEFLOW_RUNTIME_MCP_URL);
    if (runtimeUrl.protocol !== "http:" && runtimeUrl.protocol !== "https:") {
      throw new Error("MandateFlow runtime MCP URL must use HTTP or HTTPS");
    }
    if (runtimeUrl.username || runtimeUrl.password) {
      throw new Error("MandateFlow runtime MCP URL must not contain credentials");
    }
    if (runtimeUrl.pathname !== "/" || runtimeUrl.search || runtimeUrl.hash) {
      throw new Error("MandateFlow runtime MCP URL must be an origin without a path");
    }
    const runtimePort = Number(
      runtimeUrl.port || (runtimeUrl.protocol === "https:" ? "443" : "80"),
    );
    if (runtimePort !== env.MANDATEFLOW_MCP_PORT) {
      throw new Error("MandateFlow runtime MCP URL must use MANDATEFLOW_MCP_PORT");
    }
    mandateFlowRuntimeMcpUrl = runtimeUrl.origin;
  }

  const mandateFlowCapabilityTtlMs =
    env.MANDATEFLOW_CAPABILITY_TTL_MS ?? env.CODEX_TIMEOUT_MS + 60_000;
  if (mandateFlowCapabilityTtlMs <= env.CODEX_TIMEOUT_MS) {
    throw new Error(
      "MANDATEFLOW_CAPABILITY_TTL_MS must be longer than CODEX_TIMEOUT_MS",
    );
  }

  const mandateFlowContainerAddHost =
    env.MANDATEFLOW_CONTAINER_ADD_HOST?.trim() || null;
  if (mandateFlowContainerAddHost) {
    const separator = mandateFlowContainerAddHost.lastIndexOf(":");
    const host = mandateFlowContainerAddHost.slice(0, separator);
    const target = mandateFlowContainerAddHost.slice(separator + 1);
    const validHost = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(
      host,
    );
    const validTarget = target === "host-gateway" || isIP(target) === 4;
    if (!validHost || !validTarget) {
      throw new Error(
        "MANDATEFLOW_CONTAINER_ADD_HOST must map one host to host-gateway or an IP address",
      );
    }
  }

  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: browserHost,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    mandateFlowEnabled,
    mandateFlowMcpBindHost: env.MANDATEFLOW_MCP_BIND_HOST,
    mandateFlowMcpPort: env.MANDATEFLOW_MCP_PORT,
    mandateFlowRuntimeMcpUrl,
    mandateFlowContainerAddHost,
    mandateFlowCapabilityTtlMs,
    mandateFlowAllowedHosts: runtimeUrl
      ? Array.from(
          new Set([
            runtimeUrl.host,
            `127.0.0.1:${env.MANDATEFLOW_MCP_PORT}`,
            `localhost:${env.MANDATEFLOW_MCP_PORT}`,
            `[::1]:${env.MANDATEFLOW_MCP_PORT}`,
          ]),
        )
      : [],
    mandateFlowAllowedOrigins: runtimeUrl ? [runtimeUrl.origin] : [],
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

export async function writeCodexConfig(config: AppConfig): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const lines = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ];
  if (config.mandateFlowEnabled && config.mandateFlowRuntimeMcpUrl) {
    lines.push(
      `[mcp_servers.${MCP_SERVER_NAME}]`,
      `url = ${JSON.stringify(config.mandateFlowRuntimeMcpUrl + MCP_PATH)}`,
      `bearer_token_env_var = ${JSON.stringify(CAPABILITY_ENV)}`,
      "required = true",
      "",
    );
  }
  const toml = lines.join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
