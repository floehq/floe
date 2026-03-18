#!/bin/bash
set -euo pipefail

export LC_ALL=C

FILE_TO_UPLOAD="${1:-}"
SOURCE_FILE_PATH="$FILE_TO_UPLOAD"
CUSTOM_CHUNK_SIZE_MB=""
EPOCHS=1
PARALLEL_JOBS=1
RESUME_UPLOAD_ID=""
EXPLICIT_RESUME=0
MAX_RETRIES=3
KEEP_STATE=0
AUTO_FASTSTART=0
JSON_OUTPUT="${FLOE_JSON_OUTPUT:-0}"
INTERRUPT_CANCEL_UPLOAD="${FLOE_CANCEL_ON_INTERRUPT:-0}"
STATE_DIR_OVERRIDE=""
STATE_FILE_OVERRIDE=""
API_KEY="${FLOE_API_KEY:-}"
BEARER_TOKEN="${FLOE_BEARER_TOKEN:-}"
AUTH_USER="${FLOE_AUTH_USER:-}"
WALLET_ADDRESS="${FLOE_WALLET_ADDRESS:-}"
OWNER_ADDRESS="${FLOE_OWNER_ADDRESS:-}"
PUBLIC_MAX_FILE_SIZE_BYTES="${FLOE_PUBLIC_MAX_FILE_SIZE_BYTES:-$((100 * 1024 * 1024))}"
AUTH_MAX_FILE_SIZE_BYTES="${FLOE_AUTH_MAX_FILE_SIZE_BYTES:-$((15 * 1024 * 1024 * 1024))}"
GLOBAL_MAX_FILE_SIZE_BYTES="${FLOE_GLOBAL_MAX_FILE_SIZE_BYTES:-$((15 * 1024 * 1024 * 1024))}"

declare -a CURL_AUTH_HEADERS=()

API_BASE="${FLOE_API_BASE:-http://localhost:3001/v1/uploads}"

CURL_CONNECT_TIMEOUT_S="${FLOE_CURL_CONNECT_TIMEOUT_S:-5}"
CURL_MAX_TIME_S="${FLOE_CURL_MAX_TIME_S:-240}"
CURL_RETRY="${FLOE_CURL_RETRY:-3}"
CURL_RETRY_DELAY_S="${FLOE_CURL_RETRY_DELAY_S:-1}"
FINALIZE_MAX_WAIT_S="${FLOE_FINALIZE_MAX_WAIT_S:-3600}"
FINALIZE_POLL_S="${FLOE_FINALIZE_POLL_S:-5}"
FINALIZE_POLL_MAX_S="${FLOE_FINALIZE_POLL_MAX_S:-30}"
FINALIZE_WAIT_S=0

_C_CYAN='\033[38;5;51m'
_C_CYAN2='\033[38;5;38m'
_C_GREEN='\033[38;5;82m'
_C_YELLOW='\033[38;5;220m'
_C_RED='\033[38;5;203m'
_C_BLUE='\033[38;5;75m'
_C_WHITE='\033[38;5;255m'
_C_SILVER='\033[38;5;251m'
_C_MUTED='\033[38;5;240m'
NC='\033[0m'
BOLD='\033[1m'

GREEN="$_C_GREEN"
YELLOW="$_C_YELLOW"
RED="$_C_RED"
CYAN="$_C_CYAN"

IS_TTY=0
if [[ -t 1 && "${TERM:-}" != "dumb" ]]; then
  IS_TTY=1
fi

INTERRUPTED=0
INTERRUPT_REASON=""
PROGRESS_LOCK_DIR=""
UI_FD=1
FINAL_STATE_FILE=""

USE_COLOR=1
if [[ "$IS_TTY" -ne 1 || -n "${NO_COLOR:-}" ]]; then
  USE_COLOR=0
fi

if [[ "$USE_COLOR" -ne 1 ]]; then
  _C_CYAN=''
  _C_CYAN2=''
  _C_GREEN=''
  _C_YELLOW=''
  _C_RED=''
  _C_BLUE=''
  _C_WHITE=''
  _C_SILVER=''
  _C_MUTED=''
  NC=''
  BOLD=''
  GREEN=''
  YELLOW=''
  RED=''
  CYAN=''
fi

if [[ "$JSON_OUTPUT" == "1" ]]; then
  UI_FD=2
fi

ui_printf() {
  printf "$@" >&"$UI_FD"
}

ui_newline() {
  printf '\n' >&"$UI_FD"
}

_tw() {
  if [[ "$IS_TTY" -ne 1 ]]; then
    echo 80
    return
  fi
  local w; w=$(tput cols 2>/dev/null || echo 80)
  (( w < 40 )) && w=40
  echo "$w"
}

_hrule()  { printf '%*s' "$1" '' | tr ' ' '-'; }
_hrule2() { printf '%*s' "$1" '' | tr ' ' '='; }

KEY_COL=16

print_banner() {
  local tw; tw=$(_tw)
  ui_newline
  ui_printf '%b%s%b\n' "$_C_CYAN" "$(_hrule2 "$tw")" "$NC"
  ui_printf '%b  Floe%b\n' "$_C_WHITE$BOLD" "$NC"
  ui_printf '%b  Video infra on walrus%b\n' "$_C_MUTED" "$NC"
  ui_printf '%b%s%b\n\n' "$_C_CYAN" "$(_hrule2 "$tw")" "$NC"
}

