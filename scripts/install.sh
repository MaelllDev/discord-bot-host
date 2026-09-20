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
# What it does:
#   1. verifies the operating system and the required tools
#   2. installs Docker and Node.js >= 22 when they are missing
#   3. installs the project dependencies and builds backend + frontend
#   4. creates the data directory and the environment file (with a random password)
#   5. installs, enables and starts the systemd service
#   6. prints the URL, the password location and the useful commands
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

usage() {
  cat <<'USAGE'
Usage: sudo bash scripts/install.sh [options]

Options:
  --panel-dir <path>    Where the project lives (default: the repository root)
  --data-dir <path>     Data directory (default: /var/lib/botpanel)
  --env-file <path>     Environment file (default: /etc/botpanel.env)
  --port <number>       HTTP port written to the environment file (default: 8080)
  --service-user <user> User the service runs as (default: root)
  --no-service          Build only; do not install/enable the systemd unit
  --no-deps             Do not install system packages (Docker/Node.js)
  --force               Continue on an unsupported distribution
  -h, --help            Show this help

Every option can also be given through the environment:
BOTPANEL_DIR, BOTPANEL_DATA_DIR, BOTPANEL_PORT.
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

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ prechecks
[[ "${EUID}" -eq 0 ]] || fail "Run as root: sudo bash scripts/install.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
[[ -n "${PANEL_DIR}" ]] || PANEL_DIR="${BOTPANEL_DIR:-${REPO_DIR}}"

log "BotPanel installer"
log "  project: ${PANEL_DIR}"
log "  data:    ${DATA_DIR}"
log "  env:     ${ENV_FILE}"

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

HAS_APT=0
command -v apt-get >/dev/null 2>&1 && HAS_APT=1
if [[ "${INSTALL_DEPS}" -eq 1 && "${HAS_APT}" -eq 0 ]]; then
  warn "apt-get not found: system packages will not be installed automatically."
  INSTALL_DEPS=0
fi

if [[ "${OSTYPE:-}" != "linux-gnu"* && "$(uname -s)" != "Linux" ]]; then
  fail "BotPanel runs on Linux (it needs Docker and systemd)."
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

if command -v systemctl >/dev/null 2>&1; then
  systemctl enable --now docker >/dev/null 2>&1 || true
fi

if ! docker info >/dev/null 2>&1; then
  fail "The Docker daemon is not responding. Check: systemctl status docker"
fi
log "Docker ready ($(docker --version | awk '{print $3}' | tr -d ','))"

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

# --- systemd ------------------------------------------------------------------
if [[ "${INSTALL_SERVICE}" -eq 1 ]]; then
  command -v systemctl >/dev/null 2>&1 || fail "systemd is required to install the service (use --no-service to skip)."
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
  systemctl restart "${SERVICE_NAME}"

  log "Waiting for the panel to become healthy"
  healthy=0
  for _ in $(seq 1 45); do
    if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
      healthy=1
      break
    fi
    sleep 1
  done
  if [[ "${healthy}" -ne 1 ]]; then
    warn "The panel did not answer on http://127.0.0.1:${PORT}/api/health"
    warn "Check the logs: journalctl -u ${SERVICE_NAME} -n 80 --no-pager"
  fi
else
  warn "--no-service given: the systemd unit was not installed."
fi

# --- summary ------------------------------------------------------------------
primary_ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
[[ -n "${primary_ip}" ]] || primary_ip="<your-server-ip>"

printf '\n'
log "BotPanel is installed"
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
