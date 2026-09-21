# Development

## Requirements

- Node.js ≥ 22 and npm
- Docker (only for the end-to-end suite and to exercise real containers)
- Linux is assumed for anything Docker-related; the backend itself is plain Node.js

## Getting started

```bash
git clone https://github.com/MaelllDev/discord-bot-host.git
cd discord-bot-host
npm install
```

Run the backend with reload and the frontend with hot module replacement:

```bash
# terminal 1 — backend on :8080, reading from a throwaway data directory
BOTPANEL_DATA_DIR=/tmp/botpanel-dev \
BOTPANEL_PASSWORD=dev \
BOTPANEL_DISABLE_STATIC=1 \
npm run dev

# terminal 2 — Vite on :5173, proxying /api (and the WebSocket) to :8080
npm run dev:web
```

Open <http://localhost:5173> and log in with `dev`.

`BOTPANEL_DISABLE_STATIC=1` stops the backend from serving `web/dist`, so the frontend you see is
the Vite one. Useful extra variables while developing:

```bash
BOTPANEL_MAX_UPLOAD_MB=64 BOTPANEL_KEEP_RELEASES=2 BOTPANEL_DOCKER_SOCKET=/var/run/docker.sock npm run dev
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | backend with `node --watch` (TypeScript executed directly by Node) |
| `npm run dev:web` | Vite dev server |
| `npm run build` | frontend build, then backend build (`tsc`) |
| `npm run typecheck` | `tsc --noEmit` for the backend, the backend tests, the frontend and the frontend tests |
| `npm test` | backend unit/integration tests + frontend render tests |
| `npm run test:e2e` | Docker end-to-end suite (`BOTPANEL_E2E=1`, needs root) |
| `npm run test --workspace server -- --watch` | backend tests in watch mode |

## Layout

```
server/src/
  index.ts          boot: config → server → reconcile → auto start → listen
  server.ts         Fastify wiring, static files, security hooks
  config.ts         environment → PanelConfig
  db.ts             schema, migrations, every query
  auth.ts           password + session cookie + throttle
  apps/             detect · spec · service · files · backups · uploads · status · paths
  docker/           service (client) · parse (stats/logs) · templates (image + commands)
  routes/           auth · apps · files · ai · system
  ws/stream.ts      per-application WebSocket
  ai/               providers · prompt (incl. redaction) · service
  util/             archive · fsx · format · mutex · slug · paths · zipwrite
server/tests/       unit, integration and Docker E2E tests
web/src/
  pages/            Dashboard · Apps · AppDetail · NewApp · Backups · System · Settings · Login
  components/       Layout · AppCard · AppIcon · dialogs · panels/ · ui.tsx · Toasts · ErrorBoundary
  api.ts            typed API client (single place issuing requests)
  hooks.ts          useAsync · useAppStream · useDeployment
web/tests/          render tests (jsdom)
```

## Conventions

- **TypeScript everywhere, strict mode.** `noUncheckedIndexedAccess` is on, so index accesses must be
  narrowed.
- **ES modules** with explicit `.ts` extension in relative imports (Node executes TypeScript directly
  in development).
- **The backend is the source of truth.** The frontend never talks to Docker and never fabricates
  state: if the daemon is unreachable the API says `unknown` and the UI shows `unknown`.
- **Comments explain *why*.** Non-obvious decisions (retry semantics, stop intent, log run stamps)
  carry a short comment with the reasoning; avoid restating the code.
- **Errors** are `ValidationError` / `NotFoundError` / `ConflictError`; the route layer turns them
  into status codes.
- **No new runtime dependency without a good reason** — the backend currently runs on Fastify,
  dockerode, zod, yauzl/yazl and nothing else.
- **The UI is in Brazilian Portuguese** and the documentation in English. Keep UI strings consistent
  with the rest of the interface when you touch a page.

## Adding a page

1. Create the component in `web/src/pages/`, export it and add the route in `web/src/App.tsx`.
2. Add the API call to `web/src/api.ts` and the response type to `web/src/types.ts`.
3. If the data needs polling, use `useAsync(..., { pollMs })` — it pauses while the tab is hidden.
4. Add a render test in `web/tests/` if the page has non-trivial logic: mounting the page in jsdom is
   what catches runtime-only failures (see `settings.render.test.tsx`).

## Adding a route

1. Add the Zod schema to `server/src/routes/validation.ts` (when there is a body).
2. Implement the handler in the matching `server/src/routes/*.ts` file, using `AppContext`.
3. Keep domain logic in `server/src/apps/**` — routes stay thin.
4. Cover it with a test in `server/tests/api.test.ts` (the suite uses `server.inject`, no network).

## Database changes

`server/src/db.ts` owns the schema. Add new columns with
`this.addColumnIfMissing("apps", "column_name", "TYPE NOT NULL DEFAULT …")` so existing installations
migrate on boot, then update `toApp`/`insertApp`/`updateApp` accordingly. Add a store test that
proves the round trip and the migration of an old database (`server/tests/store.test.ts` has an
example that creates a legacy table first).

## Testing

```bash
npm run typecheck       # types for backend, frontend and both test suites
npm test                # backend + frontend tests (no Docker needed)
npm run test:e2e        # full container lifecycle (root + Docker)
BOTPANEL_E2E_DOCKER_RESTART=1 npm run test:e2e   # also restarts the Docker daemon
npm run build           # must stay clean before a release
bash scripts/tests/install.test.sh   # installer behaviour (Docker required)
```

Notes:

- The Docker E2E suite uses its own temporary data directory and its own instance id, so it can run
  next to a production panel on the same machine. It requires `BOTPANEL_E2E=1`.
- Frontend render tests run in jsdom (`web/vitest.config.ts`). Mounting a page and asserting the
  visible text is the cheapest way to catch "it compiles but the page is blank".
- A failed test is a failed release: `scripts/release.sh` refuses to publish.

### Changing the installer

`scripts/install.sh` is the entry point most users meet first, and it must never lie: it reports a
production installation only after the systemd unit is active *and* `/api/health` answered. The suite
in `scripts/tests/install.test.sh` runs the installer inside a throwaway `ubuntu:24.04` container
with stubs for `systemctl`, `curl`, `npm`, `docker`, `node` and `hostname`, and covers four paths:

| Case | What it proves |
|---|---|
| no systemd, production mode | exits non-zero, explains why, suggests `--no-service`, touches nothing |
| `--no-service`, Docker up | builds the artifacts, exits 0, says the panel is **not** running, never claims otherwise |
| `--no-service`, Docker down | warns and still exits 0 (a build does not need the daemon) |
| systemd present, never healthy | exits non-zero, prints the diagnostics, prints no URL |
| systemd present, health OK | exits 0, renders the unit and prints the URL |

Add a case whenever you touch the installer, and run the suite before a release. `BOTPANEL_INSTALL_TEST_IMAGE`
overrides the base image.

## Debugging the Docker side

```bash
docker ps -a --filter label=botpanel.app
docker logs -f botpanel-<slug>
docker inspect botpanel-<slug> --format '{{json .HostConfig}}' | head -c 400
docker exec -it botpanel-<slug> sh          # inside the release (/app)
docker exec -it botpanel-<slug> ls /data    # persistent volume
```

The instance label is derived from the data directory, so containers from your development instance
are easy to tell apart from the production ones.
