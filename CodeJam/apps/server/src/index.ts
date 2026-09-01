import path from "node:path";
import { AgentService } from "./agent-service.js";
import { createApp } from "./app.js";
import { isGroqConfigured, loadConfig, writeCodexConfig } from "./config.js";
import { loadApplicationEnv } from "./env.js";
import { MandateFlowClient } from "./mandateflow-client.js";
import { createRunner } from "./runner-factory.js";
import { JsonStore } from "./store.js";
import { WorkspaceManager } from "./workspace.js";

loadApplicationEnv();
const config = loadConfig();
if (config.runtimeProvider !== "fixture" && !isGroqConfigured(config)) {
  throw new Error(
    "GROQ_API_KEY is missing or still a placeholder. Set it in CodeJam/.env, copied from CodeJam/.env.example.",
  );
}
await writeCodexConfig(config);

const store = new JsonStore(path.join(config.dataDirectory, "launchpad.json"));
const workspaces = new WorkspaceManager(config.workspaceRoot);
const runner = createRunner(config);
const mandateFlow = config.mandateFlowEnabled
  ? new MandateFlowClient(
      config.mandateFlowControlUrl,
      config.mandateFlowControlToken,
    )
  : null;
const service = new AgentService(config, store, workspaces, runner, mandateFlow);
await service.initialize();

const app = await createApp(config, service);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "Shutting down");
  await app.close();
  process.exit(0);
};

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ host: config.host, port: config.port });
