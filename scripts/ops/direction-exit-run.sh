#!/bin/bash
# Runbook of the direction-exit study (spec: header of scripts/research/direction-exit.ts). Runs on the VPS from $HOME,
# one stage per call, in the foreground (launch it under setsid nohup). The repo checkout at $HOME/crypto-archive-build
# is used only to build the image: docker build --target seeder -t crypto-ops:dx .
#
#   direction-exit-run.sh export
#   direction-exit-run.sh repro | parity | rows | diagnosis
#   direction-exit-run.sh develop-a <manifestHash>
#   direction-exit-run.sh develop-b <manifestHash> <cond1h> <cond4h>
#   direction-exit-run.sh select
#   direction-exit-run.sh confirm <manifestHash> <cond1h> <cond4h> <spec>
#       spec: 1h:d0e2=K,d0e3=K,d1e2=K,d1e3=K,d2e2=K,d2e3=K;4h:...   (every K one of 1, 1.5, 2)
#   direction-exit-run.sh verdict <variance>
#
# Every stage appends {"stage","exit","at"} to $HOME/dx-out/stages.log and exits with the stage's code.
set -u -o pipefail

IMG=crypto-ops:dx
DS=$HOME/dx-ds
OUT=$HOME/dx-out
REF=$HOME/rescore-out
DEV_START=2022-01-01T00:00:00Z
DEV_END=2024-12-31T23:59:59.999Z
CONF_START=2025-01-01T00:00:00Z
CONF_END=2026-10-09T23:59:59.999Z
DS_START=2021-10-01T00:00:00Z
DS_END=2026-10-09T23:59:59.999Z
NAME_RE='^dx-d[012]-(1h|4h)-c[0-4]-e[1-4]-k(1|1\.5|2)\.json$'

mkdir -p "$OUT/develop" "$OUT/confirm" "$OUT/logs"

O=(--rm --cpu-shares 256 --memory 3g -e NODE_OPTIONS=--max-old-space-size=2560 -e NPM_CONFIG_UPDATE_NOTIFIER=false)
R=("${O[@]}" -v "$DS:/app/ds:ro" -v "$OUT:/app/out")

log() { echo "$(date -u +%FT%TZ) $*" >> "$OUT/logs/run.log"; }
die() { echo "ERROR: $*" >&2; log "error: $*"; return 1; }

need_hash() { [[ "${1:-}" =~ ^[0-9a-f]{8,}$ ]] || die "manifest hash missing or not hex: '${1:-}'"; }
need_cond() { [[ "${1:-}" =~ ^[1-4]$ ]] || die "condition must be 1..4: '${1:-}'"; }