print_section() {
  local title; title=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  local tw; tw=$(_tw)
  local label="-- ${title} "
  local fill=$(( tw - ${#label} ))
  (( fill < 1 )) && fill=1
  ui_printf '\n%b%s%b%b%s%b\n' \
    "$_C_CYAN2$BOLD" "$label" "$NC" \
    "$_C_MUTED" "$(_hrule "$fill")" "$NC"
}

print_kv() {
  local key="$1" value="$2"
  ui_printf '   %b%-*s%b  %s\n' "$_C_SILVER" "$KEY_COL" "$key" "$NC" "$value"
}

print_info() { ui_printf '   %b*%b  %s\n'     "$_C_BLUE"         "$NC" "$1";          }
print_ok()   { ui_printf '   %b+%b  %b%s%b\n' "$_C_GREEN$BOLD"   "$NC" "$_C_GREEN"   "$1" "$NC"; }
print_warn() { ui_printf '   %b!%b  %b%s%b\n' "$_C_YELLOW$BOLD"  "$NC" "$_C_YELLOW"  "$1" "$NC"; }
print_err()  { printf '   %b-%b  %b%s%b\n' "$_C_RED$BOLD"     "$NC" "$_C_RED"     "$1" "$NC" >&2; }

render_finalize_progress() {
  [[ "$IS_TTY" -ne 1 ]] && return
  local elapsed="$1"
  local note="${2:-}"
  printf '\r\033[2K   %b*%b  finalizing...  %b%ds elapsed%b' \
    "$_C_BLUE" "$NC" "$_C_MUTED" "$elapsed" "$NC" >&"$UI_FD"
  if [[ -n "$note" ]]; then
    printf '  %b[%s]%b' "$_C_YELLOW" "$note" "$NC" >&"$UI_FD"
  fi
}

render_transfer_progress() {
  [[ "$IS_TTY" -ne 1 ]] && return
  local total="$1" sent="$2" skipped="$3" failed="$4"
  local note="${5:-}"
  local done=$(( sent + skipped + failed ))

  local tw; tw=$(_tw)
  local W=$(( tw - 3 - 2 - 38 ))   # 3=indent, 2=brackets, 38=stats
  (( W < 6 )) && W=6

  local ns=0 nk=0 nf=0 ne=$W
  if (( total > 0 )); then
    ns=$(( sent    * W / total ))
    nk=$(( skipped * W / total ))
    nf=$(( failed  * W / total ))
    ne=$(( W - ns - nk - nf ))
    (( ne < 0 )) && ne=0
  fi
  local pct=0; (( total > 0 )) && pct=$(( done * 100 / total ))

  local sc="$_C_GREEN";  (( sent    == 0 )) && sc="$_C_MUTED"
  local kc="$_C_YELLOW"; (( skipped == 0 )) && kc="$_C_MUTED"
  local fc="$_C_RED";    (( failed  == 0 )) && fc="$_C_MUTED"

  printf '\r\033[2K' >&"$UI_FD"
  printf '   [' >&"$UI_FD"
  local i
  printf '%b' "$_C_GREEN" >&"$UI_FD";  for (( i=0; i<ns; i++ )); do printf '#' >&"$UI_FD"; done
  printf '%b' "$_C_YELLOW" >&"$UI_FD"; for (( i=0; i<nk; i++ )); do printf '+' >&"$UI_FD"; done
  printf '%b' "$_C_RED" >&"$UI_FD";    for (( i=0; i<nf; i++ )); do printf '!' >&"$UI_FD"; done
  printf '%b' "$_C_MUTED" >&"$UI_FD";  for (( i=0; i<ne; i++ )); do printf '.' >&"$UI_FD"; done
  printf '%b]' "$NC" >&"$UI_FD"
  printf '  %b%3d%%%b' "$_C_WHITE$BOLD" "$pct" "$NC" >&"$UI_FD"
  printf '   %b%3d sent%b' "$sc" "$sent"    "$NC" >&"$UI_FD"
  printf '  %b%3d skip%b'  "$kc" "$skipped" "$NC" >&"$UI_FD"
  printf '  %b%3d fail%b'  "$fc" "$failed"  "$NC" >&"$UI_FD"
  if [[ -n "$note" ]]; then
    printf '  %b[%s]%b' "$_C_YELLOW" "$note" "$NC" >&"$UI_FD"
  fi
}

read_progress_counts() {
  local sent=0
  local skipped=0
  local failed=0

  [[ -f "$PROGRESS_SENT_FILE" ]] && read -r sent < "$PROGRESS_SENT_FILE" || true
  [[ -f "$PROGRESS_SKIPPED_FILE" ]] && read -r skipped < "$PROGRESS_SKIPPED_FILE" || true
  [[ -f "$PROGRESS_FAILED_FILE" ]] && read -r failed < "$PROGRESS_FAILED_FILE" || true

  printf '%s %s %s\n' "${sent:-0}" "${skipped:-0}" "${failed:-0}"
}

record_progress_event() {
  local kind="$1"
  local current=0

  while ! mkdir "$PROGRESS_LOCK_DIR" 2>/dev/null; do
    sleep 0.01
  done

  case "$kind" in
    sent)
      [[ -f "$PROGRESS_SENT_FILE" ]] && read -r current < "$PROGRESS_SENT_FILE" || true
      printf '%s\n' "$(( ${current:-0} + 1 ))" > "$PROGRESS_SENT_FILE"
      ;;
    skip)
      [[ -f "$PROGRESS_SKIPPED_FILE" ]] && read -r current < "$PROGRESS_SKIPPED_FILE" || true
      printf '%s\n' "$(( ${current:-0} + 1 ))" > "$PROGRESS_SKIPPED_FILE"
      ;;
    fail)
      [[ -f "$PROGRESS_FAILED_FILE" ]] && read -r current < "$PROGRESS_FAILED_FILE" || true
      printf '%s\n' "$(( ${current:-0} + 1 ))" > "$PROGRESS_FAILED_FILE"
      ;;
  esac

  rmdir "$PROGRESS_LOCK_DIR" 2>/dev/null || true
}

read_transfer_note() {
  if [[ -f "$TRANSFER_NOTE_FILE" ]]; then
    cat "$TRANSFER_NOTE_FILE" 2>/dev/null || true
  fi
}

set_transfer_note() {
  local note="${1:-}"
  [[ -z "${TRANSFER_NOTE_FILE:-}" ]] && return
  printf '%s' "$note" > "$TRANSFER_NOTE_FILE"
}

cancel_active_upload() {
  if [[ -z "${UPLOAD_ID:-}" ]]; then
    return
  fi

  local cancel_resp_file="$TMP_DIR/cancel.resp.json"
  local cancel_http
  cancel_http=$(curl -sS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
    --max-time "$CURL_MAX_TIME_S" \
    --retry 0 \
    -o "$cancel_resp_file" \
    -w "%{http_code}" \
    "${CURL_AUTH_HEADERS[@]}" \
    -X DELETE "$API_BASE/$UPLOAD_ID" 2>/dev/null || true)

  if [[ "$cancel_http" =~ ^2 ]]; then
    print_warn "Upload canceled on server"
  elif [[ "$cancel_http" == "409" ]]; then
    print_warn "Upload is already finalizing; local run interrupted"
  fi
}

handle_interrupt() {
  local signal="${1:-INT}"
  INTERRUPTED=1
  INTERRUPT_REASON="$signal"

  if [[ "$IS_TTY" -eq 1 ]]; then
    printf '\n' >&"$UI_FD"
  fi

  set_transfer_note ""

  while IFS= read -r pid; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done < <(jobs -pr)

  if [[ "$INTERRUPT_CANCEL_UPLOAD" == "1" ]]; then
    cancel_active_upload
  fi

  if [[ -n "${STATE_FILE:-}" && -f "$STATE_FILE" ]]; then
    print_warn "State saved: $STATE_FILE"
  fi
  if [[ "$INTERRUPT_CANCEL_UPLOAD" == "1" ]]; then
    print_warn "Interrupt policy: canceled server upload"
  else
    print_warn "Interrupt policy: preserved upload for resume"
  fi
  print_warn "Interrupted by ${signal}"
  exit 130
}

show_help() {
  print_banner
  cat >&1 <<EOF
Usage: $0 <file> [options]

Options:
  -c, --chunk <mb>      Chunk size in MB (0.25 - 10)
  -e, --epochs <num>    Number of epochs (default: 1)
  -p, --parallel <n>    Parallel uploads (default: 1)
      --resume <id>     Resume an existing uploadId (skips already uploaded chunks)
      --api <url>       Override API base (default: ${API_BASE})
      --state <path>    Override state file path (disables auto state naming)
      --state-dir <dir> Store state files under this directory
      --keep-state      Keep the state file after a successful upload
      --faststart       Rewrite MP4 metadata to the front before upload
      --json            Emit final result as JSON on stdout
      --api-key <key>   Auth header: x-api-key
      --bearer <token>  Auth header: Authorization: Bearer <token>
      --auth-user <id>  Auth header: x-auth-user
      --wallet <addr>   Auth header: x-wallet-address (0x...)
      --owner <addr>    Auth header: x-owner-address (0x...)
  -h, --help            Show help
EOF
  exit 0
}

if [[ -z "$FILE_TO_UPLOAD" || "$FILE_TO_UPLOAD" == "-h" || "$FILE_TO_UPLOAD" == "--help" ]]; then
  show_help
fi

