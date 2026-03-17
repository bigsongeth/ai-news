#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/run_openclaw_pipeline.sh --hours 24 --topN 15 --shortlistMax 48 --chunkSize 8
#
# Requires:
#   - OPENAI_API_KEY (and optionally OPENAI_API_BASE/OPENAI_MODEL)

HOURS=24
TOPN=15
SHORTLIST=48
CHUNK=8

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hours) HOURS="$2"; shift 2;;
    --topN) TOPN="$2"; shift 2;;
    --shortlistMax) SHORTLIST="$2"; shift 2;;
    --chunkSize) CHUNK="$2"; shift 2;;
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

# 3) enrich sequentially (this is for local debug; cron will use sub-agents in parallel)
for f in "$RUN_DIR"/chunk-*.input.json; do
  out="${f/.input.json/.enriched.json}"
  npx -y bun scripts/openclaw_enrich_chunk.ts --input "$f" --output "$out"
done

# 4) render
npx -y bun scripts/openclaw_render.ts --runDir "$RUN_DIR" --plan "$PLAN_PATH" --topN "$TOPN" > "$RUN_DIR/digest.md"

cat "$RUN_DIR/digest.md"
