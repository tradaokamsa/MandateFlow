#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

mkdir -p data workspaces codex-home

echo "Next:"
echo "  1. Fill GROQ_API_KEY in .env; GROQ_MODEL is optional"
echo "  2. Run: docker compose up --build"
