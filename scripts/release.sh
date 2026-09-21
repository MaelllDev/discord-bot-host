#!/usr/bin/env bash
#
# BotPanel release workflow (maintainers).
#
#   bash scripts/release.sh --bump minor --notes "Explain what changed"
#
# It takes the *working* project (the installation you develop on), copies the
# source files that belong to the public repository, bumps the version, updates
# the changelog, runs the whole validation suite, then commits, tags and pushes.
#
# The repository never receives production state: no database, no environment
# file, no application data, no secrets. Documentation, scripts, workflows and
# the default logo are files owned by the repository and are never overwritten
# by this script (see the PROTECTED list below).
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_DIR="${BOTPANEL_SOURCE:-/opt/botpanel}"
VERSION=""
BUMP="patch"
NOTES=""
DRY_RUN=0
NO_PUSH=0
SKIP_E2E=0
ALLOW_DIRTY=0
BUMP_PRODUCTION=0
ASSUME_YES=0
CLEANUP_E2E=0
CLEANUP_DIR=""
REMOTE="origin"
BRANCH=""

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
step() { printf '\n\033[1;35m### %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------------ E2E cleanup
# The Docker E2E suite creates its own containers, networks and data directory.
# A run that finishes removes them in its `afterAll`; a run that is interrupted or
# fails cannot, and the leftovers would stay on the machine forever. Everything
# below exists to clean them up whatever happens — and only them: every artifact
# of a BotPanel instance carries the label `botpanel.instance`, and only instances
# created by this run (or data directories this run owns) are removed. An
# application of the running panel always belongs to another instance and to a
# container that already existed before the suite started.
E2E_TMP_ROOT=""
E2E_INSTANCES_BEFORE=""

# Fixtures of server/tests/e2e.docker.test.ts: the only application slugs the suite
# ever creates. Used as a name-scoped fallback when a run left no data directory.
SUITE_SLUGS="e2e-bot-a e2e-bot-b e2e-bot-py"

instance_id_for_dir() {
  # Same derivation used by the panel (server/src/config.ts).
  node -e 'const c=require("node:crypto"),p=require("node:path");process.stdout.write(c.createHash("sha256").update(p.resolve(process.argv[1])).digest("hex").slice(0,12))' "$1"
}

panel_instance_id() {
  # Instance of the panel running on this machine, when we can work it out. Its
  # applications are never a cleanup target, even if a container appears while the
  # suite runs.
  local data_dir="${BOTPANEL_DATA_DIR:-}"
  if [[ -z "${data_dir}" && -r /etc/botpanel.env ]]; then
    data_dir="$(grep -E '^BOTPANEL_DATA_DIR=' /etc/botpanel.env 2>/dev/null | tail -n1 | cut -d= -f2- || true)"
  fi
  [[ -n "${data_dir}" ]] || return 0
  instance_id_for_dir "${data_dir}"
}

suite_instances_by_name() {
  # Instances reachable through the fixture names of the suite, ignoring the panel
  # running on this machine.
  local slug name id protected
  protected="$(panel_instance_id || true)"
  {
    for slug in ${SUITE_SLUGS}; do
      for name in "botpanel-${slug}" "botpanel-net-${slug}"; do
        id="$(container_instance_label "${name}" || true)"
        [[ -n "${id}" ]] && printf '%s\n' "${id}"
      done
    done
  } | grep -v '^$' | sort -u | while read -r id; do
    [[ -n "${protected}" && "${id}" == "${protected}" ]] && continue
    printf '%s\n' "${id}"
  done
}

container_instance_label() { # <container-or-network-name>
  local name="$1" id
  id="$(docker inspect --format '{{index .Config.Labels "botpanel.instance"}}' "${name}" 2>/dev/null || true)"
  if [[ -z "${id}" ]]; then
    id="$(docker network inspect --format '{{index .Labels "botpanel.instance"}}' "${name}" 2>/dev/null || true)"
  fi
  [[ "${id}" == "<no value>" ]] && id=""
  printf '%s' "${id}"
}

docker_instances() {
  # Instance ids of every container and network that belongs to a BotPanel instance.
  {
    docker ps -a --filter 'label=botpanel.instance' --format '{{.Label "botpanel.instance"}}' 2>/dev/null || true
    docker network ls --filter 'label=botpanel.instance' --format '{{.Label "botpanel.instance"}}' 2>/dev/null || true
  } | grep -v '^$' | sort -u
}

remove_instance_artifacts() { # <instance-id> — never fails, never touches other instances
  local id="$1" ids names
  [[ -n "${id}" ]] || return 0
  ids="$(docker ps -aq --filter "label=botpanel.instance=${id}" 2>/dev/null || true)"
  if [[ -n "${ids}" ]]; then
    names="$(docker ps -a --filter "label=botpanel.instance=${id}" --format '{{.Names}}' 2>/dev/null | paste -sd' ' - || true)"
    printf '%s\n' "${ids}" | xargs -r docker rm -f >/dev/null 2>&1 || true
    log "removed container(s) of instance ${id}: ${names}"
  fi
  ids="$(docker network ls -q --filter "label=botpanel.instance=${id}" 2>/dev/null || true)"
  if [[ -n "${ids}" ]]; then
    names="$(docker network ls --filter "label=botpanel.instance=${id}" --format '{{.Name}}' 2>/dev/null | paste -sd' ' - || true)"
    printf '%s\n' "${ids}" | xargs -r docker network rm >/dev/null 2>&1 || true
    log "removed network(s) of instance ${id}: ${names}"
  fi
  return 0
}

cleanup_e2e() { # idempotent: safe to call from a trap and then again in the normal path
  set +e
  local dir id
  # 1. Data directories owned by this run: each one identifies its own instance.
  if [[ -n "${E2E_TMP_ROOT}" ]]; then
    for dir in "${E2E_TMP_ROOT}"/botpanel-e2e-*; do
      [[ -d "${dir}" ]] || continue
      id="$(instance_id_for_dir "${dir}" 2>/dev/null || true)"
      [[ -n "${id}" ]] && remove_instance_artifacts "${id}"
      rm -rf -- "${dir}"
      log "removed temporary directory ${dir}"
    done
    [[ -d "${E2E_TMP_ROOT}" ]] && rm -rf -- "${E2E_TMP_ROOT}"
  fi
  # 2. Fallback for a run whose data directory is already gone (the system may prune
  #    /tmp): only instances reachable through the fixture names of the suite, and
  #    only those that did not exist before it started. An application of the panel
  #    running on this machine is neither.
  if [[ -n "${E2E_TMP_ROOT}" || -n "${E2E_INSTANCES_BEFORE}" ]]; then
    while read -r id; do
      [[ -n "${id}" ]] || continue
      if printf '%s\n' "${E2E_INSTANCES_BEFORE}" | grep -qx -- "${id}"; then continue; fi
      remove_instance_artifacts "${id}"
    done < <(suite_instances_by_name)
  fi
  return 0
}

cleanup_leftovers() { # [data-dir] — manual recovery for an earlier aborted run
  local dir="${1:-}" roots=() found parent
  if [[ -n "${dir}" ]]; then
    [[ -d "${dir}" ]] || fail "not a directory: ${dir}"
    roots=("${dir}")
  else
    while IFS= read -r found; do
      [[ -n "${found}" ]] && roots+=("${found}")
    done < <(find "${TMPDIR:-/tmp}" -maxdepth 2 -type d -name 'botpanel-e2e-*' 2>/dev/null | sort)
  fi

  local id
  if [[ "${#roots[@]}" -eq 0 ]]; then
    warn "no botpanel-e2e-* data directory found in ${TMPDIR:-/tmp}"
    # Without a data directory the only safe handle is the fixture names of the
    # suite; a container of the panel running on this machine is never a target.
    mapfile -t roots < <(suite_instances_by_name)
    if [[ "${#roots[@]}" -eq 0 ]]; then
      log "nothing to clean"
      return 0
    fi
    for id in "${roots[@]}"; do
      log "artifacts of instance ${id} (found by fixture name)"
      remove_instance_artifacts "${id}"
    done
    return 0
  fi

  for dir in "${roots[@]}"; do
    id="$(instance_id_for_dir "${dir}" 2>/dev/null || true)"
    log "data directory ${dir} belongs to instance ${id:-unknown}"
    [[ -n "${id}" ]] && remove_instance_artifacts "${id}"
    parent="$(dirname "${dir}")"
    rm -rf -- "${dir}"
    log "removed temporary directory ${dir}"
    case "$(basename "${parent}")" in
      botpanel-release-e2e.*) rm -rf -- "${parent}"; log "removed temporary directory ${parent}" ;;
    esac
  done
  return 0
}

