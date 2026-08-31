import { execFile } from "node:child_process";
import {
  spawn,
  type ChildProcess,
  type ChildProcessByStdio,
} from "node:child_process";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import type { AppConfig } from "./config.js";
import { RunCancelledError } from "./errors.js";
import { GroqResponsesProxy } from "./groq-responses.js";
import {
  createRunnerProgressEvent,
  sanitizeSafeMetadata,
} from "./runtime-session.js";
import { redactRuntimeText } from "./trace.js";
import type {
  AgentRunner,
  RunUsage,
  RunnerProgressEvent,
  RunnerRequest,
  RunnerResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface ParsedEvents {
  messages: string[];
  threadId: string | null;
  usage: RunUsage | null;
  errors: string[];
  assistantStreaming?: boolean;
}

export function buildCodexArgs(
  request: RunnerRequest,
  sandboxMode: AppConfig["codexSandboxMode"],
  workspacePath = request.workspacePath,
  modelProviderBaseUrl?: string,
): string[] {
  const args = [
    ...(modelProviderBaseUrl
      ? [
          "--config",
          "model_providers.groq.base_url=" + JSON.stringify(modelProviderBaseUrl),
        ]
      : []),
    "exec",
    "--json",
    "--sandbox",
    sandboxMode,
    "--skip-git-repo-check",
    "-C",
    workspacePath,
  ];
  if (request.threadId) {
    args.push("resume", request.threadId, request.prompt);
  } else {
    args.push(request.prompt);
  }
  return args;
}

export function parseCodexEventLine(
  line: string,
  parsed: ParsedEvents,
  onProgress?: (event: RunnerProgressEvent) => void,
): void {
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }

  if (event.type === "thread.started" && typeof event.thread_id === "string") {
    parsed.threadId = event.thread_id;
    onProgress?.({
      ...createRunnerProgressEvent({
        stage: "phase",
        kind: "status",
        state: "completed",
        title: "Codex session connected",
        detail: "The Agent Runtime opened a secure coding session.",
      }),
    });
  }

  if (event.type === "turn.started") {
    onProgress?.({
      ...createRunnerProgressEvent({
        stage: "phase",
        kind: "plan",
        state: "started",
        title: "Agent is planning the next step",
        detail: "The Agent is deciding whether to inspect files, edit code, run a command, or use a protected tool.",
      }),
    });
  }

  if (event.type === "item.started" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    const progress = progressForCodexItem(item, false);
    if (progress) onProgress?.(progress);
    if (item.type === "agent_message") parsed.assistantStreaming = true;
  }

  if (event.type === "item.completed" && event.item && typeof event.item === "object") {
    const item = event.item as Record<string, unknown>;
    const progress = progressForCodexItem(item, true);
    if (progress) onProgress?.(progress);
    if (item.type === "agent_message" && typeof item.text === "string") {
      parsed.messages.push(item.text);
      parsed.assistantStreaming = false;
    }
  }

  if (event.type === "item.delta") {
    if (!parsed.assistantStreaming) {
      parsed.assistantStreaming = true;
      onProgress?.({
        ...createRunnerProgressEvent({
          stage: "phase",
          kind: "assistant",
          state: "streaming",
          title: "Agent response streaming",
          detail: "The Agent is composing a response from the completed workspace work.",
        }),
      });
    }
  }

  if (event.type === "turn.completed") {
    if (event.usage && typeof event.usage === "object") {
      const usage = event.usage as Record<string, unknown>;
      parsed.usage = {
        ...(typeof usage.input_tokens === "number"
          ? { inputTokens: usage.input_tokens }
          : {}),
        ...(typeof usage.cached_input_tokens === "number"
          ? { cachedInputTokens: usage.cached_input_tokens }
          : {}),
        ...(typeof usage.output_tokens === "number"
          ? { outputTokens: usage.output_tokens }
          : {}),
      };
    }
    onProgress?.({
      ...createRunnerProgressEvent({
        stage: "phase",
        kind: "status",
        state: "completed",
        title: "Agent turn complete",
        detail: "The Runtime finished this turn and is returning the result.",
      }),
    });
  }

  if (event.type === "error") {
    const message =
      typeof event.message === "string"
        ? event.message
        : typeof event.error === "string"
          ? event.error
          : "Codex reported an unknown error";
    parsed.errors.push(message);
    onProgress?.({
      ...createRunnerProgressEvent({
        stage: "error",
        kind: "error",
        state: "failed",
        title: "Codex reported an error",
        detail: "The Agent Runtime reported a problem before the Run could finish.",
      }),
    });
  }
}

