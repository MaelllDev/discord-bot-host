# Troubleshooting

Start with these three commands; they answer most questions:

```bash
sudo systemctl status botpanel --no-pager
sudo journalctl -u botpanel -n 100 --no-pager
docker ps -a --filter label=botpanel.app
```

## The installer stops: no systemd (containers, Codespaces)

```
[!] This host is not running systemd, so the BotPanel service cannot be installed here.
```

That is the installer refusing to pretend. The production installation *is* a systemd service, and
containers (Docker, GitHub Codespaces, dev containers, CI runners) do not run systemd as PID 1, so
there is nothing to install the unit into. The check runs before Docker, Node.js, dependencies or
files are touched, so the machine is left exactly as it was and the script exits non-zero.

| What you actually want | What to do |
|---|---|
| The normal installation | Run the installer on the VPS/host itself, not inside a container. |
| Build only, run the panel by hand | `sudo bash scripts/install.sh --no-service` (prints the exact start command, never claims an installation). |
| Active development | `npm install` then `npm run dev` + `npm run dev:web` — no root needed. See [development.md](development.md). |

## The service restarts forever with `status=200/CHDIR`

```
botpanel.service: Changing to the requested working directory failed: No such file or directory
botpanel.service: Failed at step CHDIR spawning /usr/bin/node: No such file or directory
Process: ExecStart=/usr/bin/node .../server/dist/index.js (code=exited, status=200/CHDIR)
```

The unit hardens the service with `ProtectHome=yes`, which makes `/root`, `/home` and `/run/user`
**invisible** to it. If the project lives inside one of those directories (`/root/discord-bot-host`,
`/home/you/botpanel`…), systemd cannot enter it, so the unit restarts in a loop and the panel never
answers. Two ways out:

```bash
# Option A (recommended) — move the project to the documented location
sudo systemctl stop botpanel
sudo mv /root/discord-bot-host /opt/botpanel
sudo sed -i 's|/root/discord-bot-host|/opt/botpanel|g' /etc/systemd/system/botpanel.service
sudo systemctl daemon-reload && sudo systemctl restart botpanel

# Option B — keep it where it is and relax that one directive
sudo sed -i 's|^ProtectHome=yes|ProtectHome=read-only|' /etc/systemd/system/botpanel.service
sudo systemctl daemon-reload && sudo systemctl restart botpanel
```

Re-running the installer also fixes it: it now detects a project inside a home directory, warns and
installs to `/opt/botpanel` (or uses `ProtectHome=read-only` when `--panel-dir` points into a home on
purpose).

## The installer fails the health check

```
[!] The panel is not answering on http://127.0.0.1:8080/api/health.
...
[x] BotPanel was NOT installed successfully: the systemd service is not serving the panel.
```

