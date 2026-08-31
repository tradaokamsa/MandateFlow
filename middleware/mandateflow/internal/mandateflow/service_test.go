package mandateflow

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"path/filepath"
	"testing"
	"time"
)

const testPolicy = `{
  "id":"mixed-operations-flow",
  "version":1,
  "purposeId":"MIXED_OPERATIONS_BRIEF",
  "defaultEffect":"ALLOW_IF_STATIC_SCOPE",
  "rules":[{
    "id":"NO_PAYMENT_REIDENTIFICATION",
    "when":{
      "anyAncestorClassification":"PAYMENT_AGGREGATE_ONLY",
      "destinationTool":"crm.resolve_customer"
    },
    "effect":"DENY",
    "safeAlternative":"payments.aggregate_failures"
  }]
}`

func newTestService(t *testing.T) *Service {
	t.Helper()
	policy, err := ParsePolicy([]byte(testPolicy))
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(filepath.Join(t.TempDir(), "mandateflow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return NewService(store, policy, time.Hour)
}

func testBearer(t *testing.T) (string, string) {
	t.Helper()
	random := make([]byte, 32)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	bearer := "mfr1_" + base64.RawURLEncoding.EncodeToString(random)
	digest := sha256.Sum256([]byte(bearer))
	return bearer, base64.RawURLEncoding.EncodeToString(digest[:])
}

func prepareActiveRun(t *testing.T, service *Service, runID, agentID string, mode PrepareMode, contextID, retryOf *string, permissions []Permission) (Principal, PrepareResult, string) {
	t.Helper()
	bearer, digest := testBearer(t)
	result, err := service.Prepare(context.Background(), runID, PrepareRequest{
		AgentID:              agentID,
		RuntimeInstanceID:    "test-runtime-" + runID,
		Mode:                 mode,
		PolicyContextID:      contextID,
		RetryOfRunID:         retryOf,
		MandateTemplateID:    MandateTemplateID,
		RequestedPermissions: permissions,
		CapabilitySHA256:     digest,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Activate(context.Background(), runID); err != nil {
		t.Fatal(err)
	}
	principal, err := service.Authenticate(context.Background(), bearer)
	if err != nil {
		t.Fatal(err)
	}
	return principal, result, bearer
}

func TestProvenanceAllowDenyAndRecovery(t *testing.T) {
	service := newTestService(t)
	principal, prepared, bearer := prepareActiveRun(t, service, "run-1", "agent-1", PrepareNew, nil, nil, PlatformPermissions())
	if prepared.PolicyContextID == "" || prepared.Status != "PREPARED" {
		t.Fatalf("unexpected prepare result: %+v", prepared)
	}

	support, err := service.ExecuteTool(context.Background(), principal, "support.list_tickets", "")
	if err != nil || support.Reference == nil {
		t.Fatalf("Support source failed: result=%+v error=%v", support, err)
	}
	supportCase, err := service.ExecuteTool(context.Background(), principal, "cases.lookup_subject", support.Reference.Reference)
	if err != nil || supportCase.Reference == nil || supportCase.Reference.Kind != "operations-case" {
		t.Fatalf("Support Case derivation failed: result=%+v error=%v", supportCase, err)
	}
	allowed, err := service.ExecuteTool(context.Background(), principal, "crm.resolve_customer", supportCase.Reference.Reference)
	if err != nil || !allowed.OK || allowed.Customer == nil {
		t.Fatalf("Support CRM resolution failed: result=%+v error=%v", allowed, err)
	}

	payment, err := service.ExecuteTool(context.Background(), principal, "payments.list_failures", "")
	if err != nil || payment.Reference == nil {
		t.Fatalf("Payment source failed: result=%+v error=%v", payment, err)
	}
	paymentCase, err := service.ExecuteTool(context.Background(), principal, "cases.lookup_subject", payment.Reference.Reference)
	if err != nil || paymentCase.Reference == nil {
		t.Fatalf("Payment Case derivation failed: result=%+v error=%v", paymentCase, err)
	}
	denied, err := service.ExecuteTool(context.Background(), principal, "crm.resolve_customer", paymentCase.Reference.Reference)
	if err != nil {
		t.Fatal(err)
	}
	if denied.OK || denied.Code != "FLOW_DENIED" || denied.RuleID == nil || *denied.RuleID != "NO_PAYMENT_REIDENTIFICATION" || len(denied.SafeAlternatives) != 1 || denied.SafeAlternatives[0] != "payments.aggregate_failures" {
		t.Fatalf("unexpected provenance denial: %+v", denied)
	}
	aggregate, err := service.ExecuteTool(context.Background(), principal, "payments.aggregate_failures", "")
	if err != nil || !aggregate.OK || aggregate.Aggregate == nil {
		t.Fatalf("safe recovery failed: result=%+v error=%v", aggregate, err)
	}

	evidence, err := service.Evidence(context.Background(), "run-1")
	if err != nil {
		t.Fatal(err)
	}
	if evidence.CRMCounter != 1 {
		t.Fatalf("denied CRM call changed counter: %d", evidence.CRMCounter)
	}
	var denial *ReceiptView
	for index := range evidence.Receipts {
		if evidence.Receipts[index].ID == denied.ReceiptID {
			denial = &evidence.Receipts[index]
		}
	}
	if denial == nil || denial.StaticScopeDecision != "ALLOW" || denial.ProvenanceDecision != "DENY" || denial.RuleID == nil || *denial.RuleID != "NO_PAYMENT_REIDENTIFICATION" || denial.Outcome != "NOT_INVOKED" || denial.DownstreamInvoked || denial.CounterBefore != denial.CounterAfter || len(denial.CausedByReceiptIDs) != 2 {
		t.Fatalf("denial receipt does not prove pre-execution enforcement: %+v", denial)
	}
	forged, err := service.ExecuteTool(context.Background(), principal, "crm.resolve_customer", "ref1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil || forged.Code != "INVALID_REFERENCE" {
		t.Fatalf("forged CRM reference did not fail closed: result=%+v error=%v", forged, err)
	}
	evidence, err = service.Evidence(context.Background(), "run-1")
	if err != nil {
		t.Fatal(err)
	}
	foundForgedReceipt := false
	for _, receipt := range evidence.Receipts {
		if receipt.ID == forged.ReceiptID && (receipt.CounterBefore != 1 || receipt.CounterAfter != 1 || receipt.DownstreamInvoked) {
			t.Fatalf("invalid-reference receipt did not preserve downstream proof: %+v", receipt)
		}
		if receipt.ID == forged.ReceiptID {
			foundForgedReceipt = true
		}
	}
	if !foundForgedReceipt {
		t.Fatal("invalid-reference denial receipt was not persisted")
	}

	if _, err := service.Finish(context.Background(), "run-1", "COMPLETED"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Authenticate(context.Background(), bearer); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("completed bearer remained valid: %v", err)
	}

	contextID := prepared.PolicyContextID
	retryOf := "run-1"
	retryPrincipal, retryPrepared, _ := prepareActiveRun(t, service, "run-2", "agent-1", PrepareRetry, &contextID, &retryOf, PlatformPermissions())
	if retryPrepared.PolicyContextID != contextID || retryPrepared.RunGrantID == prepared.RunGrantID {
		t.Fatalf("retry authority did not preserve only the context: %+v", retryPrepared)
	}
	retryDenied, err := service.ExecuteTool(context.Background(), retryPrincipal, "crm.resolve_customer", paymentCase.Reference.Reference)
	if err != nil || retryDenied.Code != "FLOW_DENIED" {
		t.Fatalf("retry laundered provenance: result=%+v error=%v", retryDenied, err)
	}
	retryEvidence, err := service.Evidence(context.Background(), "run-2")
	if err != nil {
		t.Fatal(err)
	}
	if retryEvidence.RetryOfRunID == nil || *retryEvidence.RetryOfRunID != "run-1" || retryEvidence.CRMCounter != 1 {
		t.Fatalf("retry evidence is incomplete: %+v", retryEvidence)
	}
}

func TestForgedCrossContextAndScopeReferencesFailClosed(t *testing.T) {
	service := newTestService(t)
	principalOne, resultOne, _ := prepareActiveRun(t, service, "run-a", "agent-a", PrepareNew, nil, nil, PlatformPermissions())
	payment, err := service.ExecuteTool(context.Background(), principalOne, "payments.list_failures", "")
	if err != nil || payment.Reference == nil {
		t.Fatal("failed to create protected reference")
	}

	principalTwo, _, _ := prepareActiveRun(t, service, "run-b", "agent-b", PrepareNew, nil, nil, PlatformPermissions())
	crossContext, err := service.ExecuteTool(context.Background(), principalTwo, "cases.lookup_subject", payment.Reference.Reference)
	if err != nil || crossContext.Code != "INVALID_REFERENCE" {
		t.Fatalf("cross-context reference did not fail closed: result=%+v error=%v", crossContext, err)
	}
	forged, err := service.ExecuteTool(context.Background(), principalOne, "cases.lookup_subject", "ref1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil || forged.Code != "INVALID_REFERENCE" {
		t.Fatalf("forged reference did not fail closed: result=%+v error=%v", forged, err)
	}
	wrongKind, err := service.ExecuteTool(context.Background(), principalOne, "crm.resolve_customer", payment.Reference.Reference)
	if err != nil || wrongKind.Code != "INVALID_REFERENCE" {
		t.Fatalf("wrong-kind reference did not fail closed: result=%+v error=%v", wrongKind, err)
	}

	if _, err := service.Finish(context.Background(), "run-a", "COMPLETED"); err != nil {
		t.Fatal(err)
	}
	contextID := resultOne.PolicyContextID
	retryOf := "run-a"
	crmOnly := []Permission{toolRegistry["crm.resolve_customer"].Permission}
	narrow, _, _ := prepareActiveRun(t, service, "run-c", "agent-a", PrepareRetry, &contextID, &retryOf, crmOnly)
	scopeDenied, err := service.ExecuteTool(context.Background(), narrow, "payments.list_failures", "")
	if err != nil || scopeDenied.Code != "SCOPE_DENIED" {
		t.Fatalf("narrow retry grant widened: result=%+v error=%v", scopeDenied, err)
	}
}

func TestFreshWorkflowRejectsOldReferencesAndAllowsFreshSupportLineage(t *testing.T) {
	service := newTestService(t)
	firstPrincipal, firstPrepared, _ := prepareActiveRun(t, service, "run-old", "agent-reset", PrepareNew, nil, nil, PlatformPermissions())
	oldSupport, err := service.ExecuteTool(context.Background(), firstPrincipal, "support.list_tickets", "")
	if err != nil || oldSupport.Reference == nil {
		t.Fatalf("old Support lookup failed: result=%+v error=%v", oldSupport, err)
	}
	if _, err := service.Finish(context.Background(), "run-old", "COMPLETED"); err != nil {
		t.Fatal(err)
	}

	secondPrincipal, secondPrepared, _ := prepareActiveRun(t, service, "run-fresh", "agent-reset", PrepareNew, nil, nil, PlatformPermissions())
	if secondPrepared.PolicyContextID == firstPrepared.PolicyContextID || secondPrepared.MandateID == firstPrepared.MandateID {
		t.Fatalf("fresh workflow reused old authority: old=%+v fresh=%+v", firstPrepared, secondPrepared)
	}
	oldReference, err := service.ExecuteTool(context.Background(), secondPrincipal, "cases.lookup_subject", oldSupport.Reference.Reference)
	if err != nil || oldReference.Code != string(CodeInvalidReference) || oldReference.OK {
		t.Fatalf("old workflow reference crossed the reset boundary: result=%+v error=%v", oldReference, err)
	}
	if _, err := service.ExecuteTool(context.Background(), firstPrincipal, "support.list_tickets", ""); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("old workflow capability remained usable after reset: %v", err)
	}

	freshSupport, err := service.ExecuteTool(context.Background(), secondPrincipal, "support.list_tickets", "")
	if err != nil || freshSupport.Reference == nil {
		t.Fatalf("fresh Support lookup failed: result=%+v error=%v", freshSupport, err)
	}
	freshCase, err := service.ExecuteTool(context.Background(), secondPrincipal, "cases.lookup_subject", freshSupport.Reference.Reference)
	if err != nil || freshCase.Reference == nil {
		t.Fatalf("fresh Case derivation failed: result=%+v error=%v", freshCase, err)
	}
	freshCRM, err := service.ExecuteTool(context.Background(), secondPrincipal, "crm.resolve_customer", freshCase.Reference.Reference)
	if err != nil || !freshCRM.OK {
		t.Fatalf("fresh Support lineage was not allowed: result=%+v error=%v", freshCRM, err)
	}
	evidence, err := service.Evidence(context.Background(), "run-fresh")
	if err != nil {
		t.Fatal(err)
	}
	if evidence.CRMCounter != 1 {
		t.Fatalf("fresh workflow CRM counter = %d, want 1", evidence.CRMCounter)
	}
}

func TestPolicyRejectsUnknownFields(t *testing.T) {
	_, err := ParsePolicy([]byte(`{"id":"mixed-operations-flow","version":1,"purposeId":"MIXED_OPERATIONS_BRIEF","defaultEffect":"ALLOW_IF_STATIC_SCOPE","rules":[],"unexpected":true}`))
	if err == nil {
		t.Fatal("policy with an unknown field was accepted")
	}
}

func TestPrepareReplayAndTerminalStateNeverReopens(t *testing.T) {
	service := newTestService(t)
	bearer, digest := testBearer(t)
	request := PrepareRequest{
		AgentID:              "agent-replay",
		RuntimeInstanceID:    "runtime-replay",
		Mode:                 PrepareNew,
		MandateTemplateID:    MandateTemplateID,
		RequestedPermissions: PlatformPermissions(),
		CapabilitySHA256:     digest,
	}
	first, err := service.Prepare(context.Background(), "run-replay", request)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := service.Prepare(context.Background(), "run-replay", request)
	if err != nil || replayed.RunGrantID != first.RunGrantID || replayed.PolicyContextID != first.PolicyContextID {
		t.Fatalf("identical prepare was not idempotent: result=%+v error=%v", replayed, err)
	}
	conflict := request
	conflict.RuntimeInstanceID = "different-runtime"
	if _, err := service.Prepare(context.Background(), "run-replay", conflict); !ErrorHasCode(err, CodeConflict) {
		t.Fatalf("conflicting prepare did not fail: %v", err)
	}
	if _, err := service.Activate(context.Background(), "run-replay"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Activate(context.Background(), "run-replay"); err != nil {
		t.Fatalf("active replay was not idempotent: %v", err)
	}
	if _, err := service.Finish(context.Background(), "run-replay", "COMPLETED"); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Finish(context.Background(), "run-replay", "COMPLETED"); err != nil {
		t.Fatalf("terminal replay was not idempotent: %v", err)
	}
	if _, err := service.Finish(context.Background(), "run-replay", "FAILED"); !ErrorHasCode(err, CodeConflict) {
		t.Fatalf("terminal status changed: %v", err)
	}
	if _, err := service.Activate(context.Background(), "run-replay"); !ErrorHasCode(err, CodeConflict) {
		t.Fatalf("terminal Run reopened: %v", err)
	}
	if _, err := service.Authenticate(context.Background(), bearer); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("terminal bearer remained valid: %v", err)
	}
}

func TestExpiredBearerFailsClosed(t *testing.T) {
	service := newTestService(t)
	fixedNow := time.Date(2026, 8, 30, 12, 0, 0, 0, time.UTC)
	service.now = func() time.Time { return fixedNow }
	_, _, bearer := prepareActiveRun(t, service, "run-expiry", "agent-expiry", PrepareNew, nil, nil, PlatformPermissions())
	service.now = func() time.Time { return fixedNow.Add(2 * time.Hour) }
	if _, err := service.Authenticate(context.Background(), bearer); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("expired bearer remained valid: %v", err)
	}
}

func TestMandateRevocationIsDurableIdempotentAndClosesAuthority(t *testing.T) {
	service := newTestService(t)
	principal, prepared, bearer := prepareActiveRun(t, service, "run-revoke", "agent-revoke", PrepareNew, nil, nil, PlatformPermissions())

	summary, err := service.MandateSummary(context.Background(), prepared.MandateID)
	if err != nil {
		t.Fatal(err)
	}
	if summary.Status != "ACTIVE" || summary.OwnerPrincipal != DemoUserA || summary.AgentPrincipal == "" {
		t.Fatalf("unexpected mandate summary: %+v", summary)
	}

	revoked, err := service.RevokeMandate(context.Background(), prepared.MandateID, DemoUserA)
	if err != nil {
		t.Fatal(err)
	}
	if revoked.Status != "REVOKED" || len(revoked.AffectedRunIDs) != 1 || revoked.AffectedRunIDs[0] != "run-revoke" || revoked.RevokedAt == nil {
		t.Fatalf("unexpected revocation result: %+v", revoked)
	}
	if _, err := service.Authenticate(context.Background(), bearer); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("revoked bearer remained valid: %v", err)
	}
	if _, err := service.ExecuteTool(context.Background(), principal, "support.list_tickets", ""); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("revoked principal remained usable: %v", err)
	}
	if _, err := service.Finish(context.Background(), "run-revoke", "CANCELLED"); err != nil {
		t.Fatalf("revoked Run could not be terminalized as cancelled: %v", err)
	}
	if _, err := service.RevokeMandate(context.Background(), prepared.MandateID, DemoUserA); err != nil {
		t.Fatalf("revocation was not idempotent: %v", err)
	}

	contextID := prepared.PolicyContextID
	retryOf := "run-revoke"
	if _, err := service.Prepare(context.Background(), "run-revoke-2", PrepareRequest{
		AgentID:              "agent-revoke",
		OwnerPrincipal:       DemoUserA,
		RuntimeInstanceID:    "runtime-revoke-2",
		Mode:                 PrepareRetry,
		PolicyContextID:      &contextID,
		RetryOfRunID:         &retryOf,
		MandateTemplateID:    MandateTemplateID,
		RequestedPermissions: PlatformPermissions(),
		CapabilitySHA256:     mustCapabilityDigest(t),
	}); !ErrorHasCode(err, CodeConflict) {
		t.Fatalf("retry under revoked mandate was admitted: %v", err)
	}
}

