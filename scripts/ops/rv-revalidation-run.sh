#!/bin/bash
# Runbook of the rv-v1 re-validation (spec: the locked header of scripts/research/rv-revalidation.ts with AMENDMENTS 1
# to 3, and the Task 7C addendum). Runs on the VPS from $HOME, one stage per call, in the foreground (launch it under
# setsid nohup). In order:
#
#   rv-revalidation-run.sh build       docker build of the clean HEAD of $HOME/crypto-archive-build, labelled with it
#   rv-revalidation-run.sh calibrate   pins the run to its commit and image ID (rv2-out/run-commit, run-image), runs
#                                      the synthetic universes of `judge jobs calibrate`, then the judge's
#                                      check-calibration. Exit 2 = an acceptance rule failed: the study stops until
#                                      the machinery is fixed
#   rv-revalidation-run.sh export      only after a calibration PASS recorded at this commit (the header: calibration
#                                      passes before any real data is read). Refuses an existing $HOME/rv2-ds. Writes
#                                      rv2-out/manifest-hash
#   rv-revalidation-run.sh resolve     drafts rv2-out/inputs/resolutions.json from Binance REST, records its sha256
#                                      (resolve.json), prints the entries and stops
#        CONTROLLER CHECKPOINT: the entries are reviewed here. Nothing chains resolve into inputs
#   rv-revalidation-run.sh inputs      only with resolve's record at this commit and dataset: verifies the reviewed
#                                      file against REST, builds the panel and records its sha256
#   rv-revalidation-run.sh real        steps 1 and 3, the stress run, the maker track and the 1-bar purge sensitivity
#   rv-revalidation-run.sh is-mcpt     step 2: the shard jobs of `judge jobs is-mcpt`, then judge merge
#   rv-revalidation-run.sh wf-mcpt     step 4, the same way
#   rv-revalidation-run.sh block       the block-permutation sensitivity of step 2 (reported only), the same way
#   rv-revalidation-run.sh verdict     judge dsr, then judge verdict (G1, G2, G3 and every REPORTED item), which
#                                      re-merges the shard directories and refuses a merged file that differs
#
# Each stage refuses until the stage before it in this list has written its record or output, so the order is
# enforced, not only advised.
#
# No stage takes an argument: the dataset hash comes from rv2-out/manifest-hash, every job list from the judge run
# inside the image, so nothing is typed by hand. Every container gets the run's commit as GIT_COMMIT and runs by the
# image ID resolved once per stage, with --cpu-shares 256 --memory 3g and no mount over /app (the image is the code).
# Network: none, except export (the internal network to Mongo, with the VPS env file) and resolve and inputs (the
# default bridge network for Binance REST, given only BINANCE_FUTURES_API_URL from the env file, which
# src/lib/binance-futures.ts reads). At most two containers run at once: the permutation and calibration jobs run in
# pairs, every other container alone, a lock (rv2-out/.lock) keeps a second stage from starting beside a first, and
# no stage starts while any rv2- container is still running (a runner killed by SIGKILL orphans its containers).
# A pooled job writes into rv2-out/part/ and is moved into its stage directory only when its container exits 0, so a
# rerun of a stage runs only the jobs whose output is missing.
# INT, TERM and HUP stop the containers this script started (docker stop) and exit 130, 143 or 129. The traps are set
# before the lock is taken, and a second signal during that cleanup is ignored, so the first one's code stands.
# Every stage appends {"stage","exit","commit","at"} to $HOME/rv2-out/stages.log and exits with the stage's code.
# The stage_* functions are only ever called through the dispatch at the end, by name.
# shellcheck disable=SC2329
set -u -o pipefail

IMG=crypto-ops:rv2
IMG_ID=
LABEL=rv2.gitCommit
BUILD=$HOME/crypto-archive-build
DS=$HOME/rv2-ds
OUT=$HOME/rv2-out
# The VPS env file. RV2_ENV_FILE exists for scripts/ops/rv-revalidation-run.test.ts, which cannot write under /opt.
ENV_FILE=${RV2_ENV_FILE:-/opt/sites/crypto/.env}
HASH_FILE=$OUT/manifest-hash
RUN_FILE=$OUT/run-commit
RUN_IMAGE=$OUT/run-image
CAL_DIR=$OUT/calibration
CAL_RECORD=$OUT/calibration.json
CAL_PASS=$OUT/calibration.pass
INPUTS=$OUT/inputs
SHARDS=$OUT/shards
PART=$OUT/part
LOCK=$OUT/.lock
# 1 once this run holds the lock: only then may a signal release it and log the stage
LOCKED=0
# The header's DATA export, verbatim (scripts/ops/rv-revalidation-run.test.ts pins each against the header and
# RV_SYMBOLS and RV_SPAN of scripts/research/rv-panel.ts).
SYMBOLS=BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,ADAUSDT,DOGEUSDT,AVAXUSDT,DOTUSDT,LINKUSDT
DS_START=2022-01-01T00:00:00Z
DS_END=2026-10-13T23:59:59.999Z
EXPORT_DATASETS=perp,funding
EXPORT_PERP_SERIES=klines
EXPORT_INTERVALS=1h,4h
# Header STEPS 2 and 4 and REPORTED: M = 1,000 for each permutation stage. CALIBRATION: 100 iid, 10 planted, 10 GARCH
# and 10 carry-only universes, one job each (the test pins both against rv-mcpt.ts and rv-stages.ts).
M=1000
CAL_JOBS=130
STAGE=
CNAMES=()
PIDS=()
NAMES=()
FAILED=()
MANIFEST=
GIT_COMMIT=
JOBS=()
O=()
REST=()

