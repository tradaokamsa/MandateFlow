import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, writeCodexConfig } from "./config.js";

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
