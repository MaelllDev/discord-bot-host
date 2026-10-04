# Changelog

All notable changes to BotPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the **initial public release**. The project was developed and used privately on a single VPS
before being published, so there is no earlier version history to import.

## [Unreleased]

## [1.1.0] - 2026-10-04

Uploads now accept `.7z`, `.rar`, `.tar.gz` and `.tar.xz` next to `.zip` (`.tar`, `.tgz` and `.txz`
are accepted as aliases), for both a new application and a code update. `.zip` keeps the streaming
`yauzl` extractor; every other format is read with `libarchive-wasm` (MIT), which has no streaming
API and therefore caps those formats at 256 MB. Every entry is validated before it touches disk —
absolute and `..` paths are refused, so are symlinks, hardlinks and special files — and encrypted or
corrupt archives are rejected with a clear message. The detected root-folder stripping, runtime
detection and deploy pipeline are unchanged. The upload form and the update dialog now accept all of
the formats (with a clear inline message when another file type is dropped), and the API error for an
unsupported extension lists all of them.

Three new features ride on the existing deploy pipeline. **Restore backup**: a successful backup can
be restored as a new immutable release — the panel re-packs the `code/` folder of the backup ZIP and
runs the same extraction, dependency installation and activation as a manual upload (backups that
contain only the `/data` volume are refused with a clear message). **Deploy from URL**: the update
dialog accepts a direct http(s) link; the panel downloads the package with the same size cap as the
multipart upload and feeds it into the normal flow (only http/https are accepted, and the transfer
is aborted mid-stream if it exceeds the limit). **Metrics history**: the panel samples CPU and memory
once a minute into a new `metric_samples` table (≈25 h retained per application, pruned on insert),
and the application page shows a 24-hour chart, so a memory leak becomes visible before the OOM
killer strikes.

The panel can now expose **itself** through **Cloudflare Tunnel**, as a panel integration rather than
an application. Give it the connector token of a tunnel you created in Cloudflare Zero Trust and it
runs `cloudflare/cloudflared:latest` in a container it manages (`botpanel-cloudflared`,
`unless-stopped`, no published ports, no host networking), keeping the tunnel up across reboots while
respecting a deliberate disconnect. The container is labelled `botpanel.managed` /
`botpanel.component=cloudflare-tunnel` / `botpanel.instance` and deliberately **not** `botpanel.app`,
so it never appears in the applications list and is never touched by application cleanup; a container
with the same name that is not ours is refused rather than adopted. The token is stored in the panel
database, never returned by the API (only `tokenSet` plus a masked hint) and redacted from every log
line, error and state field the interface can see. Status is honest: "Connected" requires a
registered connection in the connector's own logs, a running container is not enough, and Docker being
unreachable is reported as `unknown`. The page has the full lifecycle (connect, disconnect, restart,
test connection, remove configuration with confirmation) plus a redacted **Diagnostics** panel. No
Cloudflare API is called in this version: create the tunnel and its public hostname in the dashboard
and point the hostname at `http://host.docker.internal:8080`. Covered by
`server/tests/cloudflare.test.ts` and `server/tests/e2e.cloudflare.test.ts`.

## [1.0.6] - 2026-10-04

Added `scripts/update.sh`, a one-command updater for existing installations:
`curl -fsSL .../scripts/update.sh | sudo bash`. It locates the panel through its systemd unit (so it
works whatever `--panel-dir` was used), brings the code to the newest published release — the newest
tag when no release is published, `git` when the directory is a clone and the release tarball
otherwise — then rebuilds through `scripts/install.sh` and waits for `/api/health`. A build that never
comes up is rolled back to the previous one and the service restarted with it. `--check` reports the
installed and available versions without changing anything, and `--ref <tag|branch>` pins a version.
The data directory and `/etc/botpanel.env` are never touched. Covered by
`scripts/tests/update.test.sh`.