log() { echo "$(date -u +%FT%TZ) $*" >> "$OUT/logs/run.log"; }
die() {
  echo "ERROR: $*" >&2
  log "error: $*"
  return 1
}

need_hash() { [[ "${1:-}" =~ ^[0-9a-f]{64}$ ]] || die "manifest hash missing or not 64 hex: '${1:-}'"; }

# top_field <key> <file>  the raw value of a top-level key of a JSON file written with two-space indentation (the
# judge's and the stages' records): the line indented by exactly two spaces, its trailing comma dropped. A nested key
# is indented deeper and never matches.
top_field() { sed -n "s/^  \"$1\": \(.*\)$/\1/p" "$2" 2> /dev/null | head -1 | sed 's/,$//'; }

# ---- provenance --------------------------------------------------------------------------------------------------
#
# Provenance is strict (Task 7B pre-review Ruling 2, Task 7C addendum rule 3). calibrate, the first stage of a run,
# records the commit it runs at in rv2-out/run-commit, and every later stage requires the clean HEAD of the checkout,
# the image label and that recorded commit to be one commit. direction-exit-run.sh allowed Markdown and committed
# constants to change between stages (its code_unchanged). This study allows no commit of any kind: the calibration
# that licenses reading the real data must have run the very code that reads it, every TypeScript stage already
# refuses a GIT_COMMIT other than the one resolve and inputs recorded, and one commit makes the whole run
# reproducible from one checkout. A new commit means a new run in a fresh rv2-out.

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
# to its ID once (IMG_ID, so a rebuild during the stage cannot swap the code) and sets the docker arguments every
# container gets: the resource caps and the commit. Each call adds its own --network. Once calibrate has pinned the
# run, the image ID must also be the one it recorded (rv2-out/run-image): the label names a commit, not the bytes of
# the image, and a rebuild of the same commit can differ (a moved base tag, or gitignored files in the build context).
need_commit() {
  local label run_image
  GIT_COMMIT=$(head_commit) || return 1
  IMG_ID=$(docker image inspect --format '{{.Id}}' "$IMG" 2> /dev/null)
  [[ -n "$IMG_ID" ]] || die "no image $IMG: run the build stage" || return 1
  label=$(docker image inspect --format "{{ index .Config.Labels \"$LABEL\" }}" "$IMG_ID" 2> /dev/null)
  [[ "$label" == "$GIT_COMMIT" ]] ||
    die "image $IMG is labelled '$label' but $BUILD is at $GIT_COMMIT: run the build stage" || return 1
  if [[ -e "$RUN_IMAGE" ]]; then
    run_image=$(tr -d '[:space:]' < "$RUN_IMAGE") || die "cannot read $RUN_IMAGE" || return 1
    [[ "$run_image" == "$IMG_ID" ]] ||
      die "image $IMG is $IMG_ID but calibrate ran this run with $run_image (recorded in $RUN_IMAGE): the run continues only on that image" ||
      return 1
  fi
  O=(--rm --cpu-shares 256 --memory 3g -e NODE_OPTIONS=--max-old-space-size=2560 -e NPM_CONFIG_UPDATE_NOTIFIER=false
    -e "GIT_COMMIT=$GIT_COMMIT")
  log "stage $STAGE commit $GIT_COMMIT image $IMG_ID"
  echo "commit $GIT_COMMIT image $IMG_ID"
}

# same_run  the run's commit, recorded by calibrate, is the commit this stage runs at (need_commit has already held
# the image to the recorded image ID).
same_run() {
  local run
  [[ -f "$RUN_FILE" && -f "$RUN_IMAGE" ]] ||
    die "no $RUN_FILE and $RUN_IMAGE: run the calibrate stage first (it pins the run's commit and image)" || return 1
  run=$(tr -d '[:space:]' < "$RUN_FILE") || die "cannot read $RUN_FILE" || return 1
  [[ "$run" == "$GIT_COMMIT" ]] ||
    die "this run is pinned to $run (recorded by calibrate) but the checkout and image are at $GIT_COMMIT: no commit of any kind may land between stages. Check out $run and rebuild, or start a new run in a fresh $OUT" ||
    return 1
  echo "run commit $run"
}