shift
while [[ $# -gt 0 ]]; do
  case $1 in
    -c|--chunk) CUSTOM_CHUNK_SIZE_MB="$2"; shift ;;
    -e|--epochs) EPOCHS="$2"; shift ;;
    -p|--parallel) PARALLEL_JOBS="$2"; shift ;;
    --resume) RESUME_UPLOAD_ID="$2"; EXPLICIT_RESUME=1; shift ;;
    --api) API_BASE="$2"; shift ;;
    --state) STATE_FILE_OVERRIDE="$2"; shift ;;
    --state-dir) STATE_DIR_OVERRIDE="$2"; shift ;;
    --keep-state) KEEP_STATE=1 ;;
    --faststart) AUTO_FASTSTART=1 ;;
    --json) JSON_OUTPUT=1; UI_FD=2 ;;
    --api-key) API_KEY="$2"; shift ;;
    --bearer) BEARER_TOKEN="$2"; shift ;;
    --auth-user) AUTH_USER="$2"; shift ;;
    --wallet) WALLET_ADDRESS="$2"; shift ;;
    --owner) OWNER_ADDRESS="$2"; shift ;;
    -h|--help) show_help ;;
    *) print_err "Unknown option: $1"; exit 1 ;;
  esac
  shift
done

[[ ! -f "$FILE_TO_UPLOAD" ]] && print_err "File not found: $FILE_TO_UPLOAD" && exit 1

if (( BASH_VERSINFO[0] < 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] < 3) )); then
  print_err "Bash 4.3 or newer is required"
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  print_err "jq is required"
  exit 1
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  print_err "sha256sum is required"
  exit 1
fi

if ! [[ "$PARALLEL_JOBS" =~ ^[0-9]+$ ]] || [[ "$PARALLEL_JOBS" -le 0 ]]; then
  print_err "Invalid --parallel value"
  exit 1
fi

if ! [[ "$EPOCHS" =~ ^[0-9]+$ ]] || [[ "$EPOCHS" -le 0 ]]; then
  print_err "Invalid --epochs value"
  exit 1
fi

if ! [[ "$FINALIZE_MAX_WAIT_S" =~ ^[0-9]+$ ]] || [[ "$FINALIZE_MAX_WAIT_S" -le 0 ]]; then
  print_err "Invalid FLOE_FINALIZE_MAX_WAIT_S value"
  exit 1
fi

if ! [[ "$FINALIZE_POLL_S" =~ ^[0-9]+$ ]] || [[ "$FINALIZE_POLL_S" -le 0 ]]; then
  print_err "Invalid FLOE_FINALIZE_POLL_S value"
  exit 1
fi

if ! [[ "$FINALIZE_POLL_MAX_S" =~ ^[0-9]+$ ]] || [[ "$FINALIZE_POLL_MAX_S" -le 0 ]]; then
  print_err "Invalid FLOE_FINALIZE_POLL_MAX_S value"
  exit 1
fi

if [[ "$INTERRUPT_CANCEL_UPLOAD" != "0" && "$INTERRUPT_CANCEL_UPLOAD" != "1" ]]; then
  print_err "Invalid FLOE_CANCEL_ON_INTERRUPT value"
  exit 1
fi