usage() {
  cat <<'USAGE'
Usage: bash scripts/release.sh [options]

Options:
  --version <x.y.z>     Release this exact version (default: bump from the current one)
  --bump <kind>         patch | minor | major (default: patch)
  --notes <text>        Changelog text for this release
  --source <path>       Project to synchronise from (default: /opt/botpanel)
  --repo <path>         Repository to update (default: this script's parent)
  --remote <name>       Git remote to push to (default: origin)
  --branch <name>       Branch to push (default: the current branch)
  --skip-e2e            Do not run the Docker end-to-end suite (not recommended)
  --cleanup-e2e [dir]   Remove the containers, networks and temporary directories left
                        behind by an interrupted E2E run, then exit. Pass the run data
                        directory for an exact match; without it, every botpanel-e2e-*
                        directory under $TMPDIR is used
  --bump-production     Also write the new version into the source project
  --allow-dirty         Allow a dirty working tree (default: refuse)
  --no-push             Commit and tag locally, do not push
  --yes                 Do not ask for confirmation before committing
  --dry-run             Show what would be synced and validated, change nothing
  -h, --help            This help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --bump) BUMP="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --source) SOURCE_DIR="${2:-}"; shift 2 ;;
    --repo) REPO_DIR="${2:-}"; shift 2 ;;
    --remote) REMOTE="${2:-}"; shift 2 ;;
    --branch) BRANCH="${2:-}"; shift 2 ;;
    --skip-e2e) SKIP_E2E=1; shift ;;
    --cleanup-e2e)
      CLEANUP_E2E=1
      shift
      if [[ $# -gt 0 && -d "${1:-}" ]]; then CLEANUP_DIR="$1"; shift; fi
      ;;
    --yes) ASSUME_YES=1; shift ;;
    --bump-production) BUMP_PRODUCTION=1; shift ;;
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --no-push) NO_PUSH=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown option: $1" ;;
  esac
