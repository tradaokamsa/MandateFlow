package mandateflow

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS contexts (
  id TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL UNIQUE,
  agent_id TEXT NOT NULL,
  agent_principal TEXT NOT NULL,
  owner_principal TEXT NOT NULL DEFAULT 'user-a',
  purpose_id TEXT NOT NULL,
  mandate_template_id TEXT NOT NULL,
  mandate_json TEXT NOT NULL,
  mandate_hash TEXT NOT NULL,
  policy_json TEXT NOT NULL,
  policy_hash TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  state TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT NULL,
  revoked_by TEXT NULL,
  revocation_reason TEXT NULL
);
CREATE INDEX IF NOT EXISTS contexts_agent_idx ON contexts(agent_id, state);

CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(id),
  agent_id TEXT NOT NULL,
  runtime_instance_id TEXT NOT NULL,
  retry_of_run_id TEXT NULL REFERENCES runs(run_id),
  predecessor_run_id TEXT NULL REFERENCES runs(run_id),
  grant_id TEXT NOT NULL UNIQUE,
  grant_json TEXT NOT NULL,
  grant_hash TEXT NOT NULL,
  capability_digest BLOB NOT NULL UNIQUE,
  audience TEXT NOT NULL,
  prepare_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  activated_at TEXT NULL,
  expires_at TEXT NOT NULL,
  terminal_at TEXT NULL
);
CREATE INDEX IF NOT EXISTS runs_context_idx ON runs(context_id, issued_at);
CREATE INDEX IF NOT EXISTS runs_capability_idx ON runs(capability_digest);

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  run_id TEXT NOT NULL REFERENCES runs(run_id),
  context_id TEXT NOT NULL REFERENCES contexts(id),
  grant_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  decision TEXT NOT NULL,
  static_scope_decision TEXT NOT NULL,
  provenance_decision TEXT NOT NULL,
  enforcement_stage TEXT NOT NULL,
  outcome TEXT NOT NULL,
  downstream_invoked INTEGER NOT NULL,
  rule_id TEXT NULL,
  reason TEXT NOT NULL,
  caused_by_json TEXT NOT NULL,
  input_aliases_json TEXT NOT NULL,
  redacted_input_summary TEXT NOT NULL,
  redacted_result_summary TEXT NOT NULL,
  counter_before INTEGER NOT NULL,
  counter_after INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS receipts_context_idx ON receipts(context_id, created_at, id);
CREATE INDEX IF NOT EXISTS receipts_run_idx ON receipts(run_id, created_at, id);

