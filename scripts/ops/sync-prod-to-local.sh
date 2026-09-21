#!/usr/bin/env bash
#
# Streams collections from the production Mongo (crypto-mongodb, database
# cryptowithalgo, run via docker-compose.server.yml on the VPS) into a local
# Mongo for research, one collection at a time, with no intermediate file.
#
# Each collection is restored with mongorestore --drop, which wipes the
# same-named collection at the target (LOCAL_DB, or the database in
# LOCAL_MONGO_URI/LOCAL_MONGO_CONTAINER) before writing the restored data.
# For that reason a real (non---dry-run) sync refuses to run unless
# LOCAL_MONGO_URI points at localhost/127.0.0.1, or FORCE_REMOTE_LOCAL=1 is
# set, so a misconfigured URI cannot silently drop collections on some other
# host.
#
# Usage:
#   scripts/ops/sync-prod-to-local.sh [--dry-run]
#
# Requires: an SSH alias to the VPS (default "contabo") that can run docker
# on the host, and either the mongodb-database-tools (mongorestore) on this
# machine or a local Mongo container named via LOCAL_MONGO_CONTAINER.
#
# Env vars (all optional, shown with their default):
#   PROD_SSH_HOST=contabo
#   PROD_MONGO_CONTAINER=crypto-mongodb
#   PROD_DB=cryptowithalgo
#   LOCAL_DB=cryptowithalgo
#   LOCAL_MONGO_URI=mongodb://localhost:27017
#   LOCAL_MONGO_CONTAINER=            (unset: use a local mongorestore binary;
#                                       set: restore via `docker exec -i` into
#                                       that container instead)
#   FORCE_REMOTE_LOCAL=               (set to 1 to allow a real sync when
#                                       LOCAL_MONGO_URI is not localhost/127.0.0.1)
#   COLLECTIONS="candles historicalsnapshots globalsignals signaltemplates optimizationjobs backtestresultv2 cronruns signaloutcomes"
set -euo pipefail

PROD_SSH_HOST="${PROD_SSH_HOST:-contabo}"
PROD_MONGO_CONTAINER="${PROD_MONGO_CONTAINER:-crypto-mongodb}"
PROD_DB="${PROD_DB:-cryptowithalgo}"
LOCAL_DB="${LOCAL_DB:-cryptowithalgo}"
LOCAL_MONGO_URI="${LOCAL_MONGO_URI:-mongodb://localhost:27017}"
LOCAL_MONGO_CONTAINER="${LOCAL_MONGO_CONTAINER:-}"
# Mongoose's default pluralization of each model name (verified against
# src/lib/models/*.ts): BacktestResultV2 -> "backtestresultv2", with no
# trailing "s", because mongoose's pluralizer does not add a suffix to a
# word ending in a digit; SignalOutcome -> "signaloutcomes", a regular
# pluralization. Every other model here pluralizes as expected. Without
# signaloutcomes in this list, a synced local database has no outcome rows
# and scripts/ops/live-outcomes.ts --mongo-uri ... prints zeros locally.
# perpcandles and futuresmetrics carry the Binance archive history that
# scripts/ops/ingest-archive.ts writes; research reads both from the local
# copy, so leaving them out would make an exported dataset silently thinner
# than production.
COLLECTIONS="${COLLECTIONS:-candles historicalsnapshots globalsignals signaltemplates optimizationjobs backtestresultv2 cronruns signaloutcomes perpcandles futuresmetrics}"

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=true
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# The payload for the container's `sh -c`. $MONGO_INITDB_ROOT_USERNAME and
# $MONGO_INITDB_ROOT_PASSWORD are left as literal variable references (single
# quotes below protect them from expansion on the laptop and on the SSH
# host); they are only expanded by the shell that finally runs this string,
# which is the one `docker exec` starts inside crypto-mongodb, reading its
# own environment. $1 elides those two values for the --dry-run printout.
build_dump_payload() {
  local coll="$1" elide="$2" user_pass
  if [[ "$elide" == "true" ]]; then
    user_pass='-u <elided> -p <elided>'
  else
    user_pass='-u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD"'
  fi
  printf 'mongodump --quiet --archive --gzip %s --authenticationDatabase admin --db %s --collection %s' \
    "$user_pass" "$PROD_DB" "$coll"
}

