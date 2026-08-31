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
  it("does not publish a mutation in memory when persistence fails", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-test-"));
    temporaryDirectories.push(root);
    const originalPath = path.join(root, "db.json");
    const store = new JsonStore(originalPath);
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

  it("migrates legacy progress into typed session events", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "launchpad-store-migration-test-"));
    temporaryDirectories.push(root);
    const databasePath = path.join(root, "db.json");
    await writeFile(databasePath, JSON.stringify({
      version: 3,
      agents: [],
      messages: [],
      runs: [{
        id: "run-legacy",
        agentId: "agent-legacy",
        status: "completed",
        progress: [{
          id: "event-legacy",
          stage: "tool",
          label: "Running a workspace command",
          detail: "The Agent finished a command.",
          createdAt: "2026-08-31T00:00:00.000Z",
        }],
      }],
    }) + "\n");

    const store = new JsonStore(databasePath);
    await store.initialize();

    expect(store.snapshot().version).toBe(4);
    expect(store.snapshot().runs[0]?.progress[0]).toMatchObject({
      runId: "run-legacy",
      sequence: 1,
      kind: "command",
      state: "started",
      title: "Running a workspace command",
    });
    expect(JSON.parse(await readFile(databasePath, "utf8")).version).toBe(4);
  });
});
