#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

# Keep help available even before the first local .env file has been created.
for _arg in "$@"; do
  case "$_arg" in
    --help|-h)
      printf 'Usage: %s [--verbose|-v] [--quiet|-q] [--help]\n' "$(basename "$0")" >&2
      printf '  --verbose  Show full docker/npm build logs (for debugging)\n' >&2
      printf '  --quiet    Hide build logs (default for demo)\n' >&2
      printf '\nOne-click demo: make demo  (or ./CodeJam/scripts/start-local-poc.sh)\n' >&2
      exit 0
      ;;
  esac
done

# The local demo has one explicit configuration entry point. Preserve values
# supplied by Makefile/shell callers because they are intentional run-specific
# overrides (for example PORT and RUNTIME_INSTANCE_ID).
_caller_port_set="${PORT+x}"
_caller_port="${PORT-}"
_caller_control_port_set="${MANDATEFLOW_CONTROL_HOST_PORT+x}"
_caller_control_port="${MANDATEFLOW_CONTROL_HOST_PORT-}"
_caller_runtime_mcp_port_set="${MANDATEFLOW_RUNTIME_MCP_HOST_PORT+x}"
_caller_runtime_mcp_port="${MANDATEFLOW_RUNTIME_MCP_HOST_PORT-}"
_caller_instance_id_set="${RUNTIME_INSTANCE_ID+x}"
_caller_instance_id="${RUNTIME_INSTANCE_ID-}"
_caller_data_root_set="${LOCAL_POC_DATA_ROOT+x}"
_caller_data_root="${LOCAL_POC_DATA_ROOT-}"
_caller_provider_set="${RUNTIME_PROVIDER+x}"
_caller_provider="${RUNTIME_PROVIDER-}"
_caller_engine_set="${CONTAINER_ENGINE+x}"
_caller_engine="${CONTAINER_ENGINE-}"
_caller_auth_token_set="${APP_AUTH_TOKEN+x}"
_caller_auth_token="${APP_AUTH_TOKEN-}"
_caller_groq_key_set="${GROQ_API_KEY+x}"
_caller_groq_key="${GROQ_API_KEY-}"
_caller_groq_model_set="${GROQ_MODEL+x}"
_caller_groq_model="${GROQ_MODEL-}"

