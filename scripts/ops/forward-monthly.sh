#!/bin/bash
# Monthly DESCRIPTIVE re-read of the forward test (scripts/research/forward-test.ts, MONTHLY CONTINUATION).
# Installed by Claude on 2026-10-10 at the user's request ("do the forward test, use the vps"; "then continue").
# Runs from the user's crontab on the 5th of each month; reads the cumulative window 2026-07-01 .. end of the
# previous month with the frozen code. Never a new pass/fail. Remove with: crontab -e (delete the forward line).
set -u
IMG=crypto-ops:forward-monthly
BASE=$HOME/forward-monthly
FIRST=$(date -u +%Y-%m-01)
PREV=$(date -u -d "$FIRST -1 day" +%Y-%m)
END_DAY=$(date -u -d "$FIRST -1 day" +%Y-%m-%d)
RUN=$BASE/$PREV
mkdir -p "$RUN"
NET=(--network crypto_crypto-internal --env-file /opt/sites/crypto/.env)
O=(--rm --cpu-shares 256 -e NPM_CONFIG_UPDATE_NOTIFIER=false)
log() { echo "$(date -u +%FT%TZ) $*" >> "$RUN/run.log"; }

log "start: month $PREV, window 2026-07-01 .. $END_DAY"
docker run "${O[@]}" "${NET[@]}" "$IMG" npx --yes tsx scripts/ops/ingest-agg-flow.ts --allow-lockbox --max-date "$END_DAY" \
  --from "$PREV" --to "$PREV" --concurrency 2 > "$RUN/ingest.log" 2>&1
log "ingest exit $?"

rm -rf "$RUN/ds" && mkdir -p "$RUN/ds"
docker run "${O[@]}" "${NET[@]}" -v "$RUN/ds:/app/out" "$IMG" npx --yes tsx scripts/research/export-dataset.ts \
  --datasets candles,htf,perp,flow,metrics,snapshots --intervals 5m,1h,4h --perp-series klines,premiumIndex \
  --start 2026-03-01T00:00:00Z --end "${END_DAY}T23:59:59.999Z" --out /app/out > "$RUN/export.log" 2>&1
log "export exit $?"

R=("${O[@]}" -e NODE_OPTIONS=--max-old-space-size=2560 -v "$RUN/ds:/app/ds:ro" -v "$RUN:/app/out")
docker run "${R[@]}" "$IMG" npx --yes tsx scripts/research/forward-rsi.ts --dataset-dir /app/ds \
  --window-end "${END_DAY}T23:59:59.999Z" --out /app/out/forward-rsi.json > "$RUN/forward-rsi.log" 2>&1
log "forward-rsi exit $?"
docker run "${R[@]}" "$IMG" npx --yes tsx scripts/research/forward-small-taker.ts --dataset-dir /app/ds \
  --window-end "${END_DAY}T23:59:59.999Z" --out /app/out/forward-small-taker.json > "$RUN/forward-small.log" 2>&1
log "forward-small-taker exit $?"

cp "$RUN/ds/manifest.json" "$RUN/manifest.json" 2>/dev/null
rm -rf "$RUN/ds"
sha256sum "$RUN"/forward-*.json "$RUN/manifest.json" >> "$RUN/run.log" 2>&1
log "done"
