#!/usr/bin/env bash
#
# Behaviour tests for the BotPanel installer (scripts/install.sh).
#
#   bash scripts/tests/install.test.sh
#
# The installer must never claim a production installation unless systemd really
# started the service and /api/health answered. To test that without touching the
# host, the installer runs inside a throwaway container where the init system
# (/run/systemd/system) and the PATH (stubs for node, npm, docker, systemctl,
# curl, hostname...) are under our control. Nothing of the host installation is
# modified: the container is removed afterwards and only the image is cached.
#
# Set BOTPANEL_INSTALL_TEST_IMAGE to test against another base image.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE="${BOTPANEL_INSTALL_TEST_IMAGE:-ubuntu:24.04}"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker is not installed — these tests need a container to simulate a non-systemd host."
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "SKIP: the Docker daemon is not responding — cannot run the installer tests."
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/botpanel-install-test.XXXXXX")"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

cat > "${WORK}/harness.sh" <<'HARNESS'
#!/usr/bin/env bash
# Runs inside the throwaway container started by install.test.sh.
set -uo pipefail

SRC=/src
WORK=/work
STUBS="${WORK}/bin"
REPO="${WORK}/repo"

failures=0
ok()  { printf '    ok   %s\n' "$1"; }
bad() { printf '    FAIL %s\n' "$1"; failures=$((failures + 1)); }
expect_contains()     { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 — expected to find: $3"; fi; }
expect_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1 — should not contain: $3"; fi; }
expect_exit()         { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — exit $2, expected $3"; fi; }
expect_file()         { if [[ -f "$2" ]]; then ok "$1"; else bad "$1 — $2 does not exist"; fi; }
expect_no_path()      { if [[ ! -e "$2" ]]; then ok "$1"; else bad "$1 — $2 should not exist"; fi; }

# ---------------------------------------------------------------- stubs ------
# The installer only needs to *believe* the toolchain exists: these stubs never
# download anything and make each case deterministic.
mkdir -p "${STUBS}"

cat > "${STUBS}/node" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -v) echo "v22.11.0" ;;
  -p) echo "22" ;;
esac
exit 0
STUB

cat > "${STUBS}/npm" <<'STUB'
#!/usr/bin/env bash
# `npm run build` only: produce the two artifacts the installer verifies.
if [[ "${1:-}" == "run" ]]; then
  mkdir -p server/dist web/dist
  : > server/dist/index.js
  : > web/dist/index.html
fi
exit 0
STUB

cat > "${STUBS}/docker" <<'STUB'
#!/usr/bin/env bash
# STUB_DOCKER=down makes `docker info` fail, like a container without dockerd.
if [[ "${1:-}" == "info" ]]; then
  [[ "${STUB_DOCKER:-up}" == "up" ]] || exit 1
  echo "Server: Docker Engine"
fi
exit 0
STUB

cat > "${STUBS}/openssl" <<'STUB'
#!/usr/bin/env bash
echo "botpanel-test-password-1234567890"
STUB

cat > "${STUBS}/hostname" <<'STUB'
#!/usr/bin/env bash
# Documentation range (RFC 5737) on purpose: never a real address.
echo "203.0.113.7"
STUB

cat > "${STUBS}/curl" <<'STUB'
#!/usr/bin/env bash
# STUB_CURL=ok answers /api/health; anything else fails like a closed port.
if [[ "${STUB_CURL:-fail}" == "ok" ]]; then echo '{"status":"ok"}'; exit 0; fi
exit 7
STUB

cat > "${STUBS}/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "${SYSTEMCTL_LOG:-/dev/null}"
if [[ "${1:-}" == "is-active" ]]; then
  if [[ "${STUB_UNIT:-failed}" == "active" ]]; then echo active; exit 0; fi
  echo "${STUB_UNIT:-failed}"; exit 3
fi
exit 0
STUB

cat > "${STUBS}/journalctl" <<'STUB'
#!/usr/bin/env bash
echo "journalctl-stub: botpanel.service units not found on this host"
STUB

