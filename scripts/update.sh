#!/usr/bin/env bash
#
# BotPanel updater — update an existing installation to the newest release.
#
#   curl -fsSL https://raw.githubusercontent.com/MaelllDev/discord-bot-host/main/scripts/update.sh | sudo bash
#   curl -fsSL .../scripts/update.sh | sudo bash -s -- --check
#   sudo bash scripts/update.sh --ref v1.0.7
#
# What it does:
#   1. finds the existing installation by reading its systemd unit (panel dir,
#      environment file, service user) — no need to remember the original options
#   2. brings the code to the newest release: `git fetch` + `checkout` when the
#      panel directory is a clone, otherwise the release tarball from GitHub
#   3. rebuilds, rewrites the unit and restarts the service through the project's
#      own installer (`scripts/install.sh`), which is the supported update path
#   4. if the new build does not come up, the previous build is put back and the
#      service restarted, so a bad update never leaves you with a dead panel
#
# It never touches the data directory (`/var/lib/botpanel`) or the environment
# file: your applications, releases, backups and password stay exactly as they
# are.
#
set -euo pipefail

REPO="${BOTPANEL_REPO:-MaelllDev/discord-bot-host}"
BRANCH="${BOTPANEL_BRANCH:-main}"
SERVICE_NAME="botpanel"
PANEL_DIR=""
ENV_FILE=""
DATA_DIR=""
SERVICE_USER=""
PORT=""
REF=""
CHECK=0
FORCE=0
HEALTH_TIMEOUT="${BOTPANEL_UPDATE_HEALTH_TIMEOUT:-90}"

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/update.sh [options]
       curl -fsSL <raw-url>/scripts/update.sh | sudo bash [-s -- options]

Options:
  --ref <tag|branch>    Update to this tag or branch (default: the newest
                        published release, else the newest tag, else the
                        default branch)
  --check               Only report the installed and the available version;
                        nothing is downloaded, built or restarted
  --panel-dir <path>    Where the panel is installed (default: the directory
                        recorded in the systemd unit, else /opt/botpanel)
  --service <name>      systemd unit name (default: botpanel)
  --force               Continue even when the panel directory has local
                        changes (they are discarded by `git checkout -f`)
  -h, --help            Show this help

Environment: BOTPANEL_REPO, BOTPANEL_BRANCH, BOTPANEL_UPDATE_HEALTH_TIMEOUT.
USAGE
}

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) REF="${2:-}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    --panel-dir) PANEL_DIR="${2:-}"; shift 2 ;;
    --service) SERVICE_NAME="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[[ "${HEALTH_TIMEOUT}" =~ ^[0-9]+$ ]] || HEALTH_TIMEOUT=90
[[ "${EUID}" -eq 0 ]] || fail "Run as root: sudo bash scripts/update.sh"

UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

# ------------------------------------------------------------------ discovery
# The unit file is the source of truth: it records exactly where the panel was
# installed, which user runs it and which env file it loads. Reading it means the
# updater works with any installation, including one made with --panel-dir.
from_unit() { # from_unit <directive>  → value, or empty when unavailable
  [[ -f "${UNIT_FILE}" ]] || return 0
  grep -E "^$1=" "${UNIT_FILE}" 2>/dev/null | head -n1 | cut -d= -f2- | sed 's/^-//' || true
}

[[ -n "${PANEL_DIR}" ]] || PANEL_DIR="$(from_unit WorkingDirectory)"
[[ -n "${PANEL_DIR}" ]] || PANEL_DIR="/opt/botpanel"
SERVICE_USER="$(from_unit User)"
[[ -n "${SERVICE_USER}" ]] || SERVICE_USER="root"
ENV_FILE="$(from_unit EnvironmentFile)"
[[ -n "${ENV_FILE}" ]] || ENV_FILE="/etc/botpanel.env"

[[ -d "${PANEL_DIR}" ]] ||
  fail "No installation found at ${PANEL_DIR}. If it is somewhere else, pass --panel-dir <path>."
[[ -f "${PANEL_DIR}/package.json" ]] ||
  fail "${PANEL_DIR} does not look like a BotPanel installation (no package.json)."

# The data directory lives in the environment file; the installer needs it so
# the update keeps every application, release and backup where they are.
if [[ -f "${ENV_FILE}" ]]; then
  DATA_DIR="$(grep -E '^BOTPANEL_DATA_DIR=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
  PORT="$(grep -E '^BOTPANEL_PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
fi
[[ -n "${DATA_DIR}" ]] || DATA_DIR="/var/lib/botpanel"
[[ -n "${PORT}" ]] || PORT="8080"

