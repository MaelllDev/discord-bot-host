# Security model

This document describes what BotPanel actually implements. It does not claim that the system is
"secure" — it lists the guarantees, the assumptions and the known gaps so you can decide how to run
it.

## Threat model

BotPanel is an **administrative interface for a machine you own**. The realistic threats it defends
against:

- an application misbehaving (crash loop, memory leak, fork bomb, greedy CPU) affecting the others;
- one application reading or writing another application's files;
- an application reaching the network of another application;
- leaked credentials in logs;
- an unauthenticated stranger reaching the panel over the network;
- the panel becoming reachable from the internet by accident (see [Cloudflare Tunnel](#cloudflare-tunnel-token)).

What it does **not** defend against:

- a malicious container image you deliberately choose (running arbitrary code is the point);
- someone with root on the host (they already own everything);
- a compromised provider you send logs to (see [AI analysis](ai-analysis.md));
- side channels of the kernel/Docker themselves.

## Authentication and sessions

- Single administrator password, configured through `BOTPANEL_PASSWORD` (plain) or
  `BOTPANEL_PASSWORD_HASH` (`scrypt$salt$hash`, 64-byte key, 16-byte random salt, verified with
  `timingSafeEqual`). The hash wins when both are present.
- Failed logins are throttled per client address; the throttle is in memory and resets on restart.
- The session is a **signed** cookie (`botpanel_session`), HMAC-SHA256 over
  `epoch.expiry.random`, `httpOnly`, `SameSite=Lax`, `Secure` when `BOTPANEL_COOKIE_SECURE=1`,
  valid for `BOTPANEL_SESSION_TTL_HOURS`.
- A `session_epoch` value in the database makes **logout invalidate every session ever issued**
  (all cookies become invalid, not just the browser's copy).
- The secret used for signing is either `BOTPANEL_SECRET` or a randomly generated one stored in
  `<BOTPANEL_DATA_DIR>/.session-secret` (mode `0600`).
- Any `401` from the API redirects the interface to the login screen.
- There is no second factor, no user list and no per-application permission — by design.

### Password recovery

- The **Forgot your password?** entry is always visible on the login screen, but the reset itself is
  offered **only** when neither `BOTPANEL_PASSWORD` nor `BOTPANEL_PASSWORD_HASH` is set — that is,
  when the panel itself owns the password (a password generated on first boot, or one already reset
  through this flow). With the environment variables set, the service owns the credential: the entry
  explains how to change it on the server, and the token/reset routes are not even registered (`404`).
- The flow never reveals or logs the current password. The panel issues a **single-use token**
  (32 random bytes) valid for 15 minutes and writes it to `<BOTPANEL_DATA_DIR>/reset-token` with mode
  `0600`; only someone with server access can read it. Only the SHA-256 hash of the token is kept in
  memory, and a pending token is discarded on restart (a leftover file is deleted at boot).
- Redeeming a token requires a password of at least 8 characters, stores only a `scrypt` hash in the
  database, deletes `<BOTPANEL_DATA_DIR>/.initial-password` (so the old bootstrap password stops
  working) and invalidates every open session (`session_epoch`).
- Invalid, expired and already-used tokens get the **same** error response, and both endpoints are
  rate limited per client address (token creation: one request per 10 minutes; redemption: six
  attempts per 15 minutes).
- The public `GET /api/auth/recover` only answers whether recovery is available — it is what makes
  the login screen hide the link.

## Container isolation

Every application gets:

| Control | Value |
|---|---|
| Container | one per application, named `botpanel-<slug>` |
| Network | its own bridge network (`botpanel-net-<slug>`) |
| Capabilities | `CapDrop: ["ALL"]` |
| Privilege escalation | `no-new-privileges` |
| User | `BOTPANEL_RUN_UID:BOTPANEL_RUN_GID` (default `1000:1000`), never root |
| Memory | `Memory` = `MemorySwap` = your limit (no swap) |
| CPU | `NanoCpus` quota |
| Processes | `PidsLimit` (default 256) |
| Filesystem | only the release (`/app`) and the persistent directory (`/data`) are mounted |
| Logs | `json-file`, 5 MB × 3 files per container |
| Restart policy | derived from the two automation switches |

Processes started inside a container share the kernel with the host: the controls above are cgroup
and namespace limits, not a virtual machine. A container escape (kernel vulnerability) is out of
scope, as is protecting the host from code you intentionally run.

The **Cloudflare Tunnel connector** is a panel integration, not an application: it runs
`cloudflare/cloudflared:latest` with `CapDrop: ["ALL"]`, `no-new-privileges`, `unless-stopped`, no
published ports and `json-file` logs capped at 5 MB × 1 file. It is identified by its own labels
(`botpanel.component=cloudflare-tunnel` + `botpanel.instance`) and the panel refuses to touch a
container with that name that is not ours.

## Cloudflare Tunnel token

- The tunnel token is stored in the panel's database (`settings`, key `cloudflare.tunnel`) beside the
  AI key. It is **never returned by the API**: the interface receives `tokenSet: true` and a masked
  hint (`eyJh••••fQ==`). Saving the form without typing a token keeps the stored one.
- Every log line, error message and state field the panel produces passes through redaction, which
  removes the stored token value, its URL-encoded form and the generic credential patterns listed
  under [AI redaction](#ai-redaction). The connector's own output is redacted before it reaches the
  **Diagnostics** panel or `GET /api/cloudflare/logs`.
- The token is never accepted through a query string, never written to URL paths, container names or
  container labels, and never stored in the browser (no `localStorage`, no persisted frontend state).
- It **does** appear in the container's command line (`cloudflared … --token <TOKEN>`), which is how
  the connector receives it. Anyone able to inspect containers on the host can read it — that is
  already equivalent to root on the host, which is the trust level the panel assumes anyway.
- There is **no encryption at rest**. The project has no secret vault and encrypting the value with a
  key stored next to it would not protect anything; the protections that exist are the permissions of
  the data directory (`/var/lib/botpanel`, mode `0750`, owned by root) and the secret never leaving
  the process. The same applies to the AI key and to the panel password hash.
- **Remove configuration** deletes the token from the database and the container from Docker. A
  *Disconnect*, in contrast, keeps both — it only stops the connector and records that the user does
  not want it running.

### Exposing the panel through a tunnel

The tunnel removes the need for an inbound port, but it does not make the panel safer by itself:

1. Create the tunnel in Cloudflare Zero Trust and paste its token into the panel.
2. Point the tunnel's public hostname at `http://host.docker.internal:8080`.
3. **Add a Cloudflare Access policy** (self-hosted application, e-mail OTP or an IP allowlist) for
   that hostname. Without it, the panel's single password is the only barrier between the internet
   and an administrative interface that can control Docker on your VPS.
4. The connector reaches the panel through the **Docker gateway**, so the panel has to listen on a
   container-reachable address: keep `BOTPANEL_HOST` at `0.0.0.0` (its default). Binding it to
   `127.0.0.1` would leave the connector with nothing to connect to. That is the trade-off of this
   setup — the port is no longer loopback-only, so the host firewall is what keeps 8080 closed from
   the outside (allow 22/80/443 and the Docker network, block the rest).

If you can avoid publishing the panel at all, do it: the tunnel is a convenience, not a hardening
step.

## Filesystem and path safety

- Uploaded packages (`.zip`, `.7z`, `.rar`, `.tar.gz`, `.tar.xz`) are extracted entry by entry: absolute paths, `..`
  segments and paths escaping the target directory are rejected, and the archive is size-checked
  before extraction. Symlinks, hardlinks and special files are refused, and macOS/Windows junk is
  skipped. Encrypted archives are rejected.
- The file manager only serves two roots per application: the active release (`code`) and the
  persistent directory (`data`). The resolved path is verified to stay inside of them, so
  `../../etc/passwd` and symlink escapes are refused.
- Files created inside a container are owned by `BOTPANEL_RUN_UID`; the panel adjusts ownership of
  the release and the persistent directory after a deploy.
- Uploaded packages live in `<BOTPANEL_DATA_DIR>/tmp/uploads` and are pruned periodically. `.7z`,
  `.rar`, `.tar.gz` and `.tar.xz` are decompressed **in memory** (capped at 256 MB) because the WASM
  decoder has no streaming API; `.zip` is streamed from disk.
- Packages fetched **by URL** are downloaded over http(s) only, stream straight to disk under the
  same size cap as browser uploads, and the transfer is aborted mid-stream if the server sends more
  than the cap. After the download, the archive goes through the exact same validation as an upload.

## Secret handling

- Environment variables marked **secret** are masked in the interface (`•••`), and the value is only
  visible to the panel process and the container.
- The AI API key is stored in the panel's database and **never returned by the API**: the interface
  receives `apiKeySet: true` plus a masked hint (for example `gsk••••GVAY`).
- Log excerpts sent to an AI provider pass through redaction first (see below).
- The panel's own password is never exposed by the API; the *Settings* page only shows that it is
  set by environment.

## AI redaction

Before an excerpt is sent to a provider, `server/src/ai/prompt.ts` rewrites:

- known key prefixes (`sk-`, `sk-ant-`, `gsk_`, `AIza`, `xox[baprs]-`, `gh[pousr]_`, `AKIA…`);
- `Authorization: Bearer/Bot/Basic <value>` headers;
- Discord bot tokens (three dot-separated base64url segments);
- JWTs (`eyJ…` triples);
- `KEY=value` / `key: value` pairs whose name looks like a secret (`token`, `secret`, `password`,
  `api_key`, …);
- credentials embedded in URLs (`scheme://user:pass@host`).

The application's environment variables are **not** included in the prompt.

Redaction is best-effort pattern matching. Logs can contain personal data, message contents, IDs or
session cookies that no pattern will catch. **Review what your application prints** before sending
it anywhere, and check the provider's privacy policy.

## Backups

- Backups are plain ZIP files inside `<BOTPANEL_DATA_DIR>/apps/<slug>/backups` (and listed through
  the API).
- They intentionally **include environment variables in `backup.json`** so a restore is complete.
  Treat a backup file as a secret: it can contain your bot tokens.
- Download and delete them on the **Backups** page when you no longer need them.

## Operating recommendations

1. Never expose port 8080 to the internet — bind it to `127.0.0.1` and use HTTPS in front, or use
   **Cloudflare Tunnel** (outbound-only) with a Cloudflare Access policy on the hostname.
2. Use a long password (or a scrypt hash) and keep `/etc/botpanel.env` at mode `600`.
3. Keep the host, Docker and Node.js updated.
4. Whitelist Docker images with `BOTPANEL_ALLOWED_IMAGES` if you want a guard rail.
5. Do not run the panel as a user other than root unless you understand the chown/Docker-socket
   implications; if you do, give it access to the socket and set `BOTPANEL_RUN_UID` to a UID it can
   manage.
6. Review logs before sending them to an AI provider, and prefer a local Ollama instance when the
   logs are sensitive.

## Reporting a vulnerability

See [SECURITY.md](../SECURITY.md). Please do not open a public issue for a security problem.
