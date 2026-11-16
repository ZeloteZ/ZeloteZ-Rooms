#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."

if [[ ! -f .env ]]; then
  printf '%s\n' 'Copy .env.example to .env and configure your server before installing.' >&2
  exit 1
fi

docker compose --env-file .env config --quiet
docker compose --env-file .env up -d --build --wait
