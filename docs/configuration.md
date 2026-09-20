# Configuration

BotPanel reads its configuration from the process environment. The installer writes
`/etc/botpanel.env` and the systemd unit loads it with `EnvironmentFile=-/etc/botpanel.env`.

Nothing in the environment is baked into the build, so changing a value only requires editing the
file and restarting the service:

```bash
sudo nano /etc/botpanel.env
sudo systemctl restart botpanel
```

Everything except `BOTPANEL_PASSWORD` has a default. The template with comments is
[`.env.example`](../.env.example).

## Variables

### Access and session

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOTPANEL_PASSWORD` | **yes** (in practice) | *(random, generated)* | Password used to log in. When empty, the panel generates one on first boot, logs it and stores it in `<BOTPANEL_DATA_DIR>/.initial-password`. Example: `BOTPANEL_PASSWORD=my-long-panel-password` |
| `BOTPANEL_PASSWORD_HASH` | no | – | `scrypt$<salt>$<hash>` alternative to the plain password. Takes precedence when both are set. |
| `BOTPANEL_SECRET` | no | *(generated)* | Secret used to sign the session cookie (HMAC-SHA256). When empty, a random secret is generated and stored in `<BOTPANEL_DATA_DIR>/.session-secret` (mode `0600`) so sessions survive restarts. Minimum 16 characters. |
| `BOTPANEL_SESSION_TTL_HOURS` | no | `168` | Session lifetime in hours (7 days). After that the panel returns to the login screen. |

Generating a password hash:

```bash
node -e '
  const { scryptSync, randomBytes } = require("node:crypto");
  const password = process.argv[1];
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  console.log(`scrypt$${salt}$${hash}`);
' 'your-password'
```

Put the output in `BOTPANEL_PASSWORD_HASH` and remove/clear `BOTPANEL_PASSWORD`.

### Network

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOTPANEL_HOST` | no | `0.0.0.0` | Interface to bind. Use `127.0.0.1` when a reverse proxy on the same machine is the only client. |
| `BOTPANEL_PORT` | no | `8080` | HTTP port. |
| `BOTPANEL_COOKIE_SECURE` | no | `0` | `1` marks the session cookie `Secure` (only sent over HTTPS). Set it **after** HTTPS works, otherwise you cannot log in over plain HTTP. |
| `BOTPANEL_TRUST_PROXY` | no | `0` | `1` makes Fastify trust `X-Forwarded-*` headers (rate limiting and logs use the real client IP). Only enable behind a proxy you control. |
| `BOTPANEL_NAME` | no | `BotPanel` | Name shown in the sidebar and page titles. |

### Storage

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOTPANEL_DATA_DIR` | no | `/var/lib/botpanel` | Database, releases, `/data` volumes, temporary uploads. The panel **derives an instance identifier from this path**, so two panels with different data directories never touch each other's containers. |
| `BOTPANEL_DOCKER_SOCKET` | no | `/var/run/docker.sock` | Docker daemon socket. |
| `BOTPANEL_MAX_UPLOAD_MB` | no | `512` | Maximum ZIP upload size in MB. |
| `BOTPANEL_KEEP_RELEASES` | no | `10` | Releases kept per application. `0` keeps everything. Older releases are pruned after a successful deploy. |

### Containers

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOTPANEL_RUN_UID` | no | `1000` | UID used inside the containers and owner of the application files on the host. |
| `BOTPANEL_RUN_GID` | no | `1000` | Same for the group. |
| `BOTPANEL_ALLOWED_IMAGES` | no | *(any)* | Comma-separated whitelist of Docker images. Example: `node:22-slim,python:3.12-slim`. Anything not listed is rejected by the API — useful to stop a typo from pulling a random image. |

### Development only

| Variable | Required | Default | Description |
|---|---|---|---|
| `BOTPANEL_DISABLE_STATIC` | no | – | `1` stops serving the built frontend (use it together with the Vite dev server). Never set it in production. |
| `BOTPANEL_E2E` | no | – | `1` enables the Docker end-to-end suite. |
| `BOTPANEL_E2E_DOCKER_RESTART` | no | – | `1` also restarts the Docker daemon during the E2E run. |

## Settings that are **not** environment variables

- **AI provider configuration** (enabled/providers/model/base URL/line count/temperature and the API
  key) is edited in the panel and stored in the `settings` table of the SQLite database. Keys are
  never returned by the API — the interface only learns that a key exists and gets a masked hint.
- **Per-application configuration** (name, description, icon, runtime, image, entry file,
  dependency file, commands, RAM, CPU, PID limit, environment variables, ports, automation switches)
  lives in the database and is edited in the application's **Configuration** tab.
- **Secrets in the environment file** stay there; the panel shows them in the *Settings* page
  (read-only) and never exposes password values through the API.

## Verifying the effective configuration

The **Settings** page shows exactly what the process is running with (`GET /api/system`), including
the data directory, the Docker socket, the runtime UID/GID, the release retention and the session
TTL. Anything that disagrees with your file means the service was not restarted.

```bash
curl -s http://127.0.0.1:8080/api/system | head -c 300   # requires a session cookie
```

## Security notes

- `/etc/botpanel.env` contains the panel password: keep it `chmod 600` and owned by root.
- If `BOTPANEL_COOKIE_SECURE=1` and you access the panel over HTTP, login will not work by design.
- Changing `BOTPANEL_SECRET` invalidates existing sessions (everyone is logged out).
- Changing `BOTPANEL_DATA_DIR` makes the panel look at a different database — it will not find your
  applications (and, being a different instance, it will not touch the old containers).
