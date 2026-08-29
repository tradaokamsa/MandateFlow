package main

import (
	"context"
	"encoding/base64"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/techjam/mandateflow/internal/httpapi"
	"github.com/techjam/mandateflow/internal/mandateflow"
	"github.com/techjam/mandateflow/internal/mcpserver"
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	controlToken := strings.TrimSpace(os.Getenv("MANDATEFLOW_CONTROL_TOKEN"))
	if !validControlToken(controlToken) {
		logger.Error("invalid MandateFlow control token configuration")
		os.Exit(2)
	}
	databasePath := envOr("MANDATEFLOW_DB_PATH", "/var/lib/mandateflow/mandateflow.db")
	policyPath := envOr("MANDATEFLOW_POLICY_FILE", "/etc/mandateflow/mixed-operations.v1.json")
	controlAddress := envOr("MANDATEFLOW_CONTROL_ADDR", ":3002")
	mcpAddress := envOr("MANDATEFLOW_MCP_ADDR", ":3001")
	runTTL := durationFromMilliseconds("MANDATEFLOW_RUN_TTL_MS", 660_000)

	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		logger.Error("create MandateFlow data directory", "error", err.Error())
		os.Exit(1)
	}
	policy, err := mandateflow.LoadPolicy(policyPath)
	if err != nil {
		logger.Error("load MandateFlow policy", "error", err.Error())
		os.Exit(1)
	}
	store, err := mandateflow.OpenStore(databasePath)
	if err != nil {
		logger.Error("open MandateFlow store", "error", err.Error())
		os.Exit(1)
	}
	defer store.Close()
	service := mandateflow.NewService(store, policy, runTTL)

	controlServer := &http.Server{
		Addr:              controlAddress,
		Handler:           httpapi.NewControlHandler(service, controlToken),
		ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout:       5 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}
	mcpServer := &http.Server{
		Addr:              mcpAddress,
		Handler:           mcpserver.New(service),
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    16 * 1024,
	}

	errorChannel := make(chan error, 2)
	go serve(logger, "control", controlServer, errorChannel)
	go serve(logger, "mcp", mcpServer, errorChannel)
	logger.Info("MandateFlow ready", "controlAddress", controlAddress, "mcpAddress", mcpAddress, "policyVersion", policy.Policy.Version)

	signalContext, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	select {
	case <-signalContext.Done():
		logger.Info("MandateFlow shutting down", "reason", signalContext.Err().Error())
	case serverError := <-errorChannel:
		logger.Error("MandateFlow listener failed", "error", serverError.Error())
	}
	shutdownContext, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = controlServer.Shutdown(shutdownContext)
	_ = mcpServer.Shutdown(shutdownContext)
}

func validControlToken(value string) bool {
	if !strings.HasPrefix(value, "mfc1_") || len(value) != 48 {
		return false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value[len("mfc1_"):])
	return err == nil && len(decoded) == 32
}

func serve(logger *slog.Logger, name string, server *http.Server, errorsOut chan<- error) {
	logger.Info("starting listener", "listener", name, "address", server.Addr)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		errorsOut <- err
	}
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func durationFromMilliseconds(name string, fallback int64) time.Duration {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return time.Duration(fallback) * time.Millisecond
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1_000 {
		return time.Duration(fallback) * time.Millisecond
	}
	return time.Duration(value) * time.Millisecond
}