if [[ -n "$WALLET_ADDRESS" ]] && ! [[ "$WALLET_ADDRESS" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
  print_err "Invalid --wallet value (expected 0x + 64 hex chars)"
  exit 1
fi

if [[ -n "$OWNER_ADDRESS" ]] && ! [[ "$OWNER_ADDRESS" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
  print_err "Invalid --owner value (expected 0x + 64 hex chars)"
  exit 1
fi

append_auth_headers() {
  local token="${1:-}"
  if [[ -n "$API_KEY" ]]; then
    CURL_AUTH_HEADERS+=(-H "x-api-key: $API_KEY")
  fi
  if [[ -n "$token" ]]; then
    CURL_AUTH_HEADERS+=(-H "Authorization: Bearer $token")
  fi
  if [[ -n "$AUTH_USER" ]]; then
    CURL_AUTH_HEADERS+=(-H "x-auth-user: $AUTH_USER")
  fi
  if [[ -n "$WALLET_ADDRESS" ]]; then
    CURL_AUTH_HEADERS+=(-H "x-wallet-address: $WALLET_ADDRESS")
  fi
  if [[ -n "$OWNER_ADDRESS" ]]; then
    CURL_AUTH_HEADERS+=(-H "x-owner-address: $OWNER_ADDRESS")
  fi
}

append_auth_headers "$BEARER_TOKEN"

TMP_DIR="$(mktemp -d -t floe-upload-XXXXXX)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT
trap 'handle_interrupt INT' INT
trap 'handle_interrupt TERM' TERM

MP4_LAYOUT_STATE=""
MP4_LAYOUT_NOTE=""
FASTSTART_OUTPUT_PATH=""
FASTSTART_REWRITTEN=0

file_size_bytes() {
  local path="$1"
  stat -c%s "$path" 2>/dev/null || stat -f%z "$path"
}

file_content_type() {
  local path="$1"
  file --mime-type -b "$path" 2>/dev/null || echo "application/octet-stream"
}

is_mp4_input() {
  local path="$1"
  local content_type
  content_type=$(file_content_type "$path")
  [[ "$content_type" == "video/mp4" || "$path" == *.mp4 || "$path" == *.MP4 ]]
}

mp4_faststart_state() {
  local path="$1"
  local first_atom

  if ! command -v ffprobe >/dev/null 2>&1; then
    echo "unknown"
    return
  fi

  first_atom=$(
    ffprobe -v trace -i "$path" -f null - 2>&1 | \
      awk '
        /type:\x27moov\x27/ { print "moov"; exit }
        /type:\x27mdat\x27/ { print "mdat"; exit }
      ' || true
  )

  if [[ -z "$first_atom" ]]; then
    echo "unknown"
    return
  fi

  if [[ "$first_atom" == "moov" ]]; then
    echo "faststart"
  elif [[ "$first_atom" == "mdat" ]]; then
    echo "late_moov"
  else
    echo "unknown"
  fi
}

maybe_prepare_faststart_file() {
  local source_file="$1"

  if ! is_mp4_input "$source_file"; then
    return
  fi

  MP4_LAYOUT_STATE=$(mp4_faststart_state "$source_file")

  case "$MP4_LAYOUT_STATE" in
    faststart)
      MP4_LAYOUT_NOTE="MP4 metadata is front-loaded"
      ;;
    late_moov)
      if [[ "$AUTO_FASTSTART" -eq 0 ]]; then
        MP4_LAYOUT_NOTE="MP4 metadata is near EOF; playback can stall on a cold read"
        return
      fi

      if ! command -v ffmpeg >/dev/null 2>&1; then
        print_err "--faststart requires ffmpeg"
        exit 1
      fi

      FASTSTART_OUTPUT_PATH="$TMP_DIR/$(basename "$SOURCE_FILE_PATH")"
      if ! ffmpeg -hide_banner -loglevel error -y \
        -i "$source_file" \
        -c copy \
        -movflags +faststart \
        "$FASTSTART_OUTPUT_PATH"; then
        print_err "Failed to rewrite MP4 with --faststart"
        exit 1
      fi

      FILE_TO_UPLOAD="$FASTSTART_OUTPUT_PATH"
      FASTSTART_REWRITTEN=1
      MP4_LAYOUT_NOTE="MP4 metadata moved to the front before upload"
      ;;
    *)
      MP4_LAYOUT_NOTE="Unable to verify MP4 metadata placement"
      ;;
  esac
}

maybe_prepare_faststart_file "$FILE_TO_UPLOAD"

FILE_SIZE=$(file_size_bytes "$FILE_TO_UPLOAD")
CONTENT_TYPE=$(file_content_type "$FILE_TO_UPLOAD")

is_authenticated=0
if [[ -n "$API_KEY" || -n "$BEARER_TOKEN" || -n "$AUTH_USER" || -n "$WALLET_ADDRESS" || -n "$OWNER_ADDRESS" ]]; then
  is_authenticated=1
fi

tier_max_file_size="$PUBLIC_MAX_FILE_SIZE_BYTES"
if [[ "$is_authenticated" -eq 1 ]]; then
  tier_max_file_size="$AUTH_MAX_FILE_SIZE_BYTES"
fi

effective_max_file_size="$tier_max_file_size"
if (( GLOBAL_MAX_FILE_SIZE_BYTES < effective_max_file_size )); then
  effective_max_file_size="$GLOBAL_MAX_FILE_SIZE_BYTES"
fi

if (( FILE_SIZE > effective_max_file_size )); then
  print_err "File too large for this auth tier: ${FILE_SIZE} > ${effective_max_file_size} bytes"
  if [[ "$is_authenticated" -eq 0 ]]; then
    print_warn "Use auth headers or tokens to unlock higher limits"
  fi
  exit 1
fi

resolve_abs_path() {
  local p="$1"
  if command -v realpath >/dev/null 2>&1; then
    realpath "$p"
    return
  fi
  if command -v readlink >/dev/null 2>&1; then
    readlink -f "$p" 2>/dev/null || echo "$p"
    return
  fi
  echo "$p"
}

default_state_dir() {
  if [[ -n "${FLOE_STATE_DIR:-}" ]]; then
    echo "$FLOE_STATE_DIR"
    return
  fi
  if [[ -n "${XDG_STATE_HOME:-}" ]]; then
    echo "${XDG_STATE_HOME%/}/floe"
    return
  fi
  echo "${HOME%/}/.local/state/floe"
}

STATE_DIR="$(default_state_dir)"
if [[ -n "$STATE_DIR_OVERRIDE" ]]; then
  STATE_DIR="$STATE_DIR_OVERRIDE"
fi

mkdir -p "$STATE_DIR" 2>/dev/null || true

ABS_FILE_PATH="$(resolve_abs_path "$SOURCE_FILE_PATH")"
SOURCE_FILE_SIZE=$(file_size_bytes "$SOURCE_FILE_PATH")
SOURCE_FILE_MTIME=$(stat -c%Y "$SOURCE_FILE_PATH" 2>/dev/null || stat -f%m "$SOURCE_FILE_PATH")
SOURCE_FILE_SHA256=$(sha256sum "$SOURCE_FILE_PATH" | awk '{print $1}')
STATE_KEY="$(printf '%s' "${ABS_FILE_PATH}|${FILE_SIZE}|${CONTENT_TYPE}|${AUTO_FASTSTART}" | sha256sum | awk '{print $1}')"
DEFAULT_STATE_FILE="${STATE_DIR%/}/$(basename "$SOURCE_FILE_PATH").${STATE_KEY}.floe-upload.json"
STATE_FILE="${STATE_FILE_OVERRIDE:-$DEFAULT_STATE_FILE}"

curl_json() {
  local method="$1"; shift
  local url="$1"; shift
  local data="${1:-}"

  if [[ -n "$data" ]]; then
    curl -sS --fail \
      --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
      --max-time "$CURL_MAX_TIME_S" \
      --retry "$CURL_RETRY" \
      --retry-delay "$CURL_RETRY_DELAY_S" \
      --retry-all-errors \
      -X "$method" "$url" \
      "${CURL_AUTH_HEADERS[@]}" \
      -H "Content-Type: application/json" \
      -d "$data"
  else
    curl -sS --fail \
      --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
      --max-time "$CURL_MAX_TIME_S" \
      --retry "$CURL_RETRY" \
      --retry-delay "$CURL_RETRY_DELAY_S" \
      --retry-all-errors \
      -X "$method" "$url" \
      "${CURL_AUTH_HEADERS[@]}"
  fi
}

print_api_error() {
  local resp_file="$1"
  local http_code="$2"

  local code=""
  local msg=""
  code=$(jq -r '.error.code // empty' "$resp_file" 2>/dev/null || true)
  msg=$(jq -r '.error.message // empty' "$resp_file" 2>/dev/null || true)

  if [[ -n "$code" || -n "$msg" ]]; then
    echo -e "${RED}HTTP ${http_code}${NC} ${code:-ERROR} ${msg}" >&2
  else
    echo -e "${RED}HTTP ${http_code}${NC} $(tr -d '\n' < "$resp_file" | head -c 240)" >&2
  fi
}

maybe_load_state() {
  if [[ -n "$RESUME_UPLOAD_ID" ]]; then
    return
  fi

  if [[ -f "$STATE_FILE" ]]; then
    local saved
    local file_id
    local completed_at
    local saved_file_abs
    local saved_source_file_size
    local saved_file_mtime
    local saved_file_sha256

    saved=$(jq -r '.uploadId // empty' "$STATE_FILE" 2>/dev/null || true)
    file_id=$(jq -r '.fileId // empty' "$STATE_FILE" 2>/dev/null || true)
    completed_at=$(jq -r '.completedAt // empty' "$STATE_FILE" 2>/dev/null || true)

    if [[ -n "$file_id" || -n "$completed_at" ]]; then
      return
    fi

    saved_file_abs=$(jq -r '.fileAbs // empty' "$STATE_FILE" 2>/dev/null || true)
    saved_source_file_size=$(jq -r '.sourceFileSize // empty' "$STATE_FILE" 2>/dev/null || true)
    saved_file_mtime=$(jq -r '.sourceMtime // empty' "$STATE_FILE" 2>/dev/null || true)
    saved_file_sha256=$(jq -r '.sourceSha256 // empty' "$STATE_FILE" 2>/dev/null || true)

    if [[ -n "$saved_file_abs" && "$saved_file_abs" != "$ABS_FILE_PATH" ]]; then
      archive_state "source file path changed"
      return
    fi

    if [[ -n "$saved_source_file_size" && "$saved_source_file_size" != "$SOURCE_FILE_SIZE" ]]; then
      archive_state "source file size changed"
      return
    fi

    if [[ -n "$saved_file_mtime" && "$saved_file_mtime" != "$SOURCE_FILE_MTIME" ]]; then
      archive_state "source file mtime changed"
      return
    fi

    if [[ -n "$saved_file_sha256" && "$saved_file_sha256" != "$SOURCE_FILE_SHA256" ]]; then
      archive_state "source file content changed"
      return
    fi

    if [[ -n "$saved" && "$saved" != "null" ]]; then
      RESUME_UPLOAD_ID="$saved"
      print_warn "Resuming from state file: $STATE_FILE"
      print_kv "Upload ID" "$RESUME_UPLOAD_ID"
    fi
  fi
}

archive_state() {
  local reason="$1"
  if [[ ! -f "$STATE_FILE" ]]; then
    return
  fi
  local ts
  ts=$(date +%s)
  local dst="${STATE_FILE}.stale.${ts}"
  mv "$STATE_FILE" "$dst" 2>/dev/null || return
  print_warn "State archived: $dst"
  print_kv "Reason" "$reason"
}

archive_completed_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    return
  fi
  local ts dst
  ts=$(date +%s)
  dst="${STATE_FILE}.completed.${ts}"
  mv "$STATE_FILE" "$dst" 2>/dev/null || return
  FINAL_STATE_FILE="$dst"
  print_ok "State archived: $dst"
}

