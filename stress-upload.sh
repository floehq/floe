#!/usr/bin/env bash
set -euo pipefail

# =========================================================
# Floe concurrent upload stress runner
# =========================================================
# Edit these knobs as needed.
VIDEO_DIR="${VIDEO_DIR:-/home/tejas/Videos/sample}"
FILE_START="${FILE_START:-30}"
FILE_END="${FILE_END:-59}"
TOTAL_REQUESTS="${TOTAL_REQUESTS:-150}"
CONCURRENCY="${CONCURRENCY:-150}"

# Upload tuning passed to floe-upload.sh
UPLOAD_PARALLEL="${UPLOAD_PARALLEL:-1}"
UPLOAD_EPOCHS="${UPLOAD_EPOCHS:-8}"
UPLOAD_CHUNK_MB="${UPLOAD_CHUNK_MB:-20}"
API_BASE="${API_BASE:-http://localhost:3001/v1/uploads}"
AUTH_API_KEY="${AUTH_API_KEY:-}"
AUTH_BEARER_TOKEN="${AUTH_BEARER_TOKEN:-}"
AUTH_USER="${AUTH_USER:-}"
AUTH_WALLET_ADDRESS="${AUTH_WALLET_ADDRESS:-}"
AUTH_OWNER_ADDRESS="${AUTH_OWNER_ADDRESS:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UPLOADER="${UPLOADER:-$SCRIPT_DIR/floe-upload.sh}"

if [[ ! -x "$UPLOADER" ]]; then
  echo "Uploader not found or not executable: $UPLOADER" >&2
  exit 1
fi

if ! [[ "$FILE_START" =~ ^[0-9]+$ && "$FILE_END" =~ ^[0-9]+$ && "$TOTAL_REQUESTS" =~ ^[0-9]+$ && "$CONCURRENCY" =~ ^[0-9]+$ ]]; then
  echo "FILE_START, FILE_END, TOTAL_REQUESTS, and CONCURRENCY must be integers." >&2
  exit 1
fi

if (( FILE_END < FILE_START )); then
  echo "FILE_END must be >= FILE_START" >&2
  exit 1
fi

if (( TOTAL_REQUESTS <= 0 || CONCURRENCY <= 0 )); then
  echo "TOTAL_REQUESTS and CONCURRENCY must be > 0" >&2
  exit 1
fi

FILES=()
for ((n=FILE_START; n<=FILE_END; n++)); do
  f="$VIDEO_DIR/$n.mp4"
  if [[ -f "$f" ]]; then
    FILES+=("$f")
  else
    echo "Missing file: $f" >&2
    exit 1
  fi
done

FILE_COUNT="${#FILES[@]}"
if (( FILE_COUNT == 0 )); then
  echo "No files found in range." >&2
  exit 1
fi

RUN_ID="$(date +%Y%m%d_%H%M%S)_$$"
WORK_DIR="${TMPDIR:-/tmp}/floe_stress_${RUN_ID}"
STATE_DIR="$WORK_DIR/state"
LOG_DIR="$WORK_DIR/logs"
mkdir -p "$STATE_DIR" "$LOG_DIR"

SUCCESS=0
FAIL=0

echo "Starting stress run"
echo "RUN_ID=$RUN_ID"
echo "VIDEO_DIR=$VIDEO_DIR"
echo "FILES=${FILE_START}.mp4..${FILE_END}.mp4 ($FILE_COUNT files)"
echo "TOTAL_REQUESTS=$TOTAL_REQUESTS"
echo "CONCURRENCY=$CONCURRENCY"
echo "API_BASE=$API_BASE"
if [[ -n "$AUTH_API_KEY" || -n "$AUTH_BEARER_TOKEN" || -n "$AUTH_USER" || -n "$AUTH_WALLET_ADDRESS" || -n "$AUTH_OWNER_ADDRESS" ]]; then
  echo "AUTH=enabled"
else
  echo "AUTH=public"
fi
echo "Logs: $LOG_DIR"

do_upload() {
  local req_id="$1"
  local idx="$2"
  local file="${FILES[$(( idx % FILE_COUNT ))]}"
  local state_file="$STATE_DIR/req_${req_id}.json"
  local out_log="$LOG_DIR/req_${req_id}.out.log"
  local err_log="$LOG_DIR/req_${req_id}.err.log"
  local -a auth_args=()

  if [[ -n "$AUTH_API_KEY" ]]; then
    auth_args+=(--api-key "$AUTH_API_KEY")
  fi
  if [[ -n "$AUTH_BEARER_TOKEN" ]]; then
    auth_args+=(--bearer "$AUTH_BEARER_TOKEN")
  fi
  if [[ -n "$AUTH_USER" ]]; then
    auth_args+=(--auth-user "$AUTH_USER")
  fi
  if [[ -n "$AUTH_WALLET_ADDRESS" ]]; then
    auth_args+=(--wallet "$AUTH_WALLET_ADDRESS")
  fi
  if [[ -n "$AUTH_OWNER_ADDRESS" ]]; then
    auth_args+=(--owner "$AUTH_OWNER_ADDRESS")
  fi

  if "$UPLOADER" "$file" \
    --api "$API_BASE" \
    --state "$state_file" \
    --keep-state \
    -p "$UPLOAD_PARALLEL" \
    -e "$UPLOAD_EPOCHS" \
    -c "$UPLOAD_CHUNK_MB" \
    "${auth_args[@]}" \
    >"$out_log" 2>"$err_log"; then
    return 0
  fi

  return 1
}

for ((i=0; i<TOTAL_REQUESTS; i++)); do
  (
    if do_upload "$i" "$i"; then
      exit 0
    else
      exit 1
    fi
  ) &

  while (( $(jobs -rp | wc -l) >= CONCURRENCY )); do
    if wait -n; then
      ((SUCCESS++)) || true
    else
      ((FAIL++)) || true
    fi
  done
done

while (( $(jobs -rp | wc -l) > 0 )); do
  if wait -n; then
    ((SUCCESS++)) || true
  else
    ((FAIL++)) || true
  fi
done

echo ""
echo "Completed stress run"
echo "SUCCESS=$SUCCESS"
echo "FAIL=$FAIL"
echo "WORK_DIR=$WORK_DIR"

if (( FAIL > 0 )); then
  echo "Some uploads failed. Check logs in: $LOG_DIR" >&2
  exit 1
fi
