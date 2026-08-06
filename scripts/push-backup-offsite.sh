#!/usr/bin/env bash
#
# push-backup-offsite.sh
#
# Pushes the most recent local Postgres dump to an S3-compatible object
# storage bucket, in a location genuinely separate from the VPS itself.
#
# WHY THIS EXISTS
#   /root/backup-trade-bot-db.sh (already deployed, cron 17 3 * * *) dumps
#   trade_bot via `docker exec ... pg_dump | gzip` into /root/backups/ and
#   keeps the last 14 copies. That directory lives on the SAME disk as the
#   Postgres container it is backing up: if the whole VPS is lost (not just
#   the container — the box, the disk, or the provider account), all 14
#   copies are lost with it. See docs/RUNBOOK.md §7 for the full writeup.
#
#   This script is step 2, run AFTER backup-trade-bot-db.sh has produced a
#   fresh dump: it finds the newest dump and copies it to an off-VPS bucket
#   via `rclone`, which speaks the S3 API (and several others) against
#   basically any object storage provider without provider-specific code
#   here. This script does not care which provider you pick.
#
# COPY, NOT SYNC — ON PURPOSE
#   `rclone sync <src> <dst>` makes <dst> match <src> exactly, DELETING
#   anything at <dst> that is not present at <src>. Our "source" for a given
#   run is a single file (the latest dump). Pointing sync at that would
#   either (a) require syncing the whole /root/backups/ directory, which
#   just re-implements the existing 14-dump local retention policy against
#   the remote too and actively deletes older offsite copies as they age out
#   locally, or (b) if pointed at just the one latest file, risk wiping out
#   every OTHER dump already sitting in the bucket that doesn't match that
#   exact source path. `rclone copy` only adds/overwrites at the
#   destination and never deletes — the offsite bucket is allowed to
#   accumulate more history than the local 14-dump window, and re-running
#   this script (by hand, retried by cron, whatever) can never destroy a
#   previously pushed backup. Pruning the bucket, if ever wanted, should be
#   a separate, deliberate decision (e.g. a bucket lifecycle rule on the
#   provider side) — not a side effect of this script.
#
# ONE-TIME SETUP REQUIRED BEFORE THIS SCRIPT WILL WORK
#   This script assumes `rclone` is installed and already has a working
#   remote configured. Neither step can be done non-interactively by a
#   script — both need a human with real provider credentials:
#
#     1. Install rclone (once, as root on the VPS):
#          curl https://rclone.org/install.sh | sudo bash
#
#     2. Configure a remote (once, interactive):
#          rclone config
#        Pick ANY S3-compatible object storage provider — Backblaze B2,
#        Wasabi, AWS S3, Linode Object Storage, etc. Use a DIFFERENT
#        provider/region than the VPS itself, otherwise a provider-wide
#        incident can still take out both the VPS and the "offsite" copy.
#        Give the remote a name (e.g. "b2-backup") and create/point it at a
#        bucket (e.g. "trade-bot-db-backups").
#
#     3. Sanity-check the remote works before relying on this script:
#          rclone lsd <remote-name>:
#        should list (possibly empty) without error. If that fails, this
#        script will fail too — fix `rclone config` first.
#
# USAGE
#   ./push-backup-offsite.sh <remote-name> <bucket-path>
#   RCLONE_REMOTE=<remote-name> RCLONE_BUCKET_PATH=<bucket-path> ./push-backup-offsite.sh
#
#   <remote-name>   name given to the remote in `rclone config` (e.g. b2-backup)
#   <bucket-path>   bucket, optionally with a subfolder (e.g. trade-bot-db-backups/prod)
#
#   Positional arguments win over the environment variables if both are given.
#
# INTENDED CRON USAGE (once the one-time setup above is done)
#   17 3 * * * /root/backup-trade-bot-db.sh && /root/push-backup-offsite.sh <remote-name> <bucket-path> >> /root/backups/push-backup-offsite.log 2>&1
#
# EXIT CODES (for cron/monitoring to key off of)
#   0  success — latest dump found, pushed, and verified present at the remote
#   1  usage/config error (missing remote name / bucket path, rclone not
#      installed, or the named remote isn't in `rclone config`)
#   2  no local backup found (BACKUP_DIR missing, or no trade_bot_*.sql.gz in it)
#   3  another instance is already running (lock held)
#   4  `rclone copy` itself failed (network, auth, bucket permissions, ...)
#   5  push appeared to succeed but the file could not be verified at the
#      remote afterwards
#
set -euo pipefail

SCRIPT_NAME="$(basename "$0")"

# Overridable for local testing; on the VPS these defaults match
# /root/backup-trade-bot-db.sh's own layout.
BACKUP_DIR="${BACKUP_DIR:-/root/backups}"
LOG_FILE="${PUSH_BACKUP_LOG_FILE:-${BACKUP_DIR}/push-backup-offsite.log}"
LOCK_FILE="${PUSH_BACKUP_LOCK_FILE:-/tmp/push-backup-offsite.lock}"

