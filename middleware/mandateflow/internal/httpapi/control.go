package httpapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/techjam/mandateflow/internal/mandateflow"
)

type ControlHandler struct {
	service *mandateflow.Service
	token   string
	mux     *http.ServeMux
}

func NewControlHandler(service *mandateflow.Service, token string) http.Handler {
	handler := &ControlHandler{service: service, token: token, mux: http.NewServeMux()}
	handler.mux.HandleFunc("GET /healthz", handler.health)
	handler.mux.HandleFunc("PUT /control/v1/runs/{runId}/prepare", handler.prepare)
	handler.mux.HandleFunc("POST /control/v1/runs/{runId}/activate", handler.activate)
	handler.mux.HandleFunc("POST /control/v1/runs/{runId}/finish", handler.finish)
	handler.mux.HandleFunc("GET /control/v1/runs/{runId}/evidence", handler.evidence)
	handler.mux.HandleFunc("GET /control/v1/mandates/{mandateId}", handler.mandate)
	handler.mux.HandleFunc("POST /control/v1/mandates/{mandateId}/revoke", handler.revoke)
	return handler
}

func (h *ControlHandler) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.URL.Path != "/healthz" && !constantTimeBearer(request.Header.Get("Authorization"), h.token) {
		response.Header().Set("WWW-Authenticate", `Bearer error="invalid_token"`)
		writeJSON(response, http.StatusUnauthorized, map[string]string{"error": "Authentication required"})
		return
	}
	response.Header().Set("Cache-Control", "no-store")
	h.mux.ServeHTTP(response, request)
}

func (h *ControlHandler) health(response http.ResponseWriter, request *http.Request) {
	ctx, cancel := context.WithTimeout(request.Context(), time.Second)
	defer cancel()
	if err := h.service.Ready(ctx); err != nil {
		writeJSON(response, http.StatusServiceUnavailable, map[string]any{"ok": false})
		return
	}
	writeJSON(response, http.StatusOK, map[string]any{"ok": true, "service": "mandateflowd"})
}

func (h *ControlHandler) prepare(response http.ResponseWriter, request *http.Request) {
	var body mandateflow.PrepareRequest
	if err := decodeStrict(response, request, &body); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	result, err := h.service.Prepare(request.Context(), request.PathValue("runId"), body)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *ControlHandler) activate(response http.ResponseWriter, request *http.Request) {
	result, err := h.service.Activate(request.Context(), request.PathValue("runId"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *ControlHandler) finish(response http.ResponseWriter, request *http.Request) {
	var body mandateflow.FinishRequest
	if err := decodeStrict(response, request, &body); err != nil {
		writeJSON(response, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
		return
	}
	result, err := h.service.Finish(request.Context(), request.PathValue("runId"), body.Status)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *ControlHandler) evidence(response http.ResponseWriter, request *http.Request) {
	result, err := h.service.Evidence(request.Context(), request.PathValue("runId"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *ControlHandler) mandate(response http.ResponseWriter, request *http.Request) {
	result, err := h.service.MandateSummary(request.Context(), request.PathValue("mandateId"))
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func (h *ControlHandler) revoke(response http.ResponseWriter, request *http.Request) {
	var body struct {
		ActorPrincipal string `json:"actorPrincipal"`
	}
	if request.Body != nil && request.Body != http.NoBody {
		if err := decodeStrict(response, request, &body); err != nil {
			writeJSON(response, http.StatusBadRequest, map[string]string{"error": "Invalid request body"})
			return
		}
	}
	result, err := h.service.RevokeMandate(request.Context(), request.PathValue("mandateId"), body.ActorPrincipal)
	if err != nil {
		writeServiceError(response, err)
		return
	}
	writeJSON(response, http.StatusOK, result)
}

func decodeStrict(response http.ResponseWriter, request *http.Request, target any) error {
	request.Body = http.MaxBytesReader(response, request.Body, 64*1024)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON value")
	}
	return nil
}

func constantTimeBearer(header, expected string) bool {
	const prefix = "Bearer "
	if len(header) <= len(prefix) || header[:len(prefix)] != prefix {
		return false
	}
	candidate := header[len(prefix):]
	if len(candidate) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(expected)) == 1
}

func writeServiceError(response http.ResponseWriter, err error) {
	status := http.StatusInternalServerError
	message := "Internal MandateFlow error"
	var serviceErr *mandateflow.ServiceError
	if errors.As(err, &serviceErr) {
		message = serviceErr.Message
		switch serviceErr.Code {
		case mandateflow.CodeInvalidRequest:
			status = http.StatusBadRequest
		case mandateflow.CodeNotFound:
			status = http.StatusNotFound
		case mandateflow.CodeConflict:
			status = http.StatusConflict
		case mandateflow.CodeOwnershipDenied:
			status = http.StatusForbidden
		default:
			status = http.StatusBadRequest
		}
	}
	writeJSON(response, status, map[string]string{"error": message})
}

func writeJSON(response http.ResponseWriter, status int, value any) {
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(value)
}