save_state() {
  local upload_id="$1"
  local chunk_size="$2"
  local total_chunks="$3"

  mkdir -p "$(dirname "$STATE_FILE")" 2>/dev/null || true

  jq -n \
    --arg uploadId "$upload_id" \
    --arg apiBase "$API_BASE" \
    --arg file "$SOURCE_FILE_PATH" \
    --arg fileAbs "$ABS_FILE_PATH" \
    --arg preparedFile "$FILE_TO_UPLOAD" \
    --arg sourceSha256 "$SOURCE_FILE_SHA256" \
    --arg contentType "$CONTENT_TYPE" \
    --argjson fileSize "$FILE_SIZE" \
    --argjson sourceFileSize "$SOURCE_FILE_SIZE" \
    --argjson sourceMtime "$SOURCE_FILE_MTIME" \
    --argjson chunkSize "$chunk_size" \
    --argjson totalChunks "$total_chunks" \
    --argjson epochs "$EPOCHS" \
    --argjson savedAt "$(date +%s)" \
    '{
      uploadId: $uploadId,
      apiBase: $apiBase,
      file: $file,
      fileAbs: $fileAbs,
      preparedFile: $preparedFile,
      fileSize: $fileSize,
      sourceFileSize: $sourceFileSize,
      sourceMtime: $sourceMtime,
      sourceSha256: $sourceSha256,
      contentType: $contentType,
      chunkSize: $chunkSize,
      totalChunks: $totalChunks,
      epochs: $epochs,
      savedAt: $savedAt
    }' > "$STATE_FILE"
}

chunk_mb_to_bytes() {
  local mb="$1"
  awk -v mb="$mb" 'BEGIN { printf "%.0f", (mb * 1024 * 1024) }'
}

chunk_size_for_index() {
  local idx="$1"
  local offset=$(( idx * CHUNK_SIZE ))
  local remaining=$(( FILE_SIZE - offset ))
  if (( remaining <= 0 )); then
    echo 0
  elif (( remaining < CHUNK_SIZE )); then
    echo "$remaining"
  else
    echo "$CHUNK_SIZE"
  fi
}

materialize_chunk_file() {
  local idx="$1"
  local out_path="$2"
  dd if="$FILE_TO_UPLOAD" of="$out_path" bs="$CHUNK_SIZE" skip="$idx" count=1 iflag=fullblock status=none
}

maybe_load_state

print_banner
if [[ -n "$API_KEY" || -n "$BEARER_TOKEN" || -n "$AUTH_USER" || -n "$WALLET_ADDRESS" || -n "$OWNER_ADDRESS" ]]; then
print_kv "Auth mode" "enabled"
else
  print_kv "Auth mode" "public"
fi
print_kv "API"           "$API_BASE"
print_kv "File"          "$(basename "$SOURCE_FILE_PATH")"
print_kv "Size"          "$(numfmt --to=iec-i "$FILE_SIZE")"
print_kv "Type"          "$CONTENT_TYPE"
print_kv "Epochs"        "$EPOCHS"
print_kv "Parallel"      "$PARALLEL_JOBS"
print_kv "Finalize wait" "${FINALIZE_MAX_WAIT_S}s"

if [[ "$AUTO_FASTSTART" -eq 1 && -n "$FASTSTART_OUTPUT_PATH" ]]; then
  print_kv "Prepared file" "$(basename "$FASTSTART_OUTPUT_PATH")"
  if [[ "$FASTSTART_REWRITTEN" -eq 1 ]]; then
    print_info "Rewrote MP4 metadata to the front for stream-ready playback"
  fi
  print_ok "$MP4_LAYOUT_NOTE"
elif [[ "$MP4_LAYOUT_STATE" == "late_moov" ]]; then
  print_warn "$MP4_LAYOUT_NOTE"
  print_info "Use --faststart to rewrite the file before upload"
elif [[ "$AUTO_FASTSTART" -eq 1 && -n "$MP4_LAYOUT_NOTE" ]]; then
  print_ok "$MP4_LAYOUT_NOTE"
fi

UPLOAD_ID=""
CHUNK_SIZE=""
TOTAL_CHUNKS=""
STATUS_JSON=""
STATUS_VALUE=""
SHOULD_UPLOAD=1

RESUMING=0

if [[ -n "$RESUME_UPLOAD_ID" ]]; then
  print_section "Resume"
  print_info "Fetching upload status for saved session"

  STATUS_FILE="$TMP_DIR/status.resp.json"
  HTTP=$(curl -sS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
    --max-time "$CURL_MAX_TIME_S" \
    --retry "$CURL_RETRY" \
    --retry-delay "$CURL_RETRY_DELAY_S" \
    -o "$STATUS_FILE" \
    -w "%{http_code}" \
    "${CURL_AUTH_HEADERS[@]}" \
    -X GET "$API_BASE/$RESUME_UPLOAD_ID/status" || true)

  if [[ "$HTTP" =~ ^2 ]]; then
    STATUS_JSON=$(cat "$STATUS_FILE")

    UPLOAD_ID="$RESUME_UPLOAD_ID"
    CHUNK_SIZE=$(jq -r '.chunkSize' <<<"$STATUS_JSON")
    TOTAL_CHUNKS=$(jq -r '.totalChunks' <<<"$STATUS_JSON")
    STATUS_VALUE=$(jq -r '.status // empty' <<<"$STATUS_JSON")
    FILE_ID=$(jq -r '.fileId // empty' <<<"$STATUS_JSON")

    if [[ -z "$CHUNK_SIZE" || "$CHUNK_SIZE" == "null" || -z "$TOTAL_CHUNKS" || "$TOTAL_CHUNKS" == "null" ]]; then
      print_err "Invalid status response:"
      echo "$STATUS_JSON" >&2
      exit 1
    fi

    print_ok "Resuming upload $UPLOAD_ID"
    if [[ "$STATUS_VALUE" == "completed" && -n "$FILE_ID" ]]; then
      print_warn "Upload already completed on server; skipping transfer"
      SHOULD_UPLOAD=0
      RESUMING=1
    elif [[ "$STATUS_VALUE" == "finalizing" ]]; then
      print_warn "Upload is already finalizing; skipping transfer"
      SHOULD_UPLOAD=0
      RESUMING=1
    elif [[ "$STATUS_VALUE" == "canceled" || "$STATUS_VALUE" == "failed" || "$STATUS_VALUE" == "expired" ]]; then
      terminal_status="$STATUS_VALUE"
      archive_state "server upload is ${STATUS_VALUE}"
      RESUME_UPLOAD_ID=""
      STATUS_JSON=""
      RESUMING=0
      UPLOAD_ID=""
      CHUNK_SIZE=""
      TOTAL_CHUNKS=""
      STATUS_VALUE=""
      FILE_ID=""
      print_warn "Saved session is no longer resumable; creating a new upload"
      print_kv "Reason" "server status ${terminal_status}"
    else
      RESUMING=1
    fi
  else
    if [[ "$HTTP" == "404" ]]; then
      archive_state "uploadId not found (canceled/expired)"
    else
      archive_state "failed to fetch status (HTTP ${HTTP})"
      print_api_error "$STATUS_FILE" "$HTTP" || true
    fi

    if [[ "$EXPLICIT_RESUME" -eq 1 ]]; then
      print_err "Could not resume uploadId: $RESUME_UPLOAD_ID"
      print_warn "Remove --resume to create a new upload session"
      exit 1
    fi

    RESUME_UPLOAD_ID=""
    STATUS_JSON=""
  fi