chmod +x "${STUBS}"/*

export SYSTEMCTL_LOG="${WORK}/systemctl.log"
export STUB_DOCKER="up"
export STUB_CURL="fail"
export STUB_UNIT="failed"

# ---------------------------------------------------------------- helpers ----
prepare_repo() {
  rm -rf "${REPO}"
  mkdir -p "${REPO}"
  tar -C "${SRC}" --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C "${REPO}" -xf -
}

run_installer() { # run_installer <logfile> <args...>   → prints the exit code
  local logfile="$1"; shift
  local code=0
  PATH="${STUBS}:${PATH}" bash "${REPO}/scripts/install.sh" "$@" >"${logfile}" 2>&1 || code=$?
  printf '%s' "${code}"
}

# -------------------------------------------------------------- cases --------
echo
echo "  case A — production mode on a host without systemd (container/Codespaces)"
prepare_repo
rm -f "${SYSTEMCTL_LOG}"
log="${WORK}/a.log"
code="$(run_installer "${log}" --no-deps --panel-dir "${REPO}" \
  --data-dir "${WORK}/data-a" --env-file "${WORK}/env-a")"
out="$(cat "${log}")"
expect_exit "exits non-zero" "${code}" "1"
expect_contains "explains that systemd is not running" "${out}" "not running systemd"
expect_contains "points at the development/container mode" "${out}" "--no-service"
expect_contains "states that nothing happened" "${out}" "Nothing was installed"
expect_not_contains "does not claim an installation" "${out}" "BotPanel is installed"
expect_not_contains "does not print a login URL" "${out}" "Open the URL in your browser"
expect_no_path "did not touch the machine before failing" "${REPO}/server/dist"
expect_no_path "did not create data" "${WORK}/data-a"
expect_no_path "did not create an env file" "${WORK}/env-a"
expect_no_path "did not write a unit file" "/etc/systemd/system/botpanel.service"
if [[ -s "${SYSTEMCTL_LOG}" ]]; then bad "never calls systemctl"; else ok "never calls systemctl"; fi

echo
echo "  case B — --no-service (development/container mode) with Docker up"
prepare_repo
rm -f "${SYSTEMCTL_LOG}"
STUB_DOCKER="up"
log="${WORK}/b.log"
code="$(run_installer "${log}" --no-service --no-deps --panel-dir "${REPO}" \
  --data-dir "${WORK}/data-b" --env-file "${WORK}/env-b" --port 8099)"
out="$(cat "${log}")"
expect_exit "exits zero" "${code}" "0"
expect_contains "names the mode" "${out}" "development/container mode"
expect_contains "proves the build ran" "${out}" "server/dist/index.js"
expect_file "built the backend" "${REPO}/server/dist/index.js"
expect_file "built the frontend" "${REPO}/web/dist/index.html"
expect_file "created the environment file" "${WORK}/env-b"
expect_contains "says the panel is not running" "${out}" "NOT running"
expect_not_contains "does not claim an installation" "${out}" "BotPanel is installed"
expect_not_contains "does not print a login URL" "${out}" "Open the URL in your browser"
expect_not_contains "does not print production commands" "${out}" "systemctl status botpanel"
if [[ -s "${SYSTEMCTL_LOG}" ]]; then bad "never calls systemctl"; else ok "never calls systemctl"; fi

echo
echo "  case C — --no-service on a container without the Docker daemon"
prepare_repo
rm -f "${SYSTEMCTL_LOG}"
STUB_DOCKER="down"
log="${WORK}/c.log"
code="$(run_installer "${log}" --no-service --no-deps --panel-dir "${REPO}" \
  --data-dir "${WORK}/data-c" --env-file "${WORK}/env-c" --port 8099)"
out="$(cat "${log}")"
expect_exit "still exits zero (build only)" "${code}" "0"
expect_contains "warns about Docker" "${out}" "Docker daemon is not responding"
expect_not_contains "does not claim an installation" "${out}" "BotPanel is installed"
STUB_DOCKER="up"

# From here on the container pretends to be a systemd host.
mkdir -p /run/systemd/system

echo
echo "  case D — production mode, service never becomes healthy"
prepare_repo
rm -f "${SYSTEMCTL_LOG}" /etc/systemd/system/botpanel.service
STUB_UNIT="failed"
STUB_CURL="fail"
export BOTPANEL_INSTALL_HEALTH_TIMEOUT=2
log="${WORK}/d.log"
code="$(run_installer "${log}" --no-deps --panel-dir "${REPO}" \
  --data-dir "${WORK}/data-d" --env-file "${WORK}/env-d" --port 8098)"
out="$(cat "${log}")"
expect_exit "exits non-zero" "${code}" "1"
expect_contains "reports the failure" "${out}" "was NOT installed successfully"
expect_contains "shows the service diagnostics" "${out}" "journalctl-stub"
expect_not_contains "does not claim an installation" "${out}" "BotPanel is installed"
expect_not_contains "does not print a login URL" "${out}" "Open the URL in your browser"
expect_contains "says how to retry" "${out}" "run the installer again"
expect_file "installed the unit before failing" "/etc/systemd/system/botpanel.service"
unset BOTPANEL_INSTALL_HEALTH_TIMEOUT

echo
echo "  case E — production mode, service answers /api/health"
prepare_repo
rm -f "${SYSTEMCTL_LOG}" /etc/systemd/system/botpanel.service
STUB_UNIT="active"
STUB_CURL="ok"
log="${WORK}/e.log"
code="$(run_installer "${log}" --no-deps --panel-dir "${REPO}" \
  --data-dir "${WORK}/data-e" --env-file "${WORK}/env-e" --port 8098)"
out="$(cat "${log}")"
expect_exit "exits zero" "${code}" "0"
expect_contains "confirms the running service" "${out}" "BotPanel is installed and running"
expect_contains "prints the URL" "${out}" "http://203.0.113.7:8098"
expect_contains "prints the next steps" "${out}" "Open the URL in your browser"
expect_contains "prints the password" "${out}" "botpanel-test-password"
expect_file "wrote the unit file" "/etc/systemd/system/botpanel.service"
# Comments in the template mention the placeholders on purpose; only the
# active directives must be rendered.
if grep -v '^#' /etc/systemd/system/botpanel.service | grep -q '@[A-Z_]*@'; then
  bad "rendered every placeholder in the unit"
else
  ok "rendered every placeholder in the unit"
fi
if grep -q "${REPO}" /etc/systemd/system/botpanel.service; then
  ok "unit points at the project directory"
else
  bad "unit points at the project directory"
fi

echo
if [[ "${failures}" -eq 0 ]]; then
  echo "  all installer cases passed"
  exit 0
fi
echo "  ${failures} installer assertion(s) failed"
exit 1
HARNESS

echo "Installer behaviour tests (image: ${IMAGE})"
echo "  repository: ${REPO_DIR}"
docker run --rm \
  --volume "${REPO_DIR}:/src:ro" \
  --volume "${WORK}:/work" \
  "${IMAGE}" bash /work/harness.sh
status=$?

if [[ "${status}" -eq 0 ]]; then
  echo "installer tests passed"
else
  echo "installer tests FAILED (exit ${status})"
fi
exit "${status}"