function progressForCodexItem(
  item: Record<string, unknown>,
  completed: boolean,
): RunnerProgressEvent | null {
  const itemType = item.type;
  if (typeof itemType !== "string") return null;
  const failed = completed && (item.status === "failed" || item.status === "error");
  const suffix = failed ? " failed" : completed ? " complete" : "";
  const state = failed ? "failed" : completed ? "completed" : "started";
  const safeMetadata = sanitizeSafeMetadata(safeCodexMetadata(item));
  switch (itemType) {
    case "command_execution":
      return createRunnerProgressEvent({
        stage: failed ? "error" : "tool",
        kind: "command",
        state,
        title: "Running a workspace command" + suffix,
        detail: completed
          ? failed
            ? "The Agent command failed in the selected workspace."
            : "The Agent finished a command in the selected workspace."
          : "The Agent is running a command in the selected workspace.",
        ...(safeMetadata ? { safeMetadata } : {}),
      });
    case "file_change":
    case "file_edit":
      return createRunnerProgressEvent({
        stage: failed ? "error" : "tool",
        kind: "file_change",
        state,
        title: "Updating workspace files" + suffix,
        detail: completed
          ? failed
            ? "The Agent could not apply a code change in the selected workspace."
            : "The Agent applied a code change in the selected workspace."
          : "The Agent is preparing a code change in the selected workspace.",
        ...(safeMetadata ? { safeMetadata } : {}),
      });
    case "mcp_tool_call":
    case "tool_call":
      return createRunnerProgressEvent({
        stage: failed ? "error" : "tool",
        kind: "mcp",
        state,
        title: "Checking a protected tool call" + suffix,
        detail: completed
          ? failed
            ? "MandateFlow could not complete the protected-tool decision."
            : "MandateFlow recorded the protected-tool decision."
          : "MandateFlow is checking the call before the protected service runs.",
        ...(safeMetadata ? { safeMetadata } : {}),
      });
    case "agent_message":
      return createRunnerProgressEvent({
        stage: "phase",
        kind: "assistant",
        state: completed ? "completed" : "streaming",
        title: "Preparing the Agent response" + suffix,
        detail: "The Agent is assembling a safe summary of the work.",
      });
    default:
      return null;
  }
}

function safeCodexMetadata(item: Record<string, unknown>) {
  const paths = extractPaths(item);
  const durationMs = typeof item.duration_ms === "number"
    ? item.duration_ms
    : typeof item.durationMs === "number"
      ? item.durationMs
      : undefined;
  const tool = typeof item.tool === "string"
    ? item.tool
    : typeof item.name === "string"
      ? item.name
      : undefined;
  if (!paths.length && durationMs === undefined && !tool) return undefined;
  return {
    ...(paths.length ? { paths } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tool ? { tool } : {}),
  };
}

function extractPaths(item: Record<string, unknown>): string[] {
  const paths: string[] = [];
  if (typeof item.path === "string") paths.push(item.path);
  if (Array.isArray(item.changes)) {
    for (const change of item.changes) {
      if (change && typeof change === "object" && typeof (change as Record<string, unknown>).path === "string") {
        paths.push((change as Record<string, unknown>).path as string);
      }
    }
  }
  return paths;
}

export class CodexRunner implements AgentRunner {
  private readonly active = new Map<
    string,
    {
      child: ChildProcess;
      cancelled: boolean;
      timedOut: boolean;
      outputExceeded: boolean;
      settled: Promise<void>;
      forceKillTimer: NodeJS.Timeout | null;
    }
  >();