# --------------------------------------------------------------- versions
# The installed version comes from the git tag when the directory is a clone,
# otherwise from package.json — the installer copies the sources without .git,
# so a tarball installation has no other marker.
current_version() {
  if [[ -d "${PANEL_DIR}/.git" ]] && command -v git >/dev/null 2>&1; then
    local tag head
    tag="$(git -C "${PANEL_DIR}" describe --tags --abbrev=0 2>/dev/null || true)"
    if [[ -n "${tag}" ]]; then
      printf '%s' "${tag}"
      return 0
    fi
    head="$(git -C "${PANEL_DIR}" rev-parse --short HEAD 2>/dev/null || true)"
    if [[ -n "${head}" ]]; then
      printf 'commit %s' "${head}"
      return 0
    fi
  fi
  local pkg
  pkg="$(sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "${PANEL_DIR}/package.json" 2>/dev/null | head -n1 || true)"
  if [[ -n "${pkg}" ]]; then
    printf 'v%s' "${pkg}"
    return 0
  fi
  printf 'unknown'
}

# The newest published release is what "update" should mean. A repository that
# only tags (no release published yet) still has a newest version, so the tags
# are the second source; without network the default branch is the last resort.
latest_release() {
  command -v curl >/dev/null 2>&1 || return 1
  local tag
  tag="$(curl -fsSL --max-time 15 "https://api.github.com/repos/${REPO}/releases/latest" 2>/dev/null |
    sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
  [[ -n "${tag}" ]] || return 1
  printf '%s' "${tag}"
}

# The API lists tags newest first, so the first `"name"` is the newest tag.
# (GitHub answers with pretty-printed JSON; the pattern also copes with a
# compact body, which is only used by the tests.)
latest_tag() {
  command -v curl >/dev/null 2>&1 || return 1
  local tag
  tag="$(curl -fsSL --max-time 15 "https://api.github.com/repos/${REPO}/tags" 2>/dev/null |
    sed -n 's/.*"name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 || true)"
  [[ -n "${tag}" ]] || return 1
  printf '%s' "${tag}"
}

CURRENT="$(current_version)"

if [[ -n "${REF}" ]]; then
  TARGET_KIND="ref"
  TARGET="${REF}"
elif TARGET="$(latest_release)"; then
  TARGET_KIND="tag"
elif TARGET="$(latest_tag)"; then
  TARGET_KIND="tag"
  warn "No published release found — using the newest tag (${TARGET})."
else
  warn "Could not read releases or tags from GitHub — using the ${BRANCH} branch."
  TARGET_KIND="branch"
  TARGET="${BRANCH}"
fi

log "BotPanel updater"
log "  panel:   ${PANEL_DIR}"
log "  service: ${SERVICE_NAME} (user ${SERVICE_USER})"
log "  data:    ${DATA_DIR} (untouched)"
log "  current: ${CURRENT}"
log "  target:  ${TARGET}"

if [[ "${CHECK}" -eq 1 ]]; then
  printf '\n'
  if [[ "${CURRENT}" == "${TARGET}" ]]; then
    log "Already up to date (${TARGET})."
  else
    log "An update is available: ${CURRENT} → ${TARGET}"
    printf '    Run the same command without --check to install it.\n'
  fi
  exit 0
fi

# Checked only now: `--check` is a read-only report and must work on any
# installation, even one whose tree predates the current installer.
[[ -f "${PANEL_DIR}/scripts/install.sh" ]] ||
  fail "${PANEL_DIR}/scripts/install.sh is missing — reinstall with the current installer (docs/installation.md)."

