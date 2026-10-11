#!/bin/bash
# scripts/ops/cross-sectional-run.sh
# Orchestrates Cross-Sectional Relative Value backtests on the Contabo VPS.
#
# Usage (run on VPS or via ssh contabo):
#   bash scripts/ops/cross-sectional-run.sh build
#   bash scripts/ops/cross-sectional-run.sh run-8h
#   bash scripts/ops/cross-sectional-run.sh run-24h
#   bash scripts/ops/cross-sectional-run.sh sweep
#
set -eu -o pipefail

IMG="crypto-ops:cross-sectional"
BUILD_DIR="${HOME}/crypto-archive-build"
DS_DIR="${HOME}/dx-ds"
OUT_DIR="${HOME}/rv-out"

mkdir -p "${OUT_DIR}"

log() {
  echo "[$(date -u +%FT%TZ)] $*" | tee -a "${OUT_DIR}/run.log"
}

stage_build() {
  log "Building Docker image ${IMG} from ${BUILD_DIR}..."
  cd "${BUILD_DIR}"
  git status
  docker build --target seeder -t "${IMG}" .
  log "Docker build complete."
}

stage_run_8h() {
  log "Running 8-hour Cross-Sectional Relative Value Simulation (Buffer 2, Open Execution)..."
  docker run --rm \
    --cpu-shares 512 \
    --memory 4g \
    -v "${DS_DIR}:/app/ds:ro" \
    -v "${OUT_DIR}:/app/out" \
    "${IMG}" \
    npx tsx scripts/research/cross-sectional-harness.ts \
      --dataset-dir /app/ds \
      --cadence 8h \
      --legs 2 \
      --buffer 2 \
      --execution open \
      --lookback-bars 42 \
      --allow-lockbox \
      --out /app/out/report-8h-clean-buf2.json
  log "8-hour simulation complete. Report saved to ${OUT_DIR}/report-8h-clean-buf2.json."
}

stage_run_8h_betaneutral() {
  log "Running 8-hour Cross-Sectional Beta-Neutral Simulation (Buffer 2, Open Execution)..."
  docker run --rm \
    --cpu-shares 512 \
    --memory 4g \
    -v "${DS_DIR}:/app/ds:ro" \
    -v "${OUT_DIR}:/app/out" \
    "${IMG}" \
    npx tsx scripts/research/cross-sectional-harness.ts \
      --dataset-dir /app/ds \
      --cadence 8h \
      --legs 2 \
      --buffer 2 \
      --execution open \
      --beta-neutral \
      --lookback-bars 42 \
      --allow-lockbox \
      --out /app/out/report-8h-betaneutral.json
  log "8-hour beta-neutral simulation complete. Report saved to ${OUT_DIR}/report-8h-betaneutral.json."
}

stage_run_24h() {
  log "Running 24-hour Cross-Sectional Relative Value Benchmark (Buffer 1, Open Execution)..."
  docker run --rm \
    --cpu-shares 512 \
    --memory 4g \
    -v "${DS_DIR}:/app/ds:ro" \
    -v "${OUT_DIR}:/app/out" \
    "${IMG}" \
    npx tsx scripts/research/cross-sectional-harness.ts \
      --dataset-dir /app/ds \
      --cadence 24h \
      --legs 2 \
      --buffer 1 \
      --execution open \
      --lookback-bars 14 \
      --allow-lockbox \
      --out /app/out/report-24h-clean.json
  log "24-hour benchmark complete. Report saved to ${OUT_DIR}/report-24h-clean.json."
}

stage_sweep() {
  log "Running parameter sweep across momentum lookbacks and buffer settings..."
  # Buffer 0 (no hysteresis) vs Buffer 1 (hysteresis) vs Buffer 2
  for buf in 0 1 2; do
    log "Testing buffer=${buf}..."
    docker run --rm \
      -v "${DS_DIR}:/app/ds:ro" \
      -v "${OUT_DIR}:/app/out" \
      "${IMG}" \
      npx tsx scripts/research/cross-sectional-harness.ts \
        --dataset-dir /app/ds \
        --cadence 8h \
        --legs 2 \
        --buffer "${buf}" \
        --execution open \
        --lookback-bars 42 \
        --allow-lockbox \
        --out "/app/out/sweep-buf${buf}.json"
  done
  log "Parameter sweep complete."
}

ACTION="${1:-run-8h}"
case "${ACTION}" in
  build)
    stage_build
    ;;
  run-8h)
    stage_run_8h
    ;;
  run-8h-betaneutral)
    stage_run_8h_betaneutral
    ;;
  run-24h)
    stage_run_24h
    ;;
  sweep)
    stage_sweep
    ;;
  all)
    stage_run_8h
    stage_run_8h_betaneutral
    stage_run_24h
    ;;
  *)
    echo "Unknown action: ${ACTION}. Available: build, run-8h, run-8h-betaneutral, run-24h, sweep, all"
    exit 1
    ;;
esac
