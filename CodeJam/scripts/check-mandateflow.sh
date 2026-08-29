#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module_dir="$repo_dir/middleware/mandateflow"

if command -v go >/dev/null 2>&1; then
  mandateflow_go_cache="${TMPDIR:-/tmp}/mandateflow-go-cache"
  mkdir -p "$mandateflow_go_cache"
  (
    cd "$module_dir"
    GOCACHE="$mandateflow_go_cache" go test ./...
  )
  exit 0
fi

engine="${CONTAINER_ENGINE:-docker}"
command -v "$engine" >/dev/null 2>&1 || {
  printf 'Go or a container engine is required for MandateFlow checks.\n' >&2
  exit 2
}
"$engine" build --target test --file "$module_dir/Dockerfile" "$module_dir"