CREATE TABLE IF NOT EXISTS protected_references (
  reference_digest BLOB PRIMARY KEY,
  context_id TEXT NOT NULL REFERENCES contexts(id),
  owner_principal TEXT NOT NULL DEFAULT 'user-a',
  fixture_resource_id TEXT NULL,
  kind TEXT NOT NULL,
  private_target_id TEXT NOT NULL,
  effective_labels_json TEXT NOT NULL,
  parent_digest BLOB NULL,
  producing_receipt_id TEXT NOT NULL REFERENCES receipts(id),
  safe_alias TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS protected_references_context_idx ON protected_references(context_id, safe_alias);

CREATE TABLE IF NOT EXISTS fixture_counters (
  context_id TEXT NOT NULL REFERENCES contexts(id),
  tool TEXT NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (context_id, tool)
);

CREATE TABLE IF NOT EXISTS fixture_resources (
  resource_id TEXT PRIMARY KEY,
  tool TEXT NOT NULL,
  kind TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  private_target_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE INDEX IF NOT EXISTS fixture_resources_lookup_idx
  ON fixture_resources(tool, kind, owner_principal, state);

PRAGMA user_version = 2;
`

type Store struct {
	db *sql.DB
}

func OpenStore(path string) (*Store, error) {
	dsn := path
	if !strings.HasPrefix(path, "file:") {
		dsn = "file:" + path
	}
	if strings.Contains(dsn, "?") {
		dsn += "&_txlock=immediate"
	} else {
		dsn += "?_txlock=immediate"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db}
	if err := store.initialize(context.Background()); err != nil {
		db.Close()
		return nil, err
	}
	if !strings.HasPrefix(path, "file:") {
		if err := os.Chmod(path, 0o600); err != nil {
			db.Close()
			return nil, fmt.Errorf("secure sqlite file permissions: %w", err)
		}
	}
	return store, nil
}

func (s *Store) initialize(ctx context.Context) error {
	for _, pragma := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA synchronous = FULL",
	} {
		if _, err := s.db.ExecContext(ctx, pragma); err != nil {
			return fmt.Errorf("configure sqlite: %w", err)
		}
	}
	if _, err := s.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("create sqlite schema: %w", err)
	}
	for _, column := range []struct {
		table string
		name  string
		def   string
	}{
		{"contexts", "mandate_id", "TEXT"},
		{"contexts", "agent_principal", "TEXT NOT NULL DEFAULT ''"},
		{"contexts", "owner_principal", "TEXT NOT NULL DEFAULT 'user-a'"},
		{"contexts", "revoked_at", "TEXT NULL"},
		{"contexts", "revoked_by", "TEXT NULL"},
		{"contexts", "revocation_reason", "TEXT NULL"},
		{"protected_references", "owner_principal", "TEXT NOT NULL DEFAULT 'user-a'"},
		{"protected_references", "fixture_resource_id", "TEXT NULL"},
	} {
		if err := s.addColumnIfMissing(ctx, column.table, column.name, column.def); err != nil {
			return err
		}
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE contexts SET mandate_id = id WHERE mandate_id IS NULL OR mandate_id = '';
UPDATE contexts SET agent_principal = 'agent:' || agent_id
WHERE agent_principal IS NULL OR agent_principal = '';
CREATE UNIQUE INDEX IF NOT EXISTS contexts_mandate_id_idx ON contexts(mandate_id);
`); err != nil {
		return fmt.Errorf("migrate mandate identity columns: %w", err)
	}
	if err := s.seedFixtureResources(ctx); err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx, `
UPDATE runs
SET state = 'GATEWAY_RESTART', terminal_at = ?
WHERE state IN ('PREPARED', 'ACTIVE')`, formatTime(time.Now().UTC())); err != nil {
		return fmt.Errorf("recover interrupted runs: %w", err)
	}
	return nil
}

func (s *Store) addColumnIfMissing(ctx context.Context, table, column, definition string) error {
	_, err := s.db.ExecContext(ctx, `ALTER TABLE `+table+` ADD COLUMN `+column+` `+definition)
	if err != nil && !strings.Contains(strings.ToLower(err.Error()), "duplicate column") {
		return fmt.Errorf("add %s.%s: %w", table, column, err)
	}
	return nil
}

func (s *Store) seedFixtureResources(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `
INSERT OR IGNORE INTO fixture_resources
  (resource_id, tool, kind, owner_principal, private_target_id, state)
VALUES
  ('support-ticket:user-a', 'support.list_tickets', 'customer-subject', 'user-a', 'support:customer-001', 'ACTIVE'),
  ('support-ticket:user-b', 'support.list_tickets', 'customer-subject', 'user-b', 'support:customer-002', 'ACTIVE'),
  ('payment-failure:user-a', 'payments.list_failures', 'customer-subject', 'user-a', 'payment:account-777', 'ACTIVE'),
  ('payment-failure:user-b', 'payments.list_failures', 'customer-subject', 'user-b', 'payment:account-888', 'ACTIVE'),
  ('payment-summary:user-a', 'payments.aggregate_failures', 'payment-summary', 'user-a', 'payment-summary:user-a', 'ACTIVE'),
  ('payment-summary:user-b', 'payments.aggregate_failures', 'payment-summary', 'user-b', 'payment-summary:user-b', 'ACTIVE')`)
	if err != nil {
		return fmt.Errorf("seed fixture resources: %w", err)
	}
	return nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) Ping(ctx context.Context) error {
	return s.db.PingContext(ctx)
}

func (s *Store) begin(ctx context.Context) (*sql.Tx, error) {
	return s.db.BeginTx(ctx, nil)
}

func formatTime(value time.Time) string {
	return value.UTC().Format(time.RFC3339Nano)
}

func parseTime(value string) (time.Time, error) {
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse stored time: %w", err)
	}
	return parsed, nil
}

