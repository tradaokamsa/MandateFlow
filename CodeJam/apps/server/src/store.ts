import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  databaseV1Schema,
  databaseV2Schema,
  type DatabaseV1,
} from "./mandateflow/schemas.js";
import type { DatabaseV2 } from "./mandateflow/types.js";

const emptyDatabase = (): DatabaseV2 => ({
  version: 2,
  agents: [],
  messages: [],
  runs: [],
  policyContexts: [],
  runGrants: [],
  protectedReferences: [],
  policyReceipts: [],
  fixtureCounters: [],
});

interface JsonStoreOptions {
  onPersistenceFailure?: (error: Error) => void;
}

function migrateV1(database: DatabaseV1): DatabaseV2 {
  return {
    version: 2,
    agents: database.agents.map((agent) => ({
      ...agent,
      activePolicyContextId: null,
    })),
    messages: database.messages,
    runs: database.runs.map((run) => ({
      ...run,
      policyContextId: null,
      runGrantId: null,
      retryOfRunId: null,
      capabilityFingerprint: null,
      runtimeFingerprint: null,
    })) as DatabaseV2["runs"],
    policyContexts: [],
    runGrants: [],
    protectedReferences: [],
    policyReceipts: [],
    fixtureCounters: [],
  };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export class JsonStore {
  private data: DatabaseV2 = emptyDatabase();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private filePath: string,
    private readonly options: JsonStoreOptions = {},
  ) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      const unknownValue: unknown = JSON.parse(raw);
      const v2 = databaseV2Schema.safeParse(unknownValue);
      if (v2.success) {
        this.data = structuredClone(v2.data) as DatabaseV2;
        return;
      }
      const v1 = databaseV1Schema.safeParse(unknownValue);
      if (!v1.success) {
        throw new Error("Unsupported database format");
      }
      const migrated = databaseV2Schema.parse(migrateV1(v1.data)) as DatabaseV2;
      await this.persist(migrated);
      this.data = structuredClone(migrated);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const initial = emptyDatabase();
      await this.persist(initial);
      this.data = initial;
    }
  }

  snapshot(): DatabaseV2 {
    return structuredClone(this.data);
  }

  async mutate<T>(mutation: (database: DatabaseV2) => T): Promise<T> {
    let returned!: T;
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.data);
      const result = mutation(draft);
      if (isThenable(result)) {
        throw new Error("JsonStore mutation callbacks must be synchronous");
      }
      const publishable = databaseV2Schema.parse(
        structuredClone(draft),
      ) as DatabaseV2;
      const safeResult = structuredClone(result);
      await this.persist(publishable);
      this.data = publishable;
      returned = safeResult;
    });
    this.queue = operation.catch(() => undefined);
    await operation;
    return returned;
  }

  private async persist(data: DatabaseV2): Promise<void> {
    const temporaryPath = this.filePath + ".tmp";
    try {
      await writeFile(temporaryPath, JSON.stringify(data, null, 2) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      const persistenceError =
        error instanceof Error ? error : new Error(String(error));
      this.options.onPersistenceFailure?.(persistenceError);
      throw persistenceError;
    }
  }
}
