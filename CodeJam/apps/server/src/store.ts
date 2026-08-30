import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, AgentRun, Database, DemoOwnerPrincipal } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 3,
  agents: [],
  messages: [],
  runs: [],
});

export class JsonStore {
  private data: Database = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        agents?: unknown;
        messages?: unknown;
        runs?: unknown;
      };
      if (
        ![1, 2, 3].includes(parsed.version as number) ||
        !Array.isArray(parsed.agents) ||
        !Array.isArray(parsed.messages) ||
        !Array.isArray(parsed.runs)
      ) {
        throw new Error("Unsupported database format");
      }
      this.data = migrateDatabase(parsed.version as 1 | 2 | 3, {
        agents: parsed.agents as unknown[],
        messages: parsed.messages as unknown[],
        runs: parsed.runs as unknown[],
      });
      if (parsed.version !== 3) await this.persist(this.data);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      await this.persist();
    }
  }

  snapshot(): Database {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: Database) => T | Promise<T>): Promise<T> {
    let result!: T;
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.data);
      result = await mutation(next);
      await this.persist(next);
      this.data = next;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return result;
  }

  private async persist(data: Database = this.data): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }
}

function migrateDatabase(
  version: 1 | 2 | 3,
  legacy: { agents: unknown[]; messages: unknown[]; runs: unknown[] },
): Database {
  const agents = legacy.agents.map((value) => {
    const agent = value as Partial<Agent> & { owner?: unknown };
    const id = typeof agent.id === "string" ? agent.id : "legacy-agent";
    const ownerPrincipal: DemoOwnerPrincipal =
      agent.ownerPrincipal === "user-b" || agent.owner === "user-b" ? "user-b" : "user-a";
    return {
      ...(value as Agent),
      ownerPrincipal,
      agentPrincipal:
        typeof agent.agentPrincipal === "string" && agent.agentPrincipal.length > 0
          ? agent.agentPrincipal
          : "agent:" + id,
      codexHomeVersion:
        version === 3 && typeof agent.codexHomeVersion === "number"
          ? agent.codexHomeVersion
          : 0,
      activePolicyContextId:
        typeof agent.activePolicyContextId === "string" ? agent.activePolicyContextId : null,
    };
  });
  const runs = legacy.runs.map((value) => ({
    ...(value as AgentRun),
    progress: Array.isArray((value as Partial<AgentRun>).progress)
      ? (value as AgentRun).progress
      : [],
    mandateId:
      typeof (value as Partial<AgentRun>).mandateId === "string"
        ? (value as AgentRun).mandateId
        : version < 3 && typeof (value as Partial<AgentRun>).policyContextId === "string"
          ? (value as AgentRun).policyContextId
          : null,
    ownerPrincipal:
      (value as Partial<AgentRun>).ownerPrincipal === "user-b" ? "user-b" : null,
    agentPrincipal:
      typeof (value as Partial<AgentRun>).agentPrincipal === "string"
        ? (value as AgentRun).agentPrincipal
        : null,
  }));
  return {
    version: 3,
    agents: agents as Agent[],
    messages: legacy.messages as Database["messages"],
    runs: runs.map((run) => ({
      ...run,
      ...(version === 1
        ? {
            policyContextId: null,
            runGrantId: null,
            retryOfRunId: null,
            mandateStatus: "closed" as const,
            capabilityFingerprint: null,
            grantFingerprint: null,
            runtimeInstanceId: null,
          }
        : {}),
    })) as AgentRun[],
  };
}
