#!/usr/bin/env bash
#
# BotPanel installer — Debian/Ubuntu VPS.
#
#   git clone https://github.com/MaelllDev/discord-bot-host.git
#   cd discord-bot-host
#   sudo bash scripts/install.sh
#
# The script is idempotent: running it again updates an existing installation
# (it keeps /etc/botpanel.env and the data directory untouched).
#
# Two modes:
#
#   production (default)   installs, enables and starts the systemd service, waits
#                          for http://127.0.0.1:<port>/api/health and only then
#                          reports success. It requires systemd to be the init
#                          system (PID 1) and exits non-zero when it cannot be
#                          installed, started or reached.
#
#   development/container  `--no-service`: builds backend + frontend only. The
#     (--no-service)      service is not installed and the panel is not started,
#                          and the script says exactly that — this mode never
#                          reports a production installation.
#
# Production mode steps:
#   1. checks root, the operating system and the init system
#   2. installs Docker and Node.js >= 22 when they are missing
#   3. installs the project dependencies and builds backend + frontend
#   4. creates the data directory and the environment file (random password)
#   5. installs, enables and starts the systemd service
#   6. waits for /api/health and prints the URL, the password and the commands
#
# The summary at the end is only printed after the service actually answered the
# health check. Anything else exits non-zero.
#
set -euo pipefail

# ------------------------------------------------------------------ arguments
PANEL_DIR=""
DATA_DIR="${BOTPANEL_DATA_DIR:-/var/lib/botpanel}"
ENV_FILE="/etc/botpanel.env"
PORT="${BOTPANEL_PORT:-8080}"
SERVICE_NAME="botpanel"
SERVICE_USER="root"
INSTALL_SERVICE=1
INSTALL_DEPS=1
FORCE=0
HEALTH_TIMEOUT="${BOTPANEL_INSTALL_HEALTH_TIMEOUT:-45}"

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/install.sh [options]

Options:
  --panel-dir <path>    Where the project lives (default: the repository root)
  --data-dir <path>     Data directory (default: /var/lib/botpanel)
  --env-file <path>     Environment file (default: /etc/botpanel.env)
  --port <number>       HTTP port written to the environment file (default: 8080)
  --service-user <user> User the service runs as (default: root)
  --no-service          Development/container mode: build only. The systemd unit
                        is not installed and the panel is not started, so a
                        production installation is never reported.
  --no-deps             Do not install system packages (Docker/Node.js)
  --force               Continue on an unsupported distribution
  -h, --help            Show this help

The production installation requires systemd as the init system (PID 1). On a
host without it (Docker, GitHub Codespaces, dev containers, CI runners) the
installer stops with an explanation and suggests --no-service.

Every option can also be given through the environment:
BOTPANEL_DIR, BOTPANEL_DATA_DIR, BOTPANEL_PORT, BOTPANEL_INSTALL_HEALTH_TIMEOUT.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --panel-dir) PANEL_DIR="${2:-}"; shift 2 ;;
    --data-dir) DATA_DIR="${2:-}"; shift 2 ;;
    --env-file) ENV_FILE="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --service-user) SERVICE_USER="${2:-}"; shift 2 ;;
    --no-service) INSTALL_SERVICE=0; shift ;;
    --no-deps) INSTALL_DEPS=0; shift ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done

[[ "${HEALTH_TIMEOUT}" =~ ^[0-9]+$ ]] || HEALTH_TIMEOUT=45

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# systemd can only be used when it really is the init system. Inside containers
# (Docker, GitHub Codespaces, dev containers) the `systemctl` binary may exist
# while nothing runs as PID 1; `systemctl enable/start` then does nothing useful
# and the panel never comes up. `/run/systemd/system` is the directory systemd
# creates for itself when it boots, so it is the reliable signal.
systemd_is_init() {
  [[ -d /run/systemd/system ]] || return 1
  command -v systemctl >/dev/null 2>&1 || return 1
  return 0
}

# Anything we can tell the user when the service does not answer.
service_diagnostics() {
  printf '\n' >&2
  if command -v systemctl >/dev/null 2>&1; then
    systemctl status "${SERVICE_NAME}" --no-pager -n 20 >&2 || true
  fi
  if command -v journalctl >/dev/null 2>&1; then
    printf '\n' >&2
    journalctl -u "${SERVICE_NAME}" -n 40 --no-pager >&2 || true
  fi
  printf '\n' >&2
}

