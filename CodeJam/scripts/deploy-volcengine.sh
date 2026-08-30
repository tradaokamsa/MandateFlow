#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -z "${VOLCENGINE_ACCESS_KEY:-}" || -z "${VOLCENGINE_SECRET_KEY:-}" ]]; then
  echo "Export VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY first." >&2
  exit 1
fi

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.example and fill the Groq values." >&2
  exit 1
fi

if [[ ! -f deploy/volcengine/terraform.tfvars ]]; then
  echo "Missing deploy/volcengine/terraform.tfvars." >&2
  echo "Copy terraform.tfvars.example and fill the region-specific values." >&2
  exit 1
fi

set -a
source .env.production
set +a

if [[ "${GROQ_API_KEY:-}" == "" || "${APP_AUTH_TOKEN:-}" == "" ]]; then
  echo "GROQ_API_KEY and APP_AUTH_TOKEN are required in .env.production." >&2
  exit 1
fi

export TF_VAR_groq_api_key="$GROQ_API_KEY"
export TF_VAR_app_auth_token="$APP_AUTH_TOKEN"
export TF_VAR_groq_model="${GROQ_MODEL:-openai/gpt-oss-120b}"
export TF_VAR_groq_base_url="${GROQ_BASE_URL:-https://api.groq.com/openai/v1}"

terraform -chdir=deploy/volcengine init
terraform -chdir=deploy/volcengine apply

echo
echo "Deployment requested. Cloud-init may take 5-10 minutes."
terraform -chdir=deploy/volcengine output app_url
