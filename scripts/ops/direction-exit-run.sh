#!/bin/bash
# Runbook of the direction-exit study (spec: header of scripts/research/direction-exit.ts). Runs on the VPS from $HOME,
# one stage per call, in the foreground (launch it under setsid nohup). In order:
#
#   direction-exit-run.sh build       docker build of the clean HEAD of $HOME/crypto-archive-build, labelled with it
#   direction-exit-run.sh export      refuses an existing $HOME/dx-ds/manifest.json; writes $HOME/dx-out/manifest-hash
#   direction-exit-run.sh repro       exit 2 = the reproduction check failed: stop
#   direction-exit-run.sh parity      all ten symbols at 1h and 4h; exit 2 = a symbol failed: stop
#   direction-exit-run.sh rows
#   direction-exit-run.sh diagnosis   (commit DIRECTION_EXIT_FIT from its lag-1 fit, push, pull, build)
#   direction-exit-run.sh develop-a   judge check-fit first, then the 40 jobs of `judge jobs develop-a`
#                                     (develop-b and confirm run check-fit again)
#   direction-exit-run.sh cond        saves dx-out/cond.json (commit DIRECTION_EXIT_D2_CONDITION from it, pull, build)
#   direction-exit-run.sh develop-b   the 14 jobs of `judge jobs develop-b --cond-file cond.json`
#   direction-exit-run.sh select      saves dx-out/select.json (commit DIRECTION_EXIT_SELECTION from it, pull, build)
#   direction-exit-run.sh confirm     the 24 jobs of `judge jobs confirm --select-file select.json`
#   direction-exit-run.sh verdict     the judge's verdict, the trial variance recomputed from the 54 develop reports
#
# No stage takes an argument: the dataset hash comes from dx-out/manifest-hash, every job list and every expected
# report name from the judge run inside the image, so nothing is typed by hand. Every container gets the checkout's
# commit as GIT_COMMIT, and every stage refuses an image whose label is not that clean commit (tracked and untracked
# files alike). The image is resolved to its ID once per stage and every container runs by that ID. From cond on, the
# code may differ from the develop-a code only in Markdown files and in the three committed-constant declarations of
# scripts/research/direction-exit.ts (DIRECTION_EXIT_FIT, _D2_CONDITION, _SELECTION); every other line of that file
# must be identical. cond, develop-b, select, confirm and verdict check it with git diff, and develop-a, develop-b
# and confirm re-run the judge's check-fit against diagnosis.json.
# Report directories must hold exactly the expected dx-*.json files; a missing or any other one fails the stage.
# INT and TERM stop the containers this script started (docker stop) and exit 130 or 143.
# Every stage appends {"stage","exit","at"} to $HOME/dx-out/stages.log and exits with the stage's code.
# The stage_* functions are only ever called through the dispatch at the end, by name.
# shellcheck disable=SC2329
set -u -o pipefail

IMG=crypto-ops:dx
IMG_ID=
LABEL=dx.gitCommit
BUILD=$HOME/crypto-archive-build
DS=$HOME/dx-ds
OUT=$HOME/dx-out
REF=$HOME/rescore-out
HASH_FILE=$OUT/manifest-hash
DEV_START=2022-01-01T00:00:00Z
DEV_END=2024-12-31T23:59:59.999Z
CONF_START=2025-01-01T00:00:00Z
CONF_END=2026-10-09T23:59:59.999Z
REPRO_START=2025-10-01T00:00:00Z
PARITY_START=2024-11-01T00:00:00Z
DS_START=2021-10-01T00:00:00Z
DS_END=2026-10-09T23:59:59.999Z
# DIRECTION_EXIT_SYMBOLS and the judge's REPORT_NAME_PATTERN, verbatim (scripts/ops/direction-exit-run.test.ts pins both).
SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,DOTUSDT,LINKUSDT
NAME_RE='^dx-d([012])-(1h|4h)-c([0-4])-e([1-4])-k(1|1\.5|2)$'
STAGE=
CNAMES=()
PIDS=()
NAMES=()
FAILED=()
MANIFEST=
GIT_COMMIT=
JOBS=()
O=()
R=()

mkdir -p "$OUT/develop" "$OUT/confirm" "$OUT/logs"

log() { echo "$(date -u +%FT%TZ) $*" >> "$OUT/logs/run.log"; }
die() {
  echo "ERROR: $*" >&2
  log "error: $*"
  return 1
}

need_hash() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]] || die "manifest hash missing or not 64 hex: '${1:-}'"; }

# ---- provenance --------------------------------------------------------------------------------------------------

