# Security policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately, either through GitHub's *Report a vulnerability* (Security → Advisories) on this
repository, or by contacting the maintainer through one of the channels listed in the
[README](README.md#credits):

- GitHub: <https://github.com/MaelllDev>
- Discord: <https://discord.com/invite/xykJqCUeNt>

Please include:

- what the issue allows an attacker to do;
- the steps to reproduce it (a minimal configuration is enough);
- the affected version (`System` page or `server/package.json`);
- whether it requires a malicious application, a malicious panel user, or no authentication at all.

You will get an answer as soon as possible. If the report is valid, the fix is published as a new
release and you are credited unless you prefer to stay anonymous.

## Supported versions

The project publishes releases from a single development line. Only the **latest release** is
supported with fixes; if you are on an older tag, update first
(`git pull && sudo bash scripts/install.sh`).

## Scope

In scope:

- authentication and session handling in the panel;
- isolation between applications (files, processes, network, resource limits);
- path traversal in uploads, the file manager or backups;
- leaking secrets through the API, the logs or the AI feature;
- anything that lets an application escape its container's intended restrictions through BotPanel's
  own configuration (not through a Docker/kernel vulnerability).

Out of scope (by design, documented in [docs/security.md](docs/security.md)):

- running BotPanel itself as a non-root user is not supported;
- the panel serving plain HTTP when no TLS reverse proxy is configured;
- a Docker image you deliberately choose running arbitrary code with the limits you configured;
- the panel being reachable from the internet because it was exposed without a firewall.

## What is already implemented

`docs/security.md` describes the current model in detail: container isolation, resource limits,
authentication, secret handling and the AI redaction. Read it before reporting something that is an
explicit, documented trade-off.
