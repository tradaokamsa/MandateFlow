#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
demo_parent="${MANDATEFLOW_DEMO_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$demo_parent"
export LOCAL_POC_DATA_ROOT
LOCAL_POC_DATA_ROOT="$(mktemp -d "$demo_parent/mandateflow-demo.XXXXXX")"
export MANDATEFLOW_ENABLED=true

printf '[mandateflow-demo] Fresh demo state: %s\n' "$LOCAL_POC_DATA_ROOT" >&2
exec "$repo_dir/scripts/start-local-poc.sh"
