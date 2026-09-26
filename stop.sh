#!/bin/bash

# Stop every process owned by a lofAI run. Service pid files describe isolated
# process groups, not just wrapper processes, so descendants are included even
# after their parent exits or Next.js renames them.

set -u

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
STATE_DIR="${LOFAI_STATE_DIR:-$SCRIPT_DIR}"
TERM_TIMEOUT="${LOFAI_STOP_TIMEOUT:-10}"
KILL_TIMEOUT="${LOFAI_KILL_TIMEOUT:-3}"
QUIET=0
CHILDREN_ONLY=0

for argument in "$@"; do
    case "$argument" in
        --quiet) QUIET=1 ;;
        --children) CHILDREN_ONLY=1 ;;
        *) echo "Usage: $0 [--quiet] [--children]" >&2; exit 2 ;;
    esac
done

if ! [[ "$TERM_TIMEOUT" =~ ^(0|[1-9][0-9]*)$ ]] || \
   ! [[ "$KILL_TIMEOUT" =~ ^(0|[1-9][0-9]*)$ ]]; then
    echo "Shutdown timeouts must be canonical whole seconds." >&2
    exit 2
fi

log() {
    if [ "$QUIET" -eq 0 ]; then
        echo "$*"
    fi
}

process_started_at() {
    ps -o lstart= -p "$1" 2>/dev/null | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

process_group_of() {
    ps -o pgid= -p "$1" 2>/dev/null | tr -d '[:space:]'
}

pid_is_live() {
    ps -o state= -p "$1" 2>/dev/null | awk 'NF && $1 !~ /^Z/ { found=1 } END { exit !found }'
}

group_is_live() {
    ps -axo pgid=,state= 2>/dev/null | awk -v wanted="$1" \
        '$1 == wanted && $2 !~ /^Z/ { found=1 } END { exit !found }'
}

target_is_live() {
    local mode="$1"
    local pid="$2"
    if [ "$mode" = "group" ]; then
        group_is_live "$pid"
    else
        pid_is_live "$pid"
    fi
}

recorded_target_is_live() {
    local mode="$1"
    local pid="$2"
    local started="$3"
    local current_started

    if pid_is_live "$pid"; then
        current_started="$(process_started_at "$pid")"
        [ "$current_started" = "$started" ] || return 1
    fi
    target_is_live "$mode" "$pid"
}

remove_if_unchanged() {
    local file="$1"
    local expected="$2"
    local current=""
    [ -f "$file" ] || return 0
    current="$(< "$file")"
    if [ "$current" = "$expected" ]; then
        rm -f "$file"
    fi
}

signal_target() {
    local signal="$1"
    local mode="$2"
    local pid="$3"
    if [ "$mode" = "group" ]; then
        kill -"$signal" -- "-$pid" 2>/dev/null || true
        # Also covers the tiny launch window before the child calls setsid().
        kill -"$signal" "$pid" 2>/dev/null || true
    else
        kill -"$signal" "$pid" 2>/dev/null || true
    fi
}

TARGET_MODES=()
TARGET_PIDS=()
TARGET_FILES=()
TARGET_NAMES=()
TARGET_STARTED=()
TARGET_RECORDS=()

add_target() {
    local file="$1"
    local name="$2"
    local mode=""
    local pid=""
    local started=""
    local owner=""
    local extra=""
    local current_started
    local current_group
    local record

    [ -f "$file" ] || return 0
    record="$(< "$file")"
    IFS='|' read -r mode pid started owner extra <<< "$record" || true

    if [ -n "$extra" ] || { [ "$mode" != "pid" ] && [ "$mode" != "group" ]; } || \
       ! [[ "$pid" =~ ^[0-9]+$ ]] || [ "$pid" -le 1 ] || \
       [ -z "$started" ] || [ "$owner" != "$SCRIPT_DIR" ]; then
        log "Ignoring invalid $name process metadata."
        remove_if_unchanged "$file" "$record"
        return 0
    fi

    # A stale PID must never be allowed to target a newer, unrelated process.
    # If the original group leader is gone but descendants remain, no process
    # can reuse that PGID yet, so the recorded group is still safe to stop.
    if pid_is_live "$pid"; then
        current_started="$(process_started_at "$pid")"
        if [ "$current_started" != "$started" ]; then
            log "Ignoring stale $name PID $pid (it has been reused)."
            remove_if_unchanged "$file" "$record"
            return 0
        fi
        if [ "$mode" = "group" ]; then
            current_group="$(process_group_of "$pid")"
            if [ "$current_group" != "$pid" ]; then
                log "Ignoring stale $name PID $pid (it no longer leads its group)."
                remove_if_unchanged "$file" "$record"
                return 0
            fi
        fi
    elif ! target_is_live "$mode" "$pid"; then
        remove_if_unchanged "$file" "$record"
        return 0
    fi

    TARGET_MODES+=("$mode")
    TARGET_PIDS+=("$pid")
    TARGET_FILES+=("$file")
    TARGET_NAMES+=("$name")
    TARGET_STARTED+=("$started")
    TARGET_RECORDS+=("$record")
}

add_discovered_pid() {
    local pid="$1"
    local name="$2"
    local started
    local existing

    if [ "${#TARGET_PIDS[@]}" -gt 0 ]; then
        for existing in "${TARGET_PIDS[@]}"; do
            [ "$existing" = "$pid" ] && return 0
        done
    fi
    started="$(process_started_at "$pid")"
    [ -n "$started" ] || return 0

    TARGET_MODES+=("pid")
    TARGET_PIDS+=("$pid")
    TARGET_FILES+=("")
    TARGET_NAMES+=("$name")
    TARGET_STARTED+=("$started")
    TARGET_RECORDS+=("")
}

discover_project_processes() {
    local directory="$1"
    local kind="$2"
    local pid
    local comm
    local command
    local matched

    command -v lsof >/dev/null 2>&1 || return 0
    [ -d "$directory" ] || return 0

    # PID files are the authority for normal shutdown. This recovery pass is
    # deliberately narrow: it only adopts known lofAI server/worker commands
    # whose current working directory is this checkout. It catches framework
    # workers orphaned by an older launcher or an interrupted Next.js build
    # without falling back to a machine-wide pkill pattern.
    while IFS= read -r pid; do
        [[ "$pid" =~ ^[0-9]+$ ]] || continue
        [ "$pid" -gt 1 ] || continue
        comm="$(ps -o comm= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')"
        command="$(ps -o command= -p "$pid" 2>/dev/null | sed 's/^[[:space:]]*//')"
        matched=0

        if [ "$kind" = "frontend" ]; then
            case "$comm" in
                next-*|next-server) matched=1 ;;
            esac
            case "$command" in
                *"/node_modules/.bin/next "*|*"/next/dist/compiled/jest-worker/processChild.js"*|*"npm run dev"*|*"npm run start"*|*"npm run build"*|*"static_server.py --port "*)
                    matched=1
                    ;;
            esac
        else
            case "$command" in
                *"uvicorn server:app"*|*"/backend/server.py"*|*"python server.py"*)
                    matched=1
                    ;;
            esac
        fi

        if [ "$matched" -eq 1 ]; then
            add_discovered_pid "$pid" "untracked $kind worker"
        fi
    done < <(lsof -nP -t -a -d cwd +d "$directory" 2>/dev/null | sort -u)
}