func TestOwnershipDenialIsRedactedAndPreExecution(t *testing.T) {
	service := newTestService(t)
	principal, prepared, _ := prepareActiveRun(t, service, "run-owner", "agent-owner", PrepareNew, nil, nil, PlatformPermissions())
	support, err := service.ExecuteTool(context.Background(), principal, "support.list_tickets", "")
	if err != nil || support.Reference == nil {
		t.Fatalf("failed to create owned reference: result=%+v error=%v", support, err)
	}
	if _, err := service.store.db.Exec(`UPDATE protected_references SET owner_principal = 'user-b' WHERE context_id = ?`, prepared.PolicyContextID); err != nil {
		t.Fatal(err)
	}
	denied, err := service.ExecuteTool(context.Background(), principal, "cases.lookup_subject", support.Reference.Reference)
	if err != nil || denied.OK || denied.Code != string(CodeOwnershipDenied) {
		t.Fatalf("unexpected ownership denial: result=%+v error=%v", denied, err)
	}
	evidence, err := service.Evidence(context.Background(), "run-owner")
	if err != nil {
		t.Fatal(err)
	}
	var denial *ReceiptView
	for index := range evidence.Receipts {
		if evidence.Receipts[index].ID == denied.ReceiptID {
			denial = &evidence.Receipts[index]
		}
	}
	if denial == nil || denial.DownstreamInvoked || denial.Outcome != "NOT_INVOKED" || denial.RedactedResultSummary != "Protected fixture was not invoked" {
		t.Fatalf("ownership denial was not redacted/pre-execution: %+v", denial)
	}

	spoofed := principal
	spoofed.OwnerPrincipal = DemoUserB
	if _, err := service.ExecuteTool(context.Background(), spoofed, "support.list_tickets", ""); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("owner spoof was accepted: %v", err)
	}

	if _, err := service.Prepare(context.Background(), "run-owner-spoof", PrepareRequest{
		AgentID:              "agent-owner",
		OwnerPrincipal:       DemoUserB,
		RuntimeInstanceID:    "runtime-owner-spoof",
		Mode:                 PrepareNew,
		MandateTemplateID:    MandateTemplateID,
		RequestedPermissions: PlatformPermissions(),
		CapabilitySHA256:     mustCapabilityDigest(t),
	}); !ErrorHasCode(err, CodeConflict) {
		t.Fatalf("Agent owner binding changed: %v", err)
	}
}

