import type { PolicyReceipt } from "./types";

interface ReceiptCardProps {
  receipt: PolicyReceipt;
  receipts: PolicyReceipt[];
  expanded: boolean;
  onToggle: (receiptId: string | null) => void;
  onNavigate: (receiptId: string) => void;
}

function shortId(value: string): string {
  return value.length > 18 ? value.slice(0, 10) + "…" + value.slice(-5) : value;
}

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function ReceiptCard({
  receipt,
  receipts,
  expanded,
  onToggle,
  onNavigate,
}: ReceiptCardProps) {
  return (
    <article
      className={"receipt-card receipt-" + receipt.decision.toLowerCase()}
      id={"receipt-" + receipt.id}
    >
      <details open={expanded}>
        <summary
          className="receipt-summary"
          aria-expanded={expanded}
          aria-controls={`receipt-details-${receipt.id}`}
          onClick={(event) => {
            event.preventDefault();
            onToggle(expanded ? null : receipt.id);
          }}
        >
          <span className="receipt-disclosure" aria-hidden="true">
            {expanded ? "−" : "+"}
          </span>
          <span className="receipt-summary-main">
            <strong>{receipt.tool}</strong>
            <span className="receipt-reason">{receipt.reason}</span>
          </span>
          <span className="receipt-summary-state">
            <span className="receipt-state-icon" aria-hidden="true">
              {receipt.decision === "ALLOW" ? "✓" : "×"}
            </span>
            <span>{receipt.decision === "ALLOW" ? "Allowed" : "Blocked"}</span>
            <span className="receipt-disclosure-copy">{expanded ? "Hide" : "Details"}</span>
          </span>
        </summary>

        <div className="receipt-compact-meta">
          <span>scope {receipt.staticScopeDecision}</span>
          <span>flow {receipt.provenanceDecision}</span>
          <span>{receipt.outcome}</span>
          {receipt.ruleId && <span className="rule-chip">Rule: {receipt.ruleId}</span>}
          {receipt.tool === "crm.resolve_customer" && (
            <span>
              CRM {receipt.counterBefore} → {receipt.counterAfter} · {receipt.downstreamInvoked ? "invoked" : "not invoked"}
            </span>
          )}
        </div>

        <div className="receipt-details" id={`receipt-details-${receipt.id}`}>
          <dl>
            <div>
              <dt>Receipt</dt>
              <dd>{receipt.id}</dd>
            </div>
            <div>
              <dt>Server time</dt>
              <dd>{formatDateTime(receipt.createdAt)}</dd>
            </div>
            <div>
              <dt>Resource</dt>
              <dd>{receipt.resourceKind}</dd>
            </div>
            <div>
              <dt>Run / context</dt>
              <dd>{shortId(receipt.runId)} / {shortId(receipt.policyContextId)}</dd>
            </div>
            <div>
              <dt>Input</dt>
              <dd>{receipt.redactedInputSummary}</dd>
            </div>
            <div>
              <dt>Result</dt>
              <dd>{receipt.redactedResultSummary}</dd>
            </div>
          </dl>
          {receipt.ruleId && (
            <p className="receipt-rule-detail">
              Policy rule <code>{receipt.ruleId}</code> selected this decision.
            </p>
          )}
          <div className="receipt-causes">
            <strong>Causal parents</strong>
            {receipt.causedByReceiptIds.length > 0 ? (
              <div className="cause-links">
                {receipt.causedByReceiptIds.map((causeId) => {
                  const cause = receipts.find((candidate) => candidate.id === causeId);
                  return cause ? (
                    <button
                      key={causeId}
                      type="button"
                      className="cause-link"
                      onClick={() => onNavigate(causeId)}
                    >
                      {shortId(causeId)} · {cause.tool}
                    </button>
                  ) : (
                    <span className="cause-missing" key={causeId}>
                      Unavailable receipt {shortId(causeId)}
                    </span>
                  );
                })}
              </div>
            ) : (
              <span className="cause-missing">No causal parent receipt</span>
            )}
          </div>
        </div>
      </details>
    </article>
  );
}
