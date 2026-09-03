# Deploying AVOS Leaf to a VPS

This deploys three containers (Postgres, the .NET API, the Next.js frontend) behind Caddy, which
gets you automatic HTTPS for free — the same shape as avos-erp's and avos-vault's own deployments.

avos-leaf has a **hard runtime dependency on a reachable avos-licensing deployment** — signup and
login both call out to it server-to-server. Deploy (or already have running) avos-licensing first,
create an "avos-leaf" `LicensedApplication` in its staff admin UI, and note its id before starting
step 4 below.

## 1. Provision the VPS

Any small Linux VPS works (e.g. Hetzner CX22, DigitalOcean Basic Droplet) — 2 vCPU / 4GB RAM is
comfortable for this workload. Use Ubuntu 24.04 LTS.

Point your domain's DNS `A` record at the VPS's public IP before continuing — Caddy needs that to
issue a TLS certificate automatically. Use a different (sub)domain than your other AVOS
deployments, e.g. `leaf.yourdomain.com` — this is a separate service with its own database and
containers.

## 2. Install Docker

SSH into the VPS, then:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

Log out and back in for the group change to apply.

## 3. Clone the repo

```bash
git clone <your-repo-url> avos-leaf
cd avos-leaf
```

## 4. Create the production `.env`

First, in avos-licensing's staff admin UI, on the "avos-leaf" application's own page (create it if
it doesn't exist yet):

- Copy its id — you'll need it below as `LICENSING_LEAF_APPLICATION_ID`.
- Click **"Generate secret"** (under "Lets this application redirect users through avos-licensing
  to sign in..."). The secret is shown **once** — copy it immediately, you'll need it below as
  `LICENSING_LEAF_SSO_SECRET`. Clicking it again later rotates the secret (invalidates the old
  one), it doesn't just re-show it.
- In "Allowed redirect URIs (one per line, exact match required)", add
  `https://leaf.yourdomain.com/api/auth/sso/callback` (your real domain) and click **"Save redirect
  URIs"**. Not optional — the SSO exchange rejects any `redirect_uri` that isn't registered here
  exactly, byte-for-byte.

Generate the secrets and write them to a `.env` file **on the server, not in git**:

```bash
cat > .env <<EOF
DOMAIN=leaf.yourdomain.com
POSTGRES_PASSWORD=$(openssl rand -base64 24)
JWT_KEY=$(openssl rand -base64 48)
LEAF_ENCRYPTION_KEY=$(openssl rand -base64 32)
LICENSING_BASE_URL=https://licensing.yourdomain.com
LICENSING_PUBLIC_URL=https://licensing.yourdomain.com
LICENSING_LEAF_APPLICATION_ID=<paste the LicensedApplication id from avos-licensing>
LICENSING_LEAF_SSO_SECRET=<paste the secret from "Generate secret" above>
EOF
chmod 600 .env
```

`LEAF_ENCRYPTION_KEY` must decode to exactly 32 bytes (AES-256) — the command above guarantees
that. It's the key `AesGcmEncryptionService`/`LeafFileEncryptionService` use to protect account
fields and every uploaded PDF's bytes at rest. **Back this key up somewhere safe outside the
server** (e.g. a password manager): if it's lost, every account and document becomes permanently
unreadable. Back up `LICENSING_LEAF_SSO_SECRET` too — it isn't recoverable from avos-licensing
after the fact, only rotatable (which breaks nothing for existing sessions, just requires updating
this `.env` and restarting).

`LICENSING_BASE_URL` is the server-to-server hop (this container talks to it directly) and, unlike
avos-vault's equivalent setting, **must be a real HTTPS URL a public CA chain can validate** —
`IdentityLicensingClient`'s `HttpClient` has no option to skip certificate verification, so pointing
it at an internal `avos-edge` alias with a self-signed sidecar certificate will fail every request.
Always use avos-licensing's public HTTPS URL here, even when it's deployed on this same server.

`LICENSING_PUBLIC_URL` is where the SSO flow sends the **browser** (`GET /api/auth/sso/start`'s
redirect) — always the public HTTPS URL, same value as `LICENSING_BASE_URL` above in the common
case where both point at the same avos-licensing deployment.

There's no object-storage setup here: uploaded PDFs are encrypted and written to local disk under
`Leaf__StoragePath`, backed by the `leaffiles` Docker volume declared in
`docker-compose.prod.yml` — nothing external to provision.

## 4b. Shared edge Caddy

This compose file has no `caddy` service of its own — only host ports 80/443 on the whole server
can be bound to a single process, so on a server running more than one AVOS product (which is the
normal case), exactly one shared Caddy instance owns those ports and reverse-proxies to every
product's own containers by domain name. `Caddyfile` in this repo's root is kept only as a
reference for the routing logic below and for a standalone single-product deploy that adds its own
`caddy:` service back (see that file's own header comment) — it is not read by
`docker-compose.prod.yml`.

**If a shared edge Caddy is already running on this server** (check `docker ps` for a container
publishing `0.0.0.0:80`/`0.0.0.0:443` — every other AVOS product on the box uses the same one),
skip straight to adding this product's site block below, then reload it. Don't start a second one.
See avos-licensing's `DEPLOY.md` (step 4b) for how to set one up from scratch if this is the first
AVOS product on this server — same recipe, not repeated here.

Append this product's site block to the shared Caddyfile, replacing `leaf.yourdomain.com` with
this product's real domain:

```caddyfile
leaf.yourdomain.com {
	reverse_proxy https://leaf-frontend:3443 {
		header_up X-Forwarded-Host {http.request.host}
		transport http {
			tls_insecure_skip_verify
		}
	}
}
```

Then reload it:

```bash
cd /opt/avos-edge && docker compose exec caddy caddy reload --config /etc/caddy/Caddyfile
```

## 5. Start everything

```bash
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

The API applies EF Core migrations automatically on first boot — no manual migration step needed.
The shared edge Caddy (see step 4b) requests the TLS certificate for `$DOMAIN` on its first request
once this product's site block has been added and reloaded.

## 6. Verify

```bash
docker compose -f docker-compose.prod.yml ps
curl -I https://leaf.yourdomain.com
```

Visit `https://leaf.yourdomain.com/signup`, enter a real license key issued against the "avos-leaf"
application in avos-licensing, and confirm the account is created and you land on the dashboard.
Log out and log back in (and through 2FA, if the underlying avos-licensing account has it enabled)
to confirm the full round trip. Upload a PDF and reopen it to confirm the storage/encryption round
trip works too.

## Updating after a code change

```bash
git pull
docker compose -f docker-compose.prod.yml --env-file .env up -d --build
```

## Backups

This covers the `pgdata` volume (Postgres — accounts, folder/document metadata) only. The
`leaffiles` volume holding encrypted PDF bytes needs its own separate backup policy, e.g. a
periodic `docker run --rm -v avos-leaf_leaffiles:/data -v $(pwd)/backups:/backup alpine tar czf
/backup/leaffiles-$(date -u +%Y%m%dT%H%M%SZ).tar.gz -C /data .` cron entry alongside the database
backup below.

`scripts/backup.sh` dumps the database, encrypts the dump, and prunes old backups; `scripts/
restore.sh` reverses it. Both live in the repo and read their config from the same `.env` used to
run the stack, so no separate setup is needed on the VPS beyond the clone you already have.

Run a backup by hand:

```bash
./scripts/backup.sh
```

This writes `backups/avos-leaf-<UTC timestamp>.sql.enc` — an AES-256-CBC (PBKDF2, 100k iterations)
encrypted `pg_dump`, encrypted with `LEAF_ENCRYPTION_KEY` (the same key that already protects
encrypted columns — see step 4 above), so there's only one secret to safeguard, not two. Backups
older than `BACKUP_RETENTION_DAYS` (default 14) are deleted automatically on each run.
Override `BACKUP_DIR` in `.env` to write elsewhere (e.g. a mounted network volume).

Schedule it with cron — daily at 03:00 server time, logging to a file you can check later:

```bash
crontab -e
```

```cron
0 3 * * * cd /path/to/avos-leaf && ./scripts/backup.sh >> /var/log/avos-leaf-backup.log 2>&1
```

**Store backups off the VPS** — a nightly `rsync`/`rclone` of the `backups/` directory to another
host or object storage is the simplest way; the files are already encrypted, so they're safe to
copy anywhere. Keep `LEAF_ENCRYPTION_KEY` backed up somewhere safe too (outside the server, e.g. a
password manager, per step 4) — an encrypted dump without that key is unreadable, on purpose, but
that includes to you.

To restore:

```bash
./scripts/restore.sh backups/avos-leaf-20260101T030000Z.sql.enc
```

This drops and recreates the `avos_leaf` database from the decrypted dump — it asks for
confirmation first since it discards whatever is currently in the database.

## Local development (no Docker)

Run the API directly with `dotnet run --project backend/src/Avos.Leaf.Api` (needs a local Postgres
and the same `ConnectionStrings__Default`/`Jwt__*`/`Leaf__*`/`Licensing__*` settings as above, via
environment variables or `dotnet user-secrets`) and the frontend with `npm run dev` inside
`frontend/` (needs `API_INTERNAL_URL` pointing at the running API, default
`http://localhost:5490`) — the faster loop for day-to-day work.

`docker-compose.yml` (without `.prod`) is also available for a Dockerized local stack that mirrors
production's container boundaries without Caddy/TLS:

```bash
JWT_KEY=$(openssl rand -base64 48) LEAF_ENCRYPTION_KEY=$(openssl rand -base64 32) \
  LICENSING_BASE_URL=http://host.docker.internal:5090 \
  LICENSING_LEAF_APPLICATION_ID=... \
  docker compose up -d --build
```

(`host.docker.internal` lets the container reach an avos-licensing instance running directly on the
host via `dotnet run`, outside Docker — swap it for whatever address actually reaches your
avos-licensing instance.)
