#!/usr/bin/env bash
#
# Behaviour tests for the BotPanel updater (scripts/update.sh).
#
#   bash scripts/tests/update.test.sh
#
# The updater must bring an existing installation to a newer release without
# touching the data directory, must use the freshly downloaded installer (never
# the old one sitting in the installation) and must put the previous build back
# when the new one does not come up.
#
# Like install.test.sh, everything runs inside a throwaway container: systemd is
# pretended (/run/systemd/system plus a systemctl stub), GitHub is replaced by a
# curl stub that serves a locally built tarball, and npm/node/docker are stubs.
# Nothing of the host is touched.
#
# Set BOTPANEL_INSTALL_TEST_IMAGE to test against another base image.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
IMAGE="${BOTPANEL_INSTALL_TEST_IMAGE:-ubuntu:24.04}"

if ! command -v docker >/dev/null 2>&1; then
  echo "SKIP: docker is not installed — these tests need a container."
  exit 0
fi
if ! docker info >/dev/null 2>&1; then
  echo "SKIP: the Docker daemon is not responding — cannot run the updater tests."
  exit 0
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/botpanel-update-test.XXXXXX")"
cleanup() { rm -rf "${WORK}"; }
trap cleanup EXIT

cat > "${WORK}/harness.sh" <<'HARNESS'
#!/usr/bin/env bash
# Runs inside the throwaway container started by update.test.sh.
set -uo pipefail

SRC=/src
WORK=/work
STUBS="${WORK}/bin"
LATEST_TAG="v9.9.9"

failures=0
ok()  { printf '    ok   %s\n' "$1"; }
bad() { printf '    FAIL %s\n' "$1"; failures=$((failures + 1)); }
expect_contains()     { if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 — expected to find: $3"; fi; }
expect_not_contains() { if [[ "$2" != *"$3"* ]]; then ok "$1"; else bad "$1 — should not contain: $3"; fi; }
expect_exit()         { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — exit $2, expected $3"; fi; }
expect_file()         { if [[ -f "$2" ]]; then ok "$1"; else bad "$1 — $2 does not exist"; fi; }
expect_no_path()      { if [[ ! -e "$2" ]]; then ok "$1"; else bad "$1 — $2 should not exist"; fi; }
expect_content()      { if [[ -f "$2" ]] && grep -q "$3" "$2"; then ok "$1"; else bad "$1 — $2 does not contain: $3"; fi; }

mkdir -p "${STUBS}" /run/systemd/system
export SYSTEMCTL_LOG="${WORK}/systemctl.log"
export NPM_LOG="${WORK}/npm.log"
: > "${SYSTEMCTL_LOG}"
: > "${NPM_LOG}"

# ---------------------------------------------------------------- stubs ------
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
echo "npm $*" >> "${NPM_LOG}"
if [[ "${1:-}" == "run" ]]; then
  mkdir -p server/dist web/dist
  echo "NEW-BUILD" > server/dist/index.js
  echo "NEW-BUILD" > web/dist/index.html
fi
exit 0
STUB

cat > "${STUBS}/docker" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "info" ]]; then echo "Server: Docker Engine"; fi
exit 0
STUB

cat > "${STUBS}/hostname" <<'STUB'
#!/usr/bin/env bash
echo "203.0.113.7"
STUB

cat > "${STUBS}/openssl" <<'STUB'
#!/usr/bin/env bash
echo "botpanel-test-password-1234567890"
STUB

cat > "${STUBS}/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "${SYSTEMCTL_LOG}"
if [[ "${1:-}" == "is-active" ]]; then echo active; exit 0; fi
exit 0
STUB

cat > "${STUBS}/journalctl" <<'STUB'
#!/usr/bin/env bash
echo "journalctl-stub"
STUB

# One curl for everything: the GitHub API, the release tarball and the health
# endpoint of the panel that the installer checks.
cat > "${STUBS}/curl" <<'STUB'
#!/usr/bin/env bash
url=""; out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="${2:-}"; shift 2 ;;
    # Options that take a value must swallow it, otherwise the value would be
    # mistaken for the URL (the updater passes --max-time/--retry).
    --max-time|--retry|--connect-timeout|--timeout) shift 2 ;;
    -*) shift ;;
    *) url="${url:-$1}"; shift ;;
  esac