done

# Recovery mode: clean an interrupted run and exit. Deliberately before the
# working tree checks, so it works no matter what state the repository is in.
if [[ "${CLEANUP_E2E}" -eq 1 ]]; then
  command -v docker >/dev/null 2>&1 || fail "docker is required to clean up E2E artifacts"
  docker info >/dev/null 2>&1 || fail "the Docker daemon is not responding"
  step "Cleaning up E2E leftovers"
  cleanup_leftovers "${CLEANUP_DIR}"
  log "done"
  exit 0
fi

for tool in git node npm rsync; do
  command -v "${tool}" >/dev/null 2>&1 || fail "${tool} is required"
done
[[ -d "${SOURCE_DIR}/server/src" && -d "${SOURCE_DIR}/web/src" ]] || fail "not a BotPanel project: ${SOURCE_DIR}"
[[ -d "${REPO_DIR}/.git" ]] || fail "not a git repository: ${REPO_DIR} (run the release from inside the repository)"

cd "${REPO_DIR}"
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
[[ "${BRANCH}" == "HEAD" ]] && BRANCH="main"

# ---------------------------------------------------------------- versions
CURRENT="$(node -p 'require("./package.json").version')"
if [[ -z "${VERSION}" ]]; then
  case "${BUMP}" in
    patch|minor|major)
      VERSION="$(node -e '
        const [major, minor, patch] = process.argv[1].split(".").map(Number);
        const kind = process.argv[2];
        if (kind === "major") console.log(`${major + 1}.0.0`);
        else if (kind === "minor") console.log(`${major}.${minor + 1}.0`);
        else console.log(`${major}.${minor}.${patch + 1}`);
      ' "${CURRENT}" "${BUMP}")" ;;
    *) fail "--bump must be patch, minor or major" ;;
  esac