# Used for every "the service is not serving the panel" outcome: it prints the
# diagnostics and stops with a non-zero status, so the caller can never fall
# through to the success summary.
fail_not_running() {
  warn "$1"
  service_diagnostics
  fail "BotPanel was NOT installed successfully: the systemd service is not serving the panel.
Nothing was rolled back. Fix the error above and run the installer again (it is idempotent);
it keeps ${ENV_FILE} and ${DATA_DIR}.
Useful checks:
    systemctl status ${SERVICE_NAME} --no-pager
    journalctl -u ${SERVICE_NAME} -n 100 --no-pager
    ss -ltnp | grep ${PORT}"
}

# ------------------------------------------------------------------ prechecks
[[ "${EUID}" -eq 0 ]] || fail "Run as root: sudo bash scripts/install.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
[[ -n "${PANEL_DIR}" ]] || PANEL_DIR="${BOTPANEL_DIR:-${REPO_DIR}}"

log "BotPanel installer"
log "  project: ${PANEL_DIR}"
log "  data:    ${DATA_DIR}"
log "  env:     ${ENV_FILE}"
if [[ "${INSTALL_SERVICE}" -eq 0 ]]; then
  log "  mode:    development/container (--no-service): build only, no systemd unit"
else
  log "  mode:    production (systemd service)"
fi

# --- operating system ---------------------------------------------------------
if [[ -r /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_ID="${ID:-unknown}"
  OS_VERSION="${VERSION_ID:-unknown}"
else
  OS_ID="unknown"
  OS_VERSION="unknown"
fi

case "${OS_ID}" in
  ubuntu|debian) log "Operating system: ${PRETTY_NAME:-${OS_ID} ${OS_VERSION}}" ;;
  *)
    if [[ "${FORCE}" -eq 1 ]]; then
      warn "Untested distribution (${OS_ID} ${OS_VERSION}) — continuing because --force was given."
    else
      fail "This installer supports Debian/Ubuntu (detected: ${OS_ID} ${OS_VERSION}). Use --force to continue anyway at your own risk."
    fi
    ;;
esac

if [[ "${OSTYPE:-}" != "linux-gnu"* && "$(uname -s)" != "Linux" ]]; then
  fail "BotPanel runs on Linux (it needs Docker and systemd)."
fi

# --- init system --------------------------------------------------------------
# Checked before anything is installed or built: on a container there is no
# service manager, so failing here is instant and leaves the machine untouched.
if [[ "${INSTALL_SERVICE}" -eq 1 ]] && ! systemd_is_init; then
  printf '\n' >&2
  warn "This host is not running systemd, so the BotPanel service cannot be installed here."
  printf '    Detected: %s %s without systemd as PID 1 (no /run/systemd/system).\n' \
    "$(uname -s)" "${PRETTY_NAME:-${OS_ID} ${OS_VERSION}}" >&2
  printf '    This is expected in containers: Docker, GitHub Codespaces, dev containers, CI runners.\n' >&2
  printf '\n' >&2
  printf '    Options:\n' >&2
  printf '      1. Run this installer on a VPS with systemd (Debian/Ubuntu).\n' >&2
  printf '      2. Use the development/container mode, which only builds the project:\n' >&2
  printf '           bash scripts/install.sh --no-service\n' >&2
  printf '         then start the panel yourself:\n' >&2
  printf '           set -a; . %s; set +a\n' "${ENV_FILE}" >&2
  printf '           NODE_ENV=production node %s/server/dist/index.js\n' "${PANEL_DIR}" >&2
  printf '      3. Or follow docs/installation.md and run BotPanel manually.\n' >&2
  printf '\n' >&2
  printf '    Nothing was installed, built or started.\n\n' >&2
  exit 1
fi

HAS_APT=0
command -v apt-get >/dev/null 2>&1 && HAS_APT=1
if [[ "${INSTALL_DEPS}" -eq 1 && "${HAS_APT}" -eq 0 ]]; then
  warn "apt-get not found: system packages will not be installed automatically."
  INSTALL_DEPS=0
fi

# --- runtime requirements -----------------------------------------------------
need_node=0
if ! command -v node >/dev/null 2>&1; then
  need_node=1
else
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  if [[ "${node_major}" -lt 22 ]]; then
    warn "Node.js $(node -v) is too old (>= 22 required)."
    need_node=1
  fi
fi
if ! command -v npm >/dev/null 2>&1; then
  need_node=1
fi
[[ "${need_node}" -eq 0 ]] && log "Node.js $(node -v) / npm $(npm -v)"