done
case "${url}" in
  *api.github.com*releases/latest*)
    if [[ "${STUB_RELEASES:-ok}" == "ok" ]]; then
      printf '{"tag_name":"%s"}\n' "${STUB_LATEST_TAG:-v9.9.9}"
      exit 0
    fi
    exit 22 ;;
  *api.github.com*tags*)
    if [[ "${STUB_RELEASES:-ok}" == "tags" ]]; then
      # Pretty-printed like the real API, one field per line.
      printf '[\n  {\n    "name": "%s",\n    "commit": {\n      "sha": "abc"\n    }\n  }\n]\n' "${STUB_LATEST_TAG:-v9.9.9}"
      exit 0
    fi
    exit 22 ;;
  *codeload.github.com*)
    [[ -n "${out}" ]] || { echo "curl stub: -o expected for ${url}" >&2; exit 2; }
    cat "${STUB_TARBALL}" > "${out}"
    [[ "${STUB_DOWNLOAD:-ok}" == "ok" ]] || exit 56
    exit 0 ;;
  *api/health*)
    if [[ "${STUB_HEALTH:-ok}" == "ok" ]]; then echo '{"status":"ok"}'; exit 0; fi
    exit 7 ;;
esac
echo "curl stub: unexpected url ${url}" >&2
exit 2
STUB

chmod +x "${STUBS}"/*

# --------------------------------------------------------------- fixtures ----
# The "new release" tarball: the real sources with a bumped version, so the test
# can prove which code ended up installed.
build_release_tarball() {
  local stage="${WORK}/stage/discord-bot-host-${LATEST_TAG#v}"
  rm -rf "${WORK}/stage"
  mkdir -p "${stage}"
  tar -C "${SRC}" --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C "${stage}" -xf -
  sed -i '0,/^[[:space:]]*"version"[[:space:]]*:.*/s//  "version": "9.9.9",/' "${stage}/package.json"
  tar -czf "${WORK}/release.tar.gz" -C "${WORK}/stage" "discord-bot-host-${LATEST_TAG#v}"
}
build_release_tarball
# The stub runs as its own process: every knob it reads has to be exported.
export STUB_LATEST_TAG="${LATEST_TAG}"
export STUB_TARBALL="${WORK}/release.tar.gz"

# An existing installation with an OLD installer on purpose: if the updater
# called it instead of the freshly downloaded one, the marker would appear.
prepare_install() { # prepare_install <dir> [version]
  local dir="$1" version="${2:-1.0.2}"
  rm -rf "${dir}"
  mkdir -p "${dir}"
  tar -C "${SRC}" --exclude=node_modules --exclude=dist --exclude=.git -cf - . | tar -C "${dir}" -xf -
  sed -i "0,/^[[:space:]]*\"version\"[[:space:]]*:.*/s//  \"version\": \"${version}\",/" "${dir}/package.json"
  mkdir -p "${dir}/server/dist" "${dir}/web/dist"
  echo "OLD-BUILD" > "${dir}/server/dist/index.js"
  echo "OLD-BUILD" > "${dir}/web/dist/index.html"
  cat > "${dir}/scripts/install.sh" <<'OLD'
#!/usr/bin/env bash
echo "OLD-INSTALLER-MARKER" > /work/old-installer-ran
exit 0
OLD
  chmod +x "${dir}/scripts/install.sh"
}

write_unit() { # write_unit <panel-dir>
  mkdir -p /etc/systemd/system
  cat > "/etc/systemd/system/botpanel.service" <<UNIT
[Unit]
Description=BotPanel

[Service]
WorkingDirectory=$1
EnvironmentFile=-$2
ExecStart=/usr/bin/node $1/server/dist/index.js
User=root
ProtectHome=yes

[Install]
WantedBy=multi-user.target
UNIT
}

write_env() { # write_env <file> <data-dir> <port>
  mkdir -p "$(dirname "$1")"
  cat > "$1" <<ENV
BOTPANEL_PASSWORD=unchanged-secret
BOTPANEL_PORT=$3
BOTPANEL_DATA_DIR=$2
ENV
}

run_update() { # run_update <logfile> <args...>  → prints the exit code
  local logfile="$1"; shift
  local code=0
  PATH="${STUBS}:${PATH}" bash "${SRC}/scripts/update.sh" "$@" >"${logfile}" 2>&1 || code=$?
  printf '%s' "${code}"
}

