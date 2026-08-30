package mandateflow

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"
)

type Service struct {
	store      *Store
	policy     LoadedPolicy
	runTTL     time.Duration
	contextTTL time.Duration
	now        func() time.Time
}

func NewService(store *Store, policy LoadedPolicy, runTTL time.Duration) *Service {
	if runTTL <= 0 {
		runTTL = 11 * time.Minute
	}
	return &Service{
		store:      store,
		policy:     policy,
		runTTL:     runTTL,
		contextTTL: 24 * time.Hour,
		now:        func() time.Time { return time.Now().UTC() },
	}
}

func (s *Service) Ready(ctx context.Context) error {
	return s.store.Ping(ctx)
}

func (s *Service) Prepare(ctx context.Context, runID string, request PrepareRequest) (PrepareResult, error) {
	if err := validatePrepare(runID, request); err != nil {
		return PrepareResult{}, err
	}
	digest, err := base64.RawURLEncoding.DecodeString(request.CapabilitySHA256)
	if err != nil || len(digest) != sha256.Size {
		return PrepareResult{}, serviceError(CodeInvalidRequest, "capabilitySha256 must encode exactly 32 bytes")
	}
	request.RequestedPermissions, err = normalizePermissions(request.RequestedPermissions)
	if err != nil {
		return PrepareResult{}, err
	}
	prepareHash, err := canonicalHash(request)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("hash prepare request: %w", err)
	}

	tx, err := s.store.begin(ctx)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("begin prepare: %w", err)
	}
	defer tx.Rollback()

	existing, err := loadRunByID(ctx, tx, runID)
	if err == nil {
		if existing.PrepareHash != prepareHash || !equalBytes(existing.CapabilityDigest, digest) {
			return PrepareResult{}, serviceError(CodeConflict, "Run ID was already prepared with different immutable input")
		}
		return prepareResultFromRun(existing), nil
	}
	if !isNotFound(err) {
		return PrepareResult{}, fmt.Errorf("load prepared Run: %w", err)
	}

	now := s.now()
	var policyContext contextRow
	var authorityCeiling = PlatformPermissions()
	var retryOf any
	var predecessor any

	switch request.Mode {
	case PrepareNew:
		if _, err := tx.ExecContext(ctx, `
UPDATE contexts
SET state = 'CLOSED'
WHERE agent_id = ? AND state = 'ACTIVE'
  AND NOT EXISTS (
    SELECT 1 FROM runs
    WHERE runs.context_id = contexts.id AND runs.state IN ('PREPARED', 'ACTIVE')
  )`, request.AgentID); err != nil {
			return PrepareResult{}, fmt.Errorf("close prior context: %w", err)
		}
		policyContext, err = s.createContext(ctx, tx, request, now)
		if err != nil {
			return PrepareResult{}, err
		}
	case PrepareFollowUp:
		policyContext, err = s.requireExistingContext(ctx, tx, request)
		if err != nil {
			return PrepareResult{}, err
		}
		if request.PredecessorRunID != nil {
			prior, loadErr := loadRunByID(ctx, tx, *request.PredecessorRunID)
			if loadErr != nil || prior.ContextID != policyContext.ID || prior.AgentID != request.AgentID || prior.State != "COMPLETED" {
				return PrepareResult{}, serviceError(CodeConflict, "predecessor Run is not a completed Run in this policy context")
			}
			predecessor = *request.PredecessorRunID
		}
	case PrepareRetry:
		if request.RetryOfRunID == nil {
			return PrepareResult{}, serviceError(CodeInvalidRequest, "retryOfRunId is required for RETRY")
		}
		original, loadErr := loadRunByID(ctx, tx, *request.RetryOfRunID)
		if loadErr != nil || original.AgentID != request.AgentID {
			return PrepareResult{}, serviceError(CodeNotFound, "retry source Run not found")
		}
		if original.State != "COMPLETED" {
			return PrepareResult{}, serviceError(CodeConflict, "only a completed Run may be retried")
		}
		policyContext, err = loadContext(ctx, tx, original.ContextID)
		if err != nil || policyContext.State != "ACTIVE" || now.After(policyContext.ExpiresAt) {
			return PrepareResult{}, serviceError(CodeConflict, "retry policy context is not active")
		}
		if request.PolicyContextID != nil && *request.PolicyContextID != policyContext.ID {
			return PrepareResult{}, serviceError(CodeConflict, "retry cannot change policy context")
		}
		if err := json.Unmarshal([]byte(original.GrantJSON), &authorityCeiling); err != nil {
			return PrepareResult{}, fmt.Errorf("decode original grant: %w", err)
		}
		retryOf = original.RunID
		predecessor = original.RunID
	default:
		return PrepareResult{}, serviceError(CodeInvalidRequest, "unsupported prepare mode")
	}

	granted := intersectPermissions(request.RequestedPermissions, PlatformPermissions(), authorityCeiling)
	if len(granted) == 0 {
		return PrepareResult{}, serviceError(CodeInvalidRequest, "requested permissions produce an empty Run grant")
	}
	grantJSONBytes, err := json.Marshal(granted)
	if err != nil {
		return PrepareResult{}, fmt.Errorf("encode grant: %w", err)
	}
	grantDigest := sha256.Sum256(grantJSONBytes)
	grantID, err := opaqueID("grant", 16)
	if err != nil {
		return PrepareResult{}, err
	}
	expiresAt := now.Add(s.runTTL)
	if policyContext.ExpiresAt.Before(expiresAt) {
		expiresAt = policyContext.ExpiresAt
	}

	_, err = tx.ExecContext(ctx, `
INSERT INTO runs (
  run_id, context_id, agent_id, runtime_instance_id, retry_of_run_id,
  predecessor_run_id, grant_id, grant_json, grant_hash, capability_digest,
  audience, prepare_hash, state, issued_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PREPARED', ?, ?)`,
		runID,
		policyContext.ID,
		request.AgentID,
		request.RuntimeInstanceID,
		retryOf,
		predecessor,
		grantID,
		string(grantJSONBytes),
		hex.EncodeToString(grantDigest[:]),
		digest,
		GatewayAudience,
		prepareHash,
		formatTime(now),
		formatTime(expiresAt),
	)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			return PrepareResult{}, serviceError(CodeConflict, "capability digest is already bound to another Run")
		}
		return PrepareResult{}, fmt.Errorf("persist prepared Run: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return PrepareResult{}, fmt.Errorf("commit prepare: %w", err)
	}
	return PrepareResult{
		RunGrantID:            grantID,
		PolicyContextID:       policyContext.ID,
		GrantFingerprint:      fingerprint("grant", grantDigest[:]),
		CapabilityFingerprint: fingerprint("cap", digest),
		Status:                "PREPARED",
		ExpiresAt:             expiresAt,
		GrantedPermissions:    granted,
	}, nil
}

