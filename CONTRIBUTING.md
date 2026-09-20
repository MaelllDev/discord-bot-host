# Contributing

Thanks for wanting to help. BotPanel is a small, opinionated project: the goal is a private panel
that is easy to read, easy to self-host and hard to break.

## Before you start

- Open an **issue** first for anything bigger than a bug fix or a small improvement, so we can agree
  on the approach before you write code.
- Security problems do **not** go through issues — see [SECURITY.md](SECURITY.md).
- Read [docs/architecture.md](docs/architecture.md) and [docs/development.md](docs/development.md) to
  understand the layout and the conventions.

## Development setup

```bash
git clone https://github.com/MaelllDev/discord-bot-host.git
cd discord-bot-host
npm install

BOTPANEL_DATA_DIR=/tmp/botpanel-dev BOTPANEL_PASSWORD=dev BOTPANEL_DISABLE_STATIC=1 npm run dev
npm run dev:web        # in another terminal
```

## What a pull request should contain

1. **A focused change.** One topic per pull request.
2. **Tests** when behaviour changes:
   - backend logic → `server/tests/*.test.ts` (unit/integration, no Docker needed)
   - a page or a hook → `web/tests/*.render.test.tsx` (jsdom mount)
   - container lifecycle → extend `server/tests/e2e.docker.test.ts` (only when the change really
     needs Docker)
3. **A clean validation run**:
   ```bash
   npm run typecheck
   npm test
   npm run build
   ```
4. **No secrets, no production data.** Never commit `/etc/botpanel.env`, `botpanel.db`, uploaded
   ZIPs, application `shared` directories, API keys or tokens — not even as an example value. Use
   obvious placeholders such as `change-me`.
5. **Documentation** updated when you change a user-visible behaviour: `README.md`, `docs/`, and an
   entry under `## [Unreleased]` in `CHANGELOG.md`.

## Style

- TypeScript strict, no `any` without a reason in a comment.
- Keep comments about **why**, not **what**.
- The backend is the source of truth: the frontend must not invent state or talk to Docker.
- New runtime dependencies need a justification — the project deliberately keeps the dependency list
  short.
- The web interface is written in Brazilian Portuguese and the documentation in English; keep each
  one consistent with itself.

## Reporting a bug

Use the bug report template and include:

- what you did, what you expected, what happened;
- `systemctl status botpanel --no-pager` and the relevant `journalctl -u botpanel -n 100`;
- your OS, `node -v` and `docker --version`;
- the application's logs (with tokens removed!).

Never paste real tokens, passwords or private data in an issue. Replace them with `<redacted>`.
