# Production deployment

BotPanel speaks **plain HTTP**. It does not terminate TLS, it does not manage certificates and it
has no built-in multi-user or role model. Everything below assumes you own a VPS and want to keep the
panel reachable only by you.

## Recommended setup

```
Internet ──HTTPS──> Caddy/Nginx (TLS, :443) ──HTTP──> BotPanel (127.0.0.1:8080) ──> Docker
```

1. **Keep the panel on the loopback interface.**
   ```bash
   # /etc/botpanel.env
   BOTPANEL_HOST=127.0.0.1
   BOTPANEL_PORT=8080
   BOTPANEL_COOKIE_SECURE=1
   BOTPANEL_TRUST_PROXY=1
   ```
   ```bash
   sudo systemctl restart botpanel
   ```
2. **Terminate TLS** with a reverse proxy (next section).
3. **Firewall the machine**: allow 22/80/443, block everything else, never expose 8080 publicly.
   ```bash
   sudo ufw allow OpenSSH && sudo ufw allow 80 && sudo ufw allow 443 && sudo ufw enable
   ```
4. **Use a long panel password**, ideally via `BOTPANEL_PASSWORD_HASH` (see
   [configuration](configuration.md)).

> Order matters: set `BOTPANEL_COOKIE_SECURE=1` **after** HTTPS works. With it on and no HTTPS, the
> browser refuses to send the session cookie and you cannot log in.

## HTTPS with Caddy (simplest)

Caddy obtains and renews certificates automatically. `/etc/caddy/Caddyfile`:

```caddyfile
panel.example.com {
    encode gzip
    reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

Caddy forwards WebSocket upgrades automatically, which the panel needs for logs and metrics.

## HTTPS with Nginx

`/etc/nginx/sites-available/botpanel`:

```nginx
server {
    listen 443 ssl http2;
    server_name panel.example.com;

    ssl_certificate     /etc/letsencrypt/live/panel.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/panel.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # required for the log/console WebSocket
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 3600s;   # long-lived WebSocket connections
        client_max_body_size 512m;  # allow large package uploads (.zip/.7z/.rar/.tar.gz/.tar.xz)

        # note: gzip is fine for HTML/JS; do not buffer the WebSocket
        proxy_buffering off;
    }
}
```

Certificate with Certbot:

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
sudo ln -s /etc/nginx/sites-available/botpanel /etc/nginx/sites-enabled/botpanel
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d panel.example.com
```

`client_max_body_size` must be ≥ `BOTPANEL_MAX_UPLOAD_MB`, otherwise uploads die at the proxy with
`413`.

## Exposing the panel with Cloudflare Tunnel

An alternative to the reverse proxy above: the panel runs the Cloudflare connector itself, so the
panel is reachable over HTTPS with **no inbound port** on the VPS, no certificate to renew and no
`80/443` open in the firewall. Details: [cloudflare-tunnel.md](cloudflare-tunnel.md).

```
Internet ──HTTPS──> Cloudflare edge ──tunnel──> botpanel-cloudflared ──HTTP──> BotPanel 0.0.0.0:8080
```

1. Create the tunnel in **Cloudflare Zero Trust → Networks → Tunnels** (type *Cloudflared*) and copy
   its connector token.
2. In the panel: **Cloudflare Tunnel** → paste the token → *Connect with the panel* on → **Save** →
   **Connect**.
3. Add a **Public hostname** to the tunnel: service **HTTP**, URL `host.docker.internal:8080` — the
   container is created with `--add-host host.docker.internal:host-gateway`, so no host networking is
   needed for the panel to be reachable.
4. **Add a Cloudflare Access policy** for that hostname (e-mail OTP, or an IP allowlist).

Notes:

- Leave `BOTPANEL_HOST` at its default (`0.0.0.0`) for this setup: the connector reaches the panel
  through the Docker gateway address, not through the loopback interface.
- `BOTPANEL_TRUST_PROXY=1` is still useful so the login throttle and the journal see the real client
  address behind the tunnel.
- `BOTPANEL_COOKIE_SECURE=1` works here from the start, because the browser side really is HTTPS.
- The connector is managed like a service: it comes back with the VPS (`unless-stopped`) while
  *Connect with the panel* is on, and stays down after **Disconnect**.
- The tunnel exposes the panel **and nothing else**: your applications keep running locally, with the
  same isolation as before.

## Docker hardening on the host

- The panel needs the Docker socket. Anyone who can write to that socket can become root on the
  host — that is why the panel is not exposed publicly.
- Do not mount the Docker socket into the applications themselves (BotPanel never does).
- Keep Docker updated with the distribution: `sudo apt-get update && sudo apt-get upgrade docker.io`.
- Optional: cap Docker's own logging to avoid filling the disk (the panel already caps the logs of
  the containers it creates):
  ```json
  // /etc/docker/daemon.json
  { "log-driver": "json-file", "log-opts": { "max-size": "10m", "max-file": "3" } }
  ```
  ```bash
  sudo systemctl restart docker
  ```

## Backups of the panel itself

Two things matter:

1. **`<BOTPANEL_DATA_DIR>/botpanel.db`** — applications, releases, settings, AI configuration.
2. **`<BOTPANEL_DATA_DIR>/apps/<slug>/shared`** — the `/data` of each application (your bots'
   databases, sessions, files).

```bash
# stop the panel for a consistent SQLite snapshot, then copy
sudo systemctl stop botpanel
sudo tar -C /var/lib/botpanel -czf /root/botpanel-$(date +%F).tgz botpanel.db apps
sudo systemctl start botpanel
```

For per-application snapshots that can include `/data` in one ZIP, use the panel's own **Backups**
([details](backups.md)).

## Updating

```bash
cd /opt/botpanel
git pull
sudo bash scripts/install.sh
```

Applications keep running through the rebuild; the service restart is a couple of seconds. If the
release notes mention a database migration, it is automatic (additive `ALTER TABLE` statements) and
applied on boot.

## Health checks and monitoring

- `GET /api/health` returns `{"status":"ok"}` and needs no authentication.
- The **System** page shows Docker availability, host CPU/RAM/disk/load and the panel version.
- An external check (Uptime Kuma, a cron + curl) on `/api/health` is enough to notice the panel
  being down; the systemd unit already restarts it on failure (`Restart=always`).

## Capacity planning

| Resource | Guidance |
|---|---|
| Panel itself | ~80–120 MB RAM, negligible CPU when idle |
| Each application | Whatever you set as its RAM/CPU limit, plus ~10–20 MB of Docker overhead |
| Disk | `releases/` grow with every deploy — the retention policy (`BOTPANEL_KEEP_RELEASES`) caps it. `node_modules` inside each release is the biggest consumer |
| Docker images | Shared between applications using the same runtime; the panel never deletes images automatically |

If `/var/lib` is on a small partition, move `BOTPANEL_DATA_DIR` to a bigger disk (stop the service,
move the directory, update the environment file and the `ReadWritePaths=` of the unit, restart).
