# Cloudflare Tunnel

The panel can expose **itself** to the internet through Cloudflare Zero Trust by running
`cloudflared` in a container it manages. This is a **panel integration**, not an application: it has
its own page, its own container and its own settings, and it never appears in the applications list.

```text
Internet ──HTTPS──> Cloudflare edge ──tunnel──> botpanel-cloudflared ──HTTP──> BotPanel :8080
```

There is no inbound port on the VPS, no certificate to renew and no reverse proxy to keep — the
connector dials **out** to Cloudflare.

## What this version does (and does not) do

| Does | Does not (yet) |
|---|---|
| Create, keep, start, stop, restart and remove the `cloudflared` container | Create the tunnel or the DNS record through the Cloudflare API |
| Keep the tunnel up across reboots (`unless-stopped`), while respecting **Disconnect** | Terminate TLS itself (Cloudflare does) |
| Report the real connection state from the `cloudflared` logs | Add a Cloudflare Access policy for you |
| Store the tunnel token as a secret and redact it from every output | Support a `credentials.json` (locally-managed) tunnel |

**Create the tunnel first, in the dashboard.** This version works with the token of a
*remotely-managed* tunnel: Zero Trust → **Networks → Tunnels → Create a tunnel** → type
**Cloudflared** → the screen that follows shows the connector token. Copy the token and ignore the
`docker run` command it prints — the panel runs that container for you.

> Tunnels created with `cloudflared tunnel create` on the VPS are **locally-managed** and use a
> `credentials.json`, not a token. They are not supported by this integration.

## Prerequisites

- A tunnel already created in **Cloudflare Zero Trust** → Networks → Tunnels (Cloudflared type).
- The domain you want to use is in the same Cloudflare account.
- Docker reachable by the panel (the page shows `Docker unavailable` otherwise).
- The panel answering on port 8080. The container is created with
  `--add-host host.docker.internal:host-gateway`, so `http://host.docker.internal:8080` reaches the
  panel from inside the container — that is the URL to use as the tunnel service. No host networking
  and no published port on the panel are needed.

## Configuring it

1. **Copy the token** from the Cloudflare Zero Trust screen of the tunnel you created.
2. In the panel, open **Cloudflare Tunnel** (sidebar → *Manage*) and paste it into **Tunnel token**.
3. Leave **Connect with the panel** on if the tunnel should come back after a reboot, then press
   **Save**.
4. Press **Connect**. The panel pulls `cloudflare/cloudflared:latest` when it is not cached yet,
   creates the container and waits for the initial state.
5. Back in the dashboard, add a **Public hostname** to the tunnel:
   - Subdomain: whatever you want (for example `panel`)
   - Service: **HTTP**
   - URL: **`host.docker.internal:8080`**
6. **Protect it with Cloudflare Access** (Zero Trust → Access → Applications → Self-hosted). Without
   a policy the panel is reachable by anyone on the internet and the only barrier is its password —
   Cloudflare Access adds an identity check *in front of* the login.

If a token is already saved, the form shows `Token configured (eyJh••••fQ==)` and the input stays
hidden until you press **Replace token**. Saving without typing a token keeps the stored one — the
API never returns the secret, so an empty field cannot mean "delete it".

## Container specification

| Property | Value |
|---|---|
| Name | `botpanel-cloudflared` (fixed) |
| Image | `cloudflare/cloudflared:latest` (internal to the integration) |
| Command | `tunnel --no-autoupdate run --token <TOKEN>` |
| Restart policy | `unless-stopped` |
| Network | default `bridge` — **no published ports** (the tunnel is outbound-only) |
| Extra hosts | `host.docker.internal:host-gateway` (so the panel can be the tunnel target) |
| Capabilities | `CapDrop: ["ALL"]`, `no-new-privileges` |
| Logs | `json-file`, 5 MB × 1 file |
| Labels | `botpanel.managed=1`, `botpanel.component=cloudflare-tunnel`, `botpanel.instance=<id>` |

Note the labels: the container deliberately does **not** carry `botpanel.app`, which is the label the
application reconciliation uses. That is what keeps the connector out of the applications list and
away from cleanup of the user's containers. The instance label makes two panels sharing a Docker
daemon independent — and it is also why a container with the same name created by something else is
**never** adopted, stopped or removed: the panel reports `containerNameTaken` and leaves it alone.

## Boot behaviour

| `enabled` (Connect with the panel) | What the panel does at boot |
|---|---|
| on | Inspects the container, realigns `unless-stopped`, creates it if it is missing and starts it when it is not running. Never creates a duplicate. |
| off | Does nothing. A tunnel you disconnected is **not** resurrected. |

**Disconnect** stops the container and stores the intent (`enabled=false`) without deleting the token
or the container — it follows the same precedence rule as *Stop* on an application. **Remove
configuration** is the destructive one: it removes the container and deletes the token.

## Actions

| Action | What it does |
|---|---|
| **Connect** | Validates the config, ensures the image, creates the container when needed, applies `unless-stopped`, starts it and waits for the initial state. Also sets `enabled=true`. |
| **Disconnect** | Stops the container and sets `enabled=false`. Keeps the token and the container. |
| **Restart** | Realigns the restart policy and restarts the container, creating it if it does not exist. |
| **Test connection** | Read-only diagnosis: inspects the container and the logs. It never creates, recreates or restarts anything, and fails with `cloudflare.notConnected` when the container is up but no connection was registered. |
| **Remove configuration** | Asks for confirmation, removes the container and clears the stored configuration (token included). A container that is not ours is refused instead of removed. |

