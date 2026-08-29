package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/techjam/mandateflow/internal/mandateflow"
)

const controlTestPolicy = `{"id":"mixed-operations-flow","version":1,"purposeId":"MIXED_OPERATIONS_BRIEF","defaultEffect":"ALLOW_IF_STATIC_SCOPE","rules":[{"id":"NO_PAYMENT_REIDENTIFICATION","when":{"anyAncestorClassification":"PAYMENT_AGGREGATE_ONLY","destinationTool":"crm.resolve_customer"},"effect":"DENY","safeAlternative":"payments.aggregate_failures"}]}`

type readTrackingBody struct {
	read bool
}

func (body *readTrackingBody) Read([]byte) (int, error) {
	body.read = true
	return 0, io.EOF
}

func (*readTrackingBody) Close() error { return nil }

func TestControlAuthenticatesBeforeReadingBody(t *testing.T) {
	handler := controlTestHandler(t)
	body := &readTrackingBody{}
	request := httptest.NewRequest(http.MethodPut, "/control/v1/runs/run-1/prepare", body)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusUnauthorized || body.read {
		t.Fatalf("unauthenticated request status=%d bodyRead=%v", response.Code, body.read)
	}
}

func TestControlRejectsUnknownJSONFields(t *testing.T) {
	handler := controlTestHandler(t)
	request := httptest.NewRequest(http.MethodPut, "/control/v1/runs/run-1/prepare", strings.NewReader(`{"unexpected":true}`))
	request.Header.Set("Authorization", "Bearer mfc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusBadRequest {
		t.Fatalf("unknown control field status=%d body=%s", response.Code, response.Body.String())
	}
}

func controlTestHandler(t *testing.T) http.Handler {
	t.Helper()
	policy, err := mandateflow.ParsePolicy([]byte(controlTestPolicy))
	if err != nil {
		t.Fatal(err)
	}
	store, err := mandateflow.OpenStore(filepath.Join(t.TempDir(), "mandateflow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service := mandateflow.NewService(store, policy, time.Hour)
	return NewControlHandler(service, "mfc1_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
}