# head_commit  prints the checkout's HEAD, failing when it is unknown or the tracked files differ from it.
head_commit() {
  local c
  c=$(git -C "$BUILD" rev-parse HEAD 2> /dev/null)
  [[ "$c" =~ ^[0-9a-f]{40}$ ]] || die "no commit at $BUILD" || return 1
  [[ -z "$(git -C "$BUILD" status --porcelain 2> /dev/null)" ]] ||
    die "$BUILD has uncommitted or untracked files: the image would not be its commit" || return 1
  echo "$c"
}

# need_commit  sets GIT_COMMIT once for the stage (the clean HEAD, which must be the image's label), resolves the image
# to its ID once (IMG_ID, so a rebuild during the stage cannot swap the code) and sets the docker arguments that pass
# the commit to every container.
need_commit() {
  local label
  GIT_COMMIT=$(head_commit) || return 1
  IMG_ID=$(docker image inspect --format '{{.Id}}' "$IMG" 2> /dev/null)
  [[ -n "$IMG_ID" ]] || die "no image $IMG: run the build stage" || return 1
  label=$(docker image inspect --format "{{ index .Config.Labels \"$LABEL\" }}" "$IMG_ID" 2> /dev/null)
  [[ "$label" == "$GIT_COMMIT" ]] ||
    die "image $IMG is labelled '$label' but $BUILD is at $GIT_COMMIT: run the build stage" || return 1
  O=(--rm --cpu-shares 256 --memory 3g -e NODE_OPTIONS=--max-old-space-size=2560 -e NPM_CONFIG_UPDATE_NOTIFIER=false
    -e "GIT_COMMIT=$GIT_COMMIT")
  R=("${O[@]}" -v "$DS:/app/ds:ro" -v "$OUT:/app/out")
  log "stage $STAGE commit $GIT_COMMIT image $IMG_ID"
  echo "commit $GIT_COMMIT image $IMG_ID"
}

read_hash() {
  [[ -f "$HASH_FILE" ]] || die "no $HASH_FILE: run the export stage first" || return 1
  MANIFEST=$(tr -d '[:space:]' < "$HASH_FILE")
  need_hash "$MANIFEST" || return 1
  echo "dataset $MANIFEST"
}

# json_field <key> <file>  the string value of "key" in a JSON file, compact or indented: the last "key": "value" on
# the first line that has one (the match is greedy). Keys read here are unique per line.
json_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$2" | head -1; }

# strip_constants <commit>  scripts/research/direction-exit.ts at <commit> without the three committed-constant
# declarations (DIRECTION_EXIT_FIT, _D2_CONDITION, _SELECTION), each from its `export const` line through the end of
# its statement (bracket depth back to zero on a line ending in `;`). Fails when the file is missing, a declaration
# does not terminate, or the three are not all found exactly once.
strip_constants() {
  git -C "$BUILD" show "$1:scripts/research/direction-exit.ts" 2> /dev/null | awk '
    /^export const DIRECTION_EXIT_(FIT|D2_CONDITION|SELECTION)([^A-Za-z0-9_]|$)/ { skip = 1; depth = 0; n++ }
    skip {
      line = $0
      depth += gsub(/[{(\[]/, "&", line)
      depth -= gsub(/[})\]]/, "&", line)
      if (depth <= 0 && $0 ~ /;[[:space:]]*$/) skip = 0
      next
    }
    { print }
    END { if (skip) exit 3; if (n != 3) exit 4 }'
}

