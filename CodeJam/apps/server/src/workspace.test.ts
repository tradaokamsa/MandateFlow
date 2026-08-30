import { describe, expect, it } from "vitest";
import path from "node:path";
import { agentCodexHomePath } from "./workspace.js";

describe("Agent Codex homes", () => {
  it("derives distinct deterministic homes under the configured root", () => {
    const root = path.join("/tmp", "mandateflow-codex");
    expect(agentCodexHomePath(root, "agent-a")).toBe(
      path.join(root, "agents", "agent-a"),
    );
    expect(agentCodexHomePath(root, "agent-a")).not.toBe(
      agentCodexHomePath(root, "agent-b"),
    );
  });

  it("rejects path traversal instead of escaping the configured root", () => {
    expect(() => agentCodexHomePath("/tmp/mandateflow-codex", "../shared")).toThrow();
  });
});
