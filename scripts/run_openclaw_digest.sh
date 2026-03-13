#!/usr/bin/env bash
set -euo pipefail

HOURS="${1:-24}"
TOP_N="${2:-15}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$ROOT_DIR/output"
CANDIDATES="$OUT_DIR/candidates.json"

mkdir -p "$OUT_DIR"

# 1) Fetch candidates (no AI)
# Limit total to keep prompt size reasonable.
"$ROOT_DIR/.openclaw/bun" scripts/openclaw_fetch.ts --hours "$HOURS" --output "$CANDIDATES" --maxTotal 140 --perFeedCap 3 >/dev/null

# 2) Ask LLM to pick+summarize and print Feishu markdown
"$ROOT_DIR/.openclaw/bun" scripts/openclaw_digest.ts --input "$CANDIDATES" --hours "$HOURS" --top-n "$TOP_N"