env_file="${LAUNCHPAD_ENV_FILE:-$repo_dir/.env}"
if [[ "$env_file" != /* ]]; then
  env_file="$repo_dir/$env_file"
fi
if [[ ! -f "$env_file" ]]; then
  printf '[local-poc] Missing environment file: %s\n' "$env_file" >&2
  printf '[local-poc] Create it with: cp .env.example .env\n' >&2
  printf '[local-poc] Then set GROQ_API_KEY to your free Groq API key.\n' >&2
  exit 2
fi
set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

if [[ -n "$_caller_port_set" ]]; then PORT="$_caller_port"; export PORT; fi
if [[ -n "$_caller_control_port_set" ]]; then MANDATEFLOW_CONTROL_HOST_PORT="$_caller_control_port"; export MANDATEFLOW_CONTROL_HOST_PORT; fi
if [[ -n "$_caller_runtime_mcp_port_set" ]]; then MANDATEFLOW_RUNTIME_MCP_HOST_PORT="$_caller_runtime_mcp_port"; export MANDATEFLOW_RUNTIME_MCP_HOST_PORT; fi
if [[ -n "$_caller_instance_id_set" ]]; then RUNTIME_INSTANCE_ID="$_caller_instance_id"; export RUNTIME_INSTANCE_ID; fi
if [[ -n "$_caller_data_root_set" ]]; then LOCAL_POC_DATA_ROOT="$_caller_data_root"; export LOCAL_POC_DATA_ROOT; fi
if [[ -n "$_caller_provider_set" ]]; then RUNTIME_PROVIDER="$_caller_provider"; export RUNTIME_PROVIDER; fi
if [[ -n "$_caller_engine_set" ]]; then CONTAINER_ENGINE="$_caller_engine"; export CONTAINER_ENGINE; fi
if [[ -n "$_caller_auth_token_set" ]]; then APP_AUTH_TOKEN="$_caller_auth_token"; export APP_AUTH_TOKEN; fi
if [[ -n "$_caller_groq_key_set" ]]; then GROQ_API_KEY="$_caller_groq_key"; export GROQ_API_KEY; fi
if [[ -n "$_caller_groq_model_set" ]]; then GROQ_MODEL="$_caller_groq_model"; export GROQ_MODEL; fi

# --- Demo-quiet handling: silence docker/npm vomit unless --verbose ---
POC_QUIET="${POC_QUIET:-0}"
POC_VERBOSE="${POC_VERBOSE:-${VERBOSE:-0}}"
for _arg in "$@"; do
  case "$_arg" in
    --verbose|-v) POC_VERBOSE=1; POC_QUIET=0 ;;
    --quiet|-q) POC_QUIET=1; POC_VERBOSE=0 ;;
  esac
done
export POC_QUIET POC_VERBOSE

is_quiet() { [[ "$POC_QUIET" == "1" && "$POC_VERBOSE" != "1" ]]; }

# temp log for quiet runs — only shown on failure
_poc_log_file="$(mktemp -t mandateflow-poc-XXXXXX.log 2>/dev/null || mktemp /tmp/mandateflow-poc-XXXXXX.log 2>/dev/null || echo /tmp/mandateflow-poc.log)"
_poc_run() {
  if is_quiet; then
    if "$@" >"$_poc_log_file" 2>&1; then
      rm -f "$_poc_log_file" 2>/dev/null || true
      return 0
    else
      _rc=$?
      printf '\n  ✖ %s failed (exit %s)\n' "$*" "$_rc" >&2
      printf '  ── log ─────────────────────────────────────\n' >&2
      cat "$_poc_log_file" >&2 || true
      printf '  ────────────────────────────────────────────\n' >&2
      printf '  Rerun with --verbose for full output: ./run-poc.sh --verbose\n' >&2
      rm -f "$_poc_log_file" 2>/dev/null || true
      return $_rc
    fi
  else
    "$@"
  fi
}

# --- One-click demo niceties (so `make demo` / direct `npm run poc` works after .env setup) ---
# Auto-generate unlock token if not provided (one-click demo). Mirrors run-poc.sh.
if [[ -z "${APP_AUTH_TOKEN:-}" || ${#APP_AUTH_TOKEN} -lt 24 || "$APP_AUTH_TOKEN" == replace-* || ! "$APP_AUTH_TOKEN" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  if command -v node >/dev/null 2>&1; then
    _gen_token="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(24).toString("base64url"))' 2>/dev/null || true)"
    if [[ -n "${_gen_token:-}" ]]; then
      APP_AUTH_TOKEN="$_gen_token"
      export APP_AUTH_TOKEN
      _auto_token_generated=1
    fi
  fi
fi

mandateflow_dir="${MANDATEFLOW_DIR:-$repo_dir/../middleware/mandateflow}"
if [[ "$mandateflow_dir" != /* ]]; then
  mandateflow_dir="$repo_dir/$mandateflow_dir"
fi

runtime_image="${CONTAINER_RUNTIME_IMAGE:-volc-agent-runtime:local}"
runtime_base_image="${CONTAINER_RUNTIME_BASE_IMAGE:-node:22-bookworm-slim}"
runtime_apt_mirror="${CONTAINER_APT_MIRROR:-}"
runtime_apt_security_mirror="${CONTAINER_APT_SECURITY_MIRROR:-}"
runtime_apt_packages="${CONTAINER_RUNTIME_APT_PACKAGES:-ca-certificates git ripgrep}"
codex_sandbox_mode="${CODEX_SANDBOX_MODE:-workspace-write}"
mandateflow_image="${MANDATEFLOW_IMAGE:-mandateflow-sidecar:local}"
mandateflow_go_image="${MANDATEFLOW_GO_IMAGE:-golang:1.23-bookworm}"
mandateflow_control_port="${MANDATEFLOW_CONTROL_HOST_PORT:-3002}"
runtime_provider="${RUNTIME_PROVIDER:-}"
groq_key_is_usable() {
  local key="${GROQ_API_KEY:-}"
  [[ -n "$key" ]] && [[ ! "$key" =~ ^(replace|your|placeholder|change|xxx+)([-_[:space:]]|$) ]]
}
if ! groq_key_is_usable; then
  printf '[local-poc] GROQ_API_KEY is missing or still a placeholder in %s.\n' "$env_file" >&2
  printf '[local-poc] Copy .env.example to .env and set it to your free Groq API key.\n' >&2
  exit 2
fi
if [[ -z "$runtime_provider" || "$runtime_provider" == "local-process" ]]; then
  if groq_key_is_usable; then
    runtime_provider="container"
  else
    runtime_provider="fixture"
  fi
fi

log() {
  if is_quiet; then
    # In quiet/demo mode keep chatter minimal — only show when explicitly verbose
    if [[ "$POC_VERBOSE" == "1" ]]; then
      printf '[local-poc] %s\n' "$*" >&2
    fi
  else
    printf '[local-poc] %s\n' "$*" >&2
  fi
}
log_err() {
  # Always visible — errors / fatal messages even in quiet/demo mode
  printf '[local-poc] %s\n' "$*" >&2
}
step() {
  # Always visible — concise demo progress line
  printf '  → %s\n' "$*" >&2
}
ok() {
  printf '  ✓ %s\n' "$*" >&2
}

if [[ "$runtime_provider" != "container" && "$runtime_provider" != "fixture" ]]; then
  log_err "npm run poc supports RUNTIME_PROVIDER=container or RUNTIME_PROVIDER=fixture."
  exit 2
fi

if [[ ! -d "$mandateflow_dir" ]]; then
  log_err "MandateFlow module was not found at $mandateflow_dir."
  log_err "Set MANDATEFLOW_DIR to the middleware directory."
  exit 2
fi
mandateflow_dir="$(cd "$mandateflow_dir" && pwd)"

engine_works() {
  "$1" info >/dev/null 2>&1
}

detect_engine() {
  if [[ -n "${CONTAINER_ENGINE:-}" ]]; then
    command -v "$CONTAINER_ENGINE" >/dev/null 2>&1 || {
      log_err "CONTAINER_ENGINE=$CONTAINER_ENGINE was not found."
      return 1
    }
    engine_works "$CONTAINER_ENGINE" || {
      log_err "$CONTAINER_ENGINE is installed but its service is not running."
      return 1
    }
    printf '%s' "$CONTAINER_ENGINE"
    return
  fi

  if command -v docker >/dev/null 2>&1 && engine_works docker; then
    printf 'docker'
    return
  fi

  if command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
    log "Docker is not reachable; starting Colima."
    if is_quiet; then
      step "Starting Colima…"
      _poc_run colima start
    else
      colima start >&2
    fi
    if engine_works docker; then
      printf 'docker'
      return
    fi
  fi

  if command -v podman >/dev/null 2>&1; then
    if ! engine_works podman && [[ "$(uname -s)" == "Darwin" ]]; then
      log "Podman is not reachable; starting its macOS machine."
      if is_quiet; then
        step "Starting Podman machine…"
        _poc_run podman machine start || true
      else
        podman machine start >&2 || true
      fi
    fi
    if engine_works podman; then
      printf 'podman'
      return
    fi
  fi

  log_err "No running Docker, Colima, or Podman engine was found."
  log_err "Install one of them, start it, and rerun this command."
  return 1
}

app_auth_token="${APP_AUTH_TOKEN:-}"
if [[ ${#app_auth_token} -lt 24 || "$app_auth_token" == replace-* || ! "$app_auth_token" =~ ^[A-Za-z0-9._~-]+$ ]]; then
  log_err "APP_AUTH_TOKEN must contain at least 24 URL-safe characters."
  log_err "The browser and E2E check use this token; do not show it in demo output."
  exit 2
fi

command -v node >/dev/null 2>&1 || {
  log_err "Node.js 22+ is required to run the local control plane."
  exit 2
}

node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( node_major < 22 )); then
  log_err "Node.js 22+ is required; found $(node --version)."
  exit 2
fi

# Ensure demo ports are set early for freeing + banner (mirrors run-poc.sh defaults, but respect existing env)
export PORT="${PORT:-3000}"
export MANDATEFLOW_CONTROL_HOST_PORT="${MANDATEFLOW_CONTROL_HOST_PORT:-3002}"
export MANDATEFLOW_RUNTIME_MCP_HOST_PORT="${MANDATEFLOW_RUNTIME_MCP_HOST_PORT:-3001}"

# --- Smart port shutdown (so `make demo` / `npm run poc` doesn't hit EADDRINUSE) ---
# Duplicated from run-poc.sh / Makefile `shutdown` — idempotent, quiet unless -v
_free_port() {
  local port="$1"
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  elif command -v fuser >/dev/null 2>&1; then
    pids="$(fuser -n tcp "$port" 2>/dev/null | tr -s ' ' '\n' | xargs || true)"
  fi
  if [[ -n "$pids" ]]; then
    if is_quiet; then
      # quiet: only hint if verbose, otherwise silent kill
      if [[ "$POC_VERBOSE" == "1" ]]; then
        printf '[local-poc] Freeing port %s (PIDs: %s)\n' "$port" "$(echo "$pids" | tr '\n' ' ')" >&2
      fi
    else
      log "Freeing port $port (PIDs: $(echo "$pids" | tr '\n' ' '))"
    fi
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    if command -v lsof >/dev/null 2>&1; then
      pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
    else
      pids=""
    fi
    if [[ -n "$pids" ]]; then
      if is_quiet; then
        [[ "$POC_VERBOSE" == "1" ]] && printf '[local-poc] Force-killing port %s (PIDs: %s)\n' "$port" "$(echo "$pids" | tr '\n' ' ')" >&2
      else
        log "Force-killing port $port (PIDs: $(echo "$pids" | tr '\n' ' '))"
      fi
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
      sleep 0.5
    fi
  fi
}
_ports=("$PORT" "$MANDATEFLOW_CONTROL_HOST_PORT" "$MANDATEFLOW_RUNTIME_MCP_HOST_PORT" 3000 3001 3002 3100 3102 5173 34567)
_seen=""
for p in "${_ports[@]}"; do
  [[ "$p" =~ ^[0-9]+$ ]] || continue
  if [[ " $_seen " != *" $p "* ]]; then
    _seen="$_seen $p"
    _free_port "$p"
  fi
done

# Demo banner (when token was auto-generated, like run-poc.sh)
if [[ "${_auto_token_generated:-}" == "1" ]]; then
  if is_quiet; then
    printf '\n  MandateFlow — starting demo…\n' >&2
    printf '  First run may take 1–2 min (building images); subsequent runs are fast.\n' >&2
    printf '\n  Unlock token: %s\n' "$APP_AUTH_TOKEN" >&2
    printf '  Open http://localhost:%s once ready\n\n' "$PORT" >&2
  else
    # verbose: already handled below via log, but ensure token visible
    :
  fi
fi

engine="$(detect_engine)"
if is_quiet; then
  step "Using $engine ($runtime_provider) — preparing environment…"
else
  log "Using $engine as the Agent Runtime engine."
  log "Runtime provider: $runtime_provider"
fi

if [[ ! -d node_modules ]]; then
  if is_quiet; then
    step "Installing dependencies…"
    _poc_run npm --silent ci
  else
    log "Installing application dependencies."
    npm ci
  fi
fi

if [[ "${APP_DATA_DIR:-}" == "/app/data" ]]; then
  unset APP_DATA_DIR
fi
if [[ "${AGENT_WORKSPACE_ROOT:-}" == "/app/workspaces" ]]; then
  unset AGENT_WORKSPACE_ROOT
fi
if [[ "${CODEX_HOME:-}" == "/app/codex-home" ]]; then
  unset CODEX_HOME
fi

if [[ -n "${LOCAL_POC_DATA_ROOT:-}" ]]; then
  local_state_root="$LOCAL_POC_DATA_ROOT"
  export APP_DATA_DIR="$local_state_root/data"
  export AGENT_WORKSPACE_ROOT="$local_state_root/workspaces"
  export CODEX_HOME="$local_state_root/codex-home"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  local_state_root="${HOME}/.volc-agent-launchpad"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
else
  local_state_root="$repo_dir/.local"
  export APP_DATA_DIR="${APP_DATA_DIR:-$local_state_root/data}"
  export AGENT_WORKSPACE_ROOT="${AGENT_WORKSPACE_ROOT:-$local_state_root/workspaces}"
  export CODEX_HOME="${CODEX_HOME:-$local_state_root/codex-home}"
fi
if [[ "$APP_DATA_DIR" != /* ]]; then
  export APP_DATA_DIR="$repo_dir/$APP_DATA_DIR"
fi
if [[ "$AGENT_WORKSPACE_ROOT" != /* ]]; then
  export AGENT_WORKSPACE_ROOT="$repo_dir/$AGENT_WORKSPACE_ROOT"
fi
if [[ "$CODEX_HOME" != /* ]]; then
  export CODEX_HOME="$repo_dir/$CODEX_HOME"
fi
export RUNTIME_INSTANCE_ID="${RUNTIME_INSTANCE_ID:-local-$(id -u)-$(printf '%s' "$repo_dir" | cksum | awk '{print $1}')}"
export MANDATEFLOW_CONTAINER_NETWORK="${MANDATEFLOW_CONTAINER_NETWORK:-mandateflow-$RUNTIME_INSTANCE_ID}"
mandateflow_sidecar_name="mandateflow-$RUNTIME_INSTANCE_ID"

mandateflow_data_dir="$APP_DATA_DIR/mandateflow"
mkdir -p "$APP_DATA_DIR" "$AGENT_WORKSPACE_ROOT" "$CODEX_HOME" "$mandateflow_data_dir"
log "Persistent state: $local_state_root"
if is_quiet; then
  # Keep persistent state on verbose only; demo doesn't need path vomit
  :
fi
export CONTAINER_USER="${CONTAINER_USER:-$(id -u):$(id -g)}"

cleanup() {
  local container_ids
  container_ids="$($engine ps --all --quiet \
    --filter label=io.codejam.launchpad=agent-runtime \
    --filter "label=io.codejam.instance-id=$RUNTIME_INSTANCE_ID" 2>/dev/null || true)"
  if [[ -n "$container_ids" ]]; then
    log "Removing remaining Agent Runtime containers for $RUNTIME_INSTANCE_ID."
    while IFS= read -r container_id; do
      [[ -n "$container_id" ]] && "$engine" rm --force "$container_id" >/dev/null 2>&1 || true
    done <<<"$container_ids"
  fi
  "$engine" rm --force "$mandateflow_sidecar_name" >/dev/null 2>&1 || true
  "$engine" network rm "$MANDATEFLOW_CONTAINER_NETWORK" >/dev/null 2>&1 || true
  rm -f "$_poc_log_file" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Recover exact instance-labelled resources after an interrupted local run.
cleanup

if is_quiet; then
  step "Building MandateFlow sidecar… (cached after first run)"
else
  log "Building and testing the Go MandateFlow reference monitor."
fi
if is_quiet; then
  _poc_run "$engine" build \
    --target test \
    --file "$mandateflow_dir/Dockerfile" \
    --build-arg "GO_IMAGE=$mandateflow_go_image" \
    "$mandateflow_dir"
  _poc_run "$engine" build \
    --file "$mandateflow_dir/Dockerfile" \
    --build-arg "GO_IMAGE=$mandateflow_go_image" \
    --tag "$mandateflow_image" \
    "$mandateflow_dir"
else
  "$engine" build \
    --target test \
    --file "$mandateflow_dir/Dockerfile" \
    --build-arg "GO_IMAGE=$mandateflow_go_image" \
    "$mandateflow_dir"
  "$engine" build \
    --file "$mandateflow_dir/Dockerfile" \
    --build-arg "GO_IMAGE=$mandateflow_go_image" \
    --tag "$mandateflow_image" \
    "$mandateflow_dir"
fi

if [[ "$runtime_provider" == "container" ]]; then
  if is_quiet; then
    step "Building runtime image… (cached after first run)"
    _poc_run "$engine" build \
      --file Dockerfile.runtime \
      --build-arg "NODE_IMAGE=$runtime_base_image" \
      --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
      --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
      --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
      --tag "$runtime_image" \
      .
  else
    log "Building $runtime_image from Dockerfile.runtime (base: $runtime_base_image)."
    "$engine" build \
      --file Dockerfile.runtime \
      --build-arg "NODE_IMAGE=$runtime_base_image" \
      --build-arg "DEBIAN_MIRROR=$runtime_apt_mirror" \
      --build-arg "DEBIAN_SECURITY_MIRROR=$runtime_apt_security_mirror" \
      --build-arg "RUNTIME_APT_PACKAGES=$runtime_apt_packages" \
      --tag "$runtime_image" \
      .
  fi

  if is_quiet; then
    step "Verifying container mounts…"
  else
    log "Checking that the Runtime can bind-mount the configured state directories."
  fi
  preflight_user_args=(--user "$CONTAINER_USER")
  if [[ "$(basename "$engine")" == "podman" ]]; then
    preflight_user_args+=(--userns keep-id)
  fi
  if ! "$engine" run --rm \
    "${preflight_user_args[@]}" \
    --mount "type=bind,src=$AGENT_WORKSPACE_ROOT,dst=/workspace" \
    --mount "type=bind,src=$CODEX_HOME,dst=/codex-home" \
    "$runtime_image" sh -lc \
      'touch /workspace/.launchpad-write-test /codex-home/.launchpad-write-test && rm /workspace/.launchpad-write-test /codex-home/.launchpad-write-test'; then
    log_err "The container engine cannot mount $local_state_root."
    log_err "Set LOCAL_POC_DATA_ROOT to a directory shared with Docker/Colima/Podman."
    exit 2
  fi

  if [[ "$codex_sandbox_mode" == "workspace-write" ]] \
    && ! "$engine" run --rm "$runtime_image" \
      codex sandbox linux --full-auto -- true >/dev/null 2>&1; then
    log_err "Codex Landlock is unavailable in this Linux Runtime."
    log_err "Falling back to danger-full-access inside the disposable container boundary."
    log_err "Do not mount unrelated secrets or host directories into the Agent Runtime."
    if is_quiet; then
      step "Codex sandbox fallback: danger-full-access (container-isolated)"
    fi
    codex_sandbox_mode=danger-full-access
  fi
fi

if is_quiet; then
  step "Creating runtime network…"
  _poc_run "$engine" network create \
    --label io.codejam.launchpad=mandateflow-network \
    --label "io.codejam.instance-id=$RUNTIME_INSTANCE_ID" \
    "$MANDATEFLOW_CONTAINER_NETWORK" >/dev/null
else
  log "Creating the instance-specific Runtime network."
  "$engine" network create \
    --label io.codejam.launchpad=mandateflow-network \
    --label "io.codejam.instance-id=$RUNTIME_INSTANCE_ID" \
    "$MANDATEFLOW_CONTAINER_NETWORK" >/dev/null
fi

export MANDATEFLOW_CONTROL_TOKEN="$(node -e 'const c=require("node:crypto");process.stdout.write("mfc1_"+c.randomBytes(32).toString("base64url"))')"
export MANDATEFLOW_RUN_TTL_MS="$((${CODEX_TIMEOUT_MS:-600000} + 60000))"
export MANDATEFLOW_ENABLED=true
export MANDATEFLOW_CONTROL_URL="http://127.0.0.1:$mandateflow_control_port"
export MANDATEFLOW_CONTROL_HOST_PORT="$mandateflow_control_port"

sidecar_publish_args=(--publish "127.0.0.1:$mandateflow_control_port:3002")
if [[ "$runtime_provider" == "fixture" ]]; then
  runtime_mcp_host_port="${MANDATEFLOW_RUNTIME_MCP_HOST_PORT:-3001}"
  export MANDATEFLOW_RUNTIME_MCP_URL="http://127.0.0.1:$runtime_mcp_host_port/mcp"
  sidecar_publish_args+=(--publish "127.0.0.1:$runtime_mcp_host_port:3001")
else
  export MANDATEFLOW_RUNTIME_MCP_URL="http://mandateflow-gateway:3001/mcp"
fi

sidecar_user_args=(--user "$CONTAINER_USER")
if [[ "$(basename "$engine")" == "podman" ]]; then
  sidecar_user_args+=(--userns keep-id)
fi

if is_quiet; then
  step "Starting MandateFlow sidecar…"
else
  log "Starting the Go MandateFlow sidecar."
fi
"$engine" run --detach \
  --name "$mandateflow_sidecar_name" \
  --label io.codejam.launchpad=mandateflow-sidecar \
  --label "io.codejam.instance-id=$RUNTIME_INSTANCE_ID" \
  --network "$MANDATEFLOW_CONTAINER_NETWORK" \
  --network-alias mandateflow-gateway \
  "${sidecar_publish_args[@]}" \
  "${sidecar_user_args[@]}" \
  --read-only \
  --tmpfs /tmp:rw,noexec,nosuid,nodev,size=16m \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --env MANDATEFLOW_CONTROL_TOKEN \
  --env MANDATEFLOW_RUN_TTL_MS \
  --mount "type=bind,src=$mandateflow_data_dir,dst=/var/lib/mandateflow" \
  "$mandateflow_image" >/dev/null

mandateflow_ready=false
for _attempt in $(seq 1 50); do
  if curl --fail --silent --max-time 1 \
    "$MANDATEFLOW_CONTROL_URL/healthz" >/dev/null 2>&1; then
    mandateflow_ready=true
    break
  fi
  sleep 0.2
done
if [[ "$mandateflow_ready" != true ]]; then
  log_err "MandateFlow did not become ready."
  if is_quiet; then
    printf '  ✖ MandateFlow sidecar did not become ready\n' >&2
  fi
  "$engine" logs "$mandateflow_sidecar_name" >&2 || true
  exit 2
fi

export NODE_ENV=production
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3000}"
export CODEX_SANDBOX_MODE="$codex_sandbox_mode"
export RUNTIME_PROVIDER="$runtime_provider"
export CONTAINER_ENGINE="$engine"
export CONTAINER_RUNTIME_IMAGE="$runtime_image"

if is_quiet; then
  step "Building web & API…"
  _poc_run npm --silent run build
  ok "Build complete — launching"
  printf '\n  ── MandateFlow ready ─────────────────────\n' >&2
  printf '  → Open http://localhost:%s\n' "$PORT" >&2
  printf '  ──────────────────────────────────────────\n\n' >&2
else
  log "Building the local Web and API."
  npm run build
  log "Open http://localhost:$PORT"
fi
npm start
