import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  isGroqConfigured,
  loadConfig,
  writeCodexConfig,
} from "./config.js";

const secureEnvironment = {
  NODE_ENV: "test",
  MANDATEFLOW_ENABLED: "true",
  MANDATEFLOW_CONTROL_TOKEN:
    "mfc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  APP_AUTH_TOKEN: "a-secure-local-test-token",
};

describe("MandateFlow configuration", () => {
  it("accepts a loopback control endpoint and strong domain token", () => {
    expect(
      loadConfig({
        ...secureEnvironment,
        MANDATEFLOW_CONTROL_URL: "http://127.0.0.1:3002",
      }).mandateFlowEnabled,
    ).toBe(true);
  });

  it("rejects a non-loopback control endpoint", () => {
    expect(() =>
      loadConfig({
        ...secureEnvironment,
        MANDATEFLOW_CONTROL_URL: "http://mandateflow-gateway:3002",
      }),
    ).toThrow(/loopback/);
  });

  it("rejects malformed control-token characters", () => {
    expect(() =>
      loadConfig({
        ...secureEnvironment,
        MANDATEFLOW_CONTROL_TOKEN:
          "mfc1_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN invalid-token",
      }),
    ).toThrow(/MANDATEFLOW_CONTROL_TOKEN/);
  });

  it("writes only the Run bearer environment-variable name to Codex TOML", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "mandateflow-config-"));
    const config = loadConfig({
      ...secureEnvironment,
      CODEX_HOME: codexHome,
      MANDATEFLOW_RUNTIME_MCP_URL: "http://mandateflow-gateway:3001/mcp",
    });
    await writeCodexConfig(config);
    const toml = await readFile(path.join(codexHome, "config.toml"), "utf8");
    expect(toml).toContain('bearer_token_env_var = "MANDATEFLOW_RUN_CAPABILITY"');
    expect(toml).toContain("http://mandateflow-gateway:3001/mcp");
    expect(toml).not.toContain(secureEnvironment.MANDATEFLOW_CONTROL_TOKEN);
    await rm(codexHome, { recursive: true, force: true });
  });
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Groq configuration", () => {
  it("defaults the model and requires only a non-placeholder API key", () => {
    const unconfigured = loadConfig({ NODE_ENV: "test" });
    expect(unconfigured.groqModel).toBe(DEFAULT_GROQ_MODEL);
    expect(unconfigured.groqBaseUrl).toBe(DEFAULT_GROQ_BASE_URL);
    expect(isGroqConfigured(unconfigured)).toBe(false);

    for (const placeholder of ["", "   ", "replace-with-your-groq-api-key", "your-groq-api-key"]) {
      expect(
        isGroqConfigured(loadConfig({ NODE_ENV: "test", GROQ_API_KEY: placeholder })),
      ).toBe(false);
    }

    const configured = loadConfig({ NODE_ENV: "test", GROQ_API_KEY: "gsk-test-key" });
    expect(configured.groqModel).toBe(DEFAULT_GROQ_MODEL);
    expect(isGroqConfigured(configured)).toBe(true);
  });

  it("writes the Groq Responses provider without persisting the API key", async () => {
    const codexHome = await mkdtemp(path.join(tmpdir(), "launchpad-codex-"));
    temporaryDirectories.push(codexHome);
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: codexHome,
      RUNTIME_PROVIDER: "container",
      GROQ_API_KEY: "gsk-test-secret",
      GROQ_MODEL: "openai/gpt-oss-20b",
    });

    await writeCodexConfig(config);
    const codexConfig = await readFile(path.join(codexHome, "config.toml"), "utf8");
    const runtimeInstructions = await readFile(
      path.join(codexHome, "runtime-instructions.md"),
      "utf8",
    );

    expect(codexConfig).toContain('model = "openai/gpt-oss-20b"');
    expect(codexConfig).toContain(
      'model_instructions_file = "/codex-home/runtime-instructions.md"',
    );
    expect(codexConfig).toContain('model_reasoning_summary = "none"');
    expect(codexConfig).toContain("model_supports_reasoning_summaries = false");
    expect(codexConfig).toContain('model_provider = "groq"');
    expect(codexConfig).toContain('web_search = "disabled"');
    expect(codexConfig).toContain("collab = false");
    expect(codexConfig).toContain("multi_agent = false");
    expect(codexConfig).toContain("[model_providers.groq]");
    expect(codexConfig).toContain('base_url = "https://api.groq.com/openai/v1"');
    expect(codexConfig).toContain('env_key = "GROQ_API_KEY"');
    expect(codexConfig).toContain('wire_api = "responses"');
    expect(codexConfig).not.toContain("gsk-test-secret");
    expect(runtimeInstructions).toContain("Call the necessary MCP tools directly");
    expect(runtimeInstructions).toContain("never modify, infer, or reveal them");
  });
});
