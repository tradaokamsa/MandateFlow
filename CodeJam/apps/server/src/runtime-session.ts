import { posix } from "node:path";
import { redactRuntimeText } from "./trace.js";
import type {
  RunProgressStage,
  RunProgressEvent,
  RunnerProgressEvent,
  RuntimeSessionEventKind,
  RuntimeSessionEventState,
  RuntimeSessionSafeMetadata,
} from "./types.js";

const MAX_SAFE_PATHS = 8;
const MAX_SAFE_PATH_LENGTH = 160;
const MAX_SAFE_TOOL_LENGTH = 120;
const MAX_SAFE_DURATION_MS = 3_600_000;

const sensitivePathSegment = /(^|[._-])(env|secret|token|password|credential|private|key)([._-]|$)/i;

export function createRuntimeSessionEvent(
  runId: string,
  sequence: number,
  id: string,
  createdAt: string,
  event: RunnerProgressEvent,
): RunProgressEvent {
  const title = boundRuntimeText(event.title?.trim() || event.label, 160) || "Runtime activity";
  const kind = event.kind ?? kindFromLegacyEvent(event.stage, title);
  const state = event.state ?? stateFromLegacyStage(event.stage);
  const safeMetadata = sanitizeSafeMetadata(event.safeMetadata);
  return {
    id,
    runId,
    sequence,
    kind,
    state,
    title,
    detail: boundRuntimeText(event.detail, 500),
    stage: event.stage,
    label: title,
    ...(safeMetadata ? { safeMetadata } : {}),
    createdAt,
  };
}

export function createRunnerProgressEvent(input: {
  stage: RunProgressStage;
  kind: RuntimeSessionEventKind;
  state: RuntimeSessionEventState;
  title: string;
  detail: string;
  safeMetadata?: RuntimeSessionSafeMetadata;
}): RunnerProgressEvent {
  return {
    ...input,
    label: input.title,
  };
}

export function migrateRuntimeSessionEvent(
  runId: string,
  value: unknown,
  index: number,
): RunProgressEvent {
  const candidate = value && typeof value === "object"
    ? value as Partial<RunProgressEvent>
    : {};
  const stage = isRunProgressStage(candidate.stage) ? candidate.stage : "phase";
  const label = typeof candidate.label === "string" && candidate.label.trim()
    ? candidate.label.trim()
    : typeof candidate.title === "string" && candidate.title.trim()
      ? candidate.title.trim()
      : "Runtime activity";
  const event: RunnerProgressEvent = {
    stage,
    label,
    detail: typeof candidate.detail === "string" ? candidate.detail : "Runtime activity recorded.",
    ...(isRuntimeSessionEventKind(candidate.kind) ? { kind: candidate.kind } : {}),
    ...(isRuntimeSessionEventState(candidate.state) ? { state: candidate.state } : {}),
    ...(typeof candidate.title === "string" ? { title: candidate.title } : {}),
    ...(candidate.safeMetadata ? { safeMetadata: candidate.safeMetadata } : {}),
  };
  return createRuntimeSessionEvent(
    runId,
    typeof candidate.sequence === "number" && Number.isInteger(candidate.sequence) && candidate.sequence > 0
      ? candidate.sequence
      : index + 1,
    typeof candidate.id === "string" && candidate.id ? candidate.id : `legacy-${runId}-${index + 1}`,
    typeof candidate.createdAt === "string" && candidate.createdAt
      ? candidate.createdAt
      : new Date(0).toISOString(),
    event,
  );
}

export function sanitizeSafeMetadata(
  metadata: RuntimeSessionSafeMetadata | undefined,
): RuntimeSessionSafeMetadata | undefined {
  if (!metadata) return undefined;
  const paths = Array.isArray(metadata.paths)
    ? metadata.paths
        .filter((value): value is string => typeof value === "string")
        .map(safeWorkspacePath)
        .filter((value): value is string => value !== null)
        .slice(0, MAX_SAFE_PATHS)
    : [];
  const tool = typeof metadata.tool === "string"
    ? safeToolName(metadata.tool)
    : null;
  const durationMs = typeof metadata.durationMs === "number" &&
      Number.isFinite(metadata.durationMs) &&
      metadata.durationMs >= 0 &&
      metadata.durationMs <= MAX_SAFE_DURATION_MS
    ? Math.round(metadata.durationMs)
    : null;
  if (!paths.length && !tool && durationMs === null) return undefined;
  return {
    ...(paths.length ? { paths } : {}),
    ...(tool ? { tool } : {}),
    ...(durationMs !== null ? { durationMs } : {}),
  };
}

function safeWorkspacePath(value: string): string | null {
  const redacted = redactRuntimeText(value.trim()).replace(/[\\]/g, "/");
  if (!redacted || redacted.includes("[REDACTED")) return null;
  const workspaceRelative = redacted.match(/(?:^|\/)workspace\/(.+)$/i)?.[1] ?? redacted;
  const normalized = posix.normalize(workspaceRelative).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized === "..") {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => sensitivePathSegment.test(segment))) return null;
  const bounded = segments.length > 4 ? "…/" + segments.slice(-4).join("/") : segments.join("/");
  return bounded.slice(0, MAX_SAFE_PATH_LENGTH);
}

function boundRuntimeText(value: string, maxLength: number): string {
  const redacted = redactRuntimeText(value).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return redacted.length > maxLength ? redacted.slice(0, maxLength) + "…" : redacted;
}

function safeToolName(value: string): string | null {
  const tool = redactRuntimeText(value.trim());
  return /^[a-zA-Z0-9_.:-]{1,120}$/.test(tool) ? tool.slice(0, MAX_SAFE_TOOL_LENGTH) : null;
}

function kindFromLegacyEvent(
  stage: RunProgressStage,
  title: string,
): RuntimeSessionEventKind {
  if (stage === "tool") {
    if (/file|workspace file/i.test(title)) return "file_change";
    if (/protected|mcp|tool/i.test(title)) return "mcp";
    return "command";
  }
  if (stage === "error") return "error";
  if (/plan|planning|decid/i.test(title)) return "plan";
  if (/response|assistant/i.test(title)) return "assistant";
  return "status";
}

function stateFromLegacyStage(stage: RunProgressStage): RuntimeSessionEventState {
  switch (stage) {
    case "complete":
      return "completed";
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "started";
  }
}

function isRunProgressStage(value: unknown): value is RunProgressStage {
  return value === "queued" || value === "phase" || value === "tool" ||
    value === "complete" || value === "error" || value === "cancelled";
}

function isRuntimeSessionEventKind(value: unknown): value is RuntimeSessionEventKind {
  return value === "status" || value === "plan" || value === "command" ||
    value === "file_change" || value === "mcp" || value === "assistant" || value === "error";
}

function isRuntimeSessionEventState(value: unknown): value is RuntimeSessionEventState {
  return value === "started" || value === "streaming" || value === "completed" ||
    value === "failed" || value === "cancelled";
}
