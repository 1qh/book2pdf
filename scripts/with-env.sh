#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "Usage: bun run with-env -- <command> [args...]" >&2
  exit 1
fi

if [ -f .env ]; then
  dotenv -e .env -- "$@"
else
  "$@"
fi
