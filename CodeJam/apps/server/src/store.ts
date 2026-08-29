import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Database } from "./types.js";

const emptyDatabase = (): Database => ({
  version: 2,
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
      const parsed = JSON.parse(raw) as Database | { version: 1; agents: unknown[]; messages: unknown[]; runs: unknown[] };
      if (![1, 2].includes(parsed.version) || !Array.isArray(parsed.agents)) {
        throw new Error("Unsupported database format");
      }
      this.data = parsed.version === 1 ? migrateV1(parsed) : parsed;
      if (parsed.version === 1) await this.persist(this.data);
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

function migrateV1(legacy: {
  version: 1;
  agents: unknown[];
  messages: unknown[];
  runs: unknown[];
}): Database {
  return {
    version: 2,
    agents: legacy.agents.map((value) => ({
      ...(value as Database["agents"][number]),
      activePolicyContextId: null,
    })),
    messages: legacy.messages as Database["messages"],
    runs: legacy.runs.map((value) => ({
      ...(value as Database["runs"][number]),
      policyContextId: null,
      runGrantId: null,
      retryOfRunId: null,
      mandateStatus: "closed" as const,
      capabilityFingerprint: null,
      grantFingerprint: null,
      runtimeInstanceId: null,
    })),
  };
}
