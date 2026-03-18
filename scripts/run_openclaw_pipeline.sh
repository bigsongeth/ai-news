#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/run_openclaw_pipeline.sh --hours 24 --topN 15 --shortlistMax 48 --chunkSize 8 [--parallel 3]
#
# Requires:
#   - OPENAI_API_KEY (optional if SongKey fallback is available in OpenClaw config)

HOURS=24
TOPN=15
SHORTLIST=48
CHUNK=8
PARALLEL=3

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2;;
    --topN) TOPN="$2"; shift 2;;
    --shortlistMax) SHORTLIST="$2"; shift 2;;
    --chunkSize) CHUNK="$2"; shift 2;;
    --parallel) PARALLEL="$2"; shift 2;;
    *) echo "Unknown arg: $1"; exit 1;;
  esac
done

cd "$(dirname "$0")/.."
mkdir -p output

RUN_ID=$(date +%Y%m%d-%H%M%S)

# 1) fetch candidates
npx -y bun scripts/openclaw_fetch.ts --hours "$HOURS" --output "./output/candidates.json" --maxTotal 240 --perFeedCap 4

# 2) plan + chunk
PLAN_PATH=$(npx -y bun scripts/openclaw_plan.ts --input ./output/candidates.json --hours "$HOURS" --outDir ./output --runId "$RUN_ID" --shortlistMax "$SHORTLIST" --chunkSize "$CHUNK")
RUN_DIR="./output/$RUN_ID"

# 3) enrich in parallel by chunk
CHUNK_FILES=$(find "$RUN_DIR" -maxdepth 1 -name 'chunk-*.input.json' | sort)

if [[ -z "$CHUNK_FILES" ]]; then
  echo "No chunk input files found in $RUN_DIR" >&2
  exit 1
fi

run_chunk() {
  local f="$1"
  local out="${f/.input.json/.enriched.json}"
  echo "[enrich] start $(basename "$f")" >&2
  npx -y bun scripts/openclaw_enrich_chunk.ts --input "$f" --output "$out"
  echo "[enrich] done  $(basename "$out")" >&2
}

export -f run_chunk

printf '%s\n' "$CHUNK_FILES" | xargs -I{} -P "$PARALLEL" bash -lc 'run_chunk "$1"' _ {}

# 4) render
npx -y bun scripts/openclaw_render.ts --runDir "$RUN_DIR" --plan "$PLAN_PATH" --topN "$TOPN" > "$RUN_DIR/digest.md"

cat "$RUN_DIR/digest.md"