# The full remote command handed to `ssh`. docker exec's sh -c argument must
# reach the SSH host as a single shell-quoted token, since ssh flattens its
# trailing arguments into one string and re-parses it with the remote shell
# before docker exec ever sees it.
build_ssh_cmd() {
  local coll="$1" elide="$2"
  printf 'docker exec %s sh -c '\''%s'\''' "$PROD_MONGO_CONTAINER" "$(build_dump_payload "$coll" "$elide")"
}

# Human-readable form of the restore side, for the --dry-run printout only.
describe_restore_cmd() {
  local coll="$1"
  if [[ -n "$LOCAL_MONGO_CONTAINER" ]]; then
    printf 'docker exec -i %s mongorestore --quiet --archive --gzip --drop --nsInclude "%s.%s" --nsFrom "%s.*" --nsTo "%s.*"' \
      "$LOCAL_MONGO_CONTAINER" "$PROD_DB" "$coll" "$PROD_DB" "$LOCAL_DB"
  else
    printf 'mongorestore --quiet --archive --gzip --drop --nsInclude "%s.%s" --nsFrom "%s.*" --nsTo "%s.*" --uri "%s"' \
      "$PROD_DB" "$coll" "$PROD_DB" "$LOCAL_DB" "$LOCAL_MONGO_URI"
  fi
}

# The actual restore side, run as a function on the right of a pipe so no
# eval or intermediate string re-parsing is needed.
run_restore() {
  local coll="$1"
  if [[ -n "$LOCAL_MONGO_CONTAINER" ]]; then
    docker exec -i "$LOCAL_MONGO_CONTAINER" mongorestore --quiet --archive --gzip --drop \
      --nsInclude "$PROD_DB.$coll" --nsFrom "$PROD_DB.*" --nsTo "$LOCAL_DB.*"
  else
    mongorestore --quiet --archive --gzip --drop \
      --nsInclude "$PROD_DB.$coll" --nsFrom "$PROD_DB.*" --nsTo "$LOCAL_DB.*" --uri "$LOCAL_MONGO_URI"
  fi
}

# --dry-run only ever previews the pipelines: no tool check, no host contact.
if [[ "$DRY_RUN" == "true" ]]; then
  for coll in $COLLECTIONS; do
    echo "-- $coll --"
    echo "ssh -n \"$PROD_SSH_HOST\" $(build_ssh_cmd "$coll" true) \\"
    echo "  | $(describe_restore_cmd "$coll")"
  done
  exit 0
fi

if [[ -z "$LOCAL_MONGO_CONTAINER" ]] && ! command -v mongorestore >/dev/null 2>&1; then
  echo "install with: brew install mongodb-database-tools"
  exit 2
fi

# Every restore below runs --drop, which wipes the same-named collection at
# the target first. Refuse a real run against a non-local LOCAL_MONGO_URI so
# a misconfigured URI cannot silently drop collections on some other host.
is_local_uri() {
  local rest="${1#mongodb://}"
  rest="${rest#mongodb+srv://}"
  rest="${rest#*@}"
  local host="${rest%%[:/?]*}"
  [[ "$host" == "localhost" || "$host" == "127.0.0.1" ]]
}

if ! is_local_uri "$LOCAL_MONGO_URI" && [[ "${FORCE_REMOTE_LOCAL:-}" != "1" ]]; then
  echo "Refusing to run: LOCAL_MONGO_URI ($LOCAL_MONGO_URI) is not localhost or 127.0.0.1, and every collection is restored with --drop. Set FORCE_REMOTE_LOCAL=1 to override." >&2
  exit 2
fi

synced=0
failed=()

for coll in $COLLECTIONS; do
  echo "[$coll] starting"
  ssh_cmd="$(build_ssh_cmd "$coll" false)"

  if ssh -n "$PROD_SSH_HOST" "$ssh_cmd" | run_restore "$coll"; then
    echo "[$coll] done"
    synced=$((synced + 1))
  else
    echo "[$coll] failed" >&2
    failed+=("$coll")
  fi
done

echo "Synced $synced/$(echo "$COLLECTIONS" | wc -w | tr -d ' ') collections from $PROD_DB to $LOCAL_DB"
if [[ ${#failed[@]} -gt 0 ]]; then
  echo "Failed: ${failed[*]}" >&2
  exit 1
fi