fi
[[ "${VERSION}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "invalid version: ${VERSION}"

step "Release v${VERSION} (current: v${CURRENT})"
log "source:     ${SOURCE_DIR}"
log "repository: ${REPO_DIR}"
log "branch:     ${BRANCH} → ${REMOTE}"

if [[ "${DRY_RUN}" -eq 0 ]] && ! git config user.email >/dev/null 2>&1; then
  fail "no git identity in this repository. Configure one (locally) first:
    git config user.name \"Your Name\"
    git config user.email \"you@example.com\""
fi

if [[ "${ALLOW_DIRTY}" -eq 0 && "${DRY_RUN}" -eq 0 ]]; then
  if [[ -n "$(git status --porcelain)" ]]; then
    git status --short
    fail "the repository has uncommitted changes; commit or discard them first (or use --allow-dirty)"
  fi
fi

# ------------------------------------------------------------ sync manifest
# Directories that mirror the source project exactly (rsync --delete keeps them
# in sync, so deleted files disappear from the repository too).
SYNC_DIRS=(
  "server/src"
  "server/tests"
  "web/src"
  "web/tests"
)
# Single files taken from the source project.
SYNC_FILES=(
  "package.json"
  "package-lock.json"
  "server/package.json"
  "server/tsconfig.json"
  "server/tsconfig.test.json"
  "server/vitest.config.ts"
  "web/package.json"
  "web/index.html"
  "web/tsconfig.json"
  "web/tsconfig.test.json"
  "web/vite.config.ts"
  "web/vitest.config.ts"
)

step "Synchronising source files"
for dir in "${SYNC_DIRS[@]}"; do
  if [[ ! -d "${SOURCE_DIR}/${dir}" ]]; then
    warn "missing in the source project, skipped: ${dir}"
    continue
  fi
  mkdir -p "${REPO_DIR}/${dir}"
  rsync -a --delete \
    --exclude 'node_modules' --exclude 'dist' --exclude '.DS_Store' --exclude '*.log' \
    ${DRY_RUN:+--dry-run --itemize-changes} \
    "${SOURCE_DIR}/${dir}/" "${REPO_DIR}/${dir}/"
done
for file in "${SYNC_FILES[@]}"; do
  if [[ ! -f "${SOURCE_DIR}/${file}" ]]; then
    warn "missing in the source project, skipped: ${file}"
    continue
  fi
  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "  (dry-run) copy ${file}"
  else
    mkdir -p "$(dirname "${REPO_DIR}/${file}")"
    cp -p "${SOURCE_DIR}/${file}" "${REPO_DIR}/${file}"
  fi
done

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo
  log "Dry run: nothing else was executed."
  log "The version would become v${VERSION}, and the following files would change:"
  git status --short || true
  exit 0
fi

# -------------------------------------------------------------------- version
step "Setting the version to ${VERSION}"
npm version "${VERSION}" --workspaces --include-workspace-root --no-git-tag-version --silent >/dev/null
node -e 'const fs=require("fs");for(const p of ["package.json","server/package.json","web/package.json"]){const j=JSON.parse(fs.readFileSync(p,"utf8"));if(j.version!==process.argv[1]){console.error(`version mismatch in ${p}: ${j.version}`);process.exit(1)}}' "${VERSION}"
log "package.json (root, server, web) are all at ${VERSION}"

# ------------------------------------------------------------------ changelog
step "Updating CHANGELOG.md"
RELEASE_DATE="$(date -u +%F)"
NOTES="${NOTES:-See the commit history for the changes in this release.}"
NOTES="${NOTES}" RELEASE_VERSION="${VERSION}" RELEASE_DATE="${RELEASE_DATE}" node - <<'NODE'
const fs = require("node:fs");
const file = "CHANGELOG.md";
let text = fs.readFileSync(file, "utf8");
const version = process.env.RELEASE_VERSION;
const date = process.env.RELEASE_DATE;
const notes = process.env.NOTES;

if (new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(text)) {
  console.log(`CHANGELOG.md already has a section for ${version} — leaving it untouched.`);
  process.exit(0);
}

const section = `## [${version}] - ${date}\n\n${notes}\n\n`;
const anchor = /^## \[Unreleased\]\n\n/m;
if (!anchor.test(text)) {
  console.error("CHANGELOG.md has no `## [Unreleased]` section");
  process.exit(1);
}
text = text.replace(anchor, (match) => `${match}${section}`);

// link references at the bottom
text = text.replace(
  /^\[Unreleased\]: .*$/m,
  `[Unreleased]: https://github.com/MaelllDev/discord-bot-host/compare/v${version}...HEAD`,
);
if (!text.includes(`[${version}]: `)) {
  text = text.replace(/^(\[Unreleased\]: .*)$/m, `$1\n[${version}]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v${version}`);
}
fs.writeFileSync(file, text);
console.log(`CHANGELOG.md: added ${version} (${date})`);
NODE

# README badge
if grep -q 'version-[0-9]\+\.[0-9]\+\.[0-9]\+-' README.md; then
  sed -i "s|version-[0-9]\+\.[0-9]\+\.[0-9]\+-|version-${VERSION}-|" README.md
  log "README.md badge updated to ${VERSION}"
fi

# ------------------------------------------------------------------ validation
if [[ ! -d "${REPO_DIR}/node_modules" ]]; then
  step "Installing repository dependencies"
  npm ci --no-audit --no-fund
fi

step "Typecheck"
npm run typecheck

step "Tests (backend + frontend)"
npm test

step "Production build"
npm run build

if [[ "${SKIP_E2E}" -eq 0 ]]; then
  step "Docker end-to-end suite"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    # Leftovers from an earlier run are reported, never touched: they belong to
    # another release. `--cleanup-e2e` removes them on purpose.
    leftovers="$(find "${TMPDIR:-/tmp}" -maxdepth 2 -type d -name 'botpanel-e2e-*' 2>/dev/null | sort || true)"
    if [[ -n "${leftovers}" ]]; then
      warn "a previous E2E run left something behind:"
      printf '%s\n' "${leftovers}" | sed 's/^/    /' >&2
      warn "clean it with: bash scripts/release.sh --cleanup-e2e"
    fi

    # Sandbox: the suite runs with TMPDIR pointed at a directory this process owns,
    # so its data directory lands where we can find and remove it even when the run
    # is killed. Both traps remove the containers and networks it created.
    E2E_TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/botpanel-release-e2e.XXXXXX")"
    E2E_INSTANCES_BEFORE="$(docker_instances)"
    trap 'cleanup_e2e' EXIT
    trap 'cleanup_e2e; exit 130' INT TERM

    TMPDIR="${E2E_TMP_ROOT}" BOTPANEL_E2E=1 npm run test:e2e

    # Normal path: free everything now instead of at exit (idempotent).
    cleanup_e2e
  else
    fail "Docker is not available — run with --skip-e2e to release without it (not recommended)"
  fi
else
  warn "Docker E2E skipped (--skip-e2e)"
fi

# ------------------------------------------------------------- safety checks
step "Repository safety checks"
FORBIDDEN_PATHS=( ".env" ".session-secret" ".initial-password" "node_modules" "dist" "botpanel.db" )
for path in "${FORBIDDEN_PATHS[@]}"; do
  found="$(git ls-files --cached --others --exclude-standard | grep -E "(^|/)${path}(/$|\$)" || true)"
  [[ -n "${found}" ]] && fail "forbidden path would be committed: ${found}"
done

# Deliberate fakes used by the test suite: they exist precisely to prove that
# the redaction works. Anything else that looks like a credential still stops
# the release.
KNOWN_FAKE_FIXTURES='MTIzNDU2Nzg5MDEyMzQ1Njc4\.Gh1jKl\.abcdefghijklmnopqrstuvwxyz1234567|sk-ant-teste|OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz|senha-de-teste|e2e-secret'

# no secrets in the files that will be committed
SECRET_HITS="$(git ls-files --cached --others --exclude-standard -z | xargs -0 -r grep -nIE \
  '(gsk_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,}|sk-ant-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,}|Bot [A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{25,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)' \
  2>/dev/null | grep -vE "${KNOWN_FAKE_FIXTURES}" || true)"
if [[ -n "${SECRET_HITS}" ]]; then
  echo "${SECRET_HITS}"
  fail "possible secret found — investigate before releasing"
fi

PRIVATE_IP_HITS="$(git ls-files --cached --others --exclude-standard -z | xargs -0 -r grep -nIE \
  '(^|[^0-9])(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})' \
  2>/dev/null || true)"
if [[ -n "${PRIVATE_IP_HITS}" ]]; then
  echo "${PRIVATE_IP_HITS}"
  fail "private IP address found — remove it before releasing"
fi
log "no forbidden paths, secrets or private IP addresses in the release"

# --------------------------------------------------------------------- commit
step "What will be committed"
git add -A
git status --short
git diff --cached --stat | tail -20

if git diff --cached --quiet; then
  fail "nothing to commit — the repository is already up to date"
fi

if [[ "${ASSUME_YES}" -eq 0 ]]; then
  printf '\n'
  read -r -p "Commit, tag v${VERSION} and push to ${REMOTE}/${BRANCH}? [y/N] " answer
  [[ "${answer}" =~ ^[Yy]$ ]] || fail "aborted by the user"
fi

git commit -m "$(cat <<EOF
release: v${VERSION}

${NOTES}
EOF
)"
git tag -a "v${VERSION}" -m "BotPanel v${VERSION}"

if [[ "${NO_PUSH}" -eq 1 ]]; then
  warn "not pushing (--no-push): commit and tag v${VERSION} exist only locally"
else
  step "Pushing to ${REMOTE}/${BRANCH}"
  git push "${REMOTE}" "${BRANCH}"
  git push "${REMOTE}" "v${VERSION}"
  log "pushed v${VERSION}"
  log "create the GitHub release from the tag: https://github.com/MaelllDev/discord-bot-host/releases/new?tag=v${VERSION}"
fi

# --------------------------------------------------------------- production v
if [[ "${BUMP_PRODUCTION}" -eq 1 ]]; then
  step "Writing the version into ${SOURCE_DIR} (production)"
  for file in "package.json" "server/package.json" "web/package.json"; do
    if [[ -f "${SOURCE_DIR}/${file}" ]]; then
      node -e '
        const fs = require("node:fs");
        const file = process.argv[1];
        const json = JSON.parse(fs.readFileSync(file, "utf8"));
        json.version = process.argv[2];
        fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
      ' "${SOURCE_DIR}/${file}" "${VERSION}"
      log "updated ${SOURCE_DIR}/${file}"
    fi
  done
  warn "restart the service to pick it up: systemctl restart botpanel"
fi

printf '\n'
log "Released v${VERSION}"