need_docker=0
command -v docker >/dev/null 2>&1 || need_docker=1

if [[ "${INSTALL_DEPS}" -eq 1 && ( "${need_node}" -eq 1 || "${need_docker}" -eq 1 ) ]]; then
  log "Installing system dependencies (apt)"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg openssl >/dev/null
fi

if [[ "${need_node}" -eq 1 ]]; then
  [[ "${INSTALL_DEPS}" -eq 1 ]] || fail "Node.js >= 22 is required. Install it and re-run (see docs/installation.md)."
  log "Installing Node.js 22.x (NodeSource)"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
  log "Node.js $(node -v) installed"
fi

if [[ "${need_docker}" -eq 1 ]]; then
  [[ "${INSTALL_DEPS}" -eq 1 ]] || fail "Docker is required. Install it and re-run (see docs/installation.md)."
  log "Installing Docker (docker.io)"
  apt-get install -y -qq docker.io >/dev/null
fi

if systemd_is_init; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

if ! docker info >/dev/null 2>&1; then
  if [[ "${INSTALL_SERVICE}" -eq 1 ]]; then
    fail "The Docker daemon is not responding. Check: systemctl status docker"
  fi
  warn "The Docker daemon is not responding: the project will still be built, but applications"
  warn "cannot be deployed or run until Docker is available (see docs/installation.md)."
else
  log "Docker ready ($(docker --version | awk '{print $3}' | tr -d ','))"
fi

# --- project layout -----------------------------------------------------------
if [[ "${REPO_DIR}" != "${PANEL_DIR}" ]]; then
  log "Copying the project to ${PANEL_DIR}"
  mkdir -p "${PANEL_DIR}"
  tar -C "${REPO_DIR}" --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C "${PANEL_DIR}" -xf -
fi
cd "${PANEL_DIR}"
[[ -f package.json ]] || fail "package.json not found in ${PANEL_DIR} — pass --panel-dir."

log "Installing project dependencies (this can take a minute)"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi

log "Building backend and frontend"
npm run build
[[ -f server/dist/index.js ]] || fail "The backend build did not produce server/dist/index.js"
[[ -f web/dist/index.html ]] || fail "The frontend build did not produce web/dist/index.html"

# --- data directory -----------------------------------------------------------
log "Preparing the data directory at ${DATA_DIR}"
install -d -m 0750 "${DATA_DIR}"

# --- environment file ---------------------------------------------------------
generated_password=""
if [[ -f "${ENV_FILE}" ]]; then
  log "Keeping the existing configuration in ${ENV_FILE}"
else
  generated_password="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
  log "Creating ${ENV_FILE} with a freshly generated password"
  umask 077
  {
    printf '# Generated by scripts/install.sh on %s\n' "$(date -Iseconds)"
    printf '# Every available option is documented in .env.example\n'
    printf 'BOTPANEL_PASSWORD=%s\n' "${generated_password}"
    printf 'BOTPANEL_PORT=%s\n' "${PORT}"
    printf 'BOTPANEL_DATA_DIR=%s\n' "${DATA_DIR}"
    printf 'BOTPANEL_HOST=0.0.0.0\n'
    printf 'BOTPANEL_KEEP_RELEASES=10\n'
    printf 'BOTPANEL_MAX_UPLOAD_MB=512\n'
  } > "${ENV_FILE}"
  umask 022
fi
chmod 600 "${ENV_FILE}"

# Keep the recorded port in sync with what we will health-check.
env_port="$(grep -E '^BOTPANEL_PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
[[ -n "${env_port}" ]] && PORT="${env_port}"

# --- service and health -------------------------------------------------------
# PANEL_STARTED stays 0 unless the unit is active *and* answered /api/health.
# The summary below only reports a production installation when it is 1.
PANEL_STARTED=0