## Status semantics

Two different things are reported, and they are not the same:

- `containerStatus` — what Docker says about the container (`running`, `exited`, `crashed`…).
- `state` — whether the tunnel is **connected to Cloudflare**.

| `state` | Meaning |
|---|---|
| `not_configured` | No token saved yet. |
| `stopped` | Configured, container not running, and the panel is not supposed to keep it up. |
| `starting` | Container is up for less than 30 s and no connection was logged yet. |
| `connected` | A connection was registered in the `cloudflared` logs (`Registered tunnel connection`). |
| `disconnected` | Container running, no connection in the logs (and past the starting window). |
| `error` | A failure was found in the logs, the container exited/crashed, or the container is missing while the integration is enabled. |
| `unknown` | Docker is unreachable, so nothing can be asserted. |

A running container is **never** reported as a connected tunnel: the connection is inferred from the
connector's own log lines, and the most recent evidence wins (a tunnel that connected and then failed
is shown as an error, not as connected forever).

## Diagnostics

**Diagnostics** on the page loads the last 120 lines of the connector (up to 300 through the API) and
passes every line through redaction, which removes the stored token value, its URL-encoded form and
the generic credential patterns used before sending logs to an AI provider. Logs are read on demand
and never stored by the panel.

The same content is available over HTTP:

```bash
curl -s -b cookie.txt 'http://127.0.0.1:8080/api/cloudflare/logs?lines=120'
```

## HTTP API

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/api/cloudflare` | Safe state (never the token) |
| `GET` | `/api/cloudflare/logs?lines=` | Redacted connector logs (1–300, default 120) |
| `PUT` | `/api/cloudflare` | `{ token?, enabled? }` — a missing/empty `token` keeps the existing one |
| `POST` | `/api/cloudflare/connect` | Create/start and wait for the initial state |
| `POST` | `/api/cloudflare/disconnect` | Stop and record the intent |
| `POST` | `/api/cloudflare/restart` | Restart without losing configuration |
| `POST` | `/api/cloudflare/test` | Diagnosis only |
| `DELETE` | `/api/cloudflare` | Remove container and configuration |

All of them require a session cookie. The token is only ever accepted in the `PUT` body — never in a
query string.

```json
{
  "tunnel": {
    "configured": true,
    "enabled": true,
    "tokenSet": true,
    "tokenHint": "eyJh••••fQ==",
    "state": "connected",
    "containerName": "botpanel-cloudflared",
    "containerId": "9c1f…",
    "image": "cloudflare/cloudflared:latest",
    "restartPolicy": "unless-stopped",
    "containerStatus": "running",
    "uptimeSeconds": 3610,
    "exitCode": null,
    "dockerAvailable": true,
    "lastError": null,
    "lastErrorCode": null,
    "lastConnectedAt": "2026-09-28T09:12:04.000Z"
  }
}
```

## How the secret is stored

See [security](security.md#cloudflare-tunnel-token) for the reasoning. In short: the token lives in
the panel's own SQLite database (`settings`, key `cloudflare.tunnel`) next to the AI key, is never
returned by the API (`tokenSet` + masked hint only), never written to logs, errors, labels, URLs,
container names or the frontend, and is redacted from every log line the panel shows. There is no
encryption at rest: the project has no secret vault, and encrypting with a key stored next to the
data would not protect anything — the protection is the permission of the data directory
(`/var/lib/botpanel`, mode `0750`, owned by root) plus the secret never leaving the process. The
token does live in the container's command line (that is how `cloudflared` receives it), visible to
anyone who can inspect containers on the host — which is already equivalent to root.

## Error codes

The API returns stable codes and the page translates them.

| Code | HTTP | When |
|---|---|---|
| `cloudflare.tokenRequired` | 400 | Connect/restart/test without a saved token |
| `cloudflare.tokenInvalid` | 400 | The token does not look like a token (too short, spaces, control characters) |
| `cloudflare.dockerUnavailable` | 503 | The Docker daemon is not answering |
| `cloudflare.imagePullFailed` | 400 | `cloudflare/cloudflared:latest` could not be prepared |
| `cloudflare.containerStartFailed` | 400 | The container could not be created or started |
| `cloudflare.containerMissing` | – (state) | Enabled, but the container does not exist (reported as `error`) |
| `cloudflare.containerNotFound` | 400 | Test with no container yet |
| `cloudflare.containerNameTaken` | 409 | A container with the panel's connector name belongs to something else |
| `cloudflare.connectionFailed` | – (state) | The connector is up but its logs show a failure |
| `cloudflare.notConnected` | 400 | Test while the tunnel has no registered connection |

Token shape is only checked for sanity; authenticity is decided by `cloudflared` itself when it
connects. A wrong token therefore shows up as `error` + `cloudflare.connectionFailed` with the
connector's own message in **Diagnostics**.

## Roadmap (not implemented here)

- **Cloudflare API integration**: create the tunnel and the DNS record from the panel with an API
  token, and feed the connector token to `cloudflared` automatically.
- **`credentials.json` support**: run a locally-managed tunnel created with the CLI, by mounting the
  credentials file and generating a `--config`.
- Automatic Cloudflare Access application/policy creation for the exposed hostname.
