#!/usr/bin/env bash
# Serves the page at http://localhost:8000/ for testing against real AWS.
# The template accepts localhost as the return page, and browsers treat it as secure.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "Open http://localhost:8000/ (use localhost, not 127.0.0.1, so your saved key is found)"
exec python3 -m http.server 8000 --bind 127.0.0.1 --directory "$ROOT/docs"
