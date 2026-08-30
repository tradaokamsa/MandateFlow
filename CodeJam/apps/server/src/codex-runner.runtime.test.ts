import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: spawnMock };
});

import { CodexRunner } from "./codex-runner.js";

interface FixtureChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fixtureChild(lines: string[], exitCode: number): FixtureChild {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(),
  }) as FixtureChild;
  setTimeout(() => {
    for (const line of lines) child.stdout.emit("data", Buffer.from(line + "\n"));
    child.exitCode = exitCode;
    child.emit("close", exitCode);
  }, 0);
  return child;
}

function runner(): CodexRunner {
  return new CodexRunner(loadConfig({
    NODE_ENV: "test",
    CODEX_BIN: "codex-fixture",
    CODEX_HOME: "/tmp/codex-home",
    GROQ_API_KEY: "gsk-runtime-secret",
    GROQ_BASE_URL: "http://127.0.0.1:1/openai/v1",
  }));
}

describe("local Codex runner Groq proxy wiring", () => {
  beforeEach(() => spawnMock.mockReset());

  it("starts a per-run loopback proxy and keeps the key in the child environment", async () => {
    spawnMock.mockReturnValue(fixtureChild([
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "GROQ_API_KEY=gsk-runtime-secret" },
      }),
    ], 0));

    const result = await runner().run({
      runId: "run-123",
      agentId: "agent-1",
      workspacePath: "/tmp/workspace",
      prompt: "do work",
      threadId: null,
      mandateFlowCapability: "",
    });

    expect(result.output).toBe("GROQ_API_KEY=[REDACTED]");
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe("codex-fixture");
    expect(args).toContain("--config");
    const configValue = args[args.indexOf("--config") + 1] ?? "";
    expect(configValue).toMatch(
      /^model_providers\.groq\.base_url=\"http:\/\/127\.0\.0\.1:\d+\/openai\/v1\"$/,
    );
    expect(options.env.GROQ_API_KEY).toBe("gsk-runtime-secret");
    expect(args.join(" ")).not.toContain("gsk-runtime-secret");
  });
});
