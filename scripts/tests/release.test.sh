#!/usr/bin/env bash
#
# Behaviour tests for the BotPanel release workflow (scripts/release.sh).
#
#   bash scripts/tests/release.test.sh
#
# The dangerous failure here is a *silent* one: a release that reports success
# while the source files were never copied into the repository. That happened
# once — `${DRY_RUN:+--dry-run ...}` expands for "0" as well, because "0" is a
# non-empty string, so every run rsynced in dry-run mode and published nothing
# but the version bump.
#
# To make the copy step testable on its own, release.sh has `--sync-only`: it
# copies the source files and stops, without touching the version, the changelog
# or the validation suite. These tests drive that mode against a fake project and
# a throwaway git repository under $TMPDIR. The real project and the real
# repository are never written to.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
RELEASE="${REPO_DIR}/scripts/release.sh"

for tool in git node npm rsync; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "SKIP: ${tool} is required by the release workflow and is not installed."
    exit 0
  fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/botpanel-release-test.XXXXXX")"
cleanup() { rm -rf -- "${WORK}"; }
trap cleanup EXIT

SOURCE="${WORK}/source"
FAKE_REPO="${WORK}/repository"
OUT="${WORK}/out.log"

pass=0
fail=0
ok()  { printf '    ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf '    FAIL %s\n' "$1"; fail=$((fail + 1)); }
expect_file()    { if [[ -f "$2" ]]; then ok "$1"; else bad "$1 — $2 does not exist"; fi; }
expect_no_path() { if [[ ! -e "$2" ]]; then ok "$1"; else bad "$1 — $2 should not exist"; fi; }
expect_same()    { if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 — expected [$3], got [$2]"; fi; }
expect_contains(){ if [[ "$2" == *"$3"* ]]; then ok "$1"; else bad "$1 — expected to find: $3"; fi; }

# ------------------------------------------------------------------ sandbox ---
# A project shaped like the real one: the directories and single files the sync
# manifest lists, plus a stale file in each mirrored directory (to prove --delete
# removes files the source no longer has) and an outdated copy of a file that
# changed (to prove the copy really overwrites).
mkdir -p "${SOURCE}"/{server/src,server/tests,web/src,web/tests}
printf 'old ui\n' > "${SOURCE}/web/src/index.css"
printf 'old test\n' > "${SOURCE}/web/tests/old.render.test.tsx"
printf 'server entry\n' > "${SOURCE}/server/src/server.ts"
printf 'server test\n' > "${SOURCE}/server/tests/api.test.ts"
printf '{ "name": "botpanel", "version": "9.9.9" }\n' > "${SOURCE}/package.json"
printf '{ "name": "@botpanel/server", "version": "9.9.9" }\n' > "${SOURCE}/server/package.json"
printf '{ "name": "@botpanel/web", "version": "9.9.9" }\n' > "${SOURCE}/web/package.json"
printf '{\n  "lockfileVersion": 3\n}\n' > "${SOURCE}/package-lock.json"
printf '{ "compilerOptions": {} }\n' > "${SOURCE}/server/tsconfig.json"
printf '{ "compilerOptions": {} }\n' > "${SOURCE}/server/tsconfig.test.json"
printf 'export default {};\n' > "${SOURCE}/server/vitest.config.ts"
printf '{ "compilerOptions": {} }\n' > "${SOURCE}/web/tsconfig.json"
printf '{ "compilerOptions": {} }\n' > "${SOURCE}/web/tsconfig.test.json"
printf 'export default {};\n' > "${SOURCE}/web/vite.config.ts"
printf 'export default {};\n' > "${SOURCE}/web/vitest.config.ts"
printf '<!doctype html><title>new</title>\n' > "${SOURCE}/web/index.html"

mkdir -p "${FAKE_REPO}"/{server/src,server/tests,web/src,web/tests}
printf 'old ui\n' > "${FAKE_REPO}/web/src/index.css"
printf 'stale, no longer in the source\n' > "${FAKE_REPO}/web/src/gone.ts"
printf 'stale, no longer in the source\n' > "${FAKE_REPO}/server/tests/gone.test.ts"
printf '{ "name": "botpanel", "version": "1.0.0" }\n' > "${FAKE_REPO}/package.json"
printf '{ "name": "@botpanel/server", "version": "1.0.0" }\n' > "${FAKE_REPO}/server/package.json"
printf '{ "name": "@botpanel/web", "version": "1.0.0" }\n' > "${FAKE_REPO}/web/package.json"
printf '{\n  "lockfileVersion": 3\n}\n' > "${FAKE_REPO}/package-lock.json"
printf '{ "compilerOptions": {} }\n' > "${FAKE_REPO}/server/tsconfig.json"
printf '{ "compilerOptions": {} }\n' > "${FAKE_REPO}/server/tsconfig.test.json"
printf 'export default {};\n' > "${FAKE_REPO}/server/vitest.config.ts"
printf '{ "compilerOptions": {} }\n' > "${FAKE_REPO}/web/tsconfig.json"
printf '{ "compilerOptions": {} }\n' > "${FAKE_REPO}/web/tsconfig.test.json"
printf 'export default {};\n' > "${FAKE_REPO}/web/vite.config.ts"
printf 'export default {};\n' > "${FAKE_REPO}/web/vitest.config.ts"
printf '<!doctype html><title>old</title>\n' > "${FAKE_REPO}/web/index.html"
printf '# Changelog\n\n## [Unreleased]\n\nnothing yet\n' > "${FAKE_REPO}/CHANGELOG.md"

git -C "${FAKE_REPO}" init -q
git -C "${FAKE_REPO}" config user.name "release test"
git -C "${FAKE_REPO}" config user.email "release-test@example.invalid"
git -C "${FAKE_REPO}" add -A
git -C "${FAKE_REPO}" commit -qm "initial"

source_hash() {
  (cd "${SOURCE}" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -d' ' -f1
}
# -uall: a whole untracked directory would otherwise be reported as `web/tests/`,
# hiding which files actually arrived.
repo_dirty() { git -C "${FAKE_REPO}" status --porcelain -uall; }

run_release() { # <extra args...>
  bash "${RELEASE}" --source "${SOURCE}" --repo "${FAKE_REPO}" "$@" >"${OUT}" 2>&1
}

printf '\nRelease workflow — synchronisation\n'

# --- 1. a dry run reports the work and changes nothing ------------------------
BEFORE="$(source_hash)"
run_release --dry-run
status=$?
expect_same "dry run exits 0" "${status}" "0"
expect_contains "dry run lists the copies it would make" "$(cat "${OUT}")" "(dry-run) copy web/index.html"
expect_same "dry run leaves the repository untouched" "$(repo_dirty)" ""
expect_same "dry run leaves the source untouched" "$(source_hash)" "${BEFORE}"

# --- 2. a real run really copies ---------------------------------------------
run_release --sync-only
status=$?
expect_same "sync-only exits 0" "${status}" "0"
expect_contains "sync-only reports the copies it made" "$(cat "${OUT}")" "director(ies) and 12 file(s) copied"

changed="$(repo_dirty)"
expect_contains "a new file is copied into the repository" "${changed}" "web/tests/old.render.test.tsx"
expect_contains "a changed file is overwritten" "${changed}" "web/index.html"
expect_contains "a file the source dropped is removed" "${changed}" "web/src/gone.ts"
expect_contains "and so is the stale test" "${changed}" "server/tests/gone.test.ts"

expect_same "copied content matches the source" \
  "$(cat "${FAKE_REPO}/web/index.html")" "$(cat "${SOURCE}/web/index.html")"
expect_same "overwritten content matches the source" \
  "$(cat "${FAKE_REPO}/web/src/index.css")" "$(cat "${SOURCE}/web/src/index.css")"
expect_file "a file that only exists in the source arrives" "${FAKE_REPO}/server/src/server.ts"
expect_no_path "the stale file is gone" "${FAKE_REPO}/web/src/gone.ts"

# --- 3. sync-only touches nothing else ---------------------------------------
# The copy legitimately brings the source package.json along; what must not happen
# is the version being bumped to the release number (1.0.1 here).
expect_same "the version is copied, not bumped" \
  "$(node -p 'require("'"${FAKE_REPO}"'/package.json").version')" "9.9.9"
expect_contains "the changelog is untouched" "$(cat "${FAKE_REPO}/CHANGELOG.md")" "## [Unreleased]"
expect_contains "no release section was written" "$(cat "${FAKE_REPO}/CHANGELOG.md")" "nothing yet"

# --- 4. neither run wrote to the source project ------------------------------
expect_same "the source project is byte-identical" "$(source_hash)" "${BEFORE}"

printf '\n  %d passed, %d failed\n\n' "${pass}" "${fail}"
[[ "${fail}" -eq 0 ]] || exit 1
