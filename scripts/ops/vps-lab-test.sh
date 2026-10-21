#!/bin/bash
# shellcheck shell=bash
#
# scripts/ops/vps-lab-test.sh
#
# Standalone VPS testing harness for lab-v3 and quantitative research.
# Runs within strict resource boundaries to ensure zero interference
# with co-hosted production applications.
#
# Resource caps:
# - Memory: 2 GB max
# - CPU: 2.0 cores max
# - Execution lock: /tmp/vps-lab-test.lock
# - Output: /home/smara/labv3-test-logs/
#
# Usage (on the VPS):
#   bash scripts/ops/vps-lab-test.sh [--canary]
#

set -euo pipefail

LOCKFILE="/tmp/vps-lab-test.lock"
LOG_DIR="${HOME}/labv3-test-logs"
BUILD_DIR="${HOME}/crypto-archive-build"
IMAGE_NAME="crypto-ops:labv3-test"

mkdir -p "$LOG_DIR"

exec 200>"$LOCKFILE"
if ! flock -n 200; then
  echo "Error: Another lab test is currently running on this VPS." >&2
  exit 1
fi

echo "=========================================================="
echo " Starting lab-v3 VPS Testing Ground Harness"
echo " Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo " Memory limit: 2GB | CPU limit: 2.0"
echo "=========================================================="

# Check host available memory before starting
AVAIL_MEM_MB=$(free -m | awk '/^Mem:/{print $7}')
if [ "$AVAIL_MEM_MB" -lt 1500 ]; then
  echo "Error: Available memory (${AVAIL_MEM_MB}MB) is below the 1500MB safety threshold." >&2
  exit 1
fi

echo "Available host memory: ${AVAIL_MEM_MB}MB (Healthy)"

echo "Building test container from $BUILD_DIR..."
docker build \
  --target seeder \
  -t "$IMAGE_NAME" \
  "$BUILD_DIR"

echo "Executing canary test container..."
docker run --rm \
  --name "crypto-ops-lab3-canary" \
  --memory 2g \
  --cpus 2.0 \
  -e NODE_OPTIONS="--max-old-space-size=1536" \
  -v "${LOG_DIR}:/reports" \
  "$IMAGE_NAME" \
  node_modules/.bin/tsx scripts/ops/lab-v3-canary.ts --out /reports/canary-report.json

echo "=========================================================="
echo " Canary run complete. Report saved to: ${LOG_DIR}/canary-report.json"
echo " Time: $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo "=========================================================="