if [ "$CHILDREN_ONLY" -eq 0 ]; then
    add_target "$STATE_DIR/.lofai.lock" "application supervisor"
    # Read the pre-lock filename during migration from older launchers.
    add_target "$STATE_DIR/application.pid" "application supervisor"
    add_target "$STATE_DIR/logs.pid" "log follower"
fi
add_target "$STATE_DIR/frontend.pid" "frontend"
add_target "$STATE_DIR/backend.pid" "backend"

# Custom state directories are used by the process-level test harness and may
# represent another checkout. Only sweep this checkout by default when it is
# also the requested state owner; callers can explicitly opt in if needed.
if [ "$STATE_DIR" = "$SCRIPT_DIR" ] || [ "${LOFAI_RECOVER_ORPHANS:-0}" = "1" ]; then
    discover_project_processes "$SCRIPT_DIR/frontend" "frontend"
    discover_project_processes "$SCRIPT_DIR/backend" "backend"
fi

if [ "${#TARGET_PIDS[@]}" -eq 0 ]; then
    log "lofAI is already stopped."
    exit 0
fi

log "Stopping lofAI Application..."

for index in "${!TARGET_PIDS[@]}"; do
    if recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
        log "Stopping ${TARGET_NAMES[$index]} (${TARGET_MODES[$index]} ${TARGET_PIDS[$index]})..."
        signal_target TERM "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}"
    fi
done

deadline=$(( $(date +%s) + TERM_TIMEOUT ))
while :; do
    remaining=0
    for index in "${!TARGET_PIDS[@]}"; do
        if recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
            remaining=1
            break
        fi
    done
    [ "$remaining" -eq 0 ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 0.1
done

for index in "${!TARGET_PIDS[@]}"; do
    if recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
        # The supervisor is inside its EXIT trap waiting for these same
        # services. Give it the KILL window to finish bookkeeping after the
        # service groups are forced down.
        if [ "${TARGET_NAMES[$index]}" = "application supervisor" ]; then
            continue
        fi
        log "${TARGET_NAMES[$index]} did not stop gracefully; forcing it down..."
        signal_target KILL "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}"
    fi
done

deadline=$(( $(date +%s) + KILL_TIMEOUT ))
while :; do
    remaining=0
    for index in "${!TARGET_PIDS[@]}"; do
        if recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
            remaining=1
            break
        fi
    done
    [ "$remaining" -eq 0 ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 0.1
done

# A wedged supervisor must not outlive a completed stop either. By this point
# its service groups have had both the graceful and forced deadlines.
for index in "${!TARGET_PIDS[@]}"; do
    if [ "${TARGET_NAMES[$index]}" = "application supervisor" ] && \
       recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
        log "Application supervisor did not finish cleanup; forcing it down..."
        signal_target KILL "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}"
    fi
done

deadline=$(( $(date +%s) + KILL_TIMEOUT ))
while :; do
    remaining=0
    for index in "${!TARGET_PIDS[@]}"; do
        if recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
            remaining=1
            break
        fi
    done
    [ "$remaining" -eq 0 ] && break
    [ "$(date +%s)" -ge "$deadline" ] && break
    sleep 0.1
done

failed=0
for index in "${!TARGET_PIDS[@]}"; do
    if recorded_target_is_live "${TARGET_MODES[$index]}" "${TARGET_PIDS[$index]}" "${TARGET_STARTED[$index]}"; then
        echo "Error: ${TARGET_NAMES[$index]} is still running (${TARGET_PIDS[$index]})." >&2
        failed=1
    else
        remove_if_unchanged "${TARGET_FILES[$index]}" "${TARGET_RECORDS[$index]}"
    fi
done

if [ "$failed" -ne 0 ]; then
    echo "lofAI shutdown is incomplete; process metadata was kept for another attempt." >&2
    exit 1
fi

log "lofAI stopped completely."