fi

if [[ "$RESUMING" -ne 1 ]]; then
  print_section "Create"
  print_info "Opening a fresh Floe upload session"

  chunk_size_json="null"
  if [[ -n "$CUSTOM_CHUNK_SIZE_MB" ]]; then
    chunk_size_json=$(chunk_mb_to_bytes "$CUSTOM_CHUNK_SIZE_MB")
  fi

  JSON=$(jq -n \
    --arg filename "$(basename "$SOURCE_FILE_PATH")" \
    --arg contentType "$CONTENT_TYPE" \
    --argjson sizeBytes "$FILE_SIZE" \
    --argjson epochs "$EPOCHS" \
    --argjson chunkSize "$chunk_size_json" \
    '{
      filename: $filename,
      contentType: $contentType,
      sizeBytes: $sizeBytes,
      epochs: $epochs
    } + (if $chunkSize == null then {} else {chunkSize: $chunkSize} end)')

  RESP=$(curl_json POST "$API_BASE/create" "$JSON" || true)

  if [[ -z "$RESP" ]]; then
    print_err "Session creation failed"
    exit 1
  fi

  UPLOAD_ID=$(jq -r '.uploadId' <<<"$RESP")
  CHUNK_SIZE=$(jq -r '.chunkSize' <<<"$RESP")
  TOTAL_CHUNKS=$(jq -r '.totalChunks' <<<"$RESP")

  [[ -z "$UPLOAD_ID" || "$UPLOAD_ID" == "null" ]] && print_err "Session creation failed" && exit 1
  print_ok "Upload session created"
  print_kv "Upload ID" "$UPLOAD_ID"

  save_state "$UPLOAD_ID" "$CHUNK_SIZE" "$TOTAL_CHUNKS"
  print_kv "State file" "$STATE_FILE"
fi

declare -A RECEIVED
TRANSFER_NOTE_FILE="$TMP_DIR/transfer.note"
PROGRESS_LOCK_DIR="$TMP_DIR/progress.lock"
PROGRESS_SENT_FILE="$TMP_DIR/progress.sent"
PROGRESS_SKIPPED_FILE="$TMP_DIR/progress.skipped"
PROGRESS_FAILED_FILE="$TMP_DIR/progress.failed"
PROGRESS_BYTES_SENT_FILE="$TMP_DIR/progress.bytes.sent"
PROGRESS_BYTES_SKIPPED_FILE="$TMP_DIR/progress.bytes.skipped"
: > "$PROGRESS_SENT_FILE"
: > "$PROGRESS_SKIPPED_FILE"
: > "$PROGRESS_FAILED_FILE"
printf '0\n' > "$PROGRESS_BYTES_SENT_FILE"
printf '0\n' > "$PROGRESS_BYTES_SKIPPED_FILE"
printf '0\n' > "$PROGRESS_SENT_FILE"
printf '0\n' > "$PROGRESS_SKIPPED_FILE"
printf '0\n' > "$PROGRESS_FAILED_FILE"
: > "$TRANSFER_NOTE_FILE"

record_progress_bytes() {
  local file_path="$1"
  local bytes_file="$2"
  local current=0
  local size=0
  size=$(file_size_bytes "$file_path")
  [[ -f "$bytes_file" ]] && read -r current < "$bytes_file" || true
  printf '%s\n' "$(( ${current:-0} + size ))" > "$bytes_file"
}

upload_chunk() {
  local idx="$1"
  local file="$TMP_DIR/chunk-${idx}.${BASHPID}.part"
  local current=0

  if [[ -n "${RECEIVED[$idx]:-}" ]]; then
    local skipped_bytes
    skipped_bytes=$(chunk_size_for_index "$idx")
    record_progress_event "skip"
    while ! mkdir "$PROGRESS_LOCK_DIR" 2>/dev/null; do sleep 0.01; done
    [[ -f "$PROGRESS_BYTES_SKIPPED_FILE" ]] && read -r current < "$PROGRESS_BYTES_SKIPPED_FILE" || true
    printf '%s\n' "$(( ${current:-0} + skipped_bytes ))" > "$PROGRESS_BYTES_SKIPPED_FILE"
    rmdir "$PROGRESS_LOCK_DIR" 2>/dev/null || true
    return 0
  fi

  materialize_chunk_file "$idx" "$file"

  local hash
  hash=$(sha256sum "$file" | awk '{print $1}')

  local resp_file="$TMP_DIR/chunk-$idx.resp.json"

  for ((attempt=1; attempt<=MAX_RETRIES; attempt++)); do
    local http
    http=$(curl -sS \
      --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
      --max-time "$CURL_MAX_TIME_S" \
      --retry "$CURL_RETRY" \
      --retry-delay "$CURL_RETRY_DELAY_S" \
      --retry-all-errors \
      -o "$resp_file" \
      -w "%{http_code}" \
      "${CURL_AUTH_HEADERS[@]}" \
      -X PUT "$API_BASE/$UPLOAD_ID/chunk/$idx" \
      -H "x-chunk-sha256: $hash" \
      -F "chunk=@$file" 2>/dev/null || true)

    if [[ "$http" =~ ^2 ]]; then
      set_transfer_note ""
      record_progress_event "sent"
      while ! mkdir "$PROGRESS_LOCK_DIR" 2>/dev/null; do sleep 0.01; done
      record_progress_bytes "$file" "$PROGRESS_BYTES_SENT_FILE"
      rmdir "$PROGRESS_LOCK_DIR" 2>/dev/null || true
      rm -f "$file" 2>/dev/null || true
      return 0
    fi
    if [[ "$http" == "000" ]]; then
      set_transfer_note "server unreachable, retrying"
    else
      set_transfer_note "retrying chunk upload"
    fi
    sleep "$attempt"
  done

  set_transfer_note ""
  record_progress_event "fail"
  printf '\n' >&2
  print_api_error "$resp_file" "$http"
  print_err "Chunk $idx failed after retries"
  rm -f "$file" 2>/dev/null || true
  return 1
}

