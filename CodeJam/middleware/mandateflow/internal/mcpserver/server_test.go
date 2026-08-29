package mcpserver

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/techjam/mandateflow/internal/mandateflow"
)

const policyFixture = `{"id":"mixed-operations-flow","version":1,"purposeId":"MIXED_OPERATIONS_BRIEF","defaultEffect":"ALLOW_IF_STATIC_SCOPE","rules":[{"id":"NO_PAYMENT_REIDENTIFICATION","when":{"anyAncestorClassification":"PAYMENT_AGGREGATE_ONLY","destinationTool":"crm.resolve_customer"},"effect":"DENY","safeAlternative":"payments.aggregate_failures"}]}`

type bearerTransport struct {
	bearer string
	base   http.RoundTripper
}

func (transport bearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header.Set("Authorization", "Bearer "+transport.bearer)
	return transport.base.RoundTrip(clone)
}

type handlerTransport struct {
	handler http.Handler
}

func (transport handlerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	recorder := httptest.NewRecorder()
	transport.handler.ServeHTTP(recorder, request)
	return recorder.Result(), nil
}

func TestAuthenticatedStreamableHTTPToolFlow(t *testing.T) {
	service, bearer := activeService(t)
	handler := New(service)
	endpoint := "http://mandateflow.test/mcp"
	baseTransport := handlerTransport{handler: handler}

	request, err := http.NewRequest(
		http.MethodPost,
		endpoint,
		strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Content-Type", "application/json")
	unauthenticated, err := (&http.Client{Transport: baseTransport}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	unauthenticated.Body.Close()
	if unauthenticated.StatusCode != http.StatusUnauthorized {
		t.Fatalf("missing bearer status = %d", unauthenticated.StatusCode)
	}
	originRequest, err := http.NewRequest(
		http.MethodPost,
		endpoint,
		strings.NewReader(`{"jsonrpc":"2.0","id":2,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`),
	)
	if err != nil {
		t.Fatal(err)
	}
	originRequest.Header.Set("Content-Type", "application/json")
	originRequest.Header.Set("Authorization", "Bearer "+bearer)
	originRequest.Header.Set("Origin", "https://untrusted.example")
	originResponse, err := (&http.Client{Transport: baseTransport}).Do(originRequest)
	if err != nil {
		t.Fatal(err)
	}
	originResponse.Body.Close()
	if originResponse.StatusCode != http.StatusUnauthorized {
		t.Fatalf("browser-origin request status = %d", originResponse.StatusCode)
	}

	httpClient := &http.Client{Transport: bearerTransport{bearer: bearer, base: baseTransport}}
	client := mcp.NewClient(&mcp.Implementation{Name: "mandateflow-test", Version: "v1"}, nil)
	session, err := client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:   endpoint,
		HTTPClient: httpClient,
		MaxRetries: -1,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })

	payment := callTool(t, session, "payments.list_failures", map[string]any{})
	if payment.Reference == nil {
		t.Fatalf("Payment source did not return a reference: %+v", payment)
	}
	derived := callTool(t, session, "cases.lookup_subject", map[string]any{"reference": payment.Reference.Reference})
	if derived.Reference == nil {
		t.Fatalf("Case tool did not return a reference: %+v", derived)
	}
	_, err = session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "crm.resolve_customer",
		Arguments: map[string]any{
			"reference":      derived.Reference.Reference,
			"classification": "SUPPORT_FOLLOWUP_ALLOWED",
			"agentId":        "forged-agent",
		},
	})
	if err == nil {
		t.Fatal("fake client authority/provenance fields were accepted")
	}
	denied := callTool(t, session, "crm.resolve_customer", map[string]any{"reference": derived.Reference.Reference})
	if denied.Code != "FLOW_DENIED" || denied.OK {
		t.Fatalf("MCP flow was not denied: %+v", denied)
	}
}

func activeService(t *testing.T) (*mandateflow.Service, string) {
	t.Helper()
	policy, err := mandateflow.ParsePolicy([]byte(policyFixture))
	if err != nil {
		t.Fatal(err)
	}
	store, err := mandateflow.OpenStore(filepath.Join(t.TempDir(), "mandateflow.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	service := mandateflow.NewService(store, policy, time.Hour)
	randomValue := make([]byte, 32)
	if _, err := rand.Read(randomValue); err != nil {
		t.Fatal(err)
	}
	bearer := "mfr1_" + base64.RawURLEncoding.EncodeToString(randomValue)
	digest := sha256.Sum256([]byte(bearer))
	_, err = service.Prepare(context.Background(), "run-mcp", mandateflow.PrepareRequest{
		AgentID:              "agent-mcp",
		RuntimeInstanceID:    "runtime-mcp",
		Mode:                 mandateflow.PrepareNew,
		MandateTemplateID:    mandateflow.MandateTemplateID,
		RequestedPermissions: mandateflow.PlatformPermissions(),
		CapabilitySHA256:     base64.RawURLEncoding.EncodeToString(digest[:]),
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.Activate(context.Background(), "run-mcp"); err != nil {
		t.Fatal(err)
	}
	return service, bearer
}

func callTool(t *testing.T, session *mcp.ClientSession, name string, arguments map[string]any) mandateflow.ToolResult {
	t.Helper()
	response, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Content) == 0 {
		t.Fatalf("tool %s returned no content", name)
	}
	text, ok := response.Content[0].(*mcp.TextContent)
	if !ok {
		t.Fatalf("tool %s returned non-text content", name)
	}
	var result mandateflow.ToolResult
	if err := json.Unmarshal([]byte(text.Text), &result); err != nil {
		t.Fatalf("decode tool %s result: %v", name, err)
	}
	return result
}
