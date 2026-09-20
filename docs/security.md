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
- an unauthenticated stranger reaching the panel over the network.

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

## Filesystem and path safety

- ZIP uploads are extracted entry by entry: absolute paths, `..` segments and paths escaping the
  target directory are rejected, and the archive is size-checked before extraction.
- The file manager only serves two roots per application: the active release (`code`) and the
  persistent directory (`data`). The resolved path is verified to stay inside of them, so
  `../../etc/passwd` and symlink escapes are refused.
- Files created inside a container are owned by `BOTPANEL_RUN_UID`; the panel adjusts ownership of
  the release and the persistent directory after a deploy.
- Uploaded ZIPs live in `<BOTPANEL_DATA_DIR>/tmp/uploads` and are pruned periodically.

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

1. Never expose port 8080 to the internet — bind it to `127.0.0.1` and use HTTPS in front.
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
