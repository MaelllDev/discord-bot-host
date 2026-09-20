# Changelog

All notable changes to BotPanel are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

This is the **initial public release**. The project was developed and used privately on a single VPS
before being published, so there is no earlier version history to import.

## [Unreleased]

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

[Unreleased]: https://github.com/MaelllDev/discord-bot-host/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/MaelllDev/discord-bot-host/releases/tag/v1.0.0
