import type { AppConfig } from "./config.js";
import { ContainerCodexRunner } from "./container-codex-runner.js";
import { CodexRunner } from "./codex-runner.js";
import { DeterministicMandateFlowRunner } from "./fixture-runner.js";
import type { AgentRunner } from "./types.js";

export function createRunner(config: AppConfig): AgentRunner {
  if (config.runtimeProvider === "container") return new ContainerCodexRunner(config);
  if (config.runtimeProvider === "fixture") return new DeterministicMandateFlowRunner(config);
  return new CodexRunner(config);
}
