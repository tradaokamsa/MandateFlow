#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
module_dir="${MANDATEFLOW_DIR:-$repo_dir/../middleware/mandateflow}"
if [[ "$module_dir" != /* ]]; then
  module_dir="$repo_dir/$module_dir"
fi
if [[ ! -d "$module_dir" ]]; then
  printf 'MandateFlow module was not found at %s. Set MANDATEFLOW_DIR to its path.\n' "$module_dir" >&2
  exit 2
fi
module_dir="$(cd "$module_dir" && pwd)"

if command -v go >/dev/null 2>&1; then
  mandateflow_go_cache="${TMPDIR:-/tmp}/mandateflow-go-cache"
  mkdir -p "$mandateflow_go_cache"
  (
    cd "$module_dir"
    GOCACHE="$mandateflow_go_cache" go test ./...
  )
  exit 0
fi

if [[ "${MANDATEFLOW_REQUIRE_GO:-0}" == "1" ]]; then
  printf 'Go is required for the fast MandateFlow check; install Go 1.23+ or run npm run check for the container fallback.\n' >&2
  exit 2
fi

engine="${CONTAINER_ENGINE:-docker}"
command -v "$engine" >/dev/null 2>&1 || {
  printf 'Go or a container engine is required for MandateFlow checks.\n' >&2
  exit 2
}
"$engine" build --target test --file "$module_dir/Dockerfile" "$module_dir"
