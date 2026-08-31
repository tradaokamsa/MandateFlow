import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RuntimeSessionTimeline } from "./RuntimeSessionTimeline";
import type { AgentRun } from "./types";

const run: AgentRun = {
  id: "run-123",
  agentId: "agent-123",
  status: "completed",
  prompt: "Build a CLI",
  output: "Done",
  error: null,
  usage: null,
  startedAt: "2026-08-31T00:00:00.000Z",
  completedAt: "2026-08-31T00:00:02.000Z",
  policyContextId: null,
  runGrantId: null,
  mandateId: null,
  ownerPrincipal: null,
  agentPrincipal: null,
  retryOfRunId: null,
  mandateStatus: "closed",
  capabilityFingerprint: null,
  grantFingerprint: null,
  runtimeInstanceId: "runtime-123",
  progress: [
    {
      id: "event-1",
      runId: "run-123",
      sequence: 1,
      kind: "file_change",
      state: "completed",
      title: "Updating workspace files complete",
      label: "Updating workspace files complete",
      stage: "tool",
      detail: "The Agent applied a code change in the selected workspace.",
      safeMetadata: { paths: ["src/weather.ts"], durationMs: 125 },
      createdAt: "2026-08-31T00:00:01.000Z",
    },
  ],
  createdAt: "2026-08-31T00:00:00.000Z",
};

describe("RuntimeSessionTimeline", () => {
  it("renders typed state and expandable safe metadata", () => {
    const markup = renderToStaticMarkup(
      <RuntimeSessionTimeline run={run} live ariaLabel="Session events" />,
    );

    expect(markup).toContain("Updating workspace files complete");
    expect(markup).toContain("completed");
    expect(markup).toContain("Safe details");
    expect(markup).toContain("src/weather.ts");
    expect(markup).toContain("125ms");
    expect(markup).toContain('aria-label="Session events"');
    expect(markup).toContain('aria-live="polite"');
  });
});