The installer now prints the unit status and the last journal lines before exiting non-zero, and it
never prints the URL in this case. Nothing is rolled back; fix the cause and run it again (it is
idempotent). The usual causes are the ones listed in [the panel does not start](#the-panel-does-not-start)
below: a port already in use, a wrong `ExecStart`/`NODE_BIN`, an unparsable environment file. To wait
longer on a slow machine, set `BOTPANEL_INSTALL_HEALTH_TIMEOUT=120` (seconds).

## The panel does not start

| Check | Command |
|---|---|
| Service state and last error | `systemctl status botpanel --no-pager` |
| Panel log | `journalctl -u botpanel -n 100 --no-pager` |
| Unit file (paths correct?) | `systemctl cat botpanel` |
| Environment file parsed? | `sudo bash -c 'set -a; . /etc/botpanel.env; set +a; env \| grep BOTPANEL_'` |
| Port already in use | `ss -ltnp \| grep 8080` |
| Data directory writable | `sudo ls -ld /var/lib/botpanel` |

Common causes:

- **`Cannot find module .../server/dist/index.js`** — the build never ran or failed:
  `cd /opt/botpanel && npm ci && npm run build`.
- **Node too old** — `node -v` must be ≥ 22. Install with
  `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs`.
- **`EADDRINUSE`** — another service holds the port; change `BOTPANEL_PORT` or stop the other service.
- **`EACCES` on the Docker socket** — the panel cannot talk to Docker: `sudo systemctl status docker`
  and confirm `BOTPANEL_DOCKER_SOCKET` matches `docker context inspect`.
- **Permission denied writing the data directory** — `sudo chown -R root:root /var/lib/botpanel &&
  sudo chmod 750 /var/lib/botpanel`.

## Docker unavailable

The dashboard shows every application as **unknown** and an amber banner appears. This is
intentional: the panel reports what the daemon tells it instead of pretending applications are
stopped.

```bash
sudo systemctl status docker
sudo systemctl restart docker
docker info | head -5
```

The panel reconnects by itself (the unit uses `Wants=` and not `Requires=`), so restarting Docker
does not require restarting the panel.

## Cloudflare Tunnel

The page reports two different things on purpose: the **container** state (Docker) and the **tunnel**
state (connection to Cloudflare). A container that is `running` is not the same as a tunnel that is
connected — only a `Registered tunnel connection` line in the connector logs makes the page say
*Connected*. Start with the connector itself:

```bash
docker ps -a --filter name=botpanel-cloudflared
docker inspect botpanel-cloudflared --format '{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}'
docker inspect botpanel-cloudflared --format '{{json .Config.Labels}}'
docker logs --tail 100 botpanel-cloudflared
```

| Symptom | Cause / fix |
|---|---|
| *Not configured* | No token saved. Paste the connector token from Cloudflare Zero Trust and **Save** |
| *Docker unavailable* | The panel cannot reach the daemon — see [Docker unavailable](#docker-unavailable). Nothing else on the page can be trusted until it is back |
| Stuck in *Starting* | Normal for the first ~30 s after **Connect**. After that, the connector has not registered a connection yet — open **Diagnostics** |
| *No connection* (container running) | The connector is up but never registered: usually a wrong/expired token, or no route to Cloudflare (outbound HTTPS 7844/UDP 7844 blocked by the firewall). The connector's own message appears in **Diagnostics** |
| *Error* right after **Connect** with `containerNameTaken` | Something else already uses the name `botpanel-cloudflared`. The panel deliberately refuses to touch a container that is not its own — remove or rename that container, then connect again |
| *Error* with `imagePullFailed` | `cloudflare/cloudflared:latest` could not be pulled: no outbound internet, or the registry is blocked |
| Tunnel is *Connected* but the URL does not open | The tunnel's **Public hostname** is missing or points somewhere else. It must be service **HTTP** and URL `host.docker.internal:8080` |
| URL opens but shows a Cloudflare error | The hostname resolves to the tunnel but the panel is not answering: `curl -s http://127.0.0.1:8080/api/health` on the VPS |
| Tunnel came back after a restart you did not want | **Connect with the panel** is on. Press **Disconnect** — that records the intent and the boot will not restart it |
| Tunnel does not start after a reboot | **Connect with the panel** is off (or was turned off by **Disconnect**). Enable it and **Save**, then **Connect** |
| Need to start over | **Remove configuration** deletes the container and the token; create a new connector token in Cloudflare and paste it again |

Rarely useful, but explicit: the panel never publishes a port for the connector, so `ss -ltnp`
showing nothing new after **Connect** is expected behaviour, not a failure.

If the tunnel-created hostname is protected with **Cloudflare Access**, a browser error about the
identity provider is a Cloudflare-side policy problem, not a panel problem.

## Login problems

| Symptom | Cause / fix |
|---|---|
| "Invalid password" and you never set one | The generated password is in `<DATA_DIR>/.initial-password` (read it on the server: `sudo cat`). With the default installer it is also in `/etc/botpanel.env` |
| "Invalid password" and no env var is set | Use **Forgot your password?** on the login screen: the panel writes a one-time token to `<DATA_DIR>/reset-token` (valid 15 minutes) and you set a new password with it. The current password is never shown or logged |
| "Invalid password" and `BOTPANEL_PASSWORD` is set | **Forgot your password?** explains it on screen: the password comes from the service environment file (`/etc/botpanel.env` on a default install). Edit it and run `sudo systemctl restart botpanel` |
| Login works, then you are logged out immediately | `BOTPANEL_COOKIE_SECURE=1` without HTTPS. Set it to `0` until TLS works |
| Everyone is logged out after a restart | `BOTPANEL_SECRET` changed (or the `.session-secret` file was deleted). Set a fixed `BOTPANEL_SECRET` to control this |
| "Too many attempts" | The login throttle is per client address; wait a minute or restart the service |

## An application will not start

1. Open the application → **Logs**: the real error is there.
2. Check the deployment log in the **Releases** tab (dependency installation errors appear there).
3. Inspect the container:
   ```bash
   docker ps -a --filter label=botpanel.app=<slug>
   docker logs --tail 100 botpanel-<slug>
   docker inspect botpanel-<slug> --format '{{.State.ExitCode}} {{.State.Error}} {{.State.OOMKilled}}'
   ```
4. Frequent causes:
   - **Exit code 137 / `OOMKilled: true`** — the application exceeded its RAM limit. Raise the limit
     in **Configuration** or fix the leak.
   - **Exit code 1 with a Python traceback** — a missing module: the dependency file must be in the
     uploaded package and the panel installs it during the deploy. Re-deploy after fixing
     `requirements.txt`.
   - **`ModuleNotFoundError` even with the file present** — the install step failed; check the
     deployment log for the pip error (a wrong package name is the usual reason).
   - **Entry file not found** — the entry in **Configuration** must be the path relative to the
     project root inside the uploaded package.
   - **Rebuild loop** — the process exits immediately. Turn off *restart automatically* while you
     debug, otherwise the logs keep being replaced by new boots.

## Dependency installation fails

The deployment log shows the exact command and its output. Reproduce it manually:

```bash
# Node.js
docker run --rm -v /var/lib/botpanel/apps/<slug>/releases/<N>:/app -w /app node:22-slim npm install

# Python
docker run --rm -v /var/lib/botpanel/apps/<slug>/releases/<N>:/app -w /app python:3.12-slim \
  pip install --requirement requirements.txt
```

Typical reasons: no network access from the host, a private dependency without credentials, a native
module requiring build tools (`python3`, `make`, `g++` are not in the slim images), or a
`package.json` with an invalid version range.

## Uploads fail

- **`413 Payload Too Large`** — raise `BOTPANEL_MAX_UPLOAD_MB` **and** your proxy's body limit
  (`client_max_body_size` in Nginx).
- **`400` about the archive** — the package is corrupt or contains absolute/`..` paths (rejected on
  purpose), or a single file is bigger than the limit.
- The form accepts `.zip`, `.7z`, `.rar`, `.tar.gz` and `.tar.xz`. Encrypted archives are not
  supported.
- **`400` for a large `.7z`/`.rar`/`.tar.gz`/`.tar.xz`** — those formats are read in memory and
  capped at 256 MB; re-zip the project as `.zip` (which streams) to upload it.

## WebSocket / logs

| Symptom | Cause / fix |
|---|---|
| Logs never load, console stays empty | A proxy in front of the panel is not forwarding the upgrade: add `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` |
| "Reconnecting…" in a loop with Docker up | Check `journalctl -u botpanel`; the panel may be failing to attach to the container |
| Logs show `[painel] o container iniciou uma nova execução — histórico anterior limpo` | Normal: the application restarted and the screen was cleared to show only the current run |
| Old logs disappear when restarting | Intended behaviour; use the **Logs** tab download button before restarting if you need the history |

## Files

- **"Caminho inválido" / rejected path** — traversal outside the release or `/data` is refused.
- **Empty file list** — the application was created but has no published release yet.
- **Save fails with permission denied** — the file is owned by another UID. Fix ownership on the host:
  `sudo chown -R 1000:1000 /var/lib/botpanel/apps/<slug>`.

## Backups

- **"Publique um release antes"** — backups require an active release.
- **Backup stuck in `generating`** — check `journalctl -u botpanel`; a very large `/data` takes time.
  The ZIP is written under `apps/<slug>/backups`.
- **Disk full** — delete old backups on the **Backups** page and prune releases
  (`BOTPANEL_KEEP_RELEASES`).

## AI analysis

| Error | Fix |
|---|---|
| "Model does not exist or you do not have access" | Press **find models** and pick one from the list — provider catalogues change constantly |
| "Missing API key" | Type the key and save before analyzing |
| Timeouts | Lower the number of lines sent, or switch to a smaller/faster model |
| Wrong provider format | Check "provider" matches the key (a Groq key on the OpenAI endpoint returns 401) |
| Ollama | Use a base URL reachable from the panel, e.g. `http://127.0.0.1:11434/v1`, and make sure the model is pulled |

## The interface shows a blank page

Recent versions render an error message when a page fails (error boundary) instead of a white
screen. If you still see nothing:

1. Open the browser console (`F12`) and check for a failed request or a JS error.
2. Confirm the frontend build is being served: `curl -s http://127.0.0.1:8080/ | head -5` should
   return HTML with `assets/index-*.js`.
3. Hard-reload (`Ctrl+Shift+R`). The panel serves `index.html` with `max-age=0`, so a normal reload
   should be enough.
4. In development, `BOTPANEL_DISABLE_STATIC=1` means the frontend comes from Vite
   (`npm run dev:web`), not from the backend.

## systemd

```bash
sudo systemctl daemon-reload            # after editing the unit
sudo systemctl restart botpanel
sudo systemctl enable botpanel          # start on boot
systemctl is-enabled botpanel
sudo systemctl reset-failed botpanel    # clear a failed state
```

If the service restarts in a loop, look at `journalctl -u botpanel -n 200` — a bad environment file
(a value with spaces or missing quotes) or a wrong `ExecStart` path are the usual reasons.

## Nothing above helped

Collect this before asking for help:

```bash
systemctl status botpanel --no-pager
journalctl -u botpanel -n 200 --no-pager
node -v; docker --version; docker info --format '{{.ServerVersion}}'
cat /etc/os-release | head -3
```
