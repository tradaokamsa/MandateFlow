import type { AgentRun, MandateEvidence } from "./types";
import { deriveProofSnapshot } from "./proof";

interface ProofPanelProps {
  evidence: MandateEvidence | null;
  activeRun: AgentRun | null;
  busy: boolean;
  canRun: boolean;
  canRetry: boolean;
  onRunProof: () => void;
  onRetry: () => void;
}

export function ProofPanel({
  evidence,
  activeRun,
  busy,
  canRun,
  canRetry,
  onRunProof,
  onRetry,
}: ProofPanelProps) {
  const proof = deriveProofSnapshot(evidence, activeRun);
  const isRunning = activeRun != null && ["queued", "running"].includes(activeRun.status);

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
            ? "The Runtime is collecting protected decisions."
            : evidence
              ? `${evidence.receipts.length} server receipts · CRM counter ${evidence.crmCounter}`
              : "The panel fills from the next Run's persisted receipts."}
        </span>
      </div>

      <div className="proof-rows" role="list" aria-label="MandateFlow proof outcomes">
        {proof.rows.map((row) => (
          <div className={"proof-row proof-row-" + row.state} role="listitem" key={row.id}>
            <span className="proof-row-icon" aria-hidden="true">{row.state === "complete" ? "✓" : "·"}</span>
            <span className="proof-row-copy">
              <strong>{row.label}</strong>
              <span>{row.detail}</span>
            </span>
            <span className="proof-row-status">
              {row.state === "complete" ? "Verified" : "Pending"}
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
