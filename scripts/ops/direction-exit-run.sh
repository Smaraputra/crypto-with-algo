#!/bin/bash
# Runbook of the direction-exit study (spec: header of scripts/research/direction-exit.ts). Runs on the VPS from $HOME,
# one stage per call, in the foreground (launch it under setsid nohup). The repo checkout at $HOME/crypto-archive-build
# is used only to build the image: docker build --target seeder -t crypto-ops:dx .
#
#   direction-exit-run.sh export
#   direction-exit-run.sh repro | parity | rows | diagnosis
#   direction-exit-run.sh develop-a <manifestHash>
#   direction-exit-run.sh develop-b <manifestHash> <cond1h> <cond4h>
#   direction-exit-run.sh cond      (judge cond mode on the 40 develop-a reports, saved to dx-out/cond.json)
#   direction-exit-run.sh select <cond1h> <cond4h>
#   direction-exit-run.sh confirm <manifestHash> <cond1h> <cond4h> <spec>
#       spec: 1h:d0e2=K,d0e3=K,d1e2=K,d1e3=K,d2e2=K,d2e3=K;4h:...   (every K one of 1, 1.5, 2)
#   direction-exit-run.sh verdict <variance> <cond1h> <cond4h> <spec>
#
# select and verdict check the report files by exact name (54 develop, 24 confirm), missing or extra ones fail the stage.
# INT and TERM stop the containers this script started (docker stop) and exit 130 or 143.
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
NAME_RE='^dx-d[012]-(1h|4h)-c[0-4]-e[1-4]-k(1|1\.5|2)$'
STAGE=
CNAMES=()
PIDS=()
NAMES=()
FAILED=()
MANIFEST=
JOBS=()

mkdir -p "$OUT/develop" "$OUT/confirm" "$OUT/logs"

O=(--rm --cpu-shares 256 --memory 3g -e NODE_OPTIONS=--max-old-space-size=2560 -e NPM_CONFIG_UPDATE_NOTIFIER=false)
R=("${O[@]}" -v "$DS:/app/ds:ro" -v "$OUT:/app/out")

log() { echo "$(date -u +%FT%TZ) $*" >> "$OUT/logs/run.log"; }
die() { echo "ERROR: $*" >&2; log "error: $*"; return 1; }

need_hash() { [[ "${1:-}" =~ ^[0-9a-f]{8,}$ ]] || die "manifest hash missing or not hex: '${1:-}'"; }
need_cond() { [[ "${1:-}" =~ ^[1-4]$ ]] || die "condition must be 1..4: '${1:-}'"; }


# ---- signals -----------------------------------------------------------------------------------------------------

finish() {
  log "stage $STAGE exit $1"
  printf '{"stage":"%s","exit":%d,"at":"%s"}\n' "$STAGE" "$1" "$(date -u +%FT%TZ)" >> "$OUT/stages.log"
}

