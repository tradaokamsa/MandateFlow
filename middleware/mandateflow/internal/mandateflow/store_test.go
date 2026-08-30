package mandateflow

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStorePragmasAndStartupRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "mandateflow.db")
	policy, err := ParsePolicy([]byte(testPolicy))
	if err != nil {
		t.Fatal(err)
	}
	store, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	var foreignKeys, busyTimeout int
	if err := store.db.QueryRow(`PRAGMA foreign_keys`).Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`PRAGMA busy_timeout`).Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 || busyTimeout != 5000 {
		t.Fatalf("unexpected SQLite connection settings: foreign_keys=%d busy_timeout=%d", foreignKeys, busyTimeout)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("SQLite file permissions = %o", info.Mode().Perm())
	}

	service := NewService(store, policy, time.Hour)
	_, _, bearer := prepareActiveRun(t, service, "run-restart", "agent-restart", PrepareNew, nil, nil, PlatformPermissions())
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = reopened.Close() })
	recovered := NewService(reopened, policy, time.Hour)
	if _, err := recovered.Authenticate(context.Background(), bearer); !ErrorHasCode(err, CodeInvalidToken) {
		t.Fatalf("Gateway-restarted bearer remained valid: %v", err)
	}
	evidence, err := recovered.Evidence(context.Background(), "run-restart")
	if err != nil {
		t.Fatal(err)
	}
	if evidence.RunStatus != "GATEWAY_RESTART" {
		t.Fatalf("nonterminal Run was not recovered fail-closed: %s", evidence.RunStatus)
	}
}
