#!/usr/bin/env bash
set -euo pipefail

# One-click local POC runner — now a thin shim.
# All logic lives in CodeJam/scripts/start-local-poc.sh (single engine).
# Kept for backwards compat: `./run-poc.sh` === `make demo`.
# Prefer `make demo` / `make demo-verbose` going forward.

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="$repo_dir/CodeJam/scripts/start-local-poc.sh"

if [[ ! -f "$target" ]]; then
  echo "start-local-poc.sh not found at $target" >&2
  exit 1
fi

# Demo defaults matching Makefile (so direct ./run-poc.sh still behaves like `make demo`)
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-first-commit-explore}"
export LOCAL_POC_DATA_ROOT="${LOCAL_POC_DATA_ROOT:-$HOME/.mandateflow-first-commit-explore}"
export PORT="${PORT:-3100}"
export MANDATEFLOW_CONTROL_HOST_PORT="${MANDATEFLOW_CONTROL_HOST_PORT:-3102}"
export MANDATEFLOW_RUNTIME_MCP_HOST_PORT="${MANDATEFLOW_RUNTIME_MCP_HOST_PORT:-3001}"
# run-poc.sh historically defaults to quiet demo mode; preserve that.
export POC_QUIET="${POC_QUIET:-1}"
export POC_VERBOSE="${POC_VERBOSE:-${VERBOSE:-0}}"

# Handle --help here (thin shim) and exit — no need to forward.
for arg in "$@"; do
  case "$arg" in
    --help|-h)
      printf 'run-poc.sh is a thin shim — prefer: make demo\n' >&2
      printf 'Usage: %s [--verbose|-v] [--quiet|-q] [--help]\n' "$(basename "$0")" >&2
      printf '  --verbose  Show full docker/npm build logs (for debugging)\n' >&2
      printf '  --quiet    Hide build logs (default for demo)\n' >&2
      printf '\nAlso: make demo | make demo-verbose | make shutdown\n' >&2
      exit 0
      ;;
  esac
done

exec "$target" "$@"