# -------------------------------------------------------------- cases --------
echo
echo "  case A — --check reports the versions and changes nothing"
PANEL="${WORK}/opt/panel"
DATA="${WORK}/data-a"
prepare_install "${PANEL}"
write_unit "${PANEL}" "${WORK}/env-a"
write_env "${WORK}/env-a" "${DATA}" 8095
mkdir -p "${DATA}"
echo "precious" > "${DATA}/state.json"
rm -f "${WORK}/old-installer-ran"
: > "${NPM_LOG}"
log="${WORK}/a.log"
code="$(run_update "${log}" --check --panel-dir "${PANEL}")"
out="$(cat "${log}")"
expect_exit "exits zero" "${code}" "0"
expect_contains "shows the installed version" "${out}" "v1.0.2"
expect_contains "shows the available version" "${out}" "${LATEST_TAG}"
expect_contains "says an update is available" "${out}" "An update is available"
if [[ -s "${NPM_LOG}" ]]; then bad "does not build anything"; else ok "does not build anything"; fi
expect_content "leaves the installed code alone" "${PANEL}/package.json" '"version": "1.0.2"'
if [[ -s "${SYSTEMCTL_LOG}" ]]; then bad "does not touch the service"; else ok "does not touch the service"; fi

echo
echo "  case B — full update of a tarball installation"
DATA="${WORK}/data-b"
prepare_install "${PANEL}"
write_unit "${PANEL}" "${WORK}/env-b"
write_env "${WORK}/env-b" "${DATA}" 8095
mkdir -p "${DATA}"
echo "precious" > "${DATA}/state.json"
rm -f "${WORK}/old-installer-ran"
: > "${NPM_LOG}"
: > "${SYSTEMCTL_LOG}"
log="${WORK}/b.log"
code="$(run_update "${log}" --panel-dir "${PANEL}")"
out="$(cat "${log}")"
expect_exit "exits zero" "${code}" "0"
expect_contains "reports the version jump" "${out}" "v1.0.2 → ${LATEST_TAG}"
expect_content "installed the new code" "${PANEL}/package.json" '"version": "9.9.9"'
expect_content "rebuilt the backend" "${PANEL}/server/dist/index.js" "NEW-BUILD"
expect_content "rebuilt the frontend" "${PANEL}/web/dist/index.html" "NEW-BUILD"
expect_no_path "used the downloaded installer, not the old one" "${WORK}/old-installer-ran"
expect_not_contains "never prints the old installer marker" "${out}" "OLD-INSTALLER-MARKER"
expect_no_path "cleaned up the build backups" "${PANEL}/server/dist.update-backup-0"
if compgen -G "${PANEL}/server/dist.update-backup-*" > /dev/null; then
  bad "cleaned up the build backups"
else
  ok "cleaned up the build backups"
fi
expect_content "left the data directory alone" "${DATA}/state.json" "precious"
expect_content "kept the env file" "${WORK}/env-b" "BOTPANEL_PASSWORD=unchanged-secret"
expect_content "rewrote the unit for this directory" "/etc/systemd/system/botpanel.service" "WorkingDirectory=${PANEL}"
expect_content "keeps ProtectHome=yes outside a home directory" "/etc/systemd/system/botpanel.service" "ProtectHome=yes"
if grep -q "systemctl restart botpanel" "${SYSTEMCTL_LOG}"; then
  ok "restarted the service"
else
  bad "restarted the service"
fi

echo
echo "  case C — a build that never comes up restores the previous one"
DATA="${WORK}/data-c"
prepare_install "${PANEL}"
write_unit "${PANEL}" "${WORK}/env-c"
write_env "${WORK}/env-c" "${DATA}" 8095
mkdir -p "${DATA}"
echo "precious" > "${DATA}/state.json"
rm -f "${WORK}/old-installer-ran"
log="${WORK}/c.log"
export STUB_HEALTH=fail
code="$(run_update "${log}" --panel-dir "${PANEL}")"
export STUB_HEALTH=ok
out="$(cat "${log}")"
expect_exit "exits non-zero" "${code}" "1"
expect_contains "says the update failed" "${out}" "The update failed"
expect_contains "says the previous build is back" "${out}" "previous build is back in place"
expect_content "restored the previous backend build" "${PANEL}/server/dist/index.js" "OLD-BUILD"
expect_content "restored the previous frontend build" "${PANEL}/web/dist/index.html" "OLD-BUILD"
if compgen -G "${PANEL}/*/dist.update-backup-*" > /dev/null; then
  bad "cleaned up the build backups after the failure"
