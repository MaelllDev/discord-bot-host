# Changelog

All notable changes to BotPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the **initial public release**. The project was developed and used privately on a single VPS
before being published, so there is no earlier version history to import.

## [Unreleased]

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

[Unreleased]: https://github.com/MaelllDev/discord-bot-host/compare/v1.0.3...HEAD
[1.0.3]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.3
[1.0.2]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.2
[1.0.1]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.1
[1.0.0]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.0
