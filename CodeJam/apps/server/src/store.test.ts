import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonStore } from "./store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("JsonStore", () => {
  it("creates an empty validated v2 database", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    const store = new JsonStore(filePath);

    await store.initialize();

    expect(store.snapshot()).toMatchObject({
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
  });

  it("validates and migrates a v1 database without losing starter state", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        agents: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            name: "Legacy",
            description: "",
            instructions: "",
            status: "ready",
            workspacePath: "/tmp/legacy",
            codexThreadId: "thread-before-migration",
            lastError: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        messages: [],
        runs: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            agentId: "11111111-1111-4111-8111-111111111111",
            status: "completed",
            prompt: "legacy prompt",
            output: "legacy output",
            error: null,
            usage: null,
            startedAt: "2026-01-01T00:00:01.000Z",
            completedAt: "2026-01-01T00:00:02.000Z",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const store = new JsonStore(filePath);

    await store.initialize();

    const database = store.snapshot();
    expect(database.version).toBe(2);
    expect(database.agents[0]).toMatchObject({
      codexThreadId: "thread-before-migration",
      activePolicyContextId: null,
    });
    expect(database.runs[0]).toMatchObject({
      output: "legacy output",
      policyContextId: null,
      runGrantId: null,
      retryOfRunId: null,
      capabilityFingerprint: null,
      runtimeFingerprint: null,
    });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({ version: 2 });
  });

  it("rejects unknown database versions instead of resetting them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const filePath = path.join(root, "db.json");
    await writeFile(filePath, JSON.stringify({ version: 99, agents: [] }), "utf8");

    await expect(new JsonStore(filePath).initialize()).rejects.toThrow(
      /Unsupported database format/,
    );
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual({
      version: 99,
      agents: [],
    });
  });

  it("rejects thenable mutation callbacks without publishing them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();

    await expect(
      store.mutate(
        ((database: ReturnType<JsonStore["snapshot"]>) => {
          database.messages.push({
            id: "message-async",
            agentId: "agent-1",
            runId: "run-1",
            role: "user",
            content: "must not publish",
            createdAt: new Date().toISOString(),
          });
          return Promise.resolve("unsafe");
        }) as never,
      ),
    ).rejects.toThrow(/synchronous/);
    expect(store.snapshot().messages).toEqual([]);
  });

  it("does not expose published state through callback or result aliases", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();
    let leakedDraft: ReturnType<JsonStore["snapshot"]> | null = null;

    const returned = await store.mutate((database) => {
      leakedDraft = database;
      const counter = {
        policyContextId: "33333333-3333-4333-8333-333333333333",
        tool: "crm.resolve_customer" as const,
        count: 1,
      };
      database.fixtureCounters.push(counter);
      return counter;
    });
    returned.count = 999;
    if (leakedDraft) {
      (leakedDraft as ReturnType<JsonStore["snapshot"]>).fixtureCounters[0]!.count = 888;
    }

    expect(store.snapshot().fixtureCounters[0]?.count).toBe(1);
  });

  it("does not commit when a callback result cannot be safely cloned", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const store = new JsonStore(path.join(root, "db.json"));
    await store.initialize();

    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-uncloneable",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not commit",
          createdAt: new Date().toISOString(),
        });
        return () => "uncloneable";
      }),
    ).rejects.toThrow();

    expect(store.snapshot().messages).toEqual([]);
  });

  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const persistenceFailures: Error[] = [];
    const store = new JsonStore(originalPath, {
      onPersistenceFailure: (error) => persistenceFailures.push(error),
    });
    await store.initialize();

    const mutableStore = store as unknown as { filePath: string };
    mutableStore.filePath = path.join(root, "missing-directory", "db.json");
    await expect(
      store.mutate((database) => {
        database.messages.push({
          id: "message-1",
          agentId: "agent-1",
          runId: "run-1",
          role: "user",
          content: "must not become visible",
          createdAt: new Date().toISOString(),
        });
      }),
    ).rejects.toThrow();
    expect(store.snapshot().messages).toEqual([]);
    expect(persistenceFailures).toHaveLength(1);

    mutableStore.filePath = originalPath;
    await store.mutate((database) => {
      database.messages.push({
        id: "message-2",
        agentId: "agent-1",
        runId: "run-2",
        role: "user",
        content: "queue recovered",
        createdAt: new Date().toISOString(),
      });
    });
    expect(store.snapshot().messages.map((message) => message.content)).toEqual([
      "queue recovered",
    ]);
  });
});