Fixed the installer failing on the most natural clone location: a project installed inside a home
directory (`/root/discord-bot-host`, `/home/<user>/…`) never started, because the systemd unit
hardens the service with `ProtectHome=yes` and that directive makes `/root` and `/home` invisible to
it — systemd then failed to enter the working directory and the unit restarted forever with
`status=200/CHDIR`. When the location was not chosen explicitly and the clone lives in a home
directory, the installer now warns and installs to `/opt/botpanel` (keeping the strict
`ProtectHome=yes`); when `--panel-dir` points into a home directory on purpose, the unit is rendered
with `ProtectHome=read-only` so the service can still read its own build. `scripts/tests/install.test.sh`
covers both paths.

## [1.0.5] - 2026-09-27

Password recovery was reworked so no credential ever reaches the log. The login screen now always offers "Forgot your password?": when the panel owns the password (no BOTPANEL_PASSWORD / BOTPANEL_PASSWORD_HASH), it issues a single-use token valid for 15 minutes, written only to <DATA_DIR>/reset-token with mode 0600, and sets a new password (at least 8 characters) through it — the token is consumed on use, the bootstrap .initial-password file is deleted so the old password stops working, and every open session is invalidated. When the password comes from the environment, the entry explains how to change it on the server instead of pretending to reset it. Both endpoints are rate limited per client address (token creation: one request per 10 minutes; redemption: six attempts per 15 minutes) and invalid, expired or already-used tokens get the same response, so states cannot be enumerated. The password generated on first boot is no longer written to the journal either: the log only points to the 0600 file.

## [1.0.4] - 2026-09-27

Theme system with three options: light (new default, following the design language), dark, and the previous violet look as legacy — selectable from the navbar, login and settings. Language switcher rebuilt as a globe button with a menu. Applications page now toggles between cards and list with a persisted preference. Unsaved-changes bar on the application settings page with navigation blocking. Drag & drop ZIP upload in the update-code dialog, rejecting non-zip files with a clear message. New panel icons (favicon and logos) now ship with releases. Fixes: icon URL validator accepts internal upload paths, and the status watcher no longer throws unhandled rejections when the database closes on shutdown.

## [1.0.3] - 2026-09-25

New features: custom panel branding (name and icon), image uploads for application icons, Discord webhook notifications for application lifecycle events with per-webhook customization, and bilingual interface (pt-BR/English). Improvements: richer validation messages with translated error codes, Docker image existence check before deployment, cleaner application detail page, fixed sidebar with collapse button, and a dedicated backups page.

## [1.0.2] - 2026-09-21

### Added
- Complete redesign of the web interface: a rebuilt design system (buttons, fields, badges, segmented tabs, toggles, modals, metric tiles, skeletons, toasts) over a near-black surface palette with a violet/indigo accent.
- Fixed, collapsible sidebar with grouped navigation, an instance summary and a per-application status; sticky top bar showing the current page or application name, the Docker state and a shortcut to create an application.
- Rebuilt Dashboard (welcome block, KPI tiles, host capacity, recent activity) and refreshed the applications list, application detail, new-application wizard, console framing, settings, system and backups pages.
- Frontend render tests for the layout shell and the dashboard.

### Fixed
- The release workflow copied nothing: `${DRY_RUN:+--dry-run …}` expands for "0" as well, because that string is not empty, so every release ran rsync in dry-run mode and published a version bump with no source changes at all. The copy step now compares the variable, reports how many files it copied and is covered by scripts/tests/release.test.sh (a fake project plus a throwaway repository, also run in CI); --sync-only exercises the copy on its own.

## [1.0.1] - 2026-09-21

