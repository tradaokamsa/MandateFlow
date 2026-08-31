import type { AgentRun, RuntimeSessionEvent } from "./types";

interface RuntimeSessionTimelineProps {
  run: AgentRun;
  compact?: boolean;
  maxEvents?: number;
  live?: boolean;
  ariaLabel?: string;
}

function formatProgressTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(value));
}

function eventIcon(event: RuntimeSessionEvent): string {
  if (event.state === "failed") return "!";
  if (event.state === "cancelled") return "–";
  if (event.state === "completed") return "✓";
  switch (event.kind) {
    case "command":
      return "⌘";
    case "file_change":
      return "✎";
    case "mcp":
      return "↗";
    case "assistant":
      return "✦";
    case "plan":
      return "·";
    default:
      return "·";
  }
}

function eventClass(event: RuntimeSessionEvent): string {
  return [
    "run-progress-item",
    "run-progress-" + event.stage,
    "run-event-kind-" + event.kind,
    "run-event-state-" + event.state,
  ].join(" ");
}

function SafeEventDetails({ event }: { event: RuntimeSessionEvent }) {
  const metadata = event.safeMetadata;
  if (!metadata) return null;
  const hasDetails = Boolean(
    metadata.tool || metadata.durationMs !== undefined || metadata.paths?.length,
  );
  if (!hasDetails) return null;
  return (
    <details className="run-progress-details">
      <summary>Safe details</summary>
      <div className="run-progress-metadata">
        {metadata.tool && <span>Tool: <code>{metadata.tool}</code></span>}
        {metadata.durationMs !== undefined && <span>Duration: {metadata.durationMs}ms</span>}
        {metadata.paths?.length ? (
          <span>
            Files: {metadata.paths.map((path, index) => <code key={path + index}>{path}</code>)}
          </span>
        ) : null}
      </div>
    </details>
  );
}

export function RuntimeSessionTimeline({
  run,
  compact = false,
  maxEvents,
  live = false,
  ariaLabel = "Agent Runtime session activity",
}: RuntimeSessionTimelineProps) {
  const events = maxEvents ? run.progress.slice(-maxEvents) : run.progress;
  if (!events.length) return null;
  return (
    <div
      className={"runtime-session-timeline" + (compact ? " runtime-session-timeline-compact" : "")}
      aria-live={live ? "polite" : undefined}
    >
      <ol className="run-progress-list" aria-label={ariaLabel}>
        {events.map((event) => (
          <li className={eventClass(event)} key={event.id}>
            <span className="run-progress-icon" aria-hidden="true">{eventIcon(event)}</span>
            <span className="run-progress-copy">
              <span className="run-progress-title-row">
                <strong>{event.title}</strong>
                <em className="run-progress-state">{event.state}</em>
              </span>
              <span>{event.detail}</span>
              <SafeEventDetails event={event} />
            </span>
            <time dateTime={event.createdAt}>{formatProgressTime(event.createdAt)}</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