# Counts the files of a directory that match the naming contract the judge parses.
count_named() {
  local n=0 f
  for f in "$1"/*.json; do
    [[ -e "$f" ]] || continue
    [[ "$(basename "$f")" =~ $NAME_RE ]] && n=$((n + 1))
  done
  echo "$n"
}

# ---- harness runs, at most two at a time -------------------------------------------------------------------------

PIDS=()
NAMES=()
FAILED=()

# harness_run <phase> <name> <family> <interval> <params>
harness_run() {
  local phase=$1 name=$2 family=$3 iv=$4 params=$5
  local -a win
  if [[ "$phase" == develop ]]; then
    win=(--eval-from "$DEV_START" --end "$DEV_END" --no-benchmark)
  else
    win=(--eval-from "$CONF_START" --end "$CONF_END" --allow-lockbox)
  fi
  docker run "${R[@]}" "$IMG" npx tsx scripts/research/strategy-harness.ts \
    --family "$family" --interval "$iv" --fixed-eval --fix-params "$params" \
    --start "$DS_START" "${win[@]}" --funding-settlements --windows 6 \
    --dataset-dir /app/ds --expect-manifest-hash "$MANIFEST" --out "/app/out/$phase/$name.json" \
    > "$OUT/logs/$name.log" 2>&1
}

reap() {
  local i rc
  for i in "${!PIDS[@]}"; do
    wait "${PIDS[$i]}"
    rc=$?
    log "run ${NAMES[$i]} exit $rc"
    if [[ $rc -ne 0 ]]; then FAILED+=("${NAMES[$i]}"); fi
  done
  PIDS=()
  NAMES=()
}

# run_pool <phase> <job>...   job = name|family|interval|params
run_pool() {
  local phase=$1 job name family iv params
  shift
  PIDS=()
  NAMES=()
  FAILED=()
  for job in "$@"; do
    IFS='|' read -r name family iv params <<< "$job"
    log "run $name start"
    harness_run "$phase" "$name" "$family" "$iv" "$params" &
    PIDS+=($!)
    NAMES+=("$name")
    if [[ ${#PIDS[@]} -ge 2 ]]; then reap; fi
  done
  reap
  if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "FAILED runs (${#FAILED[@]}): ${FAILED[*]}" >&2
    return 1
  fi
  echo "all $# runs ok"
}

# job <family> <iv> <cond> <exit> <k>   prints one job line; D2 carries its condition, D0 and D1 use c0.
job() {
  local family=$1 iv=$2 cond=$3 exit=$4 k=$5 c=0 params
  if [[ "$family" == dx-d2 ]]; then
    c=$cond
    params="cond=$cond,exit=$exit,k=$k"
  else
    params="exit=$exit,k=$k"
  fi
  echo "$family-$iv-c$c-e$exit-k$k|$family|$iv|$params"
}

# ---- stages ------------------------------------------------------------------------------------------------------

stage_export() {
  mkdir -p "$DS"
  docker run "${O[@]}" --network crypto_crypto-internal --env-file /opt/sites/crypto/.env -v "$DS:/app/out" "$IMG" \
    npx tsx scripts/research/export-dataset.ts --intervals 1h,4h,1d --datasets candles,snapshots,htf,funding \
    --start "$DS_START" --end "$DS_END" --out /app/out 2>&1 | tee "$OUT/logs/export.log"
  local rc=$?
  [[ $rc -eq 0 ]] || return $rc
  local hash
  hash=$(sed -n 's/.*"datasetHash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DS/manifest.json" | head -1)
  [[ -n "$hash" ]] || die "no datasetHash in $DS/manifest.json" || return 1
  echo "manifestHash $hash"
  log "export manifestHash $hash"
}

stage_repro() {
  docker run "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-rows.ts --dataset-dir /app/ds \
    --out /app/out/repro-rows.jsonl.gz --start 2025-10-01T00:00:00Z --end "$CONF_END" --scores-only 2>&1 \
    | tee "$OUT/logs/repro-rows.log"
  local rc=$?
  [[ $rc -eq 0 ]] || return $rc
  docker run "${R[@]}" -v "$REF:/app/ref:ro" "$IMG" npx tsx scripts/research/direction-exit-repro.ts repro \
    --mine /app/out/repro-rows.jsonl.gz --reference /app/ref/v8-rows.jsonl.gz 2>&1 | tee "$OUT/logs/repro.log"
}

stage_parity() {
  local iv rc=0
  for iv in 1h 4h; do
    docker run "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-repro.ts parity --dataset-dir /app/ds \
      --symbol BTCUSDT --interval "$iv" --start 2024-11-01T00:00:00Z --end 2024-12-31T23:59:59.999Z 2>&1 \
      | tee "$OUT/logs/parity-$iv.log"
    local r=${PIPESTATUS[0]}
    log "parity $iv exit $r"
    if [[ $r -ne 0 ]]; then rc=$r; fi
  done
  return $rc
}

stage_rows() {
  docker run "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-rows.ts --dataset-dir /app/ds \
    --out /app/out/develop-rows.jsonl.gz --start "$DEV_START" --end "$DEV_END" 2>&1 | tee "$OUT/logs/rows.log"
}

stage_diagnosis() {
  docker run "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-diagnosis.ts \
    --rows /app/out/develop-rows.jsonl.gz --out /app/out/diagnosis.json 2>&1 | tee "$OUT/logs/diagnosis.log"
}

stage_develop_a() {
  need_hash "${1:-}" || return 1
  MANIFEST=$1
  local iv family e k jobs=()
  for iv in 1h 4h; do
    for family in dx-d0 dx-d1; do
      jobs+=("$(job "$family" "$iv" 0 1 1)")
      for e in 2 3; do
        for k in 1 1.5 2; do jobs+=("$(job "$family" "$iv" 0 "$e" "$k")"); done
      done
      jobs+=("$(job "$family" "$iv" 0 4 1)")
    done
    for e in 1 2 3 4; do jobs+=("$(job dx-d2 "$iv" "$e" 1 1)"); done
  done
  [[ ${#jobs[@]} -eq 40 ]] || die "develop-a built ${#jobs[@]} jobs, expected 40" || return 1
  run_pool develop "${jobs[@]}"
}

stage_develop_b() {
  need_hash "${1:-}" || return 1
  need_cond "${2:-}" || return 1
  need_cond "${3:-}" || return 1
  MANIFEST=$1
  local c1h=$2 c4h=$3 iv c e k jobs=()
  for iv in 1h 4h; do
    c=$c1h
    if [[ "$iv" == 4h ]]; then c=$c4h; fi
    for e in 2 3; do
      for k in 1 1.5 2; do jobs+=("$(job dx-d2 "$iv" "$c" "$e" "$k")"); done
    done
    jobs+=("$(job dx-d2 "$iv" "$c" 4 1)")
  done
  [[ ${#jobs[@]} -eq 14 ]] || die "develop-b built ${#jobs[@]} jobs, expected 14" || return 1
  run_pool develop "${jobs[@]}"
}

stage_select() {
  local n
  n=$(count_named "$OUT/develop")
  [[ "$n" -eq 54 ]] || die "expected 54 develop reports matching the naming contract, found $n" || return 1
  docker run "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-judge.ts select \
    --develop-dir /app/out/develop > "$OUT/select.json" 2> "$OUT/logs/select.log"
  local rc=$?
  cat "$OUT/select.json"
  return $rc
}

# parse_spec <spec>  validates the spec and sets one variable per value, K_<iv>_<key> (e.g. K_1h_d0e2).
parse_spec() {
  local spec=$1 part iv body kv key val
  local -a parts items
  local seen=0
  IFS=';' read -r -a parts <<< "$spec"
  [[ ${#parts[@]} -eq 2 ]] || die "spec needs two ';' separated parts (1h and 4h)" || return 1
  for part in "${parts[@]}"; do
    iv=${part%%:*}
    body=${part#*:}
    [[ "$iv" == 1h || "$iv" == 4h ]] || die "spec interval must be 1h or 4h: '$iv'" || return 1
    IFS=',' read -r -a items <<< "$body"
    for kv in "${items[@]}"; do
      key=${kv%%=*}
      val=${kv#*=}
      [[ "$key" =~ ^d[012]e[23]$ ]] || die "spec key not recognised: '$key'" || return 1
      [[ "$val" == 1 || "$val" == 1.5 || "$val" == 2 ]] || die "spec k must be 1, 1.5 or 2: '$kv'" || return 1
      printf -v "K_${iv}_${key}" %s "$val"
      seen=$((seen + 1))
    done
    for key in d0e2 d0e3 d1e2 d1e3 d2e2 d2e3; do
      local var="K_${iv}_${key}"
      [[ -n "${!var:-}" ]] || die "spec lacks $iv $key" || return 1
    done
  done
  [[ $seen -eq 12 ]] || die "spec holds $seen values, expected 12 (duplicate or missing interval)" || return 1
}

stage_confirm() {
  need_hash "${1:-}" || return 1
  need_cond "${2:-}" || return 1
  need_cond "${3:-}" || return 1
  [[ -n "${4:-}" ]] || die "spec argument missing" || return 1
  MANIFEST=$1
  local c1h=$2 c4h=$3
  parse_spec "$4" || return 1
  local iv n c family k2 k3 jobs=()
  for iv in 1h 4h; do
    c=$c1h
    if [[ "$iv" == 4h ]]; then c=$c4h; fi
    for n in 0 1 2; do
      family=dx-d$n
      k2="K_${iv}_d${n}e2"
      k3="K_${iv}_d${n}e3"
      jobs+=("$(job "$family" "$iv" "$c" 1 1)")
      jobs+=("$(job "$family" "$iv" "$c" 2 "${!k2}")")
      jobs+=("$(job "$family" "$iv" "$c" 3 "${!k3}")")
      jobs+=("$(job "$family" "$iv" "$c" 4 1)")
    done
  done
  [[ ${#jobs[@]} -eq 24 ]] || die "confirm built ${#jobs[@]} jobs, expected 24" || return 1
  run_pool confirm "${jobs[@]}"
}

stage_verdict() {
  local v=${1:-} n
  [[ "$v" =~ ^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$ ]] || die "variance must be a number: '$v'" || return 1
  n=$(count_named "$OUT/confirm")
  [[ "$n" -eq 24 ]] || die "expected 24 confirm reports matching the naming contract, found $n" || return 1
  docker run "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-judge.ts verdict \
    --confirm-dir /app/out/confirm --variance "$v" --dataset-dir /app/ds 2>&1 | tee "$OUT/logs/verdict.log"
}

# ---- dispatch ----------------------------------------------------------------------------------------------------

STAGE=${1:-}
[[ $# -gt 0 ]] && shift
case "$STAGE" in
  export | repro | parity | rows | diagnosis | develop-a | develop-b | select | confirm | verdict) ;;
  *)
    echo "usage: $0 export|repro|parity|rows|diagnosis|develop-a|develop-b|select|confirm|verdict [args]" >&2
    exit 64
    ;;
esac

MANIFEST=
log "stage $STAGE start"
"stage_${STAGE//-/_}" "$@"
RC=$?
log "stage $STAGE exit $RC"
printf '{"stage":"%s","exit":%d,"at":"%s"}\n' "$STAGE" "$RC" "$(date -u +%FT%TZ)" >> "$OUT/stages.log"
exit "$RC"
