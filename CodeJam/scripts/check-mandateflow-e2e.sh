#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ -z "${APP_AUTH_TOKEN:-}" ]]; then
  printf 'APP_AUTH_TOKEN is required for the MandateFlow E2E check.\n' >&2
  exit 2
fi

MANDATEFLOW_E2E_BASE_URL="${MANDATEFLOW_E2E_BASE_URL:-http://127.0.0.1:3000}" \
  node "$repo_dir/scripts/mandateflow-e2e.mjs"