  constructor(private readonly config: AppConfig) {}

  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync(this.config.codexBin, ["--version"], {
        timeout: 5_000,
        env: this.childEnvironment(),
      });
      return true;
    } catch {
      return false;
    }
  }

  async cancel(runId: string): Promise<boolean> {
    const active = this.active.get(runId);
    if (!active) {
      return false;
    }
    active.cancelled = true;
    this.terminate(active);
    await active.settled;
    return true;
  }

  async run(request: RunnerRequest): Promise<RunnerResult> {
    if (this.active.has(request.runId)) {
      throw new Error("Run already has an active Codex process");
    }

    const proxy = new GroqResponsesProxy(this.config.groqBaseUrl);
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      const proxyBaseUrl = await proxy.start();
      const args = buildCodexArgs(
        request,
        this.config.codexSandboxMode,
        request.workspacePath,
        proxyBaseUrl,
      );
      child = spawn(this.config.codexBin, args, {
        cwd: request.workspacePath,
        env: this.childEnvironment(request.mandateFlowCapability, request.codexHomePath),
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await proxy.close();
      throw error;
    }
    const settled = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.once("error", () => resolve());
    });
    const active = {
      child,
      cancelled: false,
      timedOut: false,
      outputExceeded: false,
      settled,
      forceKillTimer: null as NodeJS.Timeout | null,
    };
    this.active.set(request.runId, active);

    const parsed: ParsedEvents = {
      messages: [],
      threadId: request.threadId,
      usage: null,
      errors: [],
    };
    let stdout = "";
    let stderr = "";
    let totalBytes = 0;

    const consume = (chunk: Buffer, target: "stdout" | "stderr") => {
      totalBytes += chunk.byteLength;
      if (totalBytes > this.config.codexMaxOutputBytes) {
        active.outputExceeded = true;
        this.terminate(active);
        return;
      }
      if (target === "stdout") {
        stdout += chunk.toString("utf8");
        const lines = stdout.split(/\r?\n/);
        stdout = lines.pop() ?? "";
        for (const line of lines) {
          parseCodexEventLine(
            redactRuntimeText(
              redactRuntimeOutput(line, request.mandateFlowCapability),
              this.config.groqApiKey,
            ),
            parsed,
            request.onProgress,
          );
        }
      } else {
        stderr += chunk.toString("utf8");
        if (stderr.length > 16_384) {
          stderr = stderr.slice(-16_384);
        }
      }
    };

    child.stdout.on("data", (chunk: Buffer) => consume(chunk, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => consume(chunk, "stderr"));

    const timeout = setTimeout(() => {
      active.timedOut = true;
      this.terminate(active);
    }, this.config.codexTimeoutMs);
    timeout.unref();

    try {
      const exitCode = await new Promise<number>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => resolve(code ?? 1));
      });
      if (stdout.trim()) {
        parseCodexEventLine(
          redactRuntimeText(
            redactRuntimeOutput(stdout.trim(), request.mandateFlowCapability),
            this.config.groqApiKey,
          ),
          parsed,
          request.onProgress,
        );
      }
      if (active.cancelled) {
        throw new RunCancelledError();
      }
      if (active.timedOut) {
        throw new Error("Codex timed out after " + this.config.codexTimeoutMs + " ms");
      }
      if (active.outputExceeded) {
        throw new Error("Codex output exceeded CODEX_MAX_OUTPUT_BYTES");
      }
      if (exitCode !== 0) {
        const detail =
          parsed.errors.at(-1) ??
          redactRuntimeText(
            redactRuntimeOutput(stderr.trim(), request.mandateFlowCapability),
            this.config.groqApiKey,
          ) ??
          "No error detail";
        throw new Error("Codex exited with code " + exitCode + ": " + detail);
      }
      const output = redactRuntimeText(
        redactRuntimeOutput(parsed.messages.at(-1)?.trim() ?? "", request.mandateFlowCapability),
        this.config.groqApiKey,
      );
      if (!output) {
        throw new Error("Codex completed without an agent message");
      }
      return {
        output,
        threadId: parsed.threadId,
        usage: parsed.usage,
        runtimeInstanceId: "local-process-" + request.runId.slice(0, 12),
      };
    } finally {
      clearTimeout(timeout);
      if (active.forceKillTimer) clearTimeout(active.forceKillTimer);
      this.active.delete(request.runId);
      await proxy.close();
    }
  }

  private terminate(active: {
    child: ChildProcess;
    forceKillTimer: NodeJS.Timeout | null;
  }): void {
    if (active.child.exitCode !== null || active.child.signalCode !== null) return;
    active.child.kill("SIGTERM");
    if (!active.forceKillTimer) {
      active.forceKillTimer = setTimeout(() => active.child.kill("SIGKILL"), 3_000);
      active.forceKillTimer.unref();
    }
  }

  private childEnvironment(
    mandateFlowCapability = "",
    codexHomePath = this.config.codexHome,
  ): NodeJS.ProcessEnv {
    const inheritedNames = [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "SSL_CERT_FILE",
      "SSL_CERT_DIR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "NODE_EXTRA_CA_CERTS",
      "TERM",
    ] as const;
    const environment: NodeJS.ProcessEnv = {
      CODEX_HOME: codexHomePath,
      GROQ_API_KEY: this.config.groqApiKey,
      NO_COLOR: "1",
    };
    if (mandateFlowCapability) {
      environment.MANDATEFLOW_RUN_CAPABILITY = mandateFlowCapability;
    }
    for (const name of inheritedNames) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    return environment;
  }
}

export function redactRuntimeOutput(value: string, capability: string): string {
  const capabilityRedacted = capability
    ? value.split(capability).join("[REDACTED_RUN_CAPABILITY]")
    : value;
  return capabilityRedacted.replace(
    /\bref1_[A-Za-z0-9_-]{43}\b/g,
    "[REDACTED_PROTECTED_REFERENCE]",
  );
}
