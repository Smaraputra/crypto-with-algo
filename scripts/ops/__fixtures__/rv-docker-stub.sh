#!/bin/bash
# Stand-in for docker in scripts/ops/rv-revalidation-run.test.ts. It records every call in $HOME/docker.log (the
# arguments joined by the unit separator, one call per line), answers `image inspect` from $HOME/stub/label, and for
# `run` writes what the real container would write, at the host path its -v mounts map to. It refuses (exit 125) a
# run argument it does not know and an image that is not an ID, so the runner cannot run by tag unnoticed.
# Container starts and ends go to $HOME/events.log, so the test can count the containers alive at once.
#   STUB_CAL=fail      check-calibration writes a FAIL record and exits 2
#   STUB_FAIL=<name>   the container with that --name exits 1 before writing anything
#   STUB_FAIL_AFTER=<name>   the container with that --name writes its output, then exits 1
#   STUB_SLEEP=<s>     shard containers sleep this long, so two of them overlap
line=$(printf '%s\037' "$@")
printf '%s\n' "$line" >> "$HOME/docker.log"

case "${1:-}" in
  image)
    case "$*" in
      *Labels*) cat "$HOME/stub/label" ;;
      *) echo sha256:stub ;;
    esac
    exit 0
    ;;
  run) shift ;;
  *) exit 0 ;;
esac

name=
commit=
hosts=()
ctrs=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) name=$2 && shift 2 ;;
    -e)
      if [[ "$2" == GIT_COMMIT=* ]]; then commit=${2#GIT_COMMIT=}; fi
      shift 2
      ;;
    -v)
      hosts+=("${2%%:*}")
      rest=${2#*:}
      ctrs+=("${rest%%:*}")
      shift 2
      ;;
    --cpu-shares | --memory | --network | --env-file) shift 2 ;;
    --rm) shift ;;
    sha256:*) shift && break ;;
    *)
      echo "stub docker: unexpected run argument '$1'" >&2
      exit 125
      ;;
  esac
done

# host <container path>  the host path of the longest mount holding it
host() {
  local p=$1 i best=-1 blen=-1 c
  for ((i = 0; i < ${#ctrs[@]}; i++)); do
    c=${ctrs[$i]}
    if [[ ("$p" == "$c" || "$p" == "$c"/*) && ${#c} -gt $blen ]]; then
      best=$i
      blen=${#c}
    fi
  done
  if [[ $best -lt 0 ]]; then
    echo "stub docker: $p is not under a mount" >&2
    return 1
  fi
  echo "${hosts[$best]}${p#"${ctrs[$best]}"}"
}

# arg <flag> <args...>  the value after <flag>
arg() {
  local k=$1
  shift
  while [[ $# -gt 1 ]]; do
    if [[ "$1" == "$k" ]]; then
      echo "$2"
      return 0
    fi
    shift
  done
  return 1
}

end() {
  echo "end $name" >> "$HOME/events.log"
  exit "$1"
}

echo "start $name" >> "$HOME/events.log"
if [[ -n "${STUB_FAIL:-}" && "$name" == "$STUB_FAIL" ]]; then end 1; fi
if [[ "${1:-} ${2:-}" != "npx tsx" ]]; then
  echo "stub docker: '$*' is not an npx tsx command" >&2
  end 125
fi
script=$3
shift 3
HEX=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
DATASET=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd

case "$script" in
  scripts/research/export-dataset.ts)
    out=$(host "$(arg --out "$@")") || end 125
    mkdir -p "$out"
    printf '{\n  "version": 1,\n  "datasetHash": "%s"\n}\n' "$DATASET" > "$out/manifest.json"
    ;;
  scripts/research/rv-stages.ts | scripts/research/rv-judge.ts)
    mode=$1
    case "$mode" in
      jobs) cat "$HOME/stub/jobs-$2.txt" ;;
      calibrate | shard | real | merge)
        if [[ "$mode" == shard && -n "${STUB_SLEEP:-}" ]]; then sleep "$STUB_SLEEP"; fi
        out=$(host "$(arg --out "$@")") || end 125
        printf '{"stage":"%s","name":"%s","gitCommit":"%s"}\n' "$mode" "$(arg --name "$@")" "$commit" > "$out"
        ;;
      check-calibration)
        out=$(host "$(arg --out "$@")") || end 125
        pass=true
        if [[ "${STUB_CAL:-}" == fail ]]; then pass=false; fi
        printf '{\n  "gitCommit": "%s",\n  "universes": [\n    {\n      "pass": true\n    }\n  ],\n  "pass": %s,\n  "timing": {}\n}\n' \
          "$commit" "$pass" > "$out"
        echo "CALIBRATION $pass"
        if [[ "$pass" == false ]]; then end 2; fi
        ;;
      resolve)
        dir=$(host "$(arg --out-dir "$@")") || end 125
        mkdir -p "$dir"
        printf '[\n  {"symbol":"SOLUSDT","t":1668045600000,"kind":"no-event"}\n]\n' > "$dir/resolutions.json"
        printf '{\n  "stage": "resolve",\n  "version": 1,\n  "manifestHash": "%s",\n  "gitCommit": "%s",\n  "sha256": "%s",\n  "entries": 1\n}\n' \
          "$(arg --expect-manifest-hash "$@")" "$commit" "$HEX" > "$dir/resolve.json"
        ;;
      inputs)
        dir=$(host "$(arg --out-dir "$@")") || end 125
        printf 'panel' > "$dir/panel.json.gz"
        printf '{\n  "stage": "inputs",\n  "version": 1,\n  "manifestHash": "%s",\n  "panelSha256": "%s",\n  "gitCommit": "%s"\n}\n' \
          "$(arg --expect-manifest-hash "$@")" "$HEX" "$commit" > "$dir/inputs.json"
        ;;
      dsr) echo "G3: DSR 0.5000 at N = 672 (fail)" ;;
      verdict)
        out=$(host "$(arg --out "$@")") || end 125
        printf '{\n  "pass": false\n}\n' > "$out"
        echo "VERDICT FAIL"
        ;;
      *)
        echo "stub docker: unknown mode $mode" >&2
        end 125
        ;;
    esac
    ;;
  *)
    echo "stub docker: unknown script $script" >&2
    end 125
    ;;
esac
if [[ -n "${STUB_FAIL_AFTER:-}" && "$name" == "$STUB_FAIL_AFTER" ]]; then end 1; fi
end 0