if [[ "$SHOULD_UPLOAD" -eq 1 ]]; then
  EXPECTED_TOTAL=$(( (FILE_SIZE + CHUNK_SIZE - 1) / CHUNK_SIZE ))
  if [[ "$EXPECTED_TOTAL" -ne "$TOTAL_CHUNKS" ]]; then
    print_err "Chunk count mismatch: client=$EXPECTED_TOTAL server=$TOTAL_CHUNKS"
    exit 1
  fi

  print_section "Stage"
  print_kv "Chunk size"  "$(numfmt --to=iec-i "$CHUNK_SIZE")"
  print_kv "Chunk count" "$TOTAL_CHUNKS"
  print_info "Prepared upload plan for walrus-bound transfer"

  if [[ -n "$STATUS_JSON" ]]; then
    while IFS= read -r n; do
      RECEIVED["$n"]=1
    done < <(jq -r '.receivedChunks[]?' <<<"$STATUS_JSON" 2>/dev/null || true)
  fi

  print_section "Transfer"
  print_info "Uploading $TOTAL_CHUNKS chunk(s) with parallelism=$PARALLEL_JOBS"
  TRANSFER_STARTED_AT=$(date +%s)
  if [[ "$IS_TTY" -eq 1 ]]; then
    printf '\n' >&"$UI_FD"
  fi

  FAIL=0
  for ((i=0; i<TOTAL_CHUNKS; i++)); do
    if [[ "$INTERRUPTED" -eq 1 ]]; then
      FAIL=1
      break
    fi
    upload_chunk "$i" &

    while [[ $(jobs -r | wc -l) -ge $PARALLEL_JOBS ]]; do
      read -r sent skipped failed < <(read_progress_counts)
      transfer_note=$(read_transfer_note)
      render_transfer_progress "$TOTAL_CHUNKS" "$sent" "$skipped" "$failed" "$transfer_note"
      if ! wait -n; then
        FAIL=1
      fi
    done
  done

  while [[ $(jobs -r | wc -l) -gt 0 ]]; do
    read -r sent skipped failed < <(read_progress_counts)
      transfer_note=$(read_transfer_note)
      render_transfer_progress "$TOTAL_CHUNKS" "$sent" "$skipped" "$failed" "$transfer_note"
      if ! wait -n; then
        FAIL=1
      fi
  done

  read -r sent skipped failed < <(read_progress_counts)
  transfer_note=$(read_transfer_note)
  render_transfer_progress "$TOTAL_CHUNKS" "$sent" "$skipped" "$failed" "$transfer_note"
  TRANSFER_ENDED_AT=$(date +%s)
  if [[ "$IS_TTY" -eq 1 ]]; then
    printf '\n\n' >&"$UI_FD"
  fi

  if [[ $FAIL -ne 0 ]]; then
    print_err "Upload failed"
    print_warn "To resume: $0 \"$SOURCE_FILE_PATH\" --resume $UPLOAD_ID"
    print_warn "State saved: $STATE_FILE"
    exit 1
  fi

  print_ok "All chunks transferred"
else
  print_section "Stage"
  print_kv "Chunk size"  "$(numfmt --to=iec-i "$CHUNK_SIZE")"
  print_kv "Chunk count" "$TOTAL_CHUNKS"
  TRANSFER_STARTED_AT=$(date +%s)
  TRANSFER_ENDED_AT="$TRANSFER_STARTED_AT"
fi

print_section "Finalize"
if [[ "$STATUS_VALUE" == "completed" && -n "$FILE_ID" ]]; then
  print_info "Server already marked this upload completed"
  FINALIZE_STARTED_AT=$(date +%s)
else
  print_info "Requesting Walrus publish and FileMeta completion"

  FINAL_FILE="$TMP_DIR/final.resp.json"
  FINAL_HEADERS="$TMP_DIR/final.resp.headers"
  FINALIZE_STARTED_AT=$(date +%s)
  HTTP=$(curl -sS \
    --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
    --max-time "$CURL_MAX_TIME_S" \
    --retry "$CURL_RETRY" \
    --retry-delay "$CURL_RETRY_DELAY_S" \
    --retry-all-errors \
    -D "$FINAL_HEADERS" \
    -o "$FINAL_FILE" \
    -w "%{http_code}" \
    "${CURL_AUTH_HEADERS[@]}" \
    -X POST "$API_BASE/$UPLOAD_ID/complete" || true)

  if ! [[ "$HTTP" =~ ^2 ]]; then
    print_err "Finalization failed"
    print_api_error "$FINAL_FILE" "$HTTP"
    print_warn "To retry finalize: curl -X POST $API_BASE/$UPLOAD_ID/complete"
    exit 1
  fi

  FILE_ID=$(jq -r '.fileId // empty' "$FINAL_FILE" 2>/dev/null || true)
  FINAL_STATUS=$(jq -r '.status // empty' "$FINAL_FILE" 2>/dev/null || true)

  if [[ -z "$FILE_ID" ]]; then
    if [[ "$HTTP" == "202" || "$FINAL_STATUS" == "finalizing" ]]; then
      print_warn "Finalize queued; polling until the file goes ready"
      if [[ "$IS_TTY" -eq 1 ]]; then
        printf '\n' >&"$UI_FD"
      fi

      STATUS_FILE="$TMP_DIR/final.status.resp.json"
      STATUS_HEADERS="$TMP_DIR/final.status.resp.headers"
      finalize_note=""
      finalize_poll_s="$FINALIZE_POLL_S"

      while true; do
        now=$(date +%s)
        elapsed=$((now - FINALIZE_STARTED_AT))
        if (( elapsed > FINALIZE_MAX_WAIT_S )); then
          if [[ "$IS_TTY" -eq 1 ]]; then
            printf '\n' >&"$UI_FD"
          fi
          print_err "Finalize timed out after ${elapsed}s"
          exit 1
        fi

        poll_s="$FINALIZE_POLL_S"
        poll_after_ms=$(jq -r '.pollAfterMs // empty' "$FINAL_FILE" 2>/dev/null || true)
        if [[ "$poll_after_ms" =~ ^[0-9]+$ ]] && (( poll_after_ms > 0 )); then
          poll_s=$(( (poll_after_ms + 999) / 1000 ))
        else
          retry_after_hdr=$(awk 'BEGIN{IGNORECASE=1} /^retry-after:/ {gsub(/\r/,"",$2); print $2; exit}' "$FINAL_HEADERS" 2>/dev/null || true)
          if [[ "$retry_after_hdr" =~ ^[0-9]+$ ]] && (( retry_after_hdr > 0 )); then
            poll_s="$retry_after_hdr"
          else
            poll_s="$finalize_poll_s"
          fi
        fi
        (( poll_s < 1 )) && poll_s=1
        (( poll_s > FINALIZE_POLL_MAX_S )) && poll_s="$FINALIZE_POLL_MAX_S"
        next_poll_at=$(( $(date +%s) + poll_s ))
        while true; do
          now=$(date +%s)
          elapsed=$((now - FINALIZE_STARTED_AT))
          if (( elapsed > FINALIZE_MAX_WAIT_S )); then
            if [[ "$IS_TTY" -eq 1 ]]; then
              printf '\n' >&"$UI_FD"
            fi
            print_err "Finalize timed out after ${elapsed}s"
            exit 1
          fi
          render_finalize_progress "$elapsed" "$finalize_note"
          if (( now >= next_poll_at )); then
            break
          fi
          sleep 1
        done

        STATUS_HTTP=$(curl -sS \
          --connect-timeout "$CURL_CONNECT_TIMEOUT_S" \
          --max-time "$CURL_MAX_TIME_S" \
          --retry "$CURL_RETRY" \
          --retry-delay "$CURL_RETRY_DELAY_S" \
          --retry-all-errors \
          -D "$STATUS_HEADERS" \
          -o "$STATUS_FILE" \
          -w "%{http_code}" \
          "${CURL_AUTH_HEADERS[@]}" \
          -X GET "$API_BASE/$UPLOAD_ID/status" 2>/dev/null || true)

        if [[ "$STATUS_HTTP" =~ ^2 ]]; then
          finalize_note=""
          STATUS=$(jq -r '.status // empty' "$STATUS_FILE" 2>/dev/null || true)
          FILE_ID=$(jq -r '.fileId // empty' "$STATUS_FILE" 2>/dev/null || true)
          if [[ "$STATUS" == "completed" && -n "$FILE_ID" ]]; then
            FINAL_FILE="$STATUS_FILE"
            FINALIZE_WAIT_S=$(( $(date +%s) - FINALIZE_STARTED_AT ))
            printf '\r\033[2K   %b+%b  %bfinalize complete%b %b(in %ds)%b\n' \
              "$_C_GREEN$BOLD" "$NC" "$_C_GREEN" "$NC" "$_C_MUTED" "$FINALIZE_WAIT_S" "$NC" >&"$UI_FD"
            break
          fi
          if [[ "$STATUS" == "failed" ]]; then
            if [[ "$IS_TTY" -eq 1 ]]; then
              printf '\n' >&"$UI_FD"
            fi
            err_msg=$(jq -r '.error // "Upload finalization failed"' "$STATUS_FILE" 2>/dev/null || true)
            print_err "Finalization failed: ${err_msg}"
            exit 1
          fi
          cp "$STATUS_FILE" "$FINAL_FILE" 2>/dev/null || true
          cp "$STATUS_HEADERS" "$FINAL_HEADERS" 2>/dev/null || true
          if (( finalize_poll_s < FINALIZE_POLL_MAX_S )); then
            finalize_poll_s=$(( finalize_poll_s * 2 ))
            (( finalize_poll_s > FINALIZE_POLL_MAX_S )) && finalize_poll_s="$FINALIZE_POLL_MAX_S"
          fi
          continue
        fi

        if [[ "$STATUS_HTTP" == "000" ]]; then
          finalize_note="server unreachable, retrying"
          if (( finalize_poll_s < FINALIZE_POLL_MAX_S )); then
            finalize_poll_s=$(( finalize_poll_s * 2 ))
            (( finalize_poll_s > FINALIZE_POLL_MAX_S )) && finalize_poll_s="$FINALIZE_POLL_MAX_S"
          fi
          continue
        fi

        if [[ "$STATUS_HTTP" == "409" || "$STATUS_HTTP" == "429" || "$STATUS_HTTP" =~ ^5 ]]; then
          finalize_note="status ${STATUS_HTTP}, retrying"
          cp "$STATUS_FILE" "$FINAL_FILE" 2>/dev/null || true
          cp "$STATUS_HEADERS" "$FINAL_HEADERS" 2>/dev/null || true
          if (( finalize_poll_s < FINALIZE_POLL_MAX_S )); then
            finalize_poll_s=$(( finalize_poll_s * 2 ))
            (( finalize_poll_s > FINALIZE_POLL_MAX_S )) && finalize_poll_s="$FINALIZE_POLL_MAX_S"
          fi
          continue
        fi

        if [[ "$IS_TTY" -eq 1 ]]; then
          printf '\n' >&"$UI_FD"
        fi
        print_err "Finalization status check failed"
        print_api_error "$STATUS_FILE" "$STATUS_HTTP"
        exit 1
      done
    else
      print_err "Finalization failed"
      cat "$FINAL_FILE" >&2
      exit 1
    fi
  fi