# pin_run  calibrate records the run's commit and image ID on its first call and requires them on any later call.
pin_run() {
  if [[ -e "$RUN_FILE" || -e "$RUN_IMAGE" ]]; then
    same_run
    return
  fi
  printf '%s\n' "$IMG_ID" > "$RUN_IMAGE" || die "cannot write $RUN_IMAGE" || return 1
  printf '%s\n' "$GIT_COMMIT" > "$RUN_FILE" || die "cannot write $RUN_FILE" || return 1
  echo "run pinned to $GIT_COMMIT and image $IMG_ID ($RUN_FILE, $RUN_IMAGE)"
  log "run pinned $GIT_COMMIT $IMG_ID"
}

# calibration_passed  calibrate's check-calibration exited 0 at this commit: calibration.pass names the commit, and
# the record's own gitCommit and pass agree.
calibration_passed() {
  local rec commit pass
  [[ -f "$CAL_PASS" ]] ||
    die "no calibration PASS recorded ($CAL_PASS): run the calibrate stage first. The header requires the calibration to pass before any real data is read" ||
    return 1
  rec=$(tr -d '[:space:]' < "$CAL_PASS")
  [[ "$rec" == "$GIT_COMMIT" ]] || die "the calibration PASS was recorded at $rec, this stage runs at $GIT_COMMIT" || return 1
  commit=$(top_field gitCommit "$CAL_RECORD")
  pass=$(top_field pass "$CAL_RECORD")
  [[ "$commit" == "\"$GIT_COMMIT\"" && "$pass" == true ]] ||
    die "$CAL_RECORD is not a PASS at $GIT_COMMIT (gitCommit $commit, pass $pass)" || return 1
  echo "calibration PASS at $GIT_COMMIT"
}

read_hash() {
  [[ -f "$HASH_FILE" ]] || die "no $HASH_FILE: run the export stage first" || return 1
  MANIFEST=$(tr -d '[:space:]' < "$HASH_FILE")
  need_hash "$MANIFEST" || return 1
  echo "dataset $MANIFEST"
}

# recorded_by <file> <stage>  a stage record (resolve.json, inputs.json) names this commit and this dataset.
recorded_by() {
  local file=$1 what=$2 commit hash
  commit=$(top_field gitCommit "$file")
  hash=$(top_field manifestHash "$file")
  [[ "$commit" == "\"$GIT_COMMIT\"" ]] || die "$file was written by $what at commit $commit, this stage runs at $GIT_COMMIT" || return 1
  [[ "$hash" == "\"$MANIFEST\"" ]] || die "$file was written by $what from dataset $hash, this run's dataset is $MANIFEST" || return 1
}

# need_inputs  the inputs stage recorded the panel at this commit and dataset.
need_inputs() {
  [[ -f "$INPUTS/inputs.json" && -f "$INPUTS/panel.json.gz" ]] ||
    die "no recorded panel in $INPUTS: run the inputs stage first" || return 1
  recorded_by "$INPUTS/inputs.json" inputs
}

