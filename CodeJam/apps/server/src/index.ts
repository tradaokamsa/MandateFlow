import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import {
  loadConfig,
  writeCodexConfig,
  type AppConfig,
} from "./config.js";
import {
  MandateFlowKernel,
} from "./mandateflow/kernel.js";
import {
  MandateFlowReadiness,
  createMandateFlowMcpApp,
} from "./mandateflow/mcp-server.js";
import { isPackagedPolicyAvailable } from "./mandateflow/policy.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

export interface LaunchpadRuntime {
  browserApp: Awaited<ReturnType<typeof createApp>>;
  mcpApp: Awaited<ReturnType<typeof createMandateFlowMcpApp>> | null;
  service: AgentService;
  readiness: MandateFlowReadiness;
  shutdown(): Promise<void>;
}

export async function createLaunchpadRuntime(
  config: AppConfig,
): Promise<LaunchpadRuntime> {
  await writeCodexConfig(config);
  const readiness = new MandateFlowReadiness();
  let service: AgentService | null = null;
  const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"), {
    onPersistenceFailure: (error) => {
      readiness.fail(error);
      if (service) void service.shutdown().catch(() => undefined);
    },
  });
  const workspaces = new WorkspaceManager(config.workspaceRoot);
  const runner = createRunner(config);
  const kernel = new MandateFlowKernel({
    capabilityTtlMs: config.mandateFlowCapabilityTtlMs,
  });
  service = new AgentService(
    config,
    store,
    workspaces,
    runner,
    kernel,
    readiness,
  );
  await service.initialize();

  if (
    config.mandateFlowEnabled &&
    store.snapshot().policyContexts.some(
      (context) =>
        context.closedAt === null &&
        !isPackagedPolicyAvailable(
          context.mandate.policyId,
          context.mandate.policyVersion,
          context.mandate.policySha256,
        ),
    )
  ) {
    readiness.fail(new Error("An open context references an unavailable policy"));
  }

  const browserApp = await createApp(config, service);
  const mcpApp = config.mandateFlowEnabled
    ? await createMandateFlowMcpApp(
        config,
        store,
        kernel,
        readiness,
        async (runId) => {
          await service!.cancelRun(runId);
        },
      )
    : null;
  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        await service!.shutdown();
      } finally {
        try {
          if (mcpApp) await mcpApp.close();
        } finally {
          await browserApp.close();
        }
      }
    })();
    return shutdownPromise;
  };
  return { browserApp, mcpApp, service, readiness, shutdown };
}

export async function listenLaunchpadApps(
  runtime: Pick<LaunchpadRuntime, "browserApp" | "mcpApp">,
  config: AppConfig,
): Promise<void> {
  if (runtime.mcpApp) {
    await runtime.mcpApp.listen({
      host: config.mandateFlowMcpBindHost,
      port: config.mandateFlowMcpPort,
    });
  }
  await runtime.browserApp.listen({ host: config.host, port: config.port });
}

export async function startLaunchpad(config: AppConfig = loadConfig()): Promise<void> {
  const runtime = await createLaunchpadRuntime(config);
  const stopForSignal = async (signal: string) => {
    runtime.browserApp.log.info({ signal }, "Shutting down");
    try {
      await runtime.shutdown();
      process.exit(0);
    } catch (error) {
      runtime.browserApp.log.error({ err: error, signal }, "Shutdown failed");
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void stopForSignal("SIGTERM"));
  process.on("SIGINT", () => void stopForSignal("SIGINT"));

  try {
    await listenLaunchpadApps(runtime, config);
  } catch (error) {
    await runtime.shutdown();
    throw error;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) await startLaunchpad();
