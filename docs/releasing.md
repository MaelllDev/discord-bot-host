# How to publish a new release

This is the maintainer workflow. It takes the project you actually run (the working installation),
copies the source that belongs to the public repository, validates everything and publishes a
version.

```bash
cd /opt/botpanel-repository

# one-time setup: the repository needs a commit identity (local, not global)
git config user.name  "Your Name"
git config user.email "you@example.com"

bash scripts/release.sh --bump patch --notes "Fixed X and added Y"
```

The script installs the repository dependencies itself when `node_modules` is missing, runs the
complete validation suite and refuses to continue when anything fails.

## What the script does

| Step | Detail |
|---|---|
| 1. Checks | source project exists, the repository is a git repository, working tree is clean, `git`/`node`/`npm`/`rsync` are available |
| 2. Synchronises | mirrors `server/src`, `server/tests`, `web/src`, `web/tests` (with `rsync --delete`, so deleted files disappear) and copies `package.json`, `package-lock.json`, the `tsconfig`s, the vite/vitest configs and `web/index.html`. It reports how many directories and files it copied, and the step can be exercised on its own with `--sync-only`. |
| 3. Version | sets the new version on the root, `server/` and `web/` `package.json` with `npm version … --workspaces --include-workspace-root` and verifies the three match |
| 4. Changelog | inserts `## [x.y.z] - date` right after `## [Unreleased]` and updates the link references at the bottom |
| 5. README | updates the version badge |
| 6. Validation | `npm run typecheck`, `npm test`, `npm run build` and, unless skipped, the Docker E2E suite (`BOTPANEL_E2E=1 npm run test:e2e`) — **any failure aborts the release** |
| 6b. E2E sandbox | the suite runs with `TMPDIR` pointed at a directory the release owns, so its data directory can always be found; traps on `EXIT`/`INT`/`TERM` remove the containers, networks and temporary directories that run created, even when the script is killed |
| 7. Safety | refuses to commit `.env`, `node_modules`, `dist`, databases, `*.session-secret`, key/token patterns or private IP addresses |
| 8. Review | prints `git status --short` and a diff stat, then asks for confirmation |
| 9. Publish | commits `release: vX.Y.Z`, creates the annotated tag `vX.Y.Z`, pushes the branch and the tag |
| 10. Optional | `--bump-production` also writes the version into the source installation (the System page reads it from `server/package.json`, so only a restart is needed) |

## Options

| Option | Meaning |
|---|---|
| `--bump patch\|minor\|major` | How to increment (default `patch`) |
| `--version x.y.z` | Release an exact version instead of bumping |
| `--notes "text"` | Changelog text (default: a pointer to the commit history) |
| `--source /opt/botpanel` | Project to synchronise from |
| `--repo /path` | Repository to update (default: this repository) |
| `--remote origin`, `--branch main` | Where to push |
| `--skip-e2e` | Skip the Docker suite (not recommended; the release still needs typecheck/tests/build) |
| `--sync-only` | Copy the source files into the repository and stop: no version bump, no changelog, no validation. Used by `scripts/tests/release.test.sh`. |
| `--cleanup-e2e [dir]` | Remove what an interrupted E2E run left behind (containers, networks, temporary directories) and exit. With a data directory it targets that run exactly; without it, every `botpanel-e2e-*` directory under `$TMPDIR` is used |
| `--allow-dirty` | Allow a dirty working tree |
| `--no-push` | Commit and tag locally only |
| `--bump-production` | Also write the version into the source installation |
| `--yes` | Do not ask for confirmation |
| `--dry-run` | Show what would be synced; change nothing |

> **The synchronisation is verified, not assumed.** A release that reports success while nothing was
> copied is the worst kind of failure — it happened once: `${DRY_RUN:+--dry-run …}` expands for `"0"`
> as well (the string is non-empty), so every run rsynced in dry-run mode and published a version bump
> with no source changes. The script now compares `DRY_RUN` and prints the number of copied files, and
> the copy step is covered by `scripts/tests/release.test.sh`:
>
> ```bash
> bash scripts/tests/release.test.sh
> ```
>
> It builds a fake project and a throwaway git repository under `$TMPDIR` and asserts that a real run
> copies new and changed files, deletes what the source dropped, leaves the version and the changelog
> alone in `--sync-only` mode, and that `--dry-run` writes nothing. The working project and the real
> repository are never touched.

