package mandateflow

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

func (s *Service) ExecuteTool(
	ctx context.Context,
	principal Principal,
	toolName string,
	reference string,
) (ToolResult, error) {
	spec, known := toolRegistry[toolName]
	if !known {
		return ToolResult{}, serviceError(CodeScopeDenied, "tool is not in the protected registry")
	}
	tx, err := s.store.begin(ctx)
	if err != nil {
		return ToolResult{}, fmt.Errorf("begin protected tool call: %w", err)
	}
	defer tx.Rollback()

	now := s.now()
	run, err := loadRunByID(ctx, tx, principal.RunID)
	if err != nil || run.State != "ACTIVE" || run.GrantID != principal.RunGrantID ||
		run.ContextID != principal.PolicyContextID || !now.Before(run.ExpiresAt) {
		return ToolResult{}, serviceError(CodeInvalidToken, "Run authority is no longer active")
	}
	policyContext, err := loadContext(ctx, tx, run.ContextID)
	if err != nil || policyContext.State != "ACTIVE" || !now.Before(policyContext.ExpiresAt) {
		return ToolResult{}, serviceError(CodeInvalidToken, "Run authority is no longer active")
	}
	if (principal.AgentID != "" && principal.AgentID != run.AgentID) ||
		(principal.AgentPrincipal != "" && principal.AgentPrincipal != policyContext.AgentPrincipal) ||
		(principal.OwnerPrincipal != "" && principal.OwnerPrincipal != policyContext.OwnerPrincipal) ||
		(principal.MandateID != "" && principal.MandateID != policyContext.MandateID) {
		return ToolResult{}, serviceError(CodeInvalidToken, "Run authority is no longer active")
	}
	var permissions []Permission
	if err := json.Unmarshal([]byte(run.GrantJSON), &permissions); err != nil {
		return ToolResult{}, fmt.Errorf("decode immutable grant: %w", err)
	}
	if !permissionAllowed(permissions, spec.Permission) {
		counter, counterErr := fixtureCounter(ctx, tx, run.ContextID, toolName)
		if counterErr != nil {
			return ToolResult{}, counterErr
		}
		result, err := s.persistDenial(ctx, tx, run, spec, nil, "SCOPE_DENIED", "Permission tuple is outside the immutable Run grant", nil, nil, counter)
		if err != nil {
			return ToolResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return ToolResult{}, fmt.Errorf("commit scope denial: %w", err)
		}
		return result, nil
	}

	var input *referenceRow
	var causedBy []string
	var aliases []string
	if spec.InputKind != "" {
		loaded, loadErr := s.resolveReference(ctx, tx, reference, run.ContextID, spec.InputKind, now)
		if loadErr != nil {
			counter, counterErr := fixtureCounter(ctx, tx, run.ContextID, toolName)
			if counterErr != nil {
				return ToolResult{}, counterErr
			}
			result, persistErr := s.persistDenial(ctx, tx, run, spec, nil, "INVALID_REFERENCE", "Protected reference is invalid for this operation", nil, nil, counter)
			if persistErr != nil {
				return ToolResult{}, persistErr
			}
			if err := tx.Commit(); err != nil {
				return ToolResult{}, fmt.Errorf("commit invalid-reference denial: %w", err)
			}
			return result, nil
		}
		input = &loaded
		aliases = []string{loaded.SafeAlias}
		causedBy, err = causalReceiptIDs(ctx, tx, loaded)
		if err != nil {
			return ToolResult{}, err
		}
	}

	if input != nil {
		if rule, deny := s.policy.denyFor(toolName, input.EffectiveLabels); deny {
			counter, err := fixtureCounter(ctx, tx, run.ContextID, toolName)
			if err != nil {
				return ToolResult{}, err
			}
			alternatives := []string{}
			if alternative, exists := toolRegistry[rule.SafeAlternative]; exists && permissionAllowed(permissions, alternative.Permission) {
				alternatives = append(alternatives, rule.SafeAlternative)
			}
			result, err := s.persistDenial(ctx, tx, run, spec, &rule, "FLOW_DENIED", "Payment-derived references are aggregate-only and cannot be resolved through CRM", causedBy, aliases, counter)
			if err != nil {
				return ToolResult{}, err
			}
			result.SafeAlternatives = alternatives
			if err := tx.Commit(); err != nil {
				return ToolResult{}, fmt.Errorf("commit provenance denial: %w", err)
			}
			return result, nil
		}
	}

	if !s.ownedFixture(ctx, tx, policyContext, spec, input) {
		counter, err := fixtureCounter(ctx, tx, run.ContextID, toolName)
		if err != nil {
			return ToolResult{}, err
		}
		result, err := s.persistDenial(
			ctx, tx, run, spec, nil, string(CodeOwnershipDenied),
			"Protected resource access denied", causedBy, aliases, counter,
		)
		if err != nil {
			return ToolResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return ToolResult{}, fmt.Errorf("commit ownership denial: %w", err)
		}
		return result, nil
	}

	result, err := s.executeAllowed(ctx, tx, run, policyContext, spec, input, causedBy, aliases)
	if err != nil {
		return ToolResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ToolResult{}, fmt.Errorf("commit protected tool result: %w", err)
	}
	return result, nil
}

