# Backups

BotPanel can package the code of an application (and optionally its persistent data) into a ZIP that
you download and keep wherever you want. Backups are available in two places:

- **Application → Backups tab** — for one application.
- **Backups page** (sidebar) — across every application, with the owner application shown.

## Creating a backup

1. Open the application (or the global **Backups** page).
2. Press **Create backup**.
3. Tick **include `/data`** when you also want the persistent files (databases, sessions, configs
   your bot writes at runtime).
4. The status goes `generating…` → `ready` (or `failed` with the reason).

Requirements and limits:

- The application must have at least one **published release** — otherwise the API answers
  `400` (“publish a release first”).
- The ZIP is written to `<BOTPANEL_DATA_DIR>/apps/<slug>/backups/` on the server, then offered for
  download. Delete it when you are done: it occupies disk.
- Big `/data` directories take time; the interface polls only while a backup is being generated.

## What is inside

```
backup-2026-01-31T12-00-00-000Z.zip
├── backup.json      metadata: application, slug, runtime, active release, limits,
│                    environment variables, whether /data was included, timestamps
├── code/            the code of the active release (excluding node_modules and .botpanel-py)
└── data/            the persistent /data directory (only when requested)
```

`node_modules/` and generated Python dependency directories are **excluded**: a deploy recreates
them from your dependency file, and including them would multiply the size of the archive.

## Downloading and deleting

- **Download** streams the ZIP through the API (`/api/apps/:slug/backups/:id/download`) with
  `Content-Type: application/zip`.
- **Delete** removes the record and the file from the disk (with a confirmation dialog).

## Restoring

A backup is intentionally a plain ZIP, so restoring does not need the panel:

```bash
# code of the old version back into the repository you deploy from
unzip backup-*.zip 'code/*' -d /tmp/restore

# persistent data back into the application's /data
sudo systemctl stop botpanel          # optional, avoids writing during the copy
sudo tar -C /tmp/restore/data -cf - . | sudo tar -C /var/lib/botpanel/apps/<slug>/shared -xf -
sudo chown -R 1000:1000 /var/lib/botpanel/apps/<slug>/shared
sudo systemctl start botpanel
```

Then deploy the restored code again (upload the ZIP) or use **Rollback** if the release is still
present on the server.

> **Treat backups as secrets.** `backup.json` contains your environment variables, which usually
> means your bot tokens. Store the files somewhere private and delete them from the panel when you
> no longer need them.

## Backups versus releases

| | Releases | Backups |
|---|---|---|
| Created by | every deploy | you, on demand |
| Purpose | switch code instantly (rollback) | keep an off-server copy |
| Stored in | `apps/<slug>/releases/N` | `apps/<slug>/backups/*.zip` |
| Retention | automatic (`BOTPANEL_KEEP_RELEASES`) | manual — you delete them |

Both are inside `BOTPANEL_DATA_DIR`, so a host-level backup of that directory already covers the
releases. Use the panel's backup feature when you want a single downloadable file (with `/data`) per
application, for example before a risky update.
