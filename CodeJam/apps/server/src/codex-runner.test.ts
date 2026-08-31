import { describe, expect, it } from "vitest";
import {
  buildCodexArgs,
  parseCodexEventLine,
  redactRuntimeOutput,
} from "./codex-runner.js";

describe("Codex runner protocol", () => {
  it("builds a new-session invocation", () => {
    const args = buildCodexArgs(
      {
        runId: "run-1",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
        mandateFlowCapability: "",
      },
      "workspace-write",
    );
    expect(args).toEqual([
      "exec",
      "--json",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "-C",
      "/tmp/workspace",
      "build a calculator",
    ]);
  });

  it("resumes a stored Codex thread", () => {
    const args = buildCodexArgs(
      {
        runId: "run-2",
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "add tests",
        threadId: "thread-123",
        mandateFlowCapability: "",
      },
      "workspace-write",
    );
    expect(args.slice(-3)).toEqual(["resume", "thread-123", "add tests"]);
  });

  it("overrides the Groq provider URL without putting the API key in argv", () => {
    const args = buildCodexArgs(
      {
        agentId: "agent",
        workspacePath: "/tmp/workspace",
        prompt: "build a calculator",
        threadId: null,
      },
      "workspace-write",
      "/tmp/workspace",
      "http://127.0.0.1:45678/openai/v1",
    );

    expect(args.slice(0, 2)).toEqual([
      "--config",
      'model_providers.groq.base_url="http://127.0.0.1:45678/openai/v1"',
    ]);
    expect(args.join(" ")).not.toContain("gsk-secret-key");
  });

  it("extracts the session, final message and usage", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null as {
        inputTokens?: number;
        cachedInputTokens?: number;
        outputTokens?: number;
      } | null,
      errors: [] as string[],
    };
    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Done." },
      }),
      parsed,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
      parsed,
    );
    expect(parsed.threadId).toBe("thread-123");
    expect(parsed.messages).toEqual(["Done."]);
    expect(parsed.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
  });

  it("emits safe activity summaries without exposing command details", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    const progress: string[] = [];
    const onProgress = (event: { label: string; detail: string }) => {
      progress.push(event.label + " — " + event.detail);
    };

    parseCodexEventLine(
      JSON.stringify({ type: "thread.started", thread_id: "thread-123" }),
      parsed,
      onProgress,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.started",
        item: { type: "command_execution", command: "cat secret.txt" },
      }),
      parsed,
      onProgress,
    );

    expect(progress).toEqual([
      "Codex session connected — The Agent Runtime opened a secure coding session.",
      "Running a workspace command — The Agent is running a command in the selected workspace.",
    ]);
    expect(progress.join(" ")).not.toContain("secret.txt");
  });

  it("classifies coding-session items and keeps metadata safe", () => {
    const parsed = {
      messages: [] as string[],
      threadId: null as string | null,
      usage: null,
      errors: [] as string[],
    };
    const events: Array<Record<string, unknown>> = [];
    const onProgress = (event: Record<string, unknown>) => events.push(event);

    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [
            { path: "/workspace/src/weather.ts", kind: "update" },
            { path: "/workspace/.env", kind: "update" },
          ],
          duration_ms: 125,
        },
      }),
      parsed,
      onProgress,
    );
    parseCodexEventLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "mcp_tool_call", tool: "crm.resolve_customer" },
      }),
      parsed,
      onProgress,
    );
    parseCodexEventLine(JSON.stringify({ type: "item.delta", delta: "safe preview" }), parsed, onProgress);

    expect(events[0]).toMatchObject({
      kind: "file_change",
      state: "completed",
      title: "Updating workspace files complete",
      safeMetadata: {
        paths: ["src/weather.ts"],
        durationMs: 125,
      },
    });
    expect(events[1]).toMatchObject({
      kind: "mcp",
      state: "completed",
      safeMetadata: { tool: "crm.resolve_customer" },
    });
    expect(events[2]).toMatchObject({
      kind: "assistant",
      state: "streaming",
      title: "Agent response streaming",
    });
    expect(JSON.stringify(events)).not.toContain(".env");
    expect(JSON.stringify(events)).not.toContain("safe preview");
  });

  it("redacts Run authority and opaque protected references from captured output", () => {
    const capability = "mfr1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const reference = "ref1_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const redacted = redactRuntimeOutput(
      `capability=${capability} reference=${reference}`,
      capability,
    );
    expect(redacted).toBe(
      "capability=[REDACTED_RUN_CAPABILITY] reference=[REDACTED_PROTECTED_REFERENCE]",
    );
  });
});
