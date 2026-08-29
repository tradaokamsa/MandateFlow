package mcpserver

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/techjam/mandateflow/internal/mandateflow"
)

type principalContextKey struct{}

type EmptyInput struct{}

type ReferenceInput struct {
	Reference string `json:"reference" jsonschema:"opaque protected reference returned by another MandateFlow tool"`
}

func New(service *mandateflow.Service) http.Handler {
	server := mcp.NewServer(&mcp.Implementation{Name: "mandateflow", Version: "v1.0.0"}, nil)

	addNoInputTool(server, service, "support.list_tickets", "List the seeded open Support ticket and return an opaque protected subject reference.")
	addNoInputTool(server, service, "payments.list_failures", "List seeded Payment failures and return an aggregate-only opaque subject reference.")
	addReferenceTool(server, service, "cases.lookup_subject", "Transform a customer-subject reference into an operations-case reference while preserving trusted provenance.")
	addReferenceTool(server, service, "crm.resolve_customer", "Resolve an operations-case reference through CRM when its trusted provenance permits Support follow-up.")
	addNoInputTool(server, service, "payments.aggregate_failures", "Return a safe aggregate summary of Payment failures without customer identifiers.")

	streamable := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true},
	)
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/mcp" {
			http.NotFound(response, request)
			return
		}
		if request.Header.Get("Origin") != "" {
			writeInvalidToken(response)
			return
		}
		bearer := bearerToken(request.Header.Get("Authorization"))
		principal, err := service.Authenticate(request.Context(), bearer)
		if err != nil {
			writeInvalidToken(response)
			return
		}
		request = request.WithContext(context.WithValue(request.Context(), principalContextKey{}, principal))
		streamable.ServeHTTP(response, request)
	})
}

func addNoInputTool(server *mcp.Server, service *mandateflow.Service, name, description string) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description},
		func(ctx context.Context, _ *mcp.CallToolRequest, _ EmptyInput) (*mcp.CallToolResult, mandateflow.ToolResult, error) {
			return execute(ctx, service, name, "")
		},
	)
}

func addReferenceTool(server *mcp.Server, service *mandateflow.Service, name, description string) {
	mcp.AddTool(server, &mcp.Tool{Name: name, Description: description},
		func(ctx context.Context, _ *mcp.CallToolRequest, input ReferenceInput) (*mcp.CallToolResult, mandateflow.ToolResult, error) {
			return execute(ctx, service, name, input.Reference)
		},
	)
}

func execute(ctx context.Context, service *mandateflow.Service, name, reference string) (*mcp.CallToolResult, mandateflow.ToolResult, error) {
	principal, ok := ctx.Value(principalContextKey{}).(mandateflow.Principal)
	if !ok {
		return nil, mandateflow.ToolResult{}, &mandateflow.ServiceError{Code: mandateflow.CodeInvalidToken, Message: "Run authority is unavailable"}
	}
	result, err := service.ExecuteTool(ctx, principal, name, reference)
	if err != nil {
		return nil, mandateflow.ToolResult{}, err
	}
	encoded, _ := json.Marshal(result)
	return &mcp.CallToolResult{
		IsError: !result.OK,
		Content: []mcp.Content{&mcp.TextContent{Text: string(encoded)}},
	}, result, nil
}

func bearerToken(header string) string {
	if !strings.HasPrefix(header, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(header[len("Bearer "):])
}

func writeInvalidToken(response http.ResponseWriter) {
	response.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusUnauthorized)
	_, _ = response.Write([]byte(`{"error":"invalid_token"}`))
}
