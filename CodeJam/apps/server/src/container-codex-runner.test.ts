import { describe, expect, it } from "vitest";
import { CAPABILITY_ENV, loadConfig } from "./config.js";
import {
  buildContainerEnvironment,
  buildContainerRunArgs,
  containerName,
} from "./container-codex-runner.js";

describe("Container Codex runner", () => {
  it("builds an isolated Docker/Podman-compatible invocation", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      ARK_API_KEY: "secret-that-must-not-appear-in-argv",
      ARK_MODEL: "ep-test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
      CONTAINER_ENGINE: "podman",
      CONTAINER_RUNTIME_IMAGE: "runtime:test",
      CONTAINER_USER: "501:20",
      RUNTIME_INSTANCE_ID: "test-instance",
      MANDATEFLOW_CONTAINER_ADD_HOST: "host.docker.internal:host-gateway",
    });
    const capability = "mfr1_" + "b".repeat(43);
    const args = buildContainerRunArgs(
      {
        runId: "run/unsafe",
        agentId: "agent/unsafe",
        workspacePath: "/tmp/agent-workspace",
        prompt: "write a small program",
        threadId: null,
        mandateFlowCapability: capability,
      },
      config,
    );

    expect(containerName("run/unsafe", "test-instance")).toBe(
      "launchpad-test-instance-run-unsafe",
    );
    expect(args).toContain("runtime:test");
    expect(args).toContain("type=bind,src=/tmp/agent-workspace,dst=/workspace");
    expect(args).toContain("type=bind,src=/tmp/codex-home,dst=/codex-home");
    expect(args).toContain("501:20");
    expect(args).toContain("workspace-write");
    expect(args).toContain("/workspace");
    expect(args).toContain("io.codejam.instance-id=test-instance");
    expect(args).toContain("io.codejam.run-id=run/unsafe");
    expect(args).toContain("io.codejam.agent-id=agent/unsafe");
    expect(args).toContain("host.docker.internal:host-gateway");
    expect(args).toContain(CAPABILITY_ENV);
    expect(args).toContain("keep-id");
    expect(args).not.toContain("secret-that-must-not-appear-in-argv");
    expect(args).not.toContain(capability);
    expect(buildContainerEnvironment(config, capability, {})[CAPABILITY_ENV]).toBe(
      capability,
    );
  });

  it("resumes a thread inside the mounted Runtime workspace", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      CODEX_HOME: "/tmp/codex-home",
      RUNTIME_PROVIDER: "container",
    });
    const args = buildContainerRunArgs(
      {
        runId: "run",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "continue",
        threadId: "thread-123",
        mandateFlowCapability: null,
      },
      config,
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "continue"]);
    expect(args).not.toContain("keep-id");
  });
});
