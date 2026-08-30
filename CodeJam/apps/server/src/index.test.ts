import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_ENV, loadConfig } from "./config.js";
import {
  createLaunchpadRuntime,
  listenLaunchpadApps,
  type LaunchpadRuntime,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("production listener composition", () => {
  it("starts MCP before the browser listener", async () => {
    const events: string[] = [];
    const config = loadConfig({ NODE_ENV: "test" });
    const runtime = {
      mcpApp: {
        listen: async () => {
          events.push("mcp");
          return "mcp";
        },
      },
      browserApp: {
        listen: async () => {
          events.push("browser");
          return "browser";
        },
      },
    } as unknown as LaunchpadRuntime;

    await listenLaunchpadApps(runtime, config);

    expect(events).toEqual(["mcp", "browser"]);
  });

  it("creates disjoint browser and MCP apps with shared readiness", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-runtime-test-"));
    temporaryDirectories.push(root);
    const appToken = "a".repeat(43);
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: path.join(root, "data"),
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      MANDATEFLOW_ENABLED: "true",
      MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:3001",
      APP_AUTH_TOKEN: appToken,
      CODEX_TIMEOUT_MS: "10000",
      MANDATEFLOW_CAPABILITY_TTL_MS: "600000",
    });

    const runtime = await createLaunchpadRuntime(config);
    try {
      expect(runtime.mcpApp).not.toBeNull();
      const browserMcp = await runtime.browserApp.inject({
        method: "POST",
        url: "/mcp",
      });
      const mcpBrowserRoute = await runtime.mcpApp!.inject({
        method: "GET",
        url: "/api/agents",
      });
      const health = await runtime.mcpApp!.inject({
        method: "GET",
        url: "/healthz",
      });

      expect(browserMcp.statusCode).toBe(404);
      expect(mcpBrowserRoute.statusCode).toBe(404);
      expect(health.json()).toEqual({ ok: true, service: "mandateflow-mcp" });
      const toml = await readFile(path.join(config.codexHome, "config.toml"), "utf8");
      expect(toml).toContain("required = true");
      expect(toml).toContain(CAPABILITY_ENV);
      expect(toml).not.toContain(appToken);

      const shutdownOrder: string[] = [];
      const serviceShutdown = runtime.service.shutdown.bind(runtime.service);
      const mcpClose = runtime.mcpApp!.close.bind(runtime.mcpApp);
      const browserClose = runtime.browserApp.close.bind(runtime.browserApp);
      vi.spyOn(runtime.service, "shutdown").mockImplementation(async () => {
        shutdownOrder.push("service");
        await serviceShutdown();
      });
      vi.spyOn(runtime.mcpApp!, "close").mockImplementation(async () => {
        shutdownOrder.push("mcp");
        await mcpClose();
      });
      vi.spyOn(runtime.browserApp, "close").mockImplementation(async () => {
        shutdownOrder.push("browser");
        await browserClose();
      });

      await runtime.shutdown();
      expect(shutdownOrder).toEqual(["service", "mcp", "browser"]);
    } finally {
      await runtime.shutdown();
    }
  });

  it("marks the shared Gateway unready after store persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-runtime-failure-"));
    temporaryDirectories.push(root);
    const dataDirectory = path.join(root, "data");
    const config = loadConfig({
      NODE_ENV: "test",
      APP_DATA_DIR: dataDirectory,
      AGENT_WORKSPACE_ROOT: path.join(root, "workspaces"),
      CODEX_HOME: path.join(root, "codex"),
      MANDATEFLOW_ENABLED: "true",
      MANDATEFLOW_RUNTIME_MCP_URL: "http://host.docker.internal:3001",
      APP_AUTH_TOKEN: "a".repeat(43),
      CODEX_TIMEOUT_MS: "10000",
      MANDATEFLOW_CAPABILITY_TTL_MS: "600000",
    });
    const runtime = await createLaunchpadRuntime(config);
    try {
      await mkdir(path.join(dataDirectory, "launchpad.json.tmp"));

      await expect(
        runtime.service.createAgent({ name: "Persistence failure" }),
      ).rejects.toBeDefined();

      expect(runtime.readiness.isReady()).toBe(false);
      const health = await runtime.mcpApp!.inject({
        method: "GET",
        url: "/healthz",
      });
      expect(health.statusCode).toBe(503);
      expect(health.json()).toEqual({
        ok: false,
        service: "mandateflow-mcp",
      });
    } finally {
      await runtime.shutdown();
    }
  });
});
