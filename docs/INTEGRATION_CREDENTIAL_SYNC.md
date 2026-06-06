# Integration Credential Sync

Move all API keys, tokens, and secrets between Riverside OS environments without re-entering them in Back Office.

## What gets moved

The `integration_credentials` table stores **all** third-party integration secrets encrypted in PostgreSQL. This includes:

- **Helcim** — API token, terminal device codes, webhook secret
- **QBO** — client ID, client secret, access/refresh tokens
- **Podium** — client ID, client secret, refresh token, webhook secret
- **Meilisearch** — URL, API key
- **Fal.ai** — API key
- **Shippo** — API token, webhook secret
- **Geoapify** — API key
- **Visual Crossing / Weather** — API key
- **Email (IMAP/SMTP)** — username, password
- **NuORDER** — consumer key, consumer secret, user token, user secret
- **Backups (S3 / Cloud)** — access key, secret key, access/refresh tokens
- **Insights / Metabase** — admin & staff email/password, JWT secret
- **Online Store** — customer JWT signing secret

## Prerequisites

All environments must use the **same** `RIVERSIDE_CREDENTIALS_KEY` (32+ characters). This key decrypts the table. If keys differ, the encrypted values will be unreadable after import.

---

## Option A: Git-tracked encrypted dump (Recommended for Windows Deployment)

Commit the encrypted credential dump to your repo so it ships automatically in every deployment package.

### 1. Export from dev

**macOS / Linux:**
```bash
export DATABASE_URL="postgres://riverside:devpass@dev-server:5432/riverside_os"
bash scripts/export-integration-credentials.sh
# Writes: ./integration-credentials.sql
```

**Windows:**
```powershell
.\Export-IntegrationCredentials.ps1
# Writes: .\integration-credentials.sql
```

### 2. Commit and push

```bash
git add integration-credentials.sql
git commit -m "Update encrypted integration credentials"
git push
```

The file is safe to commit because every value is encrypted with ChaCha20-Poly1305 under your `RIVERSIDE_CREDENTIALS_KEY`.

### 3. Build and deploy

When you build the Windows deployment package (`build-deployment-package.ps1`), the credential dump is automatically included:

```
Packaged integration-credentials.sql (encrypted credential dump)
```

### 4. Auto-import during install / update / repair

The deployment scripts now check for `integration-credentials.sql` in the package:

- **Install** (`install-server.ps1`) — imports after migrations/seeds
- **Update / Repair** (`apply-riverside-migrations.ps1`) — imports after migrations

If the table already has data, the import is skipped to avoid overwriting existing credentials. Use `-Force` to override:

```powershell
.\Import-IntegrationCredentials.ps1 -Force
```

---

## Option B: One-shot CLI sync (Manual)

For ad-hoc transfers without git:

```bash
bash scripts/sync-integration-credentials.sh \
  "postgres://riverside:devpass@dev-server:5432/riverside_os" \
  "postgres://riverside:prodpass@prod-server:5432/riverside_os"
```

Or step-by-step:

```bash
# Export
export DATABASE_URL="postgres://riverside:devpass@dev-server:5432/riverside_os"
bash scripts/export-integration-credentials.sh > riverside-credentials.pgsql

# Import
export DATABASE_URL="postgres://riverside:prodpass@prod-server:5432/riverside_os"
bash scripts/import-integration-credentials.sh riverside-credentials.pgsql
```

### 3. Restart the target server

The server loads credentials from the database at startup. A restart is required for the new values to become active environment variables.

## Security notes

- The `.sql` dump contains **encrypted** values only — useless without the matching `RIVERSIDE_CREDENTIALS_KEY`.
- Still treat the dump file as sensitive. It reveals which integrations are configured and when they were last updated.
- The scripts do **not** migrate database users, connection strings, or `RIVERSIDE_CREDENTIALS_KEY` itself — only the encrypted integration table.
