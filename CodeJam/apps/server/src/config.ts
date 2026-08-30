import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";

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
  MANDATEFLOW_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  MANDATEFLOW_CONTROL_URL: z
    .string()
    .url()
    .default("http://127.0.0.1:3002"),
  MANDATEFLOW_CONTROL_TOKEN: z.string().trim().optional(),
  MANDATEFLOW_RUNTIME_MCP_URL: z
    .string()
    .url()
    .default("http://mandateflow-gateway:3001/mcp"),
  MANDATEFLOW_CONTAINER_NETWORK: z
    .string()
    .trim()
    .min(1)
    .max(96)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("mandateflow-local"),
  MANDATEFLOW_CONTROL_HOST_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().optional(),
  GROQ_BASE_URL: z
    .string()
    .url()
    .default(DEFAULT_GROQ_BASE_URL),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const mandateFlowControlToken = env.MANDATEFLOW_CONTROL_TOKEN?.trim() ?? "";
  if (env.MANDATEFLOW_ENABLED) {
    if (
      !/^mfc1_[A-Za-z0-9_-]{43}$/.test(mandateFlowControlToken)
    ) {
      throw new Error(
        "MANDATEFLOW_CONTROL_TOKEN must be a strong mfc1_ token when MandateFlow is enabled",
      );
    }
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters when MandateFlow is enabled",
      );
    }
    const controlHostname = new URL(env.MANDATEFLOW_CONTROL_URL).hostname;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(controlHostname)) {
      throw new Error(
        "MANDATEFLOW_CONTROL_URL must use a loopback host for the local P0",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
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
    mandateFlowEnabled: env.MANDATEFLOW_ENABLED,
    mandateFlowControlUrl: env.MANDATEFLOW_CONTROL_URL.replace(/\/+$/, ""),
    mandateFlowControlToken,
    mandateFlowRuntimeMcpUrl: env.MANDATEFLOW_RUNTIME_MCP_URL,
    mandateFlowContainerNetwork: env.MANDATEFLOW_CONTAINER_NETWORK,
    mandateFlowControlHostPort: env.MANDATEFLOW_CONTROL_HOST_PORT,
    authToken,
    groqApiKey: env.GROQ_API_KEY?.trim() ?? "",
    groqModel: env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL,
    groqBaseUrl: env.GROQ_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,
  };
}

export function isGroqConfigured(config: AppConfig): boolean {
  const key = config.groqApiKey.trim();
  return (
    key.length > 0 &&
    !/^(?:replace(?:[-_ ]|$)|your(?:[-_ ]|$)|placeholder(?:[-_ ]|$)|change(?:[-_ ]|$)|xxx+$)/i.test(
      key,
    )
  );
}

export async function writeCodexConfig(
  config: AppConfig,
  targetHome = config.codexHome,
): Promise<void> {
  await mkdir(targetHome, { recursive: true, mode: 0o700 });
  const toml = [
    "# Generated by Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.groqModel || DEFAULT_GROQ_MODEL),
    'model_reasoning_summary = "none"',
    "model_supports_reasoning_summaries = false",
    'model_provider = "groq"',
    'web_search = "disabled"',
    "",
    "[features]",
    "collab = false",
    "multi_agent = false",
    "",
    "[model_providers.groq]",
    'name = "Groq"',
    "base_url = " + JSON.stringify(config.groqBaseUrl),
    'env_key = "GROQ_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
    ...(config.mandateFlowEnabled
      ? [
          "[mcp_servers.mandateflow]",
          "url = " + JSON.stringify(config.mandateFlowRuntimeMcpUrl),
          'bearer_token_env_var = "MANDATEFLOW_RUN_CAPABILITY"',
          "required = true",
          "",
        ]
      : []),
  ].join("\n");
  await writeFile(path.join(targetHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(path.join(targetHome, "config.toml"), 0o600);
}