REMOTE_NAME="${1:-${RCLONE_REMOTE:-}}"
BUCKET_PATH="${2:-${RCLONE_BUCKET_PATH:-}}"

# --- logging: always to stdout/stderr (so cron's own mailing/journald catches
# it) AND best-effort appended to LOG_FILE (so it's greppable after the fact
# even if cron's stdout capture is swallowed somewhere). Never let a log-file
# write failure (e.g. disk full) crash the script. ------------------------
log_line() {
  local level="$1"; shift
  printf '%s [%s] %s: %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$level" "$SCRIPT_NAME" "$*"
}

log_info() {
  local msg; msg="$(log_line INFO "$@")"
  echo "$msg"
  { echo "$msg" >>"$LOG_FILE"; } 2>/dev/null || true
}

log_error() {
  local msg; msg="$(log_line ERROR "$@")"
  echo "$msg" >&2
  { echo "$msg" >>"$LOG_FILE"; } 2>/dev/null || true
}

usage() {
  cat <<EOF
Usage:
  $SCRIPT_NAME <remote-name> <bucket-path>
  RCLONE_REMOTE=<remote-name> RCLONE_BUCKET_PATH=<bucket-path> $SCRIPT_NAME

<remote-name>  name of an already-configured rclone remote (see 'rclone config',
               and the ONE-TIME SETUP block at the top of this script)
<bucket-path>  destination bucket, optionally with a subfolder, e.g.
               trade-bot-db-backups or trade-bot-db-backups/prod

Example:
  $SCRIPT_NAME b2-backup trade-bot-db-backups
EOF
}

trap 'log_error "aborting: unexpected failure at line ${LINENO} (last command: ${BASH_COMMAND})"' ERR

# --- validate inputs -------------------------------------------------------
if [[ -z "$REMOTE_NAME" || -z "$BUCKET_PATH" ]]; then
  log_error "missing remote name and/or bucket path (got remote='${REMOTE_NAME}' bucket='${BUCKET_PATH}')."
  usage >&2
  exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
  log_error "'rclone' not found on PATH. One-time install needed: curl https://rclone.org/install.sh | sudo bash"
  exit 1
fi

if ! rclone listremotes 2>/dev/null | grep -qx "${REMOTE_NAME}:"; then
  log_error "rclone remote '${REMOTE_NAME}:' is not configured. Run 'rclone config' first (one-time, interactive, see header of this script)."
  log_error "Currently configured remotes: $(rclone listremotes 2>/dev/null | tr '\n' ' ')"
  exit 1
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  log_error "backup directory '${BACKUP_DIR}' does not exist. Has backup-trade-bot-db.sh ever run?"
  exit 2
fi

# --- find the latest local dump --------------------------------------------
# ls -1t sorts newest-first by mtime; matches the naming used by
# /root/backup-trade-bot-db.sh (trade_bot_<timestamp>.sql.gz).
LATEST_BACKUP="$(ls -1t "${BACKUP_DIR}"/trade_bot_*.sql.gz 2>/dev/null | head -n 1 || true)"

if [[ -z "$LATEST_BACKUP" ]]; then
  log_error "no trade_bot_*.sql.gz files found in ${BACKUP_DIR}. Has backup-trade-bot-db.sh run yet?"
  exit 2
fi

log_info "latest local backup: ${LATEST_BACKUP} ($(du -h "$LATEST_BACKUP" 2>/dev/null | cut -f1))"

# --- prevent overlapping runs (best-effort; flock is standard on Debian/
# Ubuntu VPS images via util-linux, but we don't hard-require it) -----------
exec 9>"$LOCK_FILE"
if command -v flock >/dev/null 2>&1; then
  if ! flock -n 9; then
    log_error "another instance of ${SCRIPT_NAME} appears to be running (lock: ${LOCK_FILE}). Exiting without pushing."
    exit 3
  fi
else
  log_info "flock not available — skipping overlap protection (not a hard dependency)."
fi

# --- push --------------------------------------------------------------
DEST="${REMOTE_NAME}:${BUCKET_PATH}"
BACKUP_BASENAME="$(basename "$LATEST_BACKUP")"

log_info "pushing ${BACKUP_BASENAME} -> ${DEST}"

set +e
rclone copy "$LATEST_BACKUP" "$DEST" --checksum >>"$LOG_FILE" 2>&1
RC=$?
set -e

if [[ $RC -ne 0 ]]; then
  log_error "FAILED: 'rclone copy' exited with status ${RC} while pushing ${BACKUP_BASENAME} to ${DEST}. See ${LOG_FILE} for rclone's own output."
  exit 4
fi

# --- verify: don't just trust rclone's exit code, actually confirm the file
# is listed at the destination. Cheap and catches silent partial failures. --
if rclone lsf "$DEST" 2>/dev/null | grep -qx "$BACKUP_BASENAME"; then
  log_info "OK: ${BACKUP_BASENAME} confirmed present at ${DEST}"
else
  log_error "VERIFY FAILED: rclone copy reported success but ${BACKUP_BASENAME} is not listed at ${DEST}."
  exit 5
fi

log_info "done."
exit 0
