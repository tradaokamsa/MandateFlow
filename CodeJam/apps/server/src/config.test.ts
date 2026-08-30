import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPABILITY_ENV,
  MCP_PATH,
  MCP_SERVER_NAME,
  loadConfig,
  writeCodexConfig,
} from "./config.js";

const temporaryDirectories: string[] = [];
const appToken = "a".repeat(43);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

function enabledEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    MANDATEFLOW_ENABLED: "true",
    MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:3001",
    APP_AUTH_TOKEN: appToken,
    CODEX_TIMEOUT_MS: "10000",
    ...overrides,
  };
}

describe("MandateFlow configuration", () => {
  it("preserves disabled mode without requiring MandateFlow credentials", () => {
    const config = loadConfig({ NODE_ENV: "test" });

    expect(config.mandateFlowEnabled).toBe(false);
    expect(config.mandateFlowRuntimeMcpUrl).toBeNull();
    expect(config.mandateFlowCapabilityTtlMs).toBe(660_000);
  });

  it("derives a loopback browser listener and exact MCP boundary settings", () => {
    const config = loadConfig(
      enabledEnvironment({
        MANDATEFLOW_MCP_PORT: "4101",
        MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:4101",
        MANDATEFLOW_CONTAINER_ADD_HOST: "host.docker.internal:host-gateway",
        MANDATEFLOW_CAPABILITY_TTL_MS: "71000",
      }),
    );

    expect(config.host).toBe("127.0.0.1");
    expect(config.mandateFlowMcpBindHost).toBe("0.0.0.0");
    expect(config.mandateFlowMcpPort).toBe(4101);
    expect(config.mandateFlowRuntimeMcpUrl).toBe(
      "http://host.docker.internal:4101",
    );
    expect(config.mandateFlowContainerAddHost).toBe(
      "host.docker.internal:host-gateway",
    );
    expect(config.mandateFlowCapabilityTtlMs).toBe(71_000);
    expect(config.mandateFlowAllowedHosts).toContain(
      "host.docker.internal:4101",
    );
  });

  it.each([
    [{ APP_AUTH_TOKEN: "short" }, /256-bit APP_AUTH_TOKEN/],
    [{ MANDATEFLOW_RUNTIME_MCP_URL: undefined }, /runtime MCP URL is required/i],
    [{ MANDATEFLOW_MCP_PORT: "3000" }, /ports must differ/i],
    [
      { MANDATEFLOW_RUNTIME_MCP_URL: "http://user:pass@localhost:3001" },
      /must not contain credentials/i,
    ],
    [
      { MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:4999" },
      /must use MANDATEFLOW_MCP_PORT/i,
    ],
    [
      { MANDATEFLOW_CAPABILITY_TTL_MS: "10000" },
      /longer than CODEX_TIMEOUT_MS/i,
    ],
    [
      { MANDATEFLOW_CONTAINER_ADD_HOST: "host.docker.internal:latest" },
      /host-gateway or an IP address/i,
    ],
    [{ HOST: "0.0.0.0" }, /browser listener must be loopback/i],
  ])("rejects an unsafe enabled configuration", (override, message) => {
    expect(() => loadConfig(enabledEnvironment(override))).toThrow(message);
  });

  it("emits a required named MCP server without persisting either credential", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "mandateflow-config-test-"));
    temporaryDirectories.push(root);
    const config = loadConfig(
      enabledEnvironment({
        CODEX_HOME: root,
        ARK_API_KEY: "ark-secret",
        ARK_MODEL: "ep-test",
      }),
    );

    await writeCodexConfig(config);
    const toml = await readFile(path.join(root, "config.toml"), "utf8");

    expect(toml).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(toml).toContain(`url = "${config.mandateFlowRuntimeMcpUrl}${MCP_PATH}"`);
    expect(toml).toContain(`bearer_token_env_var = "${CAPABILITY_ENV}"`);
    expect(toml).toContain("required = true");
    expect(toml).not.toContain(appToken);
    expect(toml).not.toContain("ark-secret");
  });
});