# code_unchanged <from> <to>  the code run at <to> is the code run at <from>: every path that differs between them
# is a Markdown file or scripts/research/direction-exit.ts, and that file differs only in the declarations of
# DIRECTION_EXIT_FIT, DIRECTION_EXIT_D2_CONDITION and DIRECTION_EXIT_SELECTION (any other change fails).
code_unchanged() {
  local from=$1 to=$2 changed f bad=() tmp
  [[ "$from" =~ ^[0-9a-f]{40}$ && "$to" =~ ^[0-9a-f]{40}$ ]] || die "code check needs two commits, got '$from' '$to'" || return 1
  changed=$(git -C "$BUILD" diff --name-only "$from" "$to") || die "git diff $from $to failed" || return 1
  while IFS= read -r f; do
    if [[ -z "$f" || "$f" == *.md ]]; then
      continue
    elif [[ "$f" == scripts/research/direction-exit.ts ]]; then
      tmp=$(mktemp -d) || die "mktemp failed" || return 1
      if strip_constants "$from" > "$tmp/from" && strip_constants "$to" > "$tmp/to"; then
        if ! cmp -s "$tmp/from" "$tmp/to"; then bad+=("$f (outside the committed constants)"); fi
      else
        bad+=("$f (constants could not be stripped)")
      fi
      rm -rf "$tmp"
    else
      bad+=("$f")
    fi
  done <<< "$changed"
  if [[ ${#bad[@]} -gt 0 ]]; then
    die "code changed between $from and $to: ${bad[*]}"
    return 1
  fi
  echo "code check ok: $from..$to differs at most in Markdown or the committed constants of direction-exit.ts"
  log "code check ok $from..$to"
}

# check_fit  the committed DIRECTION_EXIT_FIT must equal diagnosis.json's lag-1 fit (judge check-fit).
check_fit() {
  judge_out "$OUT/check-fit.txt" check-fit --diagnosis /app/out/diagnosis.json --expect-manifest-hash "$MANIFEST"
}

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
  return "$rc"
}

# judge_out <outfile> <mode> <args...>  runs the judge in the image, stdout to <outfile> only when it succeeds,
# stderr to the stage log.
judge_out() {
  local outfile=$1 mode=$2 name pid rc
  shift 2
  name=$(cname "judge-$mode")
  if [[ "$mode" == jobs ]]; then name=$(cname "judge-jobs-$1"); fi
  CNAMES+=("$name")
  docker run --name "$name" "${R[@]}" "$IMG_ID" npx tsx scripts/research/direction-exit-judge.ts "$mode" "$@" \
    > "$outfile.tmp" 2>> "$OUT/logs/$STAGE.log" &
  pid=$!
  PIDS=("$pid")
  wait "$pid"
  rc=$?
  PIDS=()
  if [[ $rc -ne 0 ]]; then
    rm -f "$outfile.tmp"
    tail -n 5 "$OUT/logs/$STAGE.log" >&2
    die "judge $mode failed with exit $rc (log $OUT/logs/$STAGE.log)"
    return "$rc"
  fi
  mv "$outfile.tmp" "$outfile"
  cat "$outfile"
}

# ---- jobs and names ----------------------------------------------------------------------------------------------

# load_jobs <stage> <count> [judge flags...]  sets JOBS (name|family|interval|params) from `judge jobs <stage>`.
load_jobs() {
  local stage=$1 want=$2 file line name family iv params extra dups
  shift 2
  file="$OUT/jobs-$stage.txt"
  judge_out "$file" jobs "$stage" "$@" > /dev/null || return 1
  JOBS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    extra=
    read -r name family iv params extra <<< "$line"
    if [[ -n "$extra" || ! "$name" =~ $NAME_RE || ! "$family" =~ ^dx-d[012]$ || ! "$iv" =~ ^(1h|4h)$ ||
      ! "$params" =~ ^(cond=[1-4],)?exit=[1-4],k=(1|1\.5|2)$ || "$name" != "$family-$iv-"* ]]; then
      die "judge jobs $stage printed a malformed line: '$line'" || return 1
    fi
    JOBS+=("$name|$family|$iv|$params")
  done < "$file"
  [[ ${#JOBS[@]} -eq $want ]] || die "judge jobs $stage gave ${#JOBS[@]} jobs, expected $want" || return 1
  dups=$(job_names "${JOBS[@]}" | sort | uniq -d)
  [[ -z "$dups" ]] || die "judge jobs $stage repeats: $dups" || return 1
  echo "jobs $stage: ${#JOBS[@]} from the judge"
}

job_names() {
  local job
  for job in "$@"; do echo "${job%%|*}"; done
}

# check_exact <dir> <name>...  every expected <name>.json must exist, and no other dx-*.json may.
check_exact() {
  local dir=$1 n f b missing=() extra=() all
  shift
  all=" $* "
  for n in "$@"; do
    [[ -f "$dir/$n.json" ]] || missing+=("$n")
  done
  for f in "$dir"/dx-*.json; do
    [[ -e "$f" ]] || continue
    b=$(basename "$f" .json)
    if [[ "$all" != *" $b "* ]]; then extra+=("$b"); fi
  done
  if [[ ${#missing[@]} -gt 0 || ${#extra[@]} -gt 0 ]]; then
    echo "name check failed in $dir: expected $#, missing ${#missing[@]} [${missing[*]-}], extra ${#extra[@]} [${extra[*]-}]" >&2
    log "name check failed in $dir: missing [${missing[*]-}] extra [${extra[*]-}]"
    return 1
  fi
  echo "name check ok in $dir: $# files"
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
  docker run --name "$(cname "$name")" "${R[@]}" "$IMG_ID" npx tsx scripts/research/strategy-harness.ts \
    --family "$family" --interval "$iv" --fixed-eval --fix-params "$params" --symbols "$SYMBOLS" \
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

# ---- stages ------------------------------------------------------------------------------------------------------

stage_build() {
  GIT_COMMIT=$(head_commit) || return 1
  docker build --target seeder --label "$LABEL=$GIT_COMMIT" -t "$IMG" "$BUILD" 2>&1 | tee "$OUT/logs/build.log"
  local rc=$?
  [[ $rc -eq 0 ]] || return "$rc"
  echo "built $IMG at $GIT_COMMIT"
  log "build $GIT_COMMIT"
}

stage_export() {
  [[ ! -e "$DS/manifest.json" ]] || die "$DS/manifest.json exists: the study's dataset is exported once" || return 1
  [[ ! -e "$HASH_FILE" ]] || die "$HASH_FILE exists: the study's dataset is exported once" || return 1
  need_commit || return 1
  mkdir -p "$DS"
  drun "$(cname run)" "$OUT/logs/export.log" "${O[@]}" --network crypto_crypto-internal --env-file /opt/sites/crypto/.env \
    -v "$DS:/app/out" "$IMG_ID" \
    npx tsx scripts/research/export-dataset.ts --symbols "$SYMBOLS" --intervals 1h,4h,1d \
    --datasets candles,snapshots,htf,funding --start "$DS_START" --end "$DS_END" --out /app/out
  local rc=$? hash
  [[ $rc -eq 0 ]] || return "$rc"
  hash=$(sed -n 's/.*"datasetHash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DS/manifest.json" | head -1)
  need_hash "$hash" || return 1
  printf '%s\n' "$hash" > "$HASH_FILE"
  echo "manifestHash $hash (saved to $HASH_FILE)"
  log "export manifestHash $hash"
}

stage_repro() {
  need_commit || return 1
  read_hash || return 1
  drun "$(cname rows)" "$OUT/logs/repro-rows.log" "${R[@]}" "$IMG_ID" npx tsx scripts/research/direction-exit-rows.ts \
    --dataset-dir /app/ds --out /app/out/repro-rows.jsonl.gz --start "$REPRO_START" --end "$CONF_END" --scores-only \
    --expect-manifest-hash "$MANIFEST" || return
  drun "$(cname check)" "$OUT/logs/repro.log" "${R[@]}" -v "$REF:/app/ref:ro" "$IMG_ID" npx tsx \
    scripts/research/direction-exit-repro.ts repro --mine /app/out/repro-rows.jsonl.gz \
    --reference /app/ref/v8-rows.jsonl.gz --expect-manifest-hash "$MANIFEST"
}

stage_parity() {
  local iv rc=0 r
  need_commit || return 1
  read_hash || return 1
  for iv in 1h 4h; do
    drun "$(cname "$iv")" "$OUT/logs/parity-$iv.log" "${R[@]}" "$IMG_ID" npx tsx scripts/research/direction-exit-repro.ts \
      parity --dataset-dir /app/ds --interval "$iv" --start "$PARITY_START" --end "$DEV_END" --symbols "$SYMBOLS" \
      --expect-manifest-hash "$MANIFEST"
    r=$?
    log "parity $iv exit $r"
    if [[ $r -ne 0 ]]; then rc=$r; fi
  done
  return "$rc"
}

stage_rows() {
  need_commit || return 1
  read_hash || return 1
  drun "$(cname run)" "$OUT/logs/rows.log" "${R[@]}" "$IMG_ID" npx tsx scripts/research/direction-exit-rows.ts \
    --dataset-dir /app/ds --out /app/out/develop-rows.jsonl.gz --start "$DEV_START" --end "$DEV_END" \
    --expect-manifest-hash "$MANIFEST"
}

stage_diagnosis() {
  need_commit || return 1
  read_hash || return 1
  drun "$(cname run)" "$OUT/logs/diagnosis.log" "${R[@]}" "$IMG_ID" npx tsx scripts/research/direction-exit-diagnosis.ts \
    --rows /app/out/develop-rows.jsonl.gz --out /app/out/diagnosis.json --expect-manifest-hash "$MANIFEST"
}

stage_develop_a() {
  need_commit || return 1
  read_hash || return 1
  check_fit || return 1
  load_jobs develop-a 40 || return 1
  run_pool develop "${JOBS[@]}"
}

stage_cond() {
  local -a names
  need_commit || return 1
  read_hash || return 1
  load_jobs develop-a 40 || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  check_exact "$OUT/develop" "${names[@]}" || return 1
  rm -f "$OUT/cond.json.pending"
  judge_out "$OUT/cond.json.pending" cond --develop-dir /app/out/develop --expect-manifest-hash "$MANIFEST" || return 1
  code_unchanged "$(json_field gitCommit "$OUT/cond.json.pending")" "$GIT_COMMIT" || return 1
  mv "$OUT/cond.json.pending" "$OUT/cond.json"
}

stage_develop_b() {
  need_commit || return 1
  read_hash || return 1
  [[ -f "$OUT/cond.json" ]] || die "no $OUT/cond.json: run the cond stage first" || return 1
  code_unchanged "$(json_field gitCommit "$OUT/cond.json")" "$GIT_COMMIT" || return 1
  check_fit || return 1
  load_jobs develop-b 14 --cond-file /app/out/cond.json || return 1
  run_pool develop "${JOBS[@]}"
}

stage_select() {
  local -a names
  need_commit || return 1
  read_hash || return 1
  [[ -f "$OUT/cond.json" ]] || die "no $OUT/cond.json: run the cond stage first" || return 1
  load_jobs develop-a 40 || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  load_jobs develop-b 14 --cond-file /app/out/cond.json || return 1
  # shellcheck disable=SC2207
  names+=($(job_names "${JOBS[@]}"))
  check_exact "$OUT/develop" "${names[@]}" || return 1
  # select.json is the study's record of the picks: it is moved into place only after every check has passed.
  rm -f "$OUT/select.json.pending"
  judge_out "$OUT/select.json.pending" select --develop-dir /app/out/develop --expect-manifest-hash "$MANIFEST" || return 1
  code_unchanged "$(json_field developA "$OUT/select.json.pending")" "$(json_field developB "$OUT/select.json.pending")" || return 1
  code_unchanged "$(json_field developB "$OUT/select.json.pending")" "$GIT_COMMIT" || return 1
  mv "$OUT/select.json.pending" "$OUT/select.json"
}

stage_confirm() {
  need_commit || return 1
  read_hash || return 1
  [[ -f "$OUT/select.json" ]] || die "no $OUT/select.json: run the select stage first" || return 1
  code_unchanged "$(json_field developB "$OUT/select.json")" "$GIT_COMMIT" || return 1
  check_fit || return 1
  load_jobs confirm 24 --select-file /app/out/select.json || return 1
  run_pool confirm "${JOBS[@]}"
}

stage_verdict() {
  local -a names
  local developb confirmed judged
  need_commit || return 1
  read_hash || return 1
  [[ -f "$OUT/select.json" ]] || die "no $OUT/select.json: run the select stage first" || return 1
  developb=$(json_field developB "$OUT/select.json")
  # the verdict's own code: the judge runs at this checkout, which may differ from develop-b only in the constants
  code_unchanged "$developb" "$GIT_COMMIT" || return 1
  load_jobs confirm 24 --select-file /app/out/select.json || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  check_exact "$OUT/confirm" "${names[@]}" || return 1
  # a stale verdict.json must not be mistaken for this run's: the commits below are read from the file the judge writes
  rm -f "$OUT/confirm/verdict.json"
  drun "$(cname run)" "$OUT/logs/verdict.log" "${R[@]}" "$IMG_ID" npx tsx scripts/research/direction-exit-judge.ts verdict \
    --confirm-dir /app/out/confirm --develop-dir /app/out/develop --select-file /app/out/select.json \
    --dataset-dir /app/ds --expect-manifest-hash "$MANIFEST" || return
  confirmed=$(json_field gitCommit "$OUT/confirm/verdict.json")
  judged=$(json_field judgeCommit "$OUT/confirm/verdict.json")
  [[ "$judged" == "$GIT_COMMIT" ]] || die "verdict.json judgeCommit '$judged' is not this checkout $GIT_COMMIT" || return 1
  code_unchanged "$developb" "$confirmed"
}

# ---- dispatch ----------------------------------------------------------------------------------------------------

STAGE=${1:-}
[[ $# -gt 0 ]] && shift
case "$STAGE" in
  build | export | repro | parity | rows | diagnosis | develop-a | cond | develop-b | select | confirm | verdict) ;;
  *)
    echo "usage: $0 build|export|repro|parity|rows|diagnosis|develop-a|cond|develop-b|select|confirm|verdict" >&2
    exit 64
    ;;
esac
if [[ $# -gt 0 ]]; then
  echo "usage: $0 $STAGE (stages take no arguments; got: $*)" >&2
  exit 64
fi

trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
log "stage $STAGE start"
"stage_${STAGE//-/_}"
RC=$?
finish "$RC"
exit "$RC"
