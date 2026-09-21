# Installation

BotPanel runs on a Linux VPS with Docker and systemd. This document covers the automated installer,
the manual path, and what to check if something goes wrong.

- [Requirements](#requirements)
- [Automated installation](#automated-installation)
- [Hosts without systemd (containers, Codespaces)](#hosts-without-systemd-containers-codespaces)
- [Manual installation](#manual-installation)
- [Verifying the installation](#verifying-the-installation)
- [Where things live](#where-things-live)
- [Uninstalling](#uninstalling)

## Requirements

| Requirement | Notes |
|---|---|
| **Debian 12/13 or Ubuntu 22.04/24.04** | Other distributions work if they provide Docker, systemd and Node.js ≥ 22 (`--force`) |
| **Docker** | The daemon must be reachable at `/var/run/docker.sock` |
| **Node.js ≥ 22** with npm | Used to build the panel and to run it |
| **systemd** | The installation is a systemd service. It is required in production mode; the installer verifies it before touching the machine (see [Hosts without systemd](#hosts-without-systemd-containers-codespaces)) |
| **git** | Only to clone the repository |
| **root / sudo** | The panel talks to the Docker socket and sets the owner of the application files |

Check what you already have:

```bash
cat /etc/os-release | head -2
node -v            # expect v22 or newer
docker info        # expect Server Version on the first lines
systemctl --version | head -1
```

Minimum practical VPS: 1 vCPU / 1 GB RAM. The panel itself idles around 80–120 MB of RAM; each
application uses however much you allow it (`RAM` limit per application).

## Automated installation

```bash
git clone https://github.com/MaelllDev/discord-bot-host.git
cd discord-bot-host
sudo bash scripts/install.sh
```

What the script does, in order:

1. refuses to run as a normal user, checks the operating system and — in production mode — that
   **systemd is the init system** (`/run/systemd/system`); on a host without systemd it stops right
   there, before installing anything (see [below](#hosts-without-systemd-containers-codespaces)),
2. installs `ca-certificates curl gnupg openssl` when missing,
3. installs **Node.js 22.x** (NodeSource) when Node is missing or older than 22,
4. installs **Docker** (`docker.io`) when missing and enables the service,
5. fails early when the Docker daemon does not answer `docker info`,
6. copies the project to `--panel-dir` when you run it from another directory,
7. runs `npm ci` (or `npm install` without a lockfile),
8. runs `npm run build` (frontend, then backend),
9. creates the data directory (`/var/lib/botpanel`, mode `0750`),
10. creates `/etc/botpanel.env` from `.env.example` with a **random 24-character password**
    (an existing file is never overwritten) and `chmod 600`,
11. renders `deploy/botpanel.service` and installs it as
    `/etc/systemd/system/botpanel.service`, then `enable` + `restart`,
12. polls `http://127.0.0.1:<port>/api/health` (up to 45 seconds, or
    `BOTPANEL_INSTALL_HEALTH_TIMEOUT` seconds) until the body contains `"status":"ok"`
    **and** `systemctl is-active botpanel` reports the unit as active,
13. prints the URL, the password (when it generated one) and the useful commands.

**A failure is a failure.** If the unit fails to start or never answers `/api/health`, the installer
prints `systemctl status` and the last 40 journal lines and exits with a non-zero status. The URL and
the "open the panel and log in" instructions are printed *only* after the health check passed, so a
broken service can never look like a successful installation. Nothing is rolled back on failure: fix
the error above and run the installer again (it is idempotent).

### Options

```
--panel-dir <path>     where the project lives (default: the repository root)
--data-dir <path>      data directory (default: /var/lib/botpanel)
--env-file <path>      environment file (default: /etc/botpanel.env)
--port <number>        HTTP port written to the environment file (default: 8080)
--service-user <user>  user the service runs as (default: root)
--no-service           development/container mode: build only, no systemd unit and no start
--no-deps              do not install system packages (Docker/Node.js)
--force                continue on an unsupported distribution
--help                 list the options
```

`BOTPANEL_INSTALL_HEALTH_TIMEOUT` (environment, default `45`) sets how many seconds the installer
waits for `/api/health` before declaring the installation failed.

Examples:

```bash
# install under /srv/botpanel, listening on 9090
sudo bash scripts/install.sh --panel-dir /srv/botpanel --port 9090

# build only (you manage the process yourself, e.g. inside a container)
sudo bash scripts/install.sh --no-service
```

### Hosts without systemd (containers, Codespaces)

The production installation is a **systemd service**: it starts on boot and restarts on failure.
Containers (Docker, GitHub Codespaces, dev containers, CI runners) do not run systemd as PID 1, so
there is nothing to install the unit into. The installer detects that (`/run/systemd/system` missing)
and exits non-zero with an explanation, without installing Docker, Node.js, dependencies or files:

```
[!] This host is not running systemd, so the BotPanel service cannot be installed here.
    Detected: Linux Ubuntu 24.04.1 LTS without systemd as PID 1 (no /run/systemd/system).
    This is expected in containers: Docker, GitHub Codespaces, dev containers, CI runners.
    ...
    Nothing was installed, built or started.
```

To build and run the panel by hand in such an environment, ask for the development/container mode:

```bash
sudo bash scripts/install.sh --no-service
```

This mode builds the backend and the frontend, creates the data directory and the environment file,
and then **stops**: it prints that the service was not installed and that the panel is not running,
together with the exact commands to start it. It never prints a production URL and it tolerates a
missing Docker daemon with a warning (a build does not need Docker). Exit status is `0`, because you
explicitly asked for this mode.

```bash
# after --no-service, start the panel in the foreground
sudo -i
set -a; . /etc/botpanel.env; set +a
NODE_ENV=production node /opt/botpanel/server/dist/index.js
```

### Re-running the installer

`scripts/install.sh` is **idempotent** and is the supported update path:

```bash
cd /opt/botpanel && sudo bash scripts/install.sh
```

It keeps `/etc/botpanel.env` and the data directory untouched, rebuilds the code and restarts the
service. Your applications keep running during the rebuild (the restart takes a couple of seconds).

## Manual installation

```bash
# 1. Docker
sudo apt-get update && sudo apt-get install -y docker.io
sudo systemctl enable --now docker

# 2. Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash -
sudo apt-get install -y nodejs
node -v   # v22.x or newer

# 3. Source
git clone https://github.com/MaelllDev/discord-bot-host.git /opt/botpanel
cd /opt/botpanel
npm ci
npm run build

# 4. Configuration
sudo cp .env.example /etc/botpanel.env
sudo chmod 600 /etc/botpanel.env
sudo nano /etc/botpanel.env        # set BOTPANEL_PASSWORD at least

# 5. Data directory
sudo install -d -m 0750 /var/lib/botpanel

# 6. systemd unit
sudo sed -e 's|@PANEL_DIR@|/opt/botpanel|g' \
         -e 's|@DATA_DIR@|/var/lib/botpanel|g' \
         -e 's|@ENV_FILE@|/etc/botpanel.env|g' \
         -e "s|@NODE_BIN@|$(command -v node)|g" \
         -e 's|@SERVICE_USER@|root|g' \
         deploy/botpanel.service | sudo tee /etc/systemd/system/botpanel.service
sudo systemctl daemon-reload
sudo systemctl enable --now botpanel
```

If you prefer to run the panel in the foreground (useful to watch the first boot):

```bash
sudo set -a; . /etc/botpanel.env; set +a
NODE_ENV=production node server/dist/index.js
```

## Verifying the installation

```bash
# service state
systemctl status botpanel --no-pager

# last lines of the panel log
journalctl -u botpanel -n 40 --no-pager

# health endpoint (no authentication)
curl -fsS http://127.0.0.1:8080/api/health     # {"status":"ok"}

# is the frontend being served?
curl -fsS http://127.0.0.1:8080/ | head -5

# is the Docker socket usable by the panel?
sudo -u root docker info --format '{{.ServerVersion}} {{.Containers}}'
```

Then open `http://<your-server-ip>:8080` and log in.

## Where things live

| Path | Content |
|---|---|
| `/opt/botpanel` | source and build (default `--panel-dir`) |
| `/etc/botpanel.env` | environment file (mode `0600`) |
| `/etc/systemd/system/botpanel.service` | the unit file |
| `/var/lib/botpanel` | data directory (`BOTPANEL_DATA_DIR`) |
| `/var/lib/botpanel/botpanel.db` | SQLite database (applications, releases, deployments, events, backups, AI analyses) |
| `/var/lib/botpanel/.session-secret` | generated cookie secret (mode `0600`) |
| `/var/lib/botpanel/apps/<slug>/releases/N` | immutable code of each release |
| `/var/lib/botpanel/apps/<slug>/shared` | the `/data` volume of the application |
| `/var/lib/botpanel/tmp/uploads` | uploaded ZIPs (pruned automatically) |

## Uninstalling

```bash
sudo systemctl disable --now botpanel
sudo rm /etc/systemd/system/botpanel.service
sudo systemctl daemon-reload

# containers and networks created by the panel
docker ps -a --filter label=botpanel.app --format '{{.Names}}' | xargs -r sudo docker rm -f
docker network ls --filter label=botpanel.managed --format '{{.Name}}' | xargs -r sudo docker network rm

# files
sudo rm -rf /opt/botpanel /var/lib/botpanel /etc/botpanel.env
```

> Deleting `/var/lib/botpanel` destroys the database and the `/data` volumes of every application.
> Back up whatever matters first (`/var/lib/botpanel/apps/*/shared`).