else
  ok "cleaned up the build backups after the failure"
fi
expect_content "still left the data directory alone" "${DATA}/state.json" "precious"

echo
echo "  case D — an installation inside a home directory"
HOME_PANEL="/home/botpanel-update-test/panel"
rm -rf "/home/botpanel-update-test"
prepare_install "${HOME_PANEL}"
write_unit "${HOME_PANEL}" "${WORK}/env-d"
write_env "${WORK}/env-d" "${WORK}/data-d" 8095
log="${WORK}/d.log"
code="$(run_update "${log}" --panel-dir "${HOME_PANEL}")"
out="$(cat "${log}")"
expect_exit "exits zero" "${code}" "0"
expect_contains "warns about the home directory" "${out}" "inside a home directory"
expect_content "downgrades ProtectHome in the unit" "/etc/systemd/system/botpanel.service" "ProtectHome=read-only"
expect_content "points the unit at the home directory" "/etc/systemd/system/botpanel.service" "WorkingDirectory=${HOME_PANEL}"

echo
echo "  case F — a repository with tags but no published release"
export STUB_RELEASES=tags
log="${WORK}/f.log"
code="$(run_update "${log}" --check --panel-dir "${PANEL}")"
out="$(cat "${log}")"
export STUB_RELEASES=ok
expect_exit "exits zero" "${code}" "0"
expect_contains "falls back to the newest tag" "${out}" "${LATEST_TAG}"
expect_contains "explains the fallback" "${out}" "No published release found"

echo
echo "  case E — git installations are updated with git"
GIT_PANEL="${WORK}/git/panel"
prepare_install "${GIT_PANEL}"
if command -v git >/dev/null 2>&1; then
  git -C "${GIT_PANEL}" init -q -b main
  git -C "${GIT_PANEL}" -c user.email=t@t -c user.name=t add -A
  git -C "${GIT_PANEL}" -c user.email=t@t -c user.name=t commit -qm "1.0.2"
  git -C "${GIT_PANEL}" tag v1.0.2
  write_unit "${GIT_PANEL}" "${WORK}/env-e"
  write_env "${WORK}/env-e" "${WORK}/data-e" 8095
  log="${WORK}/e.log"
  # --ref with a branch that does not exist: the fetch fails and the updater
  # must stop before rebuilding anything.
  code="$(run_update "${log}" --panel-dir "${GIT_PANEL}" --ref nao-existe)"
  out="$(cat "${log}")"
  expect_exit "exits non-zero" "${code}" "1"
  expect_not_contains "does not claim success" "${out}" "BotPanel updated:"
  if compgen -G "${GIT_PANEL}/server/dist.update-backup-*" > /dev/null; then
    bad "did not start rebuilding"
  else
    ok "did not start rebuilding"
  fi
  expect_content "kept the previous build" "${GIT_PANEL}/server/dist/index.js" "OLD-BUILD"
else
  ok "git is not installed in this image — skipping"
fi

if [[ "${failures}" -gt 0 ]]; then
  # Logs answer the "why" almost every time: print them when something failed.
  for f in "${WORK}"/?.log; do
    [[ -f "${f}" ]] || continue
    printf '\n--- %s ---\n' "${f}"
    tail -n 25 "${f}"
  done
fi

echo
if [[ "${failures}" -eq 0 ]]; then
  echo "  all updater cases passed"
  exit 0
fi
echo "  ${failures} updater assertion(s) failed"
exit 1
HARNESS

echo "Updater behaviour tests (image: ${IMAGE})"
echo "  repository: ${REPO_DIR}"
docker run --rm \
  --volume "${REPO_DIR}:/src:ro" \
  --volume "${WORK}:/work" \
  "${IMAGE}" bash /work/harness.sh
status=$?

if [[ "${status}" -eq 0 ]]; then
  echo "updater tests passed"
else
  echo "updater tests FAILED (exit ${status})"
fi
exit "${status}"