# rest_env  REST holds the docker arguments of the Binance REST stages: BINANCE_FUTURES_API_URL from the env file when
# it sets one (and nothing else from that file), else nothing, stated, so the code's own default applies.
rest_env() {
  local url
  REST=()
  [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE" || return 1
  url=$(sed -n 's/^BINANCE_FUTURES_API_URL=//p' "$ENV_FILE" | tail -1 | tr -d '[:space:]')
  url=${url#\"}
  url=${url%\"}
  url=${url#\'}
  url=${url%\'}
  if [[ -z "$url" ]]; then
    echo "BINANCE_FUTURES_API_URL is not set in $ENV_FILE: the code's own default (src/lib/binance-futures.ts) applies"
    log "rest base url: code default"
    return 0
  fi
  [[ "$url" =~ ^https?://[^[:space:]]+$ ]] || die "BINANCE_FUTURES_API_URL in $ENV_FILE is not an http(s) URL" || return 1
  REST=(-e "BINANCE_FUTURES_API_URL=$url")
  echo "Binance futures base URL $url (from $ENV_FILE)"
  log "rest base url $url"
}

# ---- signals and the lock ----------------------------------------------------------------------------------------

finish() {
  log "stage $STAGE exit $1"
  printf '{"stage":"%s","exit":%d,"commit":"%s","at":"%s"}\n' "$STAGE" "$1" "$GIT_COMMIT" "$(date -u +%FT%TZ)" >> "$OUT/stages.log"
  rm -rf "$LOCK"
  # Released: a signal between here and the exit must not log the stage a second time
  LOCKED=0
}

# on_signal <name> <code>  set before the lock is taken (7C re-review m1). Every signal is ignored from here on, so a
# second one cannot restart the cleanup or replace the first one's exit code. A run that holds the lock logs the
# stage and releases the lock (finish). One that does not hold it yet leaves the lock, which may be another run's.
on_signal() {
  local c
  trap '' INT TERM HUP
  echo "signal $1: stopping containers started by this run" >&2
  if [[ ${#PIDS[@]} -gt 0 ]]; then kill "${PIDS[@]}" 2> /dev/null; fi
  for c in ${CNAMES[@]+"${CNAMES[@]}"}; do
    docker stop "$c" > /dev/null 2>&1
    log "signal $1: docker stop $c"
  done
  if [[ $LOCKED -eq 1 ]]; then finish "$2"; fi
  exit "$2"
}

# refuse_locked <message>  a refusal after the lock was taken: signals are ignored, the lock is released, no
# stages.log line is written (the stage never started), exit 75.
refuse_locked() {
  trap '' INT TERM HUP
  rm -rf "$LOCK"
  echo "ERROR: $*" >&2
  exit 75
}

# lock  one stage at a time, so the run never exceeds two containers. A lock left by a killed run is removed by hand.
# The lock alone cannot see containers a killed runner left behind, so no stage starts while any rv2- container
# runs (or while docker cannot say). Both refusals exit 75 and leave no stages.log line. A signal during the
# docker ps check releases the lock through on_signal.
lock() {
  local running
  if ! mkdir "$LOCK" 2> /dev/null; then
    echo "ERROR: $LOCK is held by pid $(cat "$LOCK/pid" 2> /dev/null). One stage at a time keeps the run at two containers. Remove $LOCK only if that process is gone and docker ps --filter name=^rv2- lists nothing" >&2
    exit 75
  fi
  LOCKED=1
  echo "$$" > "$LOCK/pid" || refuse_locked "cannot write $LOCK/pid"
  if ! running=$(docker ps -q --filter name=^rv2-); then
    refuse_locked "docker ps failed, so this stage cannot tell whether rv2- containers are still running"
  fi
  if [[ -n "$running" ]]; then
    refuse_locked "rv2- containers are still running ($(echo "$running" | tr '\n' ' ')). A killed runner leaves its containers behind. Stop them (docker ps --filter name=^rv2-, then docker stop) before any stage starts"
  fi
}

# cname <job-or-label>  a valid docker container name, rv2-<stage>-<label>, dots replaced.
cname() { echo "rv2-$STAGE-${1//./p}"; }

# drun <container> <logfile> <docker run args...>  foreground, output to the terminal and the log, signal-aware.
drun() {
  local name=$1 logfile=$2 pid rc
  shift 2
  CNAMES+=("$name")
  docker run --name "$name" "$@" > >(tee "$logfile") 2>&1 &
  pid=$!
  PIDS=("$pid")
  wait "$pid"
  rc=$?
  PIDS=()
  return "$rc"
}

# judge <outfile> <mode> <args...>  runs rv-judge.ts in the image without network, its stdout to <outfile> (and the
# terminal, except for jobs), its stderr to the stage log. Returns the judge's exit code.
judge() {
  local outfile=$1 mode=$2 name pid rc
  shift 2
  name=$(cname "judge-$mode")
  if [[ "$mode" == jobs ]]; then name=$(cname "judge-jobs-$1"); fi
  CNAMES+=("$name")
  docker run --name "$name" "${O[@]}" --network none -v "$OUT:/app/out" "$IMG_ID" npx tsx scripts/research/rv-judge.ts \
    "$mode" "$@" > "$outfile.tmp" 2>> "$OUT/logs/$STAGE.log" &
  pid=$!
  PIDS=("$pid")
  wait "$pid"
  rc=$?
  PIDS=()
  mv "$outfile.tmp" "$outfile" || die "cannot move $outfile.tmp to $outfile" || return 1
  if [[ "$mode" != jobs ]]; then cat "$outfile"; fi
  if [[ $rc -ne 0 ]]; then
    tail -n 5 "$OUT/logs/$STAGE.log" >&2
    log "judge $mode exit $rc"
  fi
  return "$rc"
}

# settle <part> <final>  moves a finished output into place. A container that exited 0 without it fails the stage, and
# so does a move that fails.
settle() {
  [[ -f "$1" ]] || die "the container exited 0 without writing $1" || return 1
  mv "$1" "$2" || die "cannot move $1 to $2" || return 1
  echo "wrote $2"
}

# ---- jobs --------------------------------------------------------------------------------------------------------

# load_shard_jobs <stage>  sets JOBS (name|stage|mFrom|mTo) from `judge jobs <stage>`: <stage>-NN names in order,
# covering m = 1..M once, contiguous.
load_shard_jobs() {
  local stage=$1 file line name st from to extra next=1 re
  file="$OUT/jobs-$stage.txt"
  judge "$file" jobs "$stage" || die "judge jobs $stage failed" || return 1
  re="^$stage-[0-9]{2}$"
  JOBS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    extra=
    read -r name st from to extra <<< "$line"
    if [[ -n "$extra" || ! "$name" =~ $re || "$st" != "$stage" || ! "$from" =~ ^[1-9][0-9]*$ || ! "$to" =~ ^[1-9][0-9]*$ ]]; then
      die "judge jobs $stage printed a malformed line: '$line'" || return 1
    fi
    [[ $from -eq $next && $to -ge $from ]] ||
      die "judge jobs $stage: $name covers m = $from..$to, expected it to start at m = $next" || return 1
    next=$((to + 1))
    JOBS+=("$name|$st|$from|$to")
  done < "$file"
  [[ $next -eq $((M + 1)) ]] || die "judge jobs $stage covers m = 1..$((next - 1)), the header's M is $M" || return 1
  echo "jobs $stage: ${#JOBS[@]} shards covering m = 1..$M"
}

# load_cal_jobs  sets JOBS (name|kind|k) from `judge jobs calibrate`: cal-<kind>-<k> names, CAL_JOBS of them, unique.
load_cal_jobs() {
  local file line name kind k extra dups re='^cal-(iid|planted|garch|carry)-([0-9]{3})$'
  file="$OUT/jobs-calibrate.txt"
  judge "$file" jobs calibrate || die "judge jobs calibrate failed" || return 1
  JOBS=()
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    extra=
    read -r name kind k extra <<< "$line"
    if [[ -n "$extra" || ! "$name" =~ $re || "${BASH_REMATCH[1]}" != "$kind" || $((10#${BASH_REMATCH[2]})) != "$k" ]]; then
      die "judge jobs calibrate printed a malformed line: '$line'" || return 1
    fi
    JOBS+=("$name|$kind|$k")
  done < "$file"
  [[ ${#JOBS[@]} -eq $CAL_JOBS ]] || die "judge jobs calibrate gave ${#JOBS[@]} jobs, expected $CAL_JOBS" || return 1
  dups=$(job_names "${JOBS[@]}" | sort | uniq -d)
  [[ -z "$dups" ]] || die "judge jobs calibrate repeats: $dups" || return 1
  echo "jobs calibrate: ${#JOBS[@]} universes"
}

job_names() {
  local job
  for job in "$@"; do echo "${job%%|*}"; done
}

# check_exact <dir> <ext> <name>...  every expected <name>.<ext> exists and the directory holds nothing else (the judge
# reads every file of a shard directory and every .json of the calibration directory).
check_exact() {
  local dir=$1 ext=$2 n f b missing=() extra=() all
  shift 2
  all=" $* "
  for n in "$@"; do
    [[ -f "$dir/$n.$ext" ]] || missing+=("$n")
  done
  for f in "$dir"/* "$dir"/.[!.]*; do
    [[ -e "$f" ]] || continue
    b=$(basename "$f")
    if [[ "$b" != *".$ext" || "$all" != *" ${b%."$ext"} "* ]]; then extra+=("$b"); fi
  done
  if [[ ${#missing[@]} -gt 0 || ${#extra[@]} -gt 0 ]]; then
    echo "name check failed in $dir: expected $#, missing ${#missing[@]} [${missing[*]-}], extra ${#extra[@]} [${extra[*]-}]" >&2
    log "name check failed in $dir: missing [${missing[*]-}] extra [${extra[*]-}]"
    return 1
  fi
  echo "name check ok in $dir: $# files"
}

# ---- pooled jobs, at most two at a time --------------------------------------------------------------------------

# final_of <phase> <name>  where a finished job's output lives (phase cal, or a shard stage).
final_of() {
  if [[ "$1" == cal ]]; then echo "$CAL_DIR/$2.json"; else echo "$SHARDS/$1/$2.jsonl"; fi
}

# pool_job <phase> <name>  one calibration universe or one shard, without network. The output is written into
# rv2-out/part/ and moved into place only after the container exits 0.
pool_job() {
  local phase=$1 name=$2 final part rel
  final=$(final_of "$phase" "$name")
  rel=$(basename "$final")
  part=$PART/$rel
  rm -f "$part" || return 1
  if [[ "$phase" == cal ]]; then
    set -- calibrate --name "$name" --out "/app/out/part/$rel"
  else
    set -- shard --stage "$phase" --name "$name" --inputs-dir /app/out/inputs --expect-manifest-hash "$MANIFEST" \
      --out "/app/out/part/$rel"
  fi
  docker run --name "$(cname "$name")" "${O[@]}" --network none -v "$OUT:/app/out" "$IMG_ID" \
    npx tsx scripts/research/rv-stages.ts "$@" > "$OUT/logs/$name.log" 2>&1 || return
  if [[ ! -f "$part" ]]; then
    echo "exited 0 without writing $part" >> "$OUT/logs/$name.log"
    return 1
  fi
  if ! mv "$part" "$final"; then
    echo "cannot move $part to $final" >> "$OUT/logs/$name.log"
    return 1
  fi
}

reap() {
  local i=0 rc
  while [[ $i -lt ${#PIDS[@]} ]]; do
    wait "${PIDS[$i]}"
    rc=$?
    log "run ${NAMES[$i]} exit $rc"
    if [[ $rc -ne 0 ]]; then FAILED+=("${NAMES[$i]}"); fi
    i=$((i + 1))
  done
  PIDS=()
  NAMES=()
  # Every container this run started has exited here, so a later signal has nothing of these to stop
  CNAMES=()
}

# run_pool <phase> <job>...  job = name|..., two containers at a time. A job whose output exists is kept.
run_pool() {
  local phase=$1 job name kept=0 ran=0
  shift
  PIDS=()
  NAMES=()
  FAILED=()
  for job in "$@"; do
    name=${job%%|*}
    if [[ -f "$(final_of "$phase" "$name")" ]]; then
      kept=$((kept + 1))
      log "run $name kept"
      continue
    fi
    log "run $name start"
    CNAMES+=("$(cname "$name")")
    pool_job "$phase" "$name" &
    PIDS+=($!)
    NAMES+=("$name")
    ran=$((ran + 1))
    if [[ ${#PIDS[@]} -ge 2 ]]; then reap; fi
  done
  reap
  if [[ ${#FAILED[@]} -gt 0 ]]; then
    echo "FAILED runs (${#FAILED[@]}, logs in $OUT/logs): ${FAILED[*]}" >&2
    return 1
  fi
  echo "all $# jobs done: $ran run, $kept kept from an earlier call"
}

# ---- stages ------------------------------------------------------------------------------------------------------

stage_build() {
  local rc
  GIT_COMMIT=$(head_commit) || return 1
  # a rebuild inside a run (an image pruned) must be of the run's commit
  if [[ -e "$RUN_FILE" ]]; then same_run || return 1; fi
  docker build --target seeder --label "$LABEL=$GIT_COMMIT" -t "$IMG" "$BUILD" 2>&1 | tee "$OUT/logs/build.log"
  rc=$?
  [[ $rc -eq 0 ]] || return "$rc"
  echo "built $IMG at $GIT_COMMIT"
  log "build $GIT_COMMIT"
}

stage_calibrate() {
  local rc commit pass
  local -a names
  need_commit || return 1
  pin_run || return 1
  load_cal_jobs || return 1
  mkdir -p "$CAL_DIR" || die "cannot create $CAL_DIR" || return 1
  run_pool cal "${JOBS[@]}" || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  check_exact "$CAL_DIR" json "${names[@]}" || return 1
  # a PASS is recorded only by a check-calibration that exits 0 in this call
  rm -f "$CAL_PASS" "$PART/calibration.json" || die "cannot remove $CAL_PASS before the check" || return 1
  judge "$OUT/logs/check-calibration.txt" check-calibration --dir /app/out/calibration --out /app/out/part/calibration.json
  rc=$?
  if [[ ($rc -eq 0 || $rc -eq 2) && -f "$PART/calibration.json" ]]; then
    mv "$PART/calibration.json" "$CAL_RECORD" || die "cannot move the calibration record to $CAL_RECORD" || return 1
  fi
  if [[ $rc -eq 2 ]]; then
    echo "CALIBRATION FAIL: the study stops until the machinery is fixed (header CALIBRATION ACCEPTANCE). Record: $CAL_RECORD" >&2
    log "calibration FAIL"
    return 2
  fi
  [[ $rc -eq 0 ]] || die "check-calibration failed with exit $rc (log $OUT/logs/$STAGE.log)" || return "$rc"
  commit=$(top_field gitCommit "$CAL_RECORD")
  pass=$(top_field pass "$CAL_RECORD")
  [[ "$commit" == "\"$GIT_COMMIT\"" && "$pass" == true ]] ||
    die "check-calibration exited 0 but $CAL_RECORD is not a PASS at $GIT_COMMIT (gitCommit $commit, pass $pass)" || return 1
  printf '%s\n' "$GIT_COMMIT" > "$CAL_PASS" || die "cannot write $CAL_PASS" || return 1
  echo "CALIBRATION PASS recorded at $GIT_COMMIT ($CAL_PASS)"
  log "calibration PASS $GIT_COMMIT"
}

stage_export() {
  local rc hash
  # a dangling symlink is refused too: -e alone would pass it and the export would write through it
  [[ ! -e "$DS" && ! -L "$DS" ]] || die "$DS exists: the study's dataset is exported once, into a fresh directory" || return 1
  [[ ! -e "$HASH_FILE" && ! -L "$HASH_FILE" ]] || die "$HASH_FILE exists: the study's dataset is exported once" || return 1
  need_commit || return 1
  same_run || return 1
  calibration_passed || return 1
  [[ -r "$ENV_FILE" ]] || die "cannot read $ENV_FILE" || return 1
  mkdir -p "$DS" || die "cannot create $DS" || return 1
  drun "$(cname run)" "$OUT/logs/export.log" "${O[@]}" --network crypto_crypto-internal --env-file "$ENV_FILE" \
    -v "$DS:/app/out" "$IMG_ID" npx tsx scripts/research/export-dataset.ts --symbols "$SYMBOLS" \
    --datasets "$EXPORT_DATASETS" --perp-series "$EXPORT_PERP_SERIES" --intervals "$EXPORT_INTERVALS" \
    --start "$DS_START" --end "$DS_END" --out /app/out
  rc=$?
  [[ $rc -eq 0 ]] || return "$rc"
  hash=$(sed -n 's/.*"datasetHash"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$DS/manifest.json" | head -1)
  need_hash "$hash" || return 1
  printf '%s\n' "$hash" > "$HASH_FILE" || die "cannot write $HASH_FILE" || return 1
  echo "manifestHash $hash (saved to $HASH_FILE)"
  log "export manifestHash $hash"
}

stage_resolve() {
  need_commit || return 1
  same_run || return 1
  read_hash || return 1
  [[ ! -e "$INPUTS/resolve.json" && ! -e "$INPUTS/resolutions.json" ]] ||
    die "$INPUTS already holds a resolutions file or record: resolve writes once" || return 1
  rest_env || return 1
  mkdir -p "$INPUTS" || die "cannot create $INPUTS" || return 1
  drun "$(cname run)" "$OUT/logs/resolve.log" "${O[@]}" --network bridge ${REST[@]+"${REST[@]}"} \
    -v "$DS:/app/ds:ro" -v "$OUT:/app/out" "$IMG_ID" npx tsx scripts/research/rv-stages.ts resolve \
    --dataset-dir /app/ds --out-dir /app/out/inputs --expect-manifest-hash "$MANIFEST" || return
  [[ -f "$INPUTS/resolve.json" && -f "$INPUTS/resolutions.json" ]] ||
    die "resolve exited 0 without writing $INPUTS/resolutions.json and its record" || return 1
  recorded_by "$INPUTS/resolve.json" resolve || return 1
  echo
  echo "== $INPUTS/resolutions.json, sha256 $(top_field sha256 "$INPUTS/resolve.json" | tr -d '"'), drafted from Binance REST:"
  cat "$INPUTS/resolutions.json"
  echo
  echo "CONTROLLER CHECKPOINT: review every entry above against the flags in $INPUTS/resolve.json. Run the inputs"
  echo "stage only once they are accepted. Editing the file makes inputs refuse it (its sha256 is recorded)."
}

stage_inputs() {
  need_commit || return 1
  same_run || return 1
  read_hash || return 1
  [[ -f "$INPUTS/resolve.json" && -f "$INPUTS/resolutions.json" ]] ||
    die "no resolve record in $INPUTS: run the resolve stage and review its file first (the controller checkpoint)" || return 1
  recorded_by "$INPUTS/resolve.json" resolve || return 1
  [[ ! -e "$INPUTS/inputs.json" && ! -e "$INPUTS/panel.json.gz" ]] ||
    die "$INPUTS already holds a panel or its record: inputs writes once" || return 1
  rest_env || return 1
  drun "$(cname run)" "$OUT/logs/inputs.log" "${O[@]}" --network bridge ${REST[@]+"${REST[@]}"} \
    -v "$DS:/app/ds:ro" -v "$OUT:/app/out" "$IMG_ID" npx tsx scripts/research/rv-stages.ts inputs \
    --dataset-dir /app/ds --out-dir /app/out/inputs --resolutions /app/out/inputs/resolutions.json \
    --expect-manifest-hash "$MANIFEST" || return
  need_inputs || return 1
  echo "panel recorded in $INPUTS/inputs.json"
}

stage_real() {
  need_commit || return 1
  same_run || return 1
  read_hash || return 1
  need_inputs || return 1
  rm -f "$PART/real.json" || die "cannot remove $PART/real.json" || return 1
  drun "$(cname run)" "$OUT/logs/real.log" "${O[@]}" --network none -v "$OUT:/app/out" "$IMG_ID" \
    npx tsx scripts/research/rv-stages.ts real --inputs-dir /app/out/inputs --expect-manifest-hash "$MANIFEST" \
    --out /app/out/part/real.json || return
  settle "$PART/real.json" "$OUT/real.json"
}

# shard_stage <stage>  the judge's shard jobs of a permutation stage, two at a time, into rv2-out/shards/<stage>/,
# then judge merge, which asserts full coverage of m = 1..M, the seeds and the provenance. The stage before it in the
# order (real before is-mcpt, is-mcpt before wf-mcpt, wf-mcpt before block) must have written its output.
shard_stage() {
  local stage=$1 before
  local -a names
  case "$stage" in
    is-mcpt) before=real ;;
    wf-mcpt) before=is-mcpt ;;
    block) before=wf-mcpt ;;
    *) die "unknown shard stage $stage" || return 1 ;;
  esac
  need_commit || return 1
  same_run || return 1
  read_hash || return 1
  need_inputs || return 1
  [[ -f "$OUT/$before.json" ]] || die "no $OUT/$before.json: run the $before stage first" || return 1
  load_shard_jobs "$stage" || return 1
  mkdir -p "$SHARDS/$stage" || die "cannot create $SHARDS/$stage" || return 1
  run_pool "$stage" "${JOBS[@]}" || return 1
  # shellcheck disable=SC2207
  names=($(job_names "${JOBS[@]}"))
  check_exact "$SHARDS/$stage" jsonl "${names[@]}" || return 1
  rm -f "$PART/$stage.json" || die "cannot remove $PART/$stage.json" || return 1
  judge "$OUT/logs/merge-$stage.txt" merge --stage "$stage" --dir "/app/out/shards/$stage" --inputs-dir /app/out/inputs \
    --expect-manifest-hash "$MANIFEST" --out "/app/out/part/$stage.json" || return
  settle "$PART/$stage.json" "$OUT/$stage.json"
}

stage_is_mcpt() { shard_stage is-mcpt; }
stage_wf_mcpt() { shard_stage wf-mcpt; }
stage_block() { shard_stage block; }

stage_verdict() {
  local f
  need_commit || return 1
  same_run || return 1
  read_hash || return 1
  need_inputs || return 1
  calibration_passed || return 1
  for f in real is-mcpt wf-mcpt block; do
    [[ -f "$OUT/$f.json" ]] || die "no $OUT/$f.json: run the $f stage first" || return 1
  done
  judge "$OUT/dsr.txt" dsr --real /app/out/real.json --inputs-dir /app/out/inputs --expect-manifest-hash "$MANIFEST" ||
    return
  rm -f "$PART/verdict.json" || die "cannot remove $PART/verdict.json" || return 1
  judge "$OUT/verdict.txt" verdict --real /app/out/real.json --is /app/out/is-mcpt.json --wf /app/out/wf-mcpt.json \
    --block /app/out/block.json --shards-dir /app/out/shards --calibration /app/out/calibration.json \
    --calibration-dir /app/out/calibration --inputs-dir /app/out/inputs --expect-manifest-hash "$MANIFEST" \
    --out /app/out/part/verdict.json || return
  settle "$PART/verdict.json" "$OUT/verdict.json"
}

# ---- dispatch ----------------------------------------------------------------------------------------------------
#
# One block, which bash reads whole before it runs any of it: the script runs from the checkout it builds, and a
# change to this file during a stage must not change what the stage does after the stage function returns.

{
  STAGES='build|calibrate|export|resolve|inputs|real|is-mcpt|wf-mcpt|block|verdict'
  STAGE=${1:-}
  [[ $# -gt 0 ]] && shift
  case "$STAGE" in
    build | calibrate | export | resolve | inputs | real | is-mcpt | wf-mcpt | block | verdict) ;;
    *)
      echo "usage: $0 $STAGES" >&2
      exit 64
      ;;
  esac
  if [[ $# -gt 0 ]]; then
    echo "usage: $0 $STAGE (stages take no arguments, got: $*)" >&2
    exit 64
  fi

  if ! mkdir -p "$OUT/logs" "$PART"; then
    echo "ERROR: cannot create $OUT/logs and $PART" >&2
    exit 1
  fi
  trap 'on_signal INT 130' INT
  trap 'on_signal TERM 143' TERM
  trap 'on_signal HUP 129' HUP
  lock
  log "stage $STAGE start"
  "stage_${STAGE//-/_}"
  RC=$?
  finish "$RC"
  exit "$RC"
}