type contextRow struct {
	ID                string
	MandateID         string
	AgentID           string
	AgentPrincipal    string
	OwnerPrincipal    string
	PurposeID         string
	MandateTemplateID string
	MandateJSON       string
	MandateHash       string
	PolicyJSON        string
	PolicyHash        string
	PolicyVersion     int
	State             string
	IssuedAt          time.Time
	ExpiresAt         time.Time
	RevokedAt         sql.NullString
	RevokedBy         sql.NullString
	RevocationReason  sql.NullString
}

type runRow struct {
	RunID             string
	ContextID         string
	AgentID           string
	RuntimeInstanceID string
	RetryOfRunID      sql.NullString
	PredecessorRunID  sql.NullString
	GrantID           string
	GrantJSON         string
	GrantHash         string
	CapabilityDigest  []byte
	Audience          string
	PrepareHash       string
	State             string
	IssuedAt          time.Time
	ActivatedAt       sql.NullString
	ExpiresAt         time.Time
	TerminalAt        sql.NullString
}

func scanRun(scanner interface{ Scan(...any) error }) (runRow, error) {
	var row runRow
	var issuedAt, expiresAt string
	err := scanner.Scan(
		&row.RunID,
		&row.ContextID,
		&row.AgentID,
		&row.RuntimeInstanceID,
		&row.RetryOfRunID,
		&row.PredecessorRunID,
		&row.GrantID,
		&row.GrantJSON,
		&row.GrantHash,
		&row.CapabilityDigest,
		&row.Audience,
		&row.PrepareHash,
		&row.State,
		&issuedAt,
		&row.ActivatedAt,
		&expiresAt,
		&row.TerminalAt,
	)
	if err != nil {
		return runRow{}, err
	}
	row.IssuedAt, err = parseTime(issuedAt)
	if err != nil {
		return runRow{}, err
	}
	row.ExpiresAt, err = parseTime(expiresAt)
	if err != nil {
		return runRow{}, err
	}
	return row, nil
}

const runColumns = `run_id, context_id, agent_id, runtime_instance_id,
retry_of_run_id, predecessor_run_id, grant_id, grant_json, grant_hash,
capability_digest, audience, prepare_hash, state, issued_at, activated_at,
expires_at, terminal_at`

