package mandateflow

import (
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
)

func (s *Service) Evidence(ctx context.Context, runID string) (EvidenceView, error) {
	run, err := loadRunByID(ctx, s.store.db, runID)
	if err != nil {
		if isNotFound(err) {
			return EvidenceView{}, serviceError(CodeNotFound, "Run not found")
		}
		return EvidenceView{}, fmt.Errorf("load evidence Run: %w", err)
	}
	policyContext, err := loadContext(ctx, s.store.db, run.ContextID)
	if err != nil {
		return EvidenceView{}, fmt.Errorf("load evidence context: %w", err)
	}
	rows, err := s.store.db.QueryContext(ctx, `
SELECT id, created_at, run_id, context_id, grant_id, tool, action, resource_kind,
       decision, static_scope_decision, provenance_decision, enforcement_stage,
       outcome, downstream_invoked, rule_id, reason, caused_by_json,
       input_aliases_json, redacted_input_summary, redacted_result_summary,
       counter_before, counter_after
FROM receipts
WHERE context_id = ?
ORDER BY created_at, id`, run.ContextID)
	if err != nil {
		return EvidenceView{}, fmt.Errorf("query receipts: %w", err)
	}
	defer rows.Close()
	receipts := make([]ReceiptView, 0)
	for rows.Next() {
		var receipt ReceiptView
		var downstream int
		var ruleID sql.NullString
		var causedByJSON, aliasesJSON string
		if err := rows.Scan(
			&receipt.ID, &receipt.CreatedAt, &receipt.RunID, &receipt.PolicyContextID,
			&receipt.RunGrantID, &receipt.Tool, &receipt.Action, &receipt.ResourceKind,
			&receipt.Decision, &receipt.StaticScopeDecision, &receipt.ProvenanceDecision,
			&receipt.EnforcementStage, &receipt.Outcome, &downstream, &ruleID,
			&receipt.Reason, &causedByJSON, &aliasesJSON, &receipt.RedactedInputSummary,
			&receipt.RedactedResultSummary, &receipt.CounterBefore, &receipt.CounterAfter,
		); err != nil {
			return EvidenceView{}, fmt.Errorf("scan receipt: %w", err)
		}
		receipt.DownstreamInvoked = downstream == 1
		if ruleID.Valid {
			receipt.RuleID = &ruleID.String
		}
		if err := json.Unmarshal([]byte(causedByJSON), &receipt.CausedByReceiptIDs); err != nil {
			return EvidenceView{}, fmt.Errorf("decode receipt causes: %w", err)
		}
		if err := json.Unmarshal([]byte(aliasesJSON), &receipt.InputReferenceAliases); err != nil {
			return EvidenceView{}, fmt.Errorf("decode receipt aliases: %w", err)
		}
		receipt.PolicyID = s.policy.Policy.ID
		receipt.PolicyVersion = policyContext.PolicyVersion
		receipts = append(receipts, receipt)
	}
	if err := rows.Err(); err != nil {
		return EvidenceView{}, fmt.Errorf("iterate receipts: %w", err)
	}

	var counter int
	if err := s.store.db.QueryRowContext(ctx, `
SELECT value FROM fixture_counters
WHERE context_id = ? AND tool = 'crm.resolve_customer'`, run.ContextID).Scan(&counter); err != nil {
		return EvidenceView{}, fmt.Errorf("load CRM counter: %w", err)
	}
	grantDigest, err := hex.DecodeString(run.GrantHash)
	if err != nil {
		return EvidenceView{}, fmt.Errorf("decode grant fingerprint: %w", err)
	}
	view := EvidenceView{
		RunID:                 run.RunID,
		PolicyContextID:       run.ContextID,
		RunGrantID:            run.GrantID,
		MandateID:             policyContext.MandateID,
		MandateStatus:         policyContext.State,
		OwnerPrincipal:        policyContext.OwnerPrincipal,
		AgentPrincipal:        policyContext.AgentPrincipal,
		IssuedAt:              policyContext.IssuedAt,
		ExpiresAt:             policyContext.ExpiresAt,
		RuntimeInstanceID:     run.RuntimeInstanceID,
		RunStatus:             run.State,
		PurposeID:             policyContext.PurposeID,
		PolicyID:              s.policy.Policy.ID,
		PolicyVersion:         policyContext.PolicyVersion,
		GrantFingerprint:      fingerprint("grant", grantDigest),
		CapabilityFingerprint: fingerprint("cap", run.CapabilityDigest),
		CRMCounter:            counter,
		Receipts:              receipts,
	}
	if policyContext.RevokedAt.Valid {
		if revokedAt, parseErr := parseTime(policyContext.RevokedAt.String); parseErr == nil {
			view.RevokedAt = &revokedAt
		}
	}
	if policyContext.RevokedBy.Valid {
		view.RevokedBy = policyContext.RevokedBy.String
	}
	if policyContext.RevocationReason.Valid {
		view.RevocationReason = policyContext.RevocationReason.String
	}
	if run.RetryOfRunID.Valid {
		view.RetryOfRunID = &run.RetryOfRunID.String
	}
	return view, nil
}