Recommended flow for a change:

```bash
# 0. dry run first, to see exactly which files the release would touch
bash scripts/release.sh --dry-run

# 1. develop and test in the working installation (/opt/botpanel)
npm run typecheck && npm test && npm run build

# 2. publish
bash scripts/release.sh --bump minor --notes "Adds X

- item one
- item two"

# 3. create the GitHub release from the tag (the script prints the link)

# 4. (optional) make the running panel report the new version
bash scripts/release.sh --version 1.1.0 --bump-production   # or: edit server/package.json
systemctl restart botpanel
```

## Which files belong to the repository

**Synchronised from the working project** (the code):

```
package.json · package-lock.json
server/{src,tests}/** · server/package.json · server/tsconfig*.json · server/vitest.config.ts
web/{src,tests}/** · web/index.html · web/package.json · web/tsconfig*.json
web/vite.config.ts · web/vitest.config.ts
```

**Owned by the repository** (never overwritten by a release):

```
README.md · CHANGELOG.md · LICENSE · NOTICE.md · CONTRIBUTING.md · SECURITY.md
.env.example · .gitignore · .github/** · docs/** · scripts/** · deploy/**
web/public/logo.png          # default logo, generated by scripts/generate-logo.mjs
```

**Never included** (production state and secrets):

```
/etc/botpanel.env · .session-secret · .initial-password · botpanel.db (+ -wal/-shm)
node_modules/ · dist/ · tmp/uploads/ · apps/*/releases/ · apps/*/shared/ · apps/*/backups/
application ZIPs · logs · any real token, key or private IP address
```

If you add a new top-level source directory, add it to `SYNC_DIRS` or `SYNC_FILES` in
`scripts/release.sh` and to this table.

## Before the first push of a fork

1. Replace the credits (README, `web/src/components/Credits.tsx`, `docs/releasing.md` links) with
   your own — or keep them if you are contributing upstream.
2. Check `NOTICE.md`: do not commit artwork you did not create.
3. Run `bash scripts/release.sh --dry-run` and read the file list.

## If an E2E run is interrupted

The Docker suite creates its own containers, networks and data directory. A complete run removes them
in its `afterAll`; a run that is killed (closed terminal, `Ctrl-C`, session died, failed assertion)
cannot — so `scripts/release.sh` cleans up after it with a trap, whether it fails or is interrupted.

To recover the leftovers of an **older** aborted run:

```bash
# what is there?
docker ps -a --filter label=botpanel.instance --format '{{.Names}} {{.Label "botpanel.instance"}}'
docker network ls --filter label=botpanel.instance --format '{{.Name}} {{.Label "botpanel.instance"}}'
find "${TMPDIR:-/tmp}" -maxdepth 2 -type d -name 'botpanel-e2e-*'

# remove one run exactly (the directory printed by the suite)
bash scripts/release.sh --cleanup-e2e /tmp/botpanel-e2e-XXXXXXXX

# or every run that left a data directory behind
bash scripts/release.sh --cleanup-e2e
```

Cleanup is always scoped: every container and network of a BotPanel instance carries the label
`botpanel.instance`, and the helper only deletes artifacts of the data directories you point it at
(or of instances that appeared while the suite was running). Applications of a panel running on the
same machine belong to a different instance and are never touched — verified against the running
panel before every release.

## If a release goes wrong

```bash
# the tag was created locally but the push failed
git tag -d v1.2.0
git reset --soft HEAD~1        # keep the changes staged

# the release is already public: never rewrite history — publish a fix
bash scripts/release.sh --bump patch --notes "Fixes the regression from 1.2.0"
```

The script never force-pushes and never rewrites published commits.