### Fixed
- The installer can no longer report an installation that did not happen: it verifies that systemd is really the init system (PID 1) before touching the machine, so inside containers (Docker, GitHub Codespaces, dev containers, CI runners) it stops at once with an explanation instead of building everything and failing later.
- A service that never answers /api/health now exits non-zero, prints the unit status and the journal, and the URL and the login instructions are printed only after the unit is active and the health check passed.
- --no-service is now an explicit development/container mode: it builds the project, states that the panel is not running, never prints production commands, and tolerates a missing Docker daemon with a warning.
### Added
- scripts/tests/install.test.sh: five installer cases running inside a throwaway container (no systemd, development mode with and without Docker, a service that never becomes healthy, and the normal healthy path), wired into the CI workflow.
- BOTPANEL_INSTALL_HEALTH_TIMEOUT to change how long the installer waits for /api/health (default 45 seconds).
- Documentation for hosts without systemd (docs/installation.md, docs/troubleshooting.md).
- `scripts/release.sh` now sandboxes the Docker E2E suite in a temporary directory it owns and removes the containers, networks and directories that run created when it fails or is interrupted; `--cleanup-e2e` recovers what an earlier aborted run left behind. Cleanup is scoped by the `botpanel.instance` label, so applications of a panel running on the same machine are never touched.

## [1.0.0] - 2026-09-20

First public release.

### Applications

- Create an application from a ZIP upload with automatic runtime detection (Node.js, Python, custom).
- Configurable entry file, dependency file, install and start commands, Docker image.
- Per-application limits: RAM, CPU (vCPU) and process (PID) count.
- Environment variables per application, with a secret flag that masks the value in the UI.
- Optional published ports (`hostPort:containerPort`) and a custom icon URL for the dashboard.
- One Docker container and one Docker network per application, running as an unprivileged UID with
  dropped capabilities and `no-new-privileges`.
- Persistent `/data` volume, never touched by deploys, updates or rollbacks.

### Deploy, releases and rollback

- Deploys extract the ZIP (zip-slip protected), strip a single wrapper folder, install dependencies
  inside a disposable container in the release, then recreate the application container.
- Immutable releases (`releases/N`) with instant rollback and a configurable retention policy.
- A failed dependency installation keeps the previous release running and reports the real error.
- Two independent automation switches: *start with the system* and *restart automatically*
  (mapped to Docker restart policies; a deliberate stop is always respected).

### Observability and control

- Real-time log stream over WebSocket (`stdout`/`stderr`), with filtering, auto-scroll, download and
  a clear-view button. Lines are stamped with the run they belong to, so a restart clears the screen
  instead of mixing executions.
- Interactive console (stdin) with command history.
- Live CPU, memory, PID, uptime and status metrics.
- Start, stop, restart, update code, rollback and delete actions, all following the real state of the
  container (Docker unavailable is reported as `unknown`, never as stopped).
- File manager for the code (active release) and the persistent `/data`, with editing, upload,
  download, folder creation, rename and delete.
- Backups: ZIP of the code and, optionally, of `/data`; create, download and delete per application
  or from a global page.
- Dashboard with totals, online/stopped/unknown counters, host capacity and per-application cards,
  auto-refreshing without a manual reload.
- System page with Docker status/version, host CPU/RAM/disk/load and the effective configuration.

### AI log analysis (optional)

- Bring-your-own-key support for OpenAI, Anthropic, Google Gemini, DeepSeek, Groq, OpenRouter,
  Ollama and any OpenAI-compatible endpoint.
- Model discovery from the provider, connection test, configurable line count and temperature.
- Secret redaction (key prefixes, auth headers, Discord tokens, JWTs, `secret=value` pairs,
  credentials in URLs) before the excerpt leaves the server.
- Analysis history per application, including the exact excerpt that was sent.

### Interface and platform

- Dark responsive interface with a fixed, collapsible sidebar.
- Route-level error boundary, toasts, skeletons and confirmation dialogs for destructive actions.
- Single-administrator authentication (plain password or scrypt hash), signed `httpOnly` session
  cookie, login throttling and logout that invalidates every issued session.
- SQLite storage with automatic, additive migrations.
- systemd unit template, installer that is also the updater, and documented environment file.
- Test suite: backend unit/integration tests, frontend render tests (jsdom) and a Docker
  end-to-end suite covering the full container lifecycle.

[Unreleased]: https://github.com/MaelllDev/discord-bot-host/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.1.0
[1.0.6]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.6
[1.0.5]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.5
[1.0.4]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.4
[1.0.3]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.3
[1.0.2]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.2
[1.0.1]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.1
[1.0.0]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.0