func (s *Service) executeAllowed(
	ctx context.Context,
	tx *sql.Tx,
	run runRow,
	policyContext contextRow,
	spec toolSpec,
	input *referenceRow,
	causedBy []string,
	aliases []string,
) (ToolResult, error) {
	receiptID, err := opaqueID("receipt", 16)
	if err != nil {
		return ToolResult{}, err
	}
	counterBefore, err := fixtureCounter(ctx, tx, run.ContextID, spec.Tool)
	if err != nil {
		return ToolResult{}, err
	}
	counterAfter := counterBefore
	result := ToolResult{OK: true, Message: "Protected operation completed", ReceiptID: receiptID}
	redactedInput := "No protected reference input"
	if input != nil {
		redactedInput = "Protected " + input.Kind + " reference " + input.SafeAlias
	}
	redactedResult := "Protected operation completed"

	var newReference string
	var newReferenceKind string
	var newPrivateTarget string
	var newLabels []string
	var parentDigest []byte
	var fixtureResourceID string

	switch spec.Tool {
	case "support.list_tickets":
		fixture, fixtureErr := loadFixtureResource(ctx, tx, spec.Tool, spec.OutputKind, policyContext.OwnerPrincipal)
		if fixtureErr != nil {
			return ToolResult{}, fmt.Errorf("load Support fixture: %w", fixtureErr)
		}
		newReference, err = opaqueID("ref1", 32)
		newReferenceKind = spec.OutputKind
		newPrivateTarget = fixture.PrivateTarget
		fixtureResourceID = fixture.ID
		newLabels = []string{spec.AddedLabel}
		redactedResult = "Returned one open Support ticket and an opaque customer-subject reference"
	case "payments.list_failures":
		fixture, fixtureErr := loadFixtureResource(ctx, tx, spec.Tool, spec.OutputKind, policyContext.OwnerPrincipal)
		if fixtureErr != nil {
			return ToolResult{}, fmt.Errorf("load Payment fixture: %w", fixtureErr)
		}
		newReference, err = opaqueID("ref1", 32)
		newReferenceKind = spec.OutputKind
		newPrivateTarget = fixture.PrivateTarget
		fixtureResourceID = fixture.ID
		newLabels = []string{spec.AddedLabel}
		redactedResult = "Returned aggregate-only Payment failure data and an opaque customer-subject reference"
	case "cases.lookup_subject":
		newReference, err = opaqueID("ref1", 32)
		newReferenceKind = spec.OutputKind
		newPrivateTarget = "case:" + input.PrivateTargetID
		fixtureResourceID = input.FixtureResourceID.String
		newLabels = append([]string(nil), input.EffectiveLabels...)
		parentDigest = input.Digest
		redactedResult = "Derived an opaque operations-case reference with inherited provenance"
	case "crm.resolve_customer":
		counterAfter = counterBefore + 1
		if _, err := tx.ExecContext(ctx, `
UPDATE fixture_counters SET value = ? WHERE context_id = ? AND tool = ?`,
			counterAfter, run.ContextID, spec.Tool); err != nil {
			return ToolResult{}, fmt.Errorf("increment CRM counter: %w", err)
		}
		customerID := "customer-001"
		if input != nil && input.FixtureResourceID.Valid {
			fixture, fixtureErr := loadFixtureResourceByID(ctx, tx, input.FixtureResourceID.String)
			if fixtureErr != nil || fixture.OwnerPrincipal != policyContext.OwnerPrincipal {
				return ToolResult{}, serviceError(CodeOwnershipDenied, "Protected resource access denied")
			}
			customerID = strings.TrimPrefix(fixture.PrivateTarget, "support:")
			if customerID == "" || customerID == fixture.PrivateTarget {
				return ToolResult{}, fmt.Errorf("invalid Support fixture target")
			}
		}
		result.Customer = &CustomerResult{
			DisplayName:    "Demo Support Customer",
			ContactChannel: "internal-crm://support-follow-up/" + customerID,
		}
		result.Message = "CRM resolution was allowed for the Support-derived Case reference"
		redactedResult = "CRM returned an authorized Support follow-up destination"
	case "payments.aggregate_failures":
		if _, fixtureErr := loadFixtureResource(ctx, tx, spec.Tool, spec.ResourceKind, policyContext.OwnerPrincipal); fixtureErr != nil {
			return ToolResult{}, fmt.Errorf("load Payment aggregate fixture: %w", fixtureErr)
		}
		result.Aggregate = &AggregateResult{FailureCount: 3, Summary: "3 failed payments across 2 retryable categories"}
		result.Message = "Payment failures were returned only in aggregate"
		redactedResult = "Returned a Payment failure aggregate without customer identifiers"
	default:
		return ToolResult{}, fmt.Errorf("protected fixture %q is not implemented", spec.Tool)
	}
	if err != nil {
		return ToolResult{}, err
	}

	provenanceDecision := "NOT_EVALUATED"
	if input != nil {
		provenanceDecision = "ALLOW"
	}
	if err := insertReceipt(ctx, tx, receiptInsert{
		ID: receiptID, CreatedAt: s.now(), Run: run, Spec: spec,
		Decision: "ALLOW", StaticScopeDecision: "ALLOW",
		ProvenanceDecision: provenanceDecision, Outcome: "SUCCEEDED",
		DownstreamInvoked: true, Reason: "Immutable grant and provenance policy allowed the protected operation",
		CausedBy: causedBy, Aliases: aliases, RedactedInput: redactedInput,
		RedactedResult: redactedResult, CounterBefore: counterBefore, CounterAfter: counterAfter,
	}); err != nil {
		return ToolResult{}, err
	}

	if newReference != "" {
		digest := sha256.Sum256([]byte(newReference))
		alias := fingerprint("ref", digest[:])
		labelsJSON, _ := json.Marshal(sortedStrings(newLabels))
		if _, err := tx.ExecContext(ctx, `
INSERT INTO protected_references (
  reference_digest, context_id, owner_principal, fixture_resource_id, kind, private_target_id, effective_labels_json,
  parent_digest, producing_receipt_id, safe_alias, expires_at, state
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
			digest[:], run.ContextID, policyContext.OwnerPrincipal, nullableString(fixtureResourceID),
			newReferenceKind, newPrivateTarget,
			string(labelsJSON), nullableBytes(parentDigest), receiptID, alias,
			formatTime(policyContext.ExpiresAt),
		); err != nil {
			return ToolResult{}, fmt.Errorf("persist protected reference: %w", err)
		}
		result.Reference = &ReferenceResult{
			Reference: newReference,
			Kind:      newReferenceKind,
			Summary:   redactedResult,
			ReceiptID: receiptID,
		}
	}
	return result, nil
}

func (s *Service) ownedFixture(
	ctx context.Context,
	tx *sql.Tx,
	policyContext contextRow,
	spec toolSpec,
	input *referenceRow,
) bool {
	if policyContext.OwnerPrincipal == "" {
		return false
	}
	if input != nil {
		if input.OwnerPrincipal != policyContext.OwnerPrincipal {
			return false
		}
		if input.FixtureResourceID.Valid {
			resource, err := loadFixtureResourceByID(ctx, tx, input.FixtureResourceID.String)
			return err == nil && resource.State == "ACTIVE" &&
				resource.OwnerPrincipal == policyContext.OwnerPrincipal
		}
		return true
	}
	kind := fixtureKindForTool(spec.Tool)
	if kind == "" {
		return true
	}
	resource, err := loadFixtureResource(ctx, tx, spec.Tool, kind, policyContext.OwnerPrincipal)
	return err == nil && resource.State == "ACTIVE" && resource.OwnerPrincipal == policyContext.OwnerPrincipal
}

func fixtureKindForTool(tool string) string {
	switch tool {
	case "support.list_tickets", "payments.list_failures":
		return "customer-subject"
	case "payments.aggregate_failures":
		return "payment-summary"
	default:
		return ""
	}
}

func (s *Service) persistDenial(
	ctx context.Context,
	tx *sql.Tx,
	run runRow,
	spec toolSpec,
	rule *PolicyRule,
	code string,
	reason string,
	causedBy []string,
	aliases []string,
	counter int,
) (ToolResult, error) {
	receiptID, err := opaqueID("receipt", 16)
	if err != nil {
		return ToolResult{}, err
	}
	staticDecision := "ALLOW"
	provenanceDecision := "NOT_EVALUATED"
	var ruleID *string
	if code == "SCOPE_DENIED" {
		staticDecision = "DENY"
	}
	if code == "FLOW_DENIED" || code == string(CodeOwnershipDenied) {
		provenanceDecision = "DENY"
		if rule != nil {
			ruleID = &rule.ID
		}
	}
	redactedInput := "No protected reference input"
	if len(aliases) > 0 {
		redactedInput = "Protected reference " + aliases[0]
	}
	if err := insertReceipt(ctx, tx, receiptInsert{
		ID: receiptID, CreatedAt: s.now(), Run: run, Spec: spec,
		Decision: "DENY", StaticScopeDecision: staticDecision,
		ProvenanceDecision: provenanceDecision, Outcome: "NOT_INVOKED",
		DownstreamInvoked: false, RuleID: ruleID, Reason: reason,
		CausedBy: causedBy, Aliases: aliases, RedactedInput: redactedInput,
		RedactedResult: "Protected fixture was not invoked", CounterBefore: counter, CounterAfter: counter,
	}); err != nil {
		return ToolResult{}, err
	}
	return ToolResult{
		OK: false, Code: code, Message: reason, ReceiptID: receiptID,
	}, nil
}

type receiptInsert struct {
	ID                  string
	CreatedAt           time.Time
	Run                 runRow
	Spec                toolSpec
	Decision            string
	StaticScopeDecision string
	ProvenanceDecision  string
	Outcome             string
	DownstreamInvoked   bool
	RuleID              *string
	Reason              string
	CausedBy            []string
	Aliases             []string
	RedactedInput       string
	RedactedResult      string
	CounterBefore       int
	CounterAfter        int
}

func insertReceipt(ctx context.Context, tx *sql.Tx, receipt receiptInsert) error {
	causedByJSON, _ := json.Marshal(nonNilStrings(receipt.CausedBy))
	aliasesJSON, _ := json.Marshal(nonNilStrings(receipt.Aliases))
	downstream := 0
	if receipt.DownstreamInvoked {
		downstream = 1
	}
	_, err := tx.ExecContext(ctx, `
INSERT INTO receipts (
  id, created_at, run_id, context_id, grant_id, tool, action, resource_kind,
  decision, static_scope_decision, provenance_decision, enforcement_stage,
  outcome, downstream_invoked, rule_id, reason, caused_by_json,
  input_aliases_json, redacted_input_summary, redacted_result_summary,
  counter_before, counter_after
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PRE_EXECUTION', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		receipt.ID, formatTime(receipt.CreatedAt), receipt.Run.RunID,
		receipt.Run.ContextID, receipt.Run.GrantID, receipt.Spec.Tool,
		receipt.Spec.Action, receipt.Spec.ResourceKind, receipt.Decision,
		receipt.StaticScopeDecision, receipt.ProvenanceDecision, receipt.Outcome,
		downstream, receipt.RuleID, receipt.Reason, string(causedByJSON),
		string(aliasesJSON), receipt.RedactedInput, receipt.RedactedResult,
		receipt.CounterBefore, receipt.CounterAfter,
	)
	if err != nil {
		return fmt.Errorf("persist decision receipt: %w", err)
	}
	return nil
}

func (s *Service) resolveReference(
	ctx context.Context,
	tx *sql.Tx,
	reference string,
	contextID string,
	expectedKind string,
	now time.Time,
) (referenceRow, error) {
	if len(reference) != 48 || reference[:len("ref1_")] != "ref1_" {
		return referenceRow{}, serviceError(CodeInvalidReference, "invalid protected reference")
	}
	digest := sha256.Sum256([]byte(reference))
	row, err := loadReference(ctx, tx, digest[:])
	if err != nil || row.ContextID != contextID || row.Kind != expectedKind ||
		row.State != "ACTIVE" || !now.Before(row.ExpiresAt) {
		return referenceRow{}, serviceError(CodeInvalidReference, "invalid protected reference")
	}
	return row, nil
}

func causalReceiptIDs(ctx context.Context, tx *sql.Tx, reference referenceRow) ([]string, error) {
	current := reference
	causes := make([]string, 0, 4)
	seen := make(map[string]bool)
	for depth := 0; depth < 8; depth++ {
		key := hex.EncodeToString(current.Digest)
		if seen[key] {
			return nil, fmt.Errorf("stored reference lineage contains a cycle")
		}
		seen[key] = true
		causes = append(causes, current.ProducingReceiptID)
		if len(current.ParentDigest) == 0 {
			break
		}
		parent, err := loadReference(ctx, tx, current.ParentDigest)
		if err != nil || parent.ContextID != reference.ContextID {
			return nil, fmt.Errorf("stored reference parent is invalid")
		}
		current = parent
	}
	if len(current.ParentDigest) > 0 && len(causes) == 8 {
		return nil, fmt.Errorf("stored reference lineage exceeds maximum depth")
	}
	for left, right := 0, len(causes)-1; left < right; left, right = left+1, right-1 {
		causes[left], causes[right] = causes[right], causes[left]
	}
	return causes, nil
}

func fixtureCounter(ctx context.Context, tx *sql.Tx, contextID, tool string) (int, error) {
	if tool != "crm.resolve_customer" {
		return 0, nil
	}
	var value int
	if err := tx.QueryRowContext(ctx, `SELECT value FROM fixture_counters WHERE context_id=? AND tool=?`, contextID, tool).Scan(&value); err != nil {
		return 0, fmt.Errorf("read fixture counter: %w", err)
	}
	return value, nil
}

func permissionAllowed(permissions []Permission, required Permission) bool {
	for _, permission := range permissions {
		if permission.key() == required.key() {
			return true
		}
	}
	return false
}

func sortedStrings(values []string) []string {
	result := append([]string(nil), values...)
	sort.Strings(result)
	return result
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func nullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}