func TestUserBUsesOnlyUserBOwnedFixture(t *testing.T) {
	service := newTestService(t)
	bearer, digest := testBearer(t)
	prepared, err := service.Prepare(context.Background(), "run-user-b", PrepareRequest{
		AgentID:              "agent-user-b",
		OwnerPrincipal:       DemoUserB,
		RuntimeInstanceID:    "runtime-user-b",
		Mode:                 PrepareNew,
		MandateTemplateID:    MandateTemplateID,
		RequestedPermissions: PlatformPermissions(),
		CapabilitySHA256:     digest,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Activate(context.Background(), "run-user-b"); err != nil {
		t.Fatal(err)
	}
	principal, err := service.Authenticate(context.Background(), bearer)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.ExecuteTool(context.Background(), principal, "support.list_tickets", "")
	if err != nil || result.Reference == nil {
		t.Fatalf("User B could not access its fixture: result=%+v error=%v", result, err)
	}
	supportCase, err := service.ExecuteTool(context.Background(), principal, "cases.lookup_subject", result.Reference.Reference)
	if err != nil || supportCase.Reference == nil {
		t.Fatalf("User B could not derive its operations Case: result=%+v error=%v", supportCase, err)
	}
	crm, err := service.ExecuteTool(context.Background(), principal, "crm.resolve_customer", supportCase.Reference.Reference)
	if err != nil || crm.Customer == nil || crm.Customer.ContactChannel != "internal-crm://support-follow-up/customer-002" {
		t.Fatalf("User B CRM result used the wrong fixture: result=%+v error=%v", crm, err)
	}
	var owner string
	if err := service.store.db.QueryRow(`SELECT owner_principal FROM protected_references WHERE context_id = ?`, prepared.PolicyContextID).Scan(&owner); err != nil {
		t.Fatal(err)
	}
	if owner != DemoUserB {
		t.Fatalf("reference owner = %q, want %q", owner, DemoUserB)
	}
}

func mustCapabilityDigest(t *testing.T) string {
	t.Helper()
	_, digest := testBearer(t)
	return digest
}