on_signal() {
  local c
  trap '' INT TERM
  echo "signal $1: stopping containers started by this run" >&2
  if [[ ${#PIDS[@]} -gt 0 ]]; then kill "${PIDS[@]}" 2> /dev/null; fi
  for c in ${CNAMES[@]+"${CNAMES[@]}"}; do
    docker stop "$c" > /dev/null 2>&1
    log "signal $1: docker stop $c"
  done
  finish "$2"
  exit "$2"
}

# cname <job-or-label>  a valid docker container name, dx-<stage>-<label>, dots replaced.
cname() { echo "dx-$STAGE-${1//./p}"; }

# drun <container> <logfile> <docker run args...>  foreground, output to the terminal and the log, signal-aware.
drun() {
  local name=$1 logfile=$2 pid
  shift 2
  CNAMES+=("$name")
  docker run --name "$name" "$@" > >(tee "$logfile") 2>&1 &
  pid=$!
  PIDS=("$pid")
  wait "$pid"
  local rc=$?
  PIDS=()
  return $rc
}

# ---- name contract -----------------------------------------------------------------------------------------------

# check_exact <dir> <name>...  every expected <name>.json must exist, no other file matching the contract may.
check_exact() {
  local dir=$1 n f b missing=() extra=() all
  shift
  all=" $* "
  for n in "$@"; do
    [[ -f "$dir/$n.json" ]] || missing+=("$n")
  done
  for f in "$dir"/*.json; do
    [[ -e "$f" ]] || continue
    b=$(basename "$f" .json)
    if [[ "$b" =~ $NAME_RE && "$all" != *" $b "* ]]; then extra+=("$b"); fi
  done
  if [[ ${#missing[@]} -gt 0 || ${#extra[@]} -gt 0 ]]; then
    echo "name check failed in $dir: expected $#, missing ${#missing[@]} [${missing[*]-}], extra ${#extra[@]} [${extra[*]-}]" >&2
    log "name check failed in $dir: missing [${missing[*]-}] extra [${extra[*]-}]"
    return 1
  fi
  echo "name check ok in $dir: $# files"
}

job_names() {
  local job
  for job in "$@"; do echo "${job%%|*}"; done
}

# ---- harness runs, at most two at a time -------------------------------------------------------------------------

# harness_run <phase> <name> <family> <interval> <params>
harness_run() {
  local phase=$1 name=$2 family=$3 iv=$4 params=$5
  local -a win
  if [[ "$phase" == develop ]]; then
    win=(--eval-from "$DEV_START" --end "$DEV_END" --no-benchmark)
  else
    win=(--eval-from "$CONF_START" --end "$CONF_END" --allow-lockbox)
  fi
  docker run --name "$(cname "$name")" "${R[@]}" "$IMG" npx tsx scripts/research/strategy-harness.ts \
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
    CNAMES+=("$(cname "$name")")
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

# ---- job lists (sets JOBS) ---------------------------------------------------------------------------------------

build_develop_a() {
  local iv family e k
  JOBS=()
  for iv in 1h 4h; do
    for family in dx-d0 dx-d1; do
      JOBS+=("$(job "$family" "$iv" 0 1 1)")
      for e in 2 3; do
        for k in 1 1.5 2; do JOBS+=("$(job "$family" "$iv" 0 "$e" "$k")"); done
      done
      JOBS+=("$(job "$family" "$iv" 0 4 1)")
    done
    for e in 1 2 3 4; do JOBS+=("$(job dx-d2 "$iv" "$e" 1 1)"); done
  done
  [[ ${#JOBS[@]} -eq 40 ]] || die "develop-a built ${#JOBS[@]} jobs, expected 40"
}

# build_develop_b <cond1h> <cond4h>  appends the 14 jobs to JOBS (call build_develop_a first for the 54).
build_develop_b() {
  local iv c e k
  for iv in 1h 4h; do
    c=$1
    if [[ "$iv" == 4h ]]; then c=$2; fi
    for e in 2 3; do
      for k in 1 1.5 2; do JOBS+=("$(job dx-d2 "$iv" "$c" "$e" "$k")"); done
    done
    JOBS+=("$(job dx-d2 "$iv" "$c" 4 1)")
  done
}

# build_confirm <cond1h> <cond4h>  needs parse_spec to have run.
build_confirm() {
  local iv n c family k2 k3
  JOBS=()
  for iv in 1h 4h; do
    c=$1
    if [[ "$iv" == 4h ]]; then c=$2; fi
    for n in 0 1 2; do
      family=dx-d$n
      k2="K_${iv}_d${n}e2"
      k3="K_${iv}_d${n}e3"
      JOBS+=("$(job "$family" "$iv" "$c" 1 1)")
      JOBS+=("$(job "$family" "$iv" "$c" 2 "${!k2}")")
      JOBS+=("$(job "$family" "$iv" "$c" 3 "${!k3}")")
      JOBS+=("$(job "$family" "$iv" "$c" 4 1)")
    done
  done
  [[ ${#JOBS[@]} -eq 24 ]] || die "confirm built ${#JOBS[@]} jobs, expected 24"
}

# parse_spec <spec>  strict: exactly the intervals 1h and 4h once each, exactly the six keys each, k in 1, 1.5, 2.
# Sets one variable per value, K_<iv>_<key> (e.g. K_1h_d0e2), after unsetting every such variable first.
parse_spec() {
  local spec=$1 part iv body kv key val var seen_iv=" "
  local -a parts items
  for iv in 1h 4h; do
    for key in d0e2 d0e3 d1e2 d1e3 d2e2 d2e3; do unset "K_${iv}_${key}"; done
  done
  IFS=';' read -r -a parts <<< "$spec"
  [[ ${#parts[@]} -eq 2 ]] || die "spec needs two ';' separated parts (1h and 4h), got ${#parts[@]}" || return 1
  for part in "${parts[@]}"; do
    [[ "$part" == *:* ]] || die "spec part lacks 'interval:': '$part'" || return 1
    iv=${part%%:*}
    body=${part#*:}
    [[ "$iv" == 1h || "$iv" == 4h ]] || die "spec interval must be 1h or 4h: '$iv'" || return 1
    [[ "$seen_iv" != *" $iv "* ]] || die "spec repeats interval $iv" || return 1
    seen_iv="$seen_iv$iv "
    IFS=',' read -r -a items <<< "$body"
    [[ ${#items[@]} -eq 6 ]] || die "spec $iv needs 6 values, got ${#items[@]}" || return 1
    for kv in "${items[@]}"; do
      [[ "$kv" == *=* ]] || die "spec item is not key=value: '$kv'" || return 1
      key=${kv%%=*}
      val=${kv#*=}
      [[ "$key" =~ ^d[012]e[23]$ ]] || die "spec key not recognised: '$key'" || return 1
      [[ "$val" == 1 || "$val" == 1.5 || "$val" == 2 ]] || die "spec k must be 1, 1.5 or 2: '$kv'" || return 1
      var="K_${iv}_${key}"
      [[ -z "${!var:-}" ]] || die "spec repeats $iv $key" || return 1
      printf -v "$var" %s "$val"
    done
  done
  [[ "$seen_iv" == " 1h 4h " || "$seen_iv" == " 4h 1h " ]] || die "spec must cover both 1h and 4h" || return 1
  for iv in 1h 4h; do
    for key in d0e2 d0e3 d1e2 d1e3 d2e2 d2e3; do
      var="K_${iv}_${key}"
      [[ -n "${!var:-}" ]] || die "spec lacks $iv $key" || return 1
    done
  done
}

# ---- stages ------------------------------------------------------------------------------------------------------

stage_export() {
  mkdir -p "$DS"
  drun dx-export "$OUT/logs/export.log" "${O[@]}" --network crypto_crypto-internal --env-file /opt/sites/crypto/.env \
    -v "$DS:/app/out" "$IMG" \
    npx tsx scripts/research/export-dataset.ts --intervals 1h,4h,1d --datasets candles,snapshots,htf,funding \
    --start "$DS_START" --end "$DS_END" --out /app/out
  local rc=$?
  [[ $rc -eq 0 ]] || return $rc
  local hash
  hash=$(sed -n 's/.*"datasetHash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DS/manifest.json" | head -1)
  [[ -n "$hash" ]] || die "no datasetHash in $DS/manifest.json" || return 1
  echo "manifestHash $hash"
  log "export manifestHash $hash"
}

stage_repro() {
  drun dx-repro-rows "$OUT/logs/repro-rows.log" "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-rows.ts \
    --dataset-dir /app/ds --out /app/out/repro-rows.jsonl.gz --start 2025-10-01T00:00:00Z --end "$CONF_END" --scores-only
  local rc=$?
  [[ $rc -eq 0 ]] || return $rc
  drun dx-repro "$OUT/logs/repro.log" "${R[@]}" -v "$REF:/app/ref:ro" "$IMG" npx tsx \
    scripts/research/direction-exit-repro.ts repro --mine /app/out/repro-rows.jsonl.gz \
    --reference /app/ref/v8-rows.jsonl.gz
}

stage_parity() {
  local iv rc=0 r
  for iv in 1h 4h; do
    drun "dx-parity-$iv" "$OUT/logs/parity-$iv.log" "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-repro.ts \
      parity --dataset-dir /app/ds --symbol BTCUSDT --interval "$iv" --start 2024-11-01T00:00:00Z \
      --end 2024-12-31T23:59:59.999Z
    r=$?
    log "parity $iv exit $r"
    if [[ $r -ne 0 ]]; then rc=$r; fi
  done
  return $rc
}

stage_rows() {
  drun dx-rows "$OUT/logs/rows.log" "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-rows.ts \
    --dataset-dir /app/ds --out /app/out/develop-rows.jsonl.gz --start "$DEV_START" --end "$DEV_END"
}

stage_diagnosis() {
  drun dx-diagnosis "$OUT/logs/diagnosis.log" "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-diagnosis.ts \
    --rows /app/out/develop-rows.jsonl.gz --out /app/out/diagnosis.json
}

stage_develop_a() {
  need_hash "${1:-}" || return 1
  MANIFEST=$1
  build_develop_a || return 1
  run_pool develop "${JOBS[@]}"
}

stage_develop_b() {
  need_hash "${1:-}" || return 1
  need_cond "${2:-}" || return 1
  need_cond "${3:-}" || return 1
  MANIFEST=$1
  JOBS=()
  build_develop_b "$2" "$3"
  [[ ${#JOBS[@]} -eq 14 ]] || die "develop-b built ${#JOBS[@]} jobs, expected 14" || return 1
  run_pool develop "${JOBS[@]}"
}

# Runs the judge in mode $1 with the remaining args, stdout to $2 and stderr to the stage log.
judge_to_file() {
  local mode=$1 outfile=$2 pid rc
  shift 2
  CNAMES+=("dx-$STAGE")
  docker run --name "dx-$STAGE" "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-judge.ts "$mode" "$@" \
    > "$outfile" 2> "$OUT/logs/$STAGE.log" &
  pid=$!
  PIDS=("$pid")
  wait "$pid"
  rc=$?
  PIDS=()
  cat "$outfile"
  return $rc
}

stage_cond() {
  local -a names
  local n missing=()
  build_develop_a || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  for n in "${names[@]}"; do [[ -f "$OUT/develop/$n.json" ]] || missing+=("$n"); done
  if [[ ${#missing[@]} -gt 0 ]]; then
    die "cond: ${#missing[@]} of 40 develop-a reports missing: ${missing[*]}" || return 1
  fi
  judge_to_file cond "$OUT/cond.json" --develop-dir /app/out/develop
}

stage_select() {
  need_cond "${1:-}" || return 1
  need_cond "${2:-}" || return 1
  local -a names
  build_develop_a || return 1
  build_develop_b "$1" "$2"
  [[ ${#JOBS[@]} -eq 54 ]] || die "select built ${#JOBS[@]} names, expected 54" || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  check_exact "$OUT/develop" "${names[@]}" || return 1
  judge_to_file select "$OUT/select.json" --develop-dir /app/out/develop
}

stage_confirm() {
  need_hash "${1:-}" || return 1
  need_cond "${2:-}" || return 1
  need_cond "${3:-}" || return 1
  [[ -n "${4:-}" ]] || die "spec argument missing" || return 1
  MANIFEST=$1
  parse_spec "$4" || return 1
  build_confirm "$2" "$3" || return 1
  run_pool confirm "${JOBS[@]}"
}

stage_verdict() {
  local v=${1:-}
  [[ "$v" =~ ^[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?$ ]] || die "variance must be a number: '$v'" || return 1
  need_cond "${2:-}" || return 1
  need_cond "${3:-}" || return 1
  [[ -n "${4:-}" ]] || die "spec argument missing" || return 1
  parse_spec "$4" || return 1
  build_confirm "$2" "$3" || return 1
  local -a names
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  check_exact "$OUT/confirm" "${names[@]}" || return 1
  drun dx-verdict "$OUT/logs/verdict.log" "${R[@]}" "$IMG" npx tsx scripts/research/direction-exit-judge.ts verdict \
    --confirm-dir /app/out/confirm --variance "$v" --dataset-dir /app/ds
}

# ---- dispatch ----------------------------------------------------------------------------------------------------

STAGE=${1:-}
[[ $# -gt 0 ]] && shift
case "$STAGE" in
  export | repro | parity | rows | diagnosis | develop-a | develop-b | cond | select | confirm | verdict) ;;
  *)
    echo "usage: $0 export|repro|parity|rows|diagnosis|develop-a|develop-b|cond|select|confirm|verdict [args]" >&2
    exit 64
    ;;
esac

trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
log "stage $STAGE start"
"stage_${STAGE//-/_}" "$@"
RC=$?
finish "$RC"
exit "$RC"