if [[ "${INSTALL_SERVICE}" -eq 1 ]]; then
  systemd_is_init || fail_not_running "systemd disappeared while the installer was running"

  log "Installing the systemd service (${SERVICE_NAME}.service)"
  NODE_BIN="$(command -v node)"
  sed -e "s|@PANEL_DIR@|${PANEL_DIR}|g" \
      -e "s|@DATA_DIR@|${DATA_DIR}|g" \
      -e "s|@ENV_FILE@|${ENV_FILE}|g" \
      -e "s|@NODE_BIN@|${NODE_BIN}|g" \
      -e "s|@SERVICE_USER@|${SERVICE_USER}|g" \
      "${PANEL_DIR}/deploy/botpanel.service" > "/etc/systemd/system/${SERVICE_NAME}.service"
  chmod 0644 "/etc/systemd/system/${SERVICE_NAME}.service"
  systemctl daemon-reload
  systemctl enable "${SERVICE_NAME}" >/dev/null
  systemctl restart "${SERVICE_NAME}" ||
    fail_not_running "systemd could not start ${SERVICE_NAME}.service"

  log "Waiting up to ${HEALTH_TIMEOUT}s for http://127.0.0.1:${PORT}/api/health"
  healthy=0
  for _ in $(seq 1 "${HEALTH_TIMEOUT}"); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
      healthy=1
      break
    fi
    unit_state="$(systemctl is-active "${SERVICE_NAME}" 2>/dev/null || true)"
    if [[ "${unit_state}" == "failed" || "${unit_state}" == "inactive" ]]; then
      warn "The systemd unit went ${unit_state} — stopping the wait."
      break
    fi
    sleep 1
  done

  if [[ "${healthy}" -ne 1 ]]; then
    fail_not_running "The panel is not answering on http://127.0.0.1:${PORT}/api/health."
  fi

  if ! systemctl is-active --quiet "${SERVICE_NAME}"; then
    fail_not_running "The health check answered, but systemd does not report ${SERVICE_NAME} as active."
  fi

  PANEL_STARTED=1
  log "Service is active and answering /api/health"
else
  warn "--no-service given: development/container mode, the panel was not started."
fi

# --- summary ------------------------------------------------------------------
primary_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[[ -n "${primary_ip}" ]] || primary_ip="<your-server-ip>"

printf '\n'
if [[ "${PANEL_STARTED}" -eq 1 ]]; then
  log "BotPanel is installed and running (systemd service ${SERVICE_NAME})"
  printf '   URL:      http://%s:%s\n' "${primary_ip}" "${PORT}"
  if [[ -n "${generated_password}" ]]; then
    printf '   Password: %s  (also in %s)\n' "${generated_password}" "${ENV_FILE}"
  elif grep -q '^BOTPANEL_PASSWORD=' "${ENV_FILE}" 2>/dev/null; then
    printf '   Password: the one already configured in %s\n' "${ENV_FILE}"
  fi
  printf '   Data:     %s\n' "${DATA_DIR}"
  printf '\n'
  printf 'Next steps:\n'
  printf '   1. Open the URL in your browser and log in.\n'
  printf '   2. Go to "New application", upload your bot as a ZIP and review the detected runtime.\n'
  printf '   3. For HTTPS, put a reverse proxy (Caddy/Nginx) in front and set\n'
  printf '      BOTPANEL_COOKIE_SECURE=1 in %s (see docs/deployment.md).\n' "${ENV_FILE}"
  printf '\n'
  printf 'Useful commands:\n'
  printf '   systemctl status %s        # service status\n' "${SERVICE_NAME}"
  printf '   journalctl -u %s -f        # follow panel logs\n' "${SERVICE_NAME}"
  printf '   docker ps                  # containers of your applications\n'
  printf '   docker logs -f botpanel-<slug>   # container logs of one application\n'
  printf '\n'
else
  # Only reachable with --no-service: never claim a production installation.
  log "Build finished — development/container mode (--no-service)"
  printf '   The systemd service was NOT installed and the panel is NOT running.\n'
  printf '   Backend:  %s/server/dist/index.js\n' "${PANEL_DIR}"
  printf '   Frontend: %s/web/dist/index.html\n' "${PANEL_DIR}"
  printf '   Config:   %s\n' "${ENV_FILE}"
  printf '   Data:     %s\n' "${DATA_DIR}"
  if [[ -n "${generated_password}" ]]; then
    printf '   Password: %s  (also in %s)\n' "${generated_password}" "${ENV_FILE}"
  fi
  printf '\n'
  printf 'Start the panel yourself with:\n'
  printf '   set -a; . %s; set +a\n' "${ENV_FILE}"
  printf '   NODE_ENV=production node %s/server/dist/index.js\n' "${PANEL_DIR}"
  printf '\n'
  printf 'Once it is running: UI at http://127.0.0.1:%s, health at /api/health.\n' "${PORT}"
  printf 'For a production installation (start on boot, restart on failure) run this\n'
  printf 'script on a host with systemd — see docs/installation.md.\n'
  printf '\n'
fi
