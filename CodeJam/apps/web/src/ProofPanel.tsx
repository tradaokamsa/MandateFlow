import type { AgentRun, MandateEvidence } from "./types";
import { deriveProofSnapshot } from "./proof";
import { RuntimeSessionTimeline } from "./RuntimeSessionTimeline";

interface ProofPanelProps {
  evidence: MandateEvidence | null;
  activeRun: AgentRun | null;
  busy: boolean;
  canRun: boolean;
  canRetry: boolean;
  canStop: boolean;
  blockedReason?: string;
  onRunProof: () => void;
  onRetry: () => void;
  onStop: () => void;
}

export function ProofPanel({
  evidence,
  activeRun,
  busy,
  canRun,
  canRetry,
  canStop,
  blockedReason,
  onRunProof,
  onRetry,
  onStop,
}: ProofPanelProps) {
  const proof = deriveProofSnapshot(evidence, activeRun);
  const isRunning = activeRun != null && ["queued", "running"].includes(activeRun.status);
  const progress = activeRun?.progress ?? [];
  const currentProgress = progress.at(-1);
  const progressAge = currentProgress
    ? Date.now() - new Date(currentProgress.createdAt).getTime()
    : 0;
  const runtimeStalled = isRunning && progressAge > 12_000;
  const proofIncomplete = activeRun?.status === "failed";

  return (
    <section className="proof-console" aria-labelledby="proof-console-title">
      <div className="proof-console-header">
        <div>
          <span className="eyebrow">Live security proof</span>
          <h3 id="proof-console-title">What MandateFlow protected</h3>
          <p>
            An MCP scope can permit CRM. MandateFlow decides whether CRM may consume this specific reference.
          </p>
        </div>
        <span className={"proof-source " + (evidence ? "proof-source-live" : "proof-source-waiting")}>
          <span aria-hidden="true">{evidence ? "●" : "○"}</span>
          {evidence ? "Live Go gateway evidence" : "Awaiting a live run"}
        </span>
      </div>

      <div className="proof-actions">
        <button
          type="button"
          className="button button-primary"
          onClick={onRunProof}
          disabled={!canRun || busy || isRunning}
        >
          {isRunning ? <><span className="spinner" aria-hidden="true" /> Running proof…</> : "Run MandateFlow proof"}
        </button>
        {canRetry && (
          <button
            type="button"
            className="button button-ghost"
            onClick={onRetry}
            disabled={busy || isRunning}
          >
            Verify retry persistence
          </button>
        )}
        <span className="proof-action-note" role="status">
          {isRunning
            ? currentProgress?.detail ?? "The Runtime is collecting protected decisions."
            : evidence
              ? `${evidence.receipts.length} server receipts · CRM counter ${evidence.crmCounter}`
              : blockedReason ?? "The panel fills from the next Run's persisted receipts."}
        </span>
      </div>

      {activeRun && (
        <section className="run-activity" aria-live={isRunning ? "polite" : undefined} aria-labelledby="run-activity-title">
          <div className="run-activity-heading">
            <div>
              <span className="eyebrow">Runtime activity</span>
              <strong id="run-activity-title">
                {currentProgress?.title ?? (isRunning ? "Starting the Agent Runtime" : "Run activity")}
              </strong>
            </div>
            <div className="run-activity-actions">
              <span className={"run-status run-status-" + activeRun.status}>{activeRun.status}</span>
              {isRunning && canStop && (
                <button type="button" className="button button-danger button-compact" onClick={onStop} disabled={busy}>
                  Stop run
                </button>
              )}
            </div>
          </div>
          <RuntimeSessionTimeline
            run={activeRun}
            compact
            maxEvents={7}
            ariaLabel="Recent Agent Runtime activity"
          />
          {runtimeStalled && (
            <div className="run-stall-notice" role="alert">
              <span>
                No new Runtime event for {Math.max(1, Math.round(progressAge / 1000))}s. The Agent may be waiting on a model or command.
              </span>
              {canStop && (
                <button type="button" className="button button-ghost button-compact" onClick={onStop} disabled={busy}>
                  Stop and review
                </button>
              )}
            </div>
          )}
        </section>
      )}

      <div className="proof-rows" role="list" aria-label="MandateFlow proof outcomes">
        {proof.rows.map((row) => (
          <div className={"proof-row proof-row-" + row.state} role="listitem" key={row.id}>
            <span className="proof-row-icon" aria-hidden="true">{row.state === "complete" ? "✓" : "·"}</span>
            <span className="proof-row-copy">
              <strong>{row.label}</strong>
              <span>{row.detail}</span>
            </span>
            <span className="proof-row-status">
              {row.state === "complete" ? "Verified" : proofIncomplete ? "Not recorded" : "Pending"}
            </span>
          </div>
        ))}
      </div>

      <div className="proof-evidence-strip">
        <div>
          <span>Policy rule</span>
          <strong>
            {proof.ruleId ?? (proof.denial ? "Rule ID unavailable in receipt" : "Awaiting a denied CRM decision")}
          </strong>
        </div>
        <div>
          <span>Non-execution</span>
          <strong>
            {proof.nonExecution ?? (proof.denial ? "Counter proof unavailable" : "Awaiting the protected-action counter")}
          </strong>
        </div>
        <div>
          <span>Evidence source</span>
          <strong>{evidence ? `${evidence.policyId} v${evidence.policyVersion}` : "Go gateway + SQLite"}</strong>
        </div>
      </div>
    </section>
  );
}