func (s *Service) createContext(ctx context.Context, tx *sql.Tx, request PrepareRequest, now time.Time) (contextRow, error) {
	contextID, err := opaqueID("ctx", 16)
	if err != nil {
		return contextRow{}, err
	}
	expiresAt := now.Add(s.contextTTL)
	mandate := struct {
		TemplateID  string       `json:"templateId"`
		PurposeID   string       `json:"purposeId"`
		Permissions []Permission `json:"permissions"`
		IssuedAt    string       `json:"issuedAt"`
		ExpiresAt   string       `json:"expiresAt"`
	}{
		TemplateID:  MandateTemplateID,
		PurposeID:   PurposeMixedOperations,
		Permissions: PlatformPermissions(),
		IssuedAt:    formatTime(now),
		ExpiresAt:   formatTime(expiresAt),
	}
	mandateJSON, err := json.Marshal(mandate)
	if err != nil {
		return contextRow{}, fmt.Errorf("encode mandate: %w", err)
	}
	mandateDigest := sha256.Sum256(mandateJSON)
	_, err = tx.ExecContext(ctx, `
INSERT INTO contexts (
  id, agent_id, purpose_id, mandate_template_id, mandate_json, mandate_hash,
  policy_json, policy_hash, policy_version, state, issued_at, expires_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`,
		contextID,
		request.AgentID,
		PurposeMixedOperations,
		MandateTemplateID,
		string(mandateJSON),
		hex.EncodeToString(mandateDigest[:]),
		string(s.policy.Raw),
		s.policy.Hash,
		s.policy.Policy.Version,
		formatTime(now),
		formatTime(expiresAt),
	)
	if err != nil {
		return contextRow{}, fmt.Errorf("create policy context: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO fixture_counters (context_id, tool, value)
VALUES (?, 'crm.resolve_customer', 0)`, contextID); err != nil {
		return contextRow{}, fmt.Errorf("create fixture counter: %w", err)
	}
	return contextRow{
		ID: contextID, AgentID: request.AgentID, PurposeID: PurposeMixedOperations,
		MandateTemplateID: MandateTemplateID, MandateJSON: string(mandateJSON),
		MandateHash: hex.EncodeToString(mandateDigest[:]), PolicyJSON: string(s.policy.Raw),
		PolicyHash: s.policy.Hash, PolicyVersion: s.policy.Policy.Version,
		State: "ACTIVE", IssuedAt: now, ExpiresAt: expiresAt,
	}, nil
}

func (s *Service) requireExistingContext(ctx context.Context, tx *sql.Tx, request PrepareRequest) (contextRow, error) {
	if request.PolicyContextID == nil || *request.PolicyContextID == "" {
		return contextRow{}, serviceError(CodeInvalidRequest, "policyContextId is required for FOLLOW_UP")
	}
	row, err := loadContext(ctx, tx, *request.PolicyContextID)
	if err != nil || row.AgentID != request.AgentID {
		return contextRow{}, serviceError(CodeNotFound, "policy context not found")
	}
	if row.State != "ACTIVE" || s.now().After(row.ExpiresAt) {
		return contextRow{}, serviceError(CodeConflict, "policy context is not active")
	}
	if row.PolicyHash != s.policy.Hash || row.PolicyVersion != s.policy.Policy.Version {
		return contextRow{}, serviceError(CodeConflict, "policy context is pinned to a different policy")
	}
	return row, nil
}

func (s *Service) Activate(ctx context.Context, runID string) (LifecycleResult, error) {
	tx, err := s.store.begin(ctx)
	if err != nil {
		return LifecycleResult{}, fmt.Errorf("begin activate: %w", err)
	}
	defer tx.Rollback()
	row, err := loadRunByID(ctx, tx, runID)
	if err != nil {
		if isNotFound(err) {
			return LifecycleResult{}, serviceError(CodeNotFound, "Run not found")
		}
		return LifecycleResult{}, err
	}
	if row.State == "ACTIVE" {
		return lifecycleResult(row), nil
	}
	if row.State != "PREPARED" {
		return LifecycleResult{}, serviceError(CodeConflict, "terminal or expired Run cannot be activated")
	}
	now := s.now()
	if !now.Before(row.ExpiresAt) {
		if _, err := tx.ExecContext(ctx, `UPDATE runs SET state='EXPIRED', terminal_at=? WHERE run_id=?`, formatTime(now), runID); err != nil {
			return LifecycleResult{}, err
		}
		if err := tx.Commit(); err != nil {
			return LifecycleResult{}, err
		}
		return LifecycleResult{}, serviceError(CodeConflict, "prepared Run expired before activation")
	}
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET state='ACTIVE', activated_at=? WHERE run_id=?`, formatTime(now), runID); err != nil {
		return LifecycleResult{}, fmt.Errorf("activate Run: %w", err)
	}
	row.State = "ACTIVE"
	row.ActivatedAt = sql.NullString{String: formatTime(now), Valid: true}
	if err := tx.Commit(); err != nil {
		return LifecycleResult{}, fmt.Errorf("commit activate: %w", err)
	}
	return lifecycleResult(row), nil
}

func (s *Service) Finish(ctx context.Context, runID string, status string) (LifecycleResult, error) {
	allowed := map[string]bool{"COMPLETED": true, "FAILED": true, "CANCELLED": true, "ABANDONED": true}
	if !allowed[status] {
		return LifecycleResult{}, serviceError(CodeInvalidRequest, "unsupported terminal status")
	}
	tx, err := s.store.begin(ctx)
	if err != nil {
		return LifecycleResult{}, fmt.Errorf("begin finish: %w", err)
	}
	defer tx.Rollback()
	row, err := loadRunByID(ctx, tx, runID)
	if err != nil {
		if isNotFound(err) {
			return LifecycleResult{}, serviceError(CodeNotFound, "Run not found")
		}
		return LifecycleResult{}, err
	}
	if row.State == status {
		return lifecycleResult(row), nil
	}
	if row.State != "PREPARED" && row.State != "ACTIVE" {
		return LifecycleResult{}, serviceError(CodeConflict, "Run is already terminal with a different status")
	}
	now := s.now()
	if _, err := tx.ExecContext(ctx, `UPDATE runs SET state=?, terminal_at=? WHERE run_id=?`, status, formatTime(now), runID); err != nil {
		return LifecycleResult{}, fmt.Errorf("finish Run: %w", err)
	}
	row.State = status
	row.TerminalAt = sql.NullString{String: formatTime(now), Valid: true}
	if err := tx.Commit(); err != nil {
		return LifecycleResult{}, fmt.Errorf("commit finish: %w", err)
	}
	return lifecycleResult(row), nil
}

func (s *Service) Authenticate(ctx context.Context, bearer string) (Principal, error) {
	if !strings.HasPrefix(bearer, "mfr1_") || len(bearer) != 48 {
		return Principal{}, serviceError(CodeInvalidToken, "invalid bearer")
	}
	digest := sha256.Sum256([]byte(bearer))
	row, err := loadRunByCapability(ctx, s.store.db, digest[:])
	if err != nil {
		return Principal{}, serviceError(CodeInvalidToken, "invalid bearer")
	}
	now := s.now()
	if row.State != "ACTIVE" || row.Audience != GatewayAudience || !now.Before(row.ExpiresAt) {
		return Principal{}, serviceError(CodeInvalidToken, "invalid bearer")
	}
	policyContext, err := loadContext(ctx, s.store.db, row.ContextID)
	if err != nil || policyContext.State != "ACTIVE" || !now.Before(policyContext.ExpiresAt) {
		return Principal{}, serviceError(CodeInvalidToken, "invalid bearer")
	}
	var permissions []Permission
	if err := json.Unmarshal([]byte(row.GrantJSON), &permissions); err != nil {
		return Principal{}, serviceError(CodeInvalidToken, "invalid bearer")
	}
	return Principal{
		RunID: row.RunID, RunGrantID: row.GrantID, AgentID: row.AgentID,
		PolicyContextID: row.ContextID, Permissions: permissions, ExpiresAt: row.ExpiresAt,
	}, nil
}

func validatePrepare(runID string, request PrepareRequest) error {
	if runID == "" || len(runID) > 128 || request.AgentID == "" || len(request.AgentID) > 128 {
		return serviceError(CodeInvalidRequest, "runId and agentId are required")
	}
	if request.RuntimeInstanceID == "" || len(request.RuntimeInstanceID) > 128 {
		return serviceError(CodeInvalidRequest, "runtimeInstanceId is required")
	}
	if request.MandateTemplateID != MandateTemplateID {
		return serviceError(CodeInvalidRequest, "unsupported mandate template")
	}
	if len(request.RequestedPermissions) == 0 || len(request.RequestedPermissions) > len(toolRegistry) {
		return serviceError(CodeInvalidRequest, "requestedPermissions must contain one to five tuples")
	}
	return nil
}

func normalizePermissions(input []Permission) ([]Permission, error) {
	seen := make(map[string]Permission)
	for _, permission := range input {
		if permission.Tool == "" || permission.Action == "" || permission.ResourceKind == "" {
			return nil, serviceError(CodeInvalidRequest, "permission tuples require tool, action and resourceKind")
		}
		if len(permission.Tool) > 96 || len(permission.Action) > 32 || len(permission.ResourceKind) > 64 {
			return nil, serviceError(CodeInvalidRequest, "permission tuple field is too long")
		}
		seen[permission.key()] = permission
	}
	result := make([]Permission, 0, len(seen))
	for _, permission := range seen {
		result = append(result, permission)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].key() < result[j].key() })
	return result, nil
}