# A panel inside a home directory is the one layout the systemd unit cannot
# harden the same way (see docs/troubleshooting.md). Mention it, but keep the
# installation where the user put it instead of moving files behind their back.
case "${PANEL_DIR}" in
  /root|/root/*|/home|/home/*)
    warn "This installation lives inside a home directory (${PANEL_DIR})."
    warn "The unit will use ProtectHome=read-only; /opt/botpanel is recommended (docs/installation.md)."
    ;;
esac

# ------------------------------------------------------------------- new code
if [[ -d "${PANEL_DIR}/.git" ]] && command -v git >/dev/null 2>&1; then
  log "Fetching the code with git"
  if [[ "${FORCE}" -eq 0 ]] && [[ -n "$(git -C "${PANEL_DIR}" status --porcelain 2>/dev/null || true)" ]]; then
    fail "The panel directory has local changes. Commit or stash them, or run again with --force to discard them."
  fi
  git -C "${PANEL_DIR}" fetch --tags --force origin
  # Tags resolve directly; a branch name only exists as a remote ref in a clone
  # that was checked out on a tag, hence the second attempt.
  git -C "${PANEL_DIR}" checkout -f "${TARGET}" 2>/dev/null ||
    git -C "${PANEL_DIR}" checkout -f "origin/${TARGET}"
else
  command -v curl >/dev/null 2>&1 ||
    fail "curl is required to download the release — install it, or turn ${PANEL_DIR} into a git clone."
  log "Downloading ${TARGET} from GitHub"
  case "${TARGET_KIND}" in
    tag) ARCHIVE_URL="https://codeload.github.com/${REPO}/tar.gz/refs/tags/${TARGET}" ;;
    *)   ARCHIVE_URL="https://codeload.github.com/${REPO}/tar.gz/refs/heads/${TARGET}" ;;
  esac

  WORK="$(mktemp -d "${TMPDIR:-/tmp}/botpanel-update.XXXXXX")"
  cleanup() { rm -rf "${WORK}"; }
  trap cleanup EXIT

  curl -fsSL --retry 3 --max-time 300 "${ARCHIVE_URL}" -o "${WORK}/release.tar.gz" ||
    fail "Could not download ${ARCHIVE_URL} — check the tag name and your connection."
  tar -xzf "${WORK}/release.tar.gz" -C "${WORK}"
  # The archive always has a single top-level directory named after the repo.
  # (`-print -quit` instead of `| head`: a pipe would trip `pipefail` on SIGPIPE.)
  SRC="$(find "${WORK}" -maxdepth 1 -mindepth 1 -type d -print -quit)"
  [[ -n "${SRC}" ]] || fail "The downloaded archive looks empty."

  # Copy the sources over the installation. Nothing is ever deleted: a file the
  # user added by hand must not disappear because of an update.
  log "Copying the new files into ${PANEL_DIR}"
  tar -C "${SRC}" --exclude=node_modules --exclude=.git -cf - . | tar -C "${PANEL_DIR}" -xf -

  cleanup
  trap - EXIT
fi

log "Code updated: $(current_version)"

# -------------------------------------------------------------------- rebuild
# `scripts/install.sh` is the supported update path: it installs dependencies,
# builds backend + frontend, rewrites the unit (with the ProtectHome decision for
# this directory) and restarts the service once it answers /api/health. Reusing
# it keeps a single implementation of those steps instead of two that drift.
STAMP="$(date +%s)"
BACKUPS=()
for part in server/dist web/dist; do
  if [[ -d "${PANEL_DIR}/${part}" ]]; then
    mv "${PANEL_DIR}/${part}" "${PANEL_DIR}/${part}.update-backup-${STAMP}"
    BACKUPS+=("${part}")
  fi
done

restore_previous_build() {
  local part
  for part in ${BACKUPS[@]+"${BACKUPS[@]}"}; do
    rm -rf "${PANEL_DIR}/${part}"
    mv "${PANEL_DIR}/${part}.update-backup-${STAMP}" "${PANEL_DIR}/${part}"
  done
}

log "Rebuilding (this takes a minute)"
export BOTPANEL_INSTALL_HEALTH_TIMEOUT="${HEALTH_TIMEOUT}"
if ! bash "${PANEL_DIR}/scripts/install.sh" \
  --panel-dir "${PANEL_DIR}" \
  --data-dir "${DATA_DIR}" \
  --env-file "${ENV_FILE}" \
  --port "${PORT}" \
  --service-user "${SERVICE_USER}" \
  --no-deps; then
  warn "The update failed."
  restore_previous_build
  warn "Restarting the service with the previous build."
  systemctl daemon-reload || true
  systemctl restart "${SERVICE_NAME}" || true
  fail "BotPanel was NOT updated — the previous build is back in place. Fix the error above and run the updater again."
fi

# The installer already restarted the service and waited for /api/health, so a
# successful exit is the moment to drop the backups of the previous build.
for part in ${BACKUPS[@]+"${BACKUPS[@]}"}; do
  rm -rf "${PANEL_DIR}/${part}.update-backup-${STAMP}"
done

printf '\n'
log "BotPanel updated: ${CURRENT} → ${TARGET}"
printf '   Panel:  http://%s:%s\n' "$(hostname -I 2>/dev/null | awk '{print $1}' || echo "<your-server-ip>")" "${PORT}"
printf '   Data:   %s (untouched)\n' "${DATA_DIR}"
printf '   Logs:   journalctl -u %s -f\n' "${SERVICE_NAME}"
printf '\n'
