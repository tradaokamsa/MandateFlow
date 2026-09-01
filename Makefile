.PHONY: demo demo-verbose poc shutdown stop kill-ports help

# Config — overridable via env / `make VAR=val`
PORT ?= 3100
MANDATEFLOW_CONTROL_HOST_PORT ?= 3102
MANDATEFLOW_RUNTIME_MCP_HOST_PORT ?= 3001
RUNTIME_INSTANCE_ID ?= first-commit-explore
# deduped + sorted by make's `sort`
PORTS := $(sort $(PORT) $(MANDATEFLOW_CONTROL_HOST_PORT) $(MANDATEFLOW_RUNTIME_MCP_HOST_PORT) 3000 3001 3002 3100 3102 5173 34567)

# Default target — show help
.DEFAULT_GOAL := help

demo: shutdown ## Start MandateFlow demo (quiet, demo-friendly — frees ports, silenced docker/npm logs)
	@RUNTIME_INSTANCE_ID="$(RUNTIME_INSTANCE_ID)" LOCAL_POC_DATA_ROOT="$(HOME)/.mandateflow-first-commit-explore" PORT="$(PORT)" MANDATEFLOW_CONTROL_HOST_PORT="$(MANDATEFLOW_CONTROL_HOST_PORT)" MANDATEFLOW_RUNTIME_MCP_HOST_PORT="$(MANDATEFLOW_RUNTIME_MCP_HOST_PORT)" POC_QUIET=1 ./CodeJam/scripts/start-local-poc.sh

demo-verbose: shutdown ## Start demo with full docker/npm logs (for debugging)
	@RUNTIME_INSTANCE_ID="$(RUNTIME_INSTANCE_ID)" LOCAL_POC_DATA_ROOT="$(HOME)/.mandateflow-first-commit-explore" PORT="$(PORT)" MANDATEFLOW_CONTROL_HOST_PORT="$(MANDATEFLOW_CONTROL_HOST_PORT)" MANDATEFLOW_RUNTIME_MCP_HOST_PORT="$(MANDATEFLOW_RUNTIME_MCP_HOST_PORT)" POC_VERBOSE=1 ./CodeJam/scripts/start-local-poc.sh --verbose

poc: demo ## Alias for demo

# Smart shutdown — lsof -i:PORT + stale MandateFlow containers/networks
# Standalone: `make shutdown` / `make stop` / `make kill-ports`
# Also runs automatically as `make demo` prerequisite.
shutdown: ## Free project ports (lsof) and remove stale MandateFlow containers/networks
	@echo "  → Freeing project ports ($(PORTS))..."
	@for port in $(PORTS); do \
		pids=""; \
		if command -v lsof >/dev/null 2>&1; then \
			pids=$$(lsof -ti tcp:$$port 2>/dev/null || true); \
		elif command -v fuser >/dev/null 2>&1; then \
			pids=$$(fuser -n tcp $$port 2>/dev/null | tr -s ' ' '\n' | xargs || true); \
		fi; \
		if [ -n "$$pids" ]; then \
			echo "    • Freeing port $$port (PIDs: $$(echo $$pids | tr '\n' ' '))"; \
			kill $$pids 2>/dev/null || true; sleep 1; \
			if command -v lsof >/dev/null 2>&1; then \
				pids=$$(lsof -ti tcp:$$port 2>/dev/null || true); \
			else pids=""; fi; \
			if [ -n "$$pids" ]; then \
				echo "    • Force-killing port $$port (PIDs: $$(echo $$pids | tr '\n' ' '))"; \
				kill -9 $$pids 2>/dev/null || true; sleep 0.5; \
			fi; \
		fi; \
	done
	@for engine in docker podman; do \
		if command -v $$engine >/dev/null 2>&1 && $$engine info >/dev/null 2>&1; then \
			sidecar="mandateflow-$(RUNTIME_INSTANCE_ID)"; \
			if $$engine ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$$sidecar"; then \
				echo "    • Removing stale container $$sidecar ($$engine)"; \
				$$engine rm --force "$$sidecar" >/dev/null 2>&1 || true; \
			fi; \
			cids=$$($$engine ps --all --quiet --filter label=io.codejam.launchpad=agent-runtime --filter "label=io.codejam.instance-id=$(RUNTIME_INSTANCE_ID)" 2>/dev/null || true); \
			if [ -n "$$cids" ]; then \
				echo "    • Removing stale agent-runtime containers ($$engine)"; \
				for cid in $$cids; do $$engine rm --force "$$cid" >/dev/null 2>&1 || true; done; \
			fi; \
			net="mandateflow-$(RUNTIME_INSTANCE_ID)"; \
			if $$engine network ls --format '{{.Name}}' 2>/dev/null | grep -qx "$$net"; then \
				echo "    • Removing stale network $$net ($$engine)"; \
				$$engine network rm "$$net" >/dev/null 2>&1 || true; \
			fi; \
		fi; \
	done
	@echo "  ✓ Ports/containers ready"

stop: shutdown ## Alias for shutdown
kill-ports: shutdown ## Alias for shutdown

help: ## Show this help
	@grep -E '^[a-zA-Z0-9_.-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' | sort
	@echo ""
	@echo "Examples:"
	@echo "  make demo              # quiet demo (frees ports, then CodeJam/scripts/start-local-poc.sh)"
	@echo "  make shutdown          # only free ports + stale containers (smart lsof)"
	@echo "  make demo-verbose      # full logs"
	@echo "  make demo VERBOSE=1    # env-override verbose"
	@echo "  ./run-poc.sh           # deprecated shim — use 'make demo'"

# Note: start-local-poc.sh is now the single engine — it auto-loads ../api_key.txt,
# auto-generates APP_AUTH_TOKEN, frees ports, and silences builds. `run-poc.sh`
# remains as a thin backwards-compat shim.
