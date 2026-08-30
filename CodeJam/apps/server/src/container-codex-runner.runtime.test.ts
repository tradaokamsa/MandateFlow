import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: spawnMock };
});

import { ContainerCodexRunner } from "./container-codex-runner.js";

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

function runner(): ContainerCodexRunner {
  return new ContainerCodexRunner(loadConfig({
    NODE_ENV: "test",
    RUNTIME_PROVIDER: "container",
    CONTAINER_ENGINE: "container-fixture",
    CONTAINER_RUNTIME_IMAGE: "runtime:test",
    CODEX_HOME: "/tmp/codex-home",
    GROQ_API_KEY: "container-secret",
  }));
}

describe("container Codex runner Groq proxy wiring", () => {
  beforeEach(() => spawnMock.mockReset());

  it("starts the bundled proxy before Codex and passes the key only as environment", async () => {
    spawnMock.mockReturnValue(fixtureChild([
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Done" } }),
    ], 0));

    const result = await runner().run({
      runId: "run-123",
      agentId: "agent-1",
      workspacePath: "/tmp/workspace",
      prompt: "do work",
      threadId: null,
      mandateFlowCapability: "",
    });

    expect(result.output).toBe("Done");
    const [command, args, options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: NodeJS.ProcessEnv },
    ];
    expect(command).toBe("container-fixture");
    expect(args).toContain("GROQ_API_KEY");
    expect(args).toContain("GROQ_UPSTREAM_BASE_URL");
    expect(args).toContain("GROQ_RESPONSES_PROXY_PORT=34567");
    expect(args.join(" ")).toContain("/opt/launchpad/groq-responses-proxy.mjs");
    expect(args.join(" ")).toContain(
      'model_providers.groq.base_url="http://127.0.0.1:34567/openai/v1"',
    );
    expect(options.env).toMatchObject({
      GROQ_API_KEY: "container-secret",
      GROQ_UPSTREAM_BASE_URL: "https://api.groq.com/openai/v1",
      GROQ_RESPONSES_PROXY_PORT: "34567",
    });
    expect(args.join(" ")).not.toContain("container-secret");
  });
});