fi

FINALIZE_ENDED_AT=$(date +%s)
if (( FINALIZE_WAIT_S <= 0 )); then
  FINALIZE_WAIT_S=$((FINALIZE_ENDED_AT - FINALIZE_STARTED_AT))
fi

read -r sent skipped failed < <(read_progress_counts)
TRANSFER_BYTES_SENT=0
TRANSFER_BYTES_SKIPPED=0
[[ -f "$PROGRESS_BYTES_SENT_FILE" ]] && read -r TRANSFER_BYTES_SENT < "$PROGRESS_BYTES_SENT_FILE" || true
[[ -f "$PROGRESS_BYTES_SKIPPED_FILE" ]] && read -r TRANSFER_BYTES_SKIPPED < "$PROGRESS_BYTES_SKIPPED_FILE" || true
TRANSFER_WAIT_S=$(( TRANSFER_ENDED_AT - TRANSFER_STARTED_AT ))
(( TRANSFER_WAIT_S < 1 )) && TRANSFER_WAIT_S=1
AVG_UPLOAD_BPS=$(( TRANSFER_BYTES_SENT / TRANSFER_WAIT_S ))

print_section "Ready"
print_ok "Upload successful"
ui_newline
print_kv "File ID"       "$FILE_ID"
print_kv "Transfer time" "${TRANSFER_WAIT_S}s"
print_kv "Finalize wait" "${FINALIZE_WAIT_S}s"
print_kv "Uploaded"      "$(numfmt --to=iec-i "$TRANSFER_BYTES_SENT")"
print_kv "Skipped"       "$(numfmt --to=iec-i "$TRANSFER_BYTES_SKIPPED")"
print_kv "Throughput"    "$(numfmt --to=iec-i "$AVG_UPLOAD_BPS")/s"
ui_newline
FILES_BASE="${API_BASE%/v1/uploads}"
print_kv "Metadata" "${FILES_BASE}/v1/files/$FILE_ID/metadata"
print_kv "Manifest" "${FILES_BASE}/v1/files/$FILE_ID/manifest"
print_kv "Stream"   "${FILES_BASE}/v1/files/$FILE_ID/stream"

if [[ -f "$STATE_FILE" ]]; then
  FINAL_STATE_FILE="$STATE_FILE"
  tmp_state="$TMP_DIR/state.completed.json"
  jq --arg fileId "$FILE_ID" '. + {"fileId": $fileId, "completedAt": (now|floor)}' "$STATE_FILE" > "$tmp_state" 2>/dev/null || true
  if [[ -s "$tmp_state" ]]; then
    mv "$tmp_state" "$STATE_FILE" || true
  fi

  if [[ "$KEEP_STATE" -eq 0 && "${FLOE_KEEP_STATE:-0}" != "1" ]]; then
    archive_completed_state
  fi
fi

if [[ "$JSON_OUTPUT" == "1" ]]; then
  jq -n \
    --arg uploadId "$UPLOAD_ID" \
    --arg fileId "$FILE_ID" \
    --arg metadataUrl "${FILES_BASE}/v1/files/$FILE_ID/metadata" \
    --arg manifestUrl "${FILES_BASE}/v1/files/$FILE_ID/manifest" \
    --arg streamUrl "${FILES_BASE}/v1/files/$FILE_ID/stream" \
    --arg stateFile "$FINAL_STATE_FILE" \
    --arg contentType "$CONTENT_TYPE" \
    --arg sourceFile "$SOURCE_FILE_PATH" \
    --arg preparedFile "$FILE_TO_UPLOAD" \
    --argjson fileSize "$FILE_SIZE" \
    --argjson totalChunks "$TOTAL_CHUNKS" \
    --argjson transferSeconds "$TRANSFER_WAIT_S" \
    --argjson finalizeSeconds "$FINALIZE_WAIT_S" \
    --argjson uploadedBytes "$TRANSFER_BYTES_SENT" \
    --argjson skippedBytes "$TRANSFER_BYTES_SKIPPED" \
    --argjson avgUploadBytesPerSecond "$AVG_UPLOAD_BPS" \
    --argjson sentChunks "$sent" \
    --argjson skippedChunks "$skipped" \
    --argjson failedChunks "$failed" \
    '{
      ok: true,
      uploadId: $uploadId,
      fileId: $fileId,
      sourceFile: $sourceFile,
      preparedFile: $preparedFile,
      contentType: $contentType,
      fileSize: $fileSize,
      totalChunks: $totalChunks,
      transferSeconds: $transferSeconds,
      finalizeSeconds: $finalizeSeconds,
      uploadedBytes: $uploadedBytes,
      skippedBytes: $skippedBytes,
      avgUploadBytesPerSecond: $avgUploadBytesPerSecond,
      sentChunks: $sentChunks,
      skippedChunks: $skippedChunks,
      failedChunks: $failedChunks,
      metadataUrl: $metadataUrl,
      manifestUrl: $manifestUrl,
      streamUrl: $streamUrl,
      stateFile: $stateFile
    }'
else
  ui_newline
fi
