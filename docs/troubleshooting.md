# Troubleshooting

Start with these three commands; they answer most questions:

```bash
sudo systemctl status botpanel --no-pager
sudo journalctl -u botpanel -n 100 --no-pager
docker ps -a --filter label=botpanel.app
```

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

## Login problems

| Symptom | Cause / fix |
|---|---|
| "Invalid password" and you never set one | The generated password is in `/etc/botpanel.env`, in `journalctl -u botpanel \| grep -i senha`, or in `<DATA_DIR>/.initial-password` |
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
     ZIP and the panel installs it during the deploy. Re-deploy after fixing `requirements.txt`.
   - **`ModuleNotFoundError` even with the file present** — the install step failed; check the
     deployment log for the pip error (a wrong package name is the usual reason).
   - **Entry file not found** — the entry in **Configuration** must be the path relative to the
     project root inside the ZIP.
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
- **`400` about the archive** — the ZIP is corrupt or contains absolute/`..` paths (rejected on
  purpose), or a single file is bigger than the limit.
- The form accepts `.zip` only.

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