func loadRunByID(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, runID string) (runRow, error) {
	return scanRun(queryer.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE run_id = ?`, runID))
}

func loadRunByCapability(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, digest []byte) (runRow, error) {
	return scanRun(queryer.QueryRowContext(ctx, `SELECT `+runColumns+` FROM runs WHERE capability_digest = ?`, digest))
}

func loadContext(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, contextID string) (contextRow, error) {
	var row contextRow
	var issuedAt, expiresAt string
	err := queryer.QueryRowContext(ctx, `
SELECT id, mandate_id, agent_id, agent_principal, owner_principal, purpose_id,
       mandate_template_id, mandate_json, mandate_hash, policy_json, policy_hash,
       policy_version, state, issued_at, expires_at, revoked_at, revoked_by,
       revocation_reason
FROM contexts WHERE id = ?`, contextID).Scan(
		&row.ID, &row.MandateID, &row.AgentID, &row.AgentPrincipal, &row.OwnerPrincipal,
		&row.PurposeID, &row.MandateTemplateID,
		&row.MandateJSON, &row.MandateHash, &row.PolicyJSON, &row.PolicyHash,
		&row.PolicyVersion, &row.State, &issuedAt, &expiresAt, &row.RevokedAt,
		&row.RevokedBy, &row.RevocationReason,
	)
	if err != nil {
		return contextRow{}, err
	}
	row.IssuedAt, err = parseTime(issuedAt)
	if err != nil {
		return contextRow{}, err
	}
	row.ExpiresAt, err = parseTime(expiresAt)
	if err != nil {
		return contextRow{}, err
	}
	return row, nil
}

type referenceRow struct {
	Digest             []byte
	ContextID          string
	OwnerPrincipal     string
	FixtureResourceID  sql.NullString
	Kind               string
	PrivateTargetID    string
	EffectiveLabels    []string
	ParentDigest       []byte
	ProducingReceiptID string
	SafeAlias          string
	ExpiresAt          time.Time
	State              string
}

func loadReference(ctx context.Context, tx *sql.Tx, digest []byte) (referenceRow, error) {
	var row referenceRow
	var labelsJSON, expiresAt string
	err := tx.QueryRowContext(ctx, `
SELECT reference_digest, context_id, owner_principal, fixture_resource_id,
       kind, private_target_id, effective_labels_json, parent_digest, producing_receipt_id,
       safe_alias, expires_at, state
FROM protected_references WHERE reference_digest = ?`, digest).Scan(
		&row.Digest, &row.ContextID, &row.OwnerPrincipal, &row.FixtureResourceID,
		&row.Kind, &row.PrivateTargetID,
		&labelsJSON, &row.ParentDigest, &row.ProducingReceiptID,
		&row.SafeAlias, &expiresAt, &row.State,
	)
	if err != nil {
		return referenceRow{}, err
	}
	if err := json.Unmarshal([]byte(labelsJSON), &row.EffectiveLabels); err != nil {
		return referenceRow{}, fmt.Errorf("decode stored labels: %w", err)
	}
	row.ExpiresAt, err = parseTime(expiresAt)
	if err != nil {
		return referenceRow{}, err
	}
	return row, nil
}

type fixtureResourceRow struct {
	ID             string
	Tool           string
	Kind           string
	OwnerPrincipal string
	PrivateTarget  string
	State          string
}

func loadFixtureResource(ctx context.Context, tx *sql.Tx, tool, kind, ownerPrincipal string) (fixtureResourceRow, error) {
	var row fixtureResourceRow
	err := tx.QueryRowContext(ctx, `
SELECT resource_id, tool, kind, owner_principal, private_target_id, state
FROM fixture_resources
WHERE tool = ? AND kind = ? AND owner_principal = ? AND state = 'ACTIVE'
ORDER BY resource_id LIMIT 1`, tool, kind, ownerPrincipal).Scan(
		&row.ID, &row.Tool, &row.Kind, &row.OwnerPrincipal, &row.PrivateTarget, &row.State,
	)
	return row, err
}

func loadFixtureResourceByID(ctx context.Context, tx *sql.Tx, resourceID string) (fixtureResourceRow, error) {
	var row fixtureResourceRow
	err := tx.QueryRowContext(ctx, `
SELECT resource_id, tool, kind, owner_principal, private_target_id, state
FROM fixture_resources WHERE resource_id = ?`, resourceID).Scan(
		&row.ID, &row.Tool, &row.Kind, &row.OwnerPrincipal, &row.PrivateTarget, &row.State,
	)
	return row, err
}

func loadContextByMandateID(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, mandateID string) (contextRow, error) {
	var row contextRow
	var issuedAt, expiresAt string
	err := queryer.QueryRowContext(ctx, `
SELECT id, mandate_id, agent_id, agent_principal, owner_principal, purpose_id,
       mandate_template_id, mandate_json, mandate_hash, policy_json, policy_hash,
       policy_version, state, issued_at, expires_at, revoked_at, revoked_by,
       revocation_reason
FROM contexts WHERE mandate_id = ?`, mandateID).Scan(
		&row.ID, &row.MandateID, &row.AgentID, &row.AgentPrincipal, &row.OwnerPrincipal,
		&row.PurposeID, &row.MandateTemplateID, &row.MandateJSON, &row.MandateHash,
		&row.PolicyJSON, &row.PolicyHash, &row.PolicyVersion, &row.State, &issuedAt,
		&expiresAt, &row.RevokedAt, &row.RevokedBy, &row.RevocationReason,
	)
	if err != nil {
		return contextRow{}, err
	}
	row.IssuedAt, err = parseTime(issuedAt)
	if err != nil {
		return contextRow{}, err
	}
	row.ExpiresAt, err = parseTime(expiresAt)
	if err != nil {
		return contextRow{}, err
	}
	return row, nil
}

func loadBoundAgentOwner(ctx context.Context, queryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, agentID string) (string, error) {
	var owner string
	err := queryer.QueryRowContext(ctx, `
SELECT owner_principal FROM contexts
WHERE agent_id = ? ORDER BY issued_at, id LIMIT 1`, agentID).Scan(&owner)
	return owner, err
}

func isNotFound(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