func intersectPermissions(groups ...[]Permission) []Permission {
	if len(groups) == 0 {
		return nil
	}
	counts := make(map[string]int)
	values := make(map[string]Permission)
	for index, group := range groups {
		seen := make(map[string]bool)
		for _, permission := range group {
			key := permission.key()
			if seen[key] {
				continue
			}
			seen[key] = true
			if index == 0 || counts[key] == index {
				counts[key]++
				values[key] = permission
			}
		}
	}
	result := make([]Permission, 0)
	for key, count := range counts {
		if count == len(groups) {
			result = append(result, values[key])
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].key() < result[j].key() })
	return result
}

func canonicalHash(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:]), nil
}

func opaqueID(prefix string, byteCount int) (string, error) {
	buffer := make([]byte, byteCount)
	if _, err := rand.Read(buffer); err != nil {
		return "", fmt.Errorf("generate opaque value: %w", err)
	}
	return prefix + "_" + base64.RawURLEncoding.EncodeToString(buffer), nil
}

func fingerprint(prefix string, digest []byte) string {
	encoded := hex.EncodeToString(digest)
	if len(encoded) > 8 {
		encoded = encoded[:8]
	}
	return prefix + ":" + encoded
}

func equalBytes(left, right []byte) bool {
	if len(left) != len(right) {
		return false
	}
	var different byte
	for index := range left {
		different |= left[index] ^ right[index]
	}
	return different == 0
}

func prepareResultFromRun(row runRow) PrepareResult {
	var permissions []Permission
	_ = json.Unmarshal([]byte(row.GrantJSON), &permissions)
	grantDigest, _ := hex.DecodeString(row.GrantHash)
	return PrepareResult{
		RunGrantID: row.GrantID, PolicyContextID: row.ContextID,
		GrantFingerprint:      fingerprint("grant", grantDigest),
		CapabilityFingerprint: fingerprint("cap", row.CapabilityDigest),
		Status:                row.State, ExpiresAt: row.ExpiresAt, GrantedPermissions: permissions,
	}
}

func lifecycleResult(row runRow) LifecycleResult {
	result := LifecycleResult{RunID: row.RunID, Status: row.State, ExpiresAt: row.ExpiresAt}
	if row.TerminalAt.Valid {
		if terminalAt, err := parseTime(row.TerminalAt.String); err == nil {
			result.TerminalAt = &terminalAt
		}
	}
	return result
}
