import { describe, expect, it } from "vitest";
import {
  createRuntimeSessionEvent,
  migrateRuntimeSessionEvent,
  sanitizeSafeMetadata,
} from "./runtime-session.js";

describe("Runtime session events", () => {
  it("adds stable run identity and sequence data to legacy progress", () => {
    const event = migrateRuntimeSessionEvent(
      "run-123",
      {
        id: "legacy-event",
        stage: "tool",
        label: "Running a workspace command",
        detail: "The command completed",
        createdAt: "2026-08-31T00:00:00.000Z",
      },
      0,
    );

    expect(event).toMatchObject({
      id: "legacy-event",
      runId: "run-123",
      sequence: 1,
      kind: "command",
      state: "started",
      title: "Running a workspace command",
    });
  });

  it("redacts and bounds metadata before it can be persisted", () => {
    const metadata = sanitizeSafeMetadata({
      paths: ["/workspace/src/index.ts", "/workspace/.env", "../../private/token.txt"],
      durationMs: 120.6,
      tool: "crm.resolve_customer",
    });
    const event = createRuntimeSessionEvent(
      "run-123",
      2,
      "event-2",
      "2026-08-31T00:00:01.000Z",
      {
        stage: "tool",
        label: "Protected tool call complete",
        detail: "Authorization: Bearer should-never-persist",
        kind: "mcp",
        state: "completed",
        title: "Protected tool call complete",
        ...(metadata ? { safeMetadata: metadata } : {}),
      },
    );

    expect(event.safeMetadata).toEqual({
      paths: ["src/index.ts"],
      tool: "crm.resolve_customer",
      durationMs: 121,
    });
    expect(event.detail).toContain("Authorization: Bearer [REDACTED]");
    expect(JSON.stringify(event)).not.toContain(".env");
    expect(JSON.stringify(event)).not.toContain("private");
    expect(JSON.stringify(event)).not.toContain("should-never-persist");
  });
});
