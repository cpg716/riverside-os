# Release QA Checklist (ROS)

**Purpose:** Single pre-release runbook for validating Riverside OS before tagging or shipping.

**Applies to:** Back Office, POS, checkout/revenue logic, settings/integrations, and Help Center changes.

---

## 0) Preconditions

- You are on the intended release branch (`main` for direct releases, or a validated release branch).
- Database/services are available for local verification.
- No uncommitted local changes you don’t intend to ship.
- Browser-facing RC/production candidates must define **`RIVERSIDE_STRICT_PRODUCTION=true`**, **`RIVERSIDE_CORS_ORIGINS`**, **`RIVERSIDE_STORE_CUSTOMER_JWT_SECRET`**, and **`FRONTEND_DIST`** before signoff. Local permissive defaults are for development only.

### Local Runtime Prerequisites / RC parity

- Run **`npm install`** from the repo root.
- Run **`cd client && npm install`**.
- Keep **`server/.env`** present for local parity (copy from **`server/.env.example`**). For local Docker Postgres, **`DATABASE_URL`** must use **`localhost:5433`**.
- If you expect automatic local Metabase sign-in, **`server/.env`** must also define the local **`RIVERSIDE_METABASE_ADMIN_*`** and **`RIVERSIDE_METABASE_STAFF_*`** shared-auth values.
- Expected local services and ports:
  - Postgres **5433**
  - API **3000**
  - Vite **5173**
  - deterministic E2E API/UI **43300 / 43173**
  - Metabase **3001**
  - Meilisearch **7700** when used
- Expected seed/state assumptions:
  - **`store_settings`** row **`id = 1`**
  - E2E staff **`1234`** and **`5678`**
- **`npm run pack`** is expected to work from the repo root on a normal install.

Recommended sanity checks:

```bash
git status
git pull --ff-only
```

---

## 1) Gatekeeper checks (required)

Run from repo root:

```bash
cargo fmt --check --manifest-path server/Cargo.toml
npm run lint
npm --prefix client run build
```

### Pass criteria
- `cargo fmt --check` exits 0
- `npm run lint` exits 0 (no errors)
- `npm --prefix client run build` exits 0

If any fail, fix before release commit.

---

## 2) E2E prerequisites

Playwright UI tests require a reachable frontend at `E2E_BASE_URL` and API at `E2E_API_BASE`.
The deterministic local browser stack uses `http://localhost:43173` for the UI and `http://127.0.0.1:43300` for the API so it does not collide with an everyday `npm run dev` session on `5173/3000` or other local Vite projects.

### Deterministic local browser stack

```bash
npm install
npm run dev:e2e
```

This boots Docker Postgres, reapplies any pending migrations, seeds the standard E2E staff fixtures, and starts the Rust API plus the Vite UI used by browser specs.

**Local env requirement:** the API process still reads **`server/.env`** (or exported shell env). For local Docker runs, **`DATABASE_URL`** must target **`localhost:5433`**. If your RC validation expects automatic Metabase sign-in instead of a standalone Metabase login screen, ensure **`server/.env`** also carries the local **`RIVERSIDE_METABASE_ADMIN_*`** / **`RIVERSIDE_METABASE_STAFF_*`** shared-auth credentials before starting the stack.
**Root dependency requirement:** repo-root helpers such as **`npm run dev:e2e`**, **`npm run test:e2e:*`**, and **`npm run pack`** expect the root package dependencies to be installed in this worktree, not borrowed through ad hoc symlinks.

### Terminal 2: run tests from client

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e -- --workers=1
```

### Root shortcuts (recommended for release flow)

From repo root, use these shortcuts:

```bash
npm run test:e2e:list
npm run test:e2e:release
npm run test:e2e:visual
npm run test:e2e:high-risk
npm run test:e2e:phase2
npm run test:e2e:tender
```

- `test:e2e:list` lists all Playwright tests.
- `test:e2e:release` runs the standard release gate suite.
- `test:e2e:visual` runs visual baselines with `E2E_RUN_VISUAL=1`.
- `test:e2e:high-risk` runs the high-risk API regression suite.
- `test:e2e:phase2` runs the Phase 2 finance/help lifecycle suite.
- `test:e2e:tender` runs the deterministic tender contract suite.

> If you see `ERR_CONNECTION_REFUSED` to `localhost:43173`, the dedicated E2E UI server is not running.
> Local Playwright now auto-boots this same dedicated stack unless `E2E_AUTO_BOOT=0` is set.

---

## 3) High-risk release focus (must verify)

For releases touching checkout, payments, taxes, reports, or Help Center admin flows:

1. **Checkout / payment intent path**
2. **Saved card / Stripe vault behavior**
3. **Tax edge behavior (line-level where applicable)**
4. **Booked vs Recognized reporting invariants**
5. **Help Center Manager admin ops**
   - Generate manifest
   - Reindex search
   - Permission gates (`help.manage`)

---

## 3.1) Visual baseline policy (opt-in)

Visual screenshot baselines are **opt-in** and **non-blocking by default**.

- The visual suite runs only when explicitly enabled with:
  - `E2E_RUN_VISUAL=1`
- Default release gate behavior should not fail solely due to snapshot drift
  (fonts/layout/render variance across machines).

Run visuals only when you intentionally want snapshot validation/update:
- UI polish sweeps
- intentional visual refreshes
- pre-merge screenshot review passes

### Canonical visual consistency guidance

For “visual-perfect” consistency, use a **single canonical environment** as the
source of truth for screenshot approvals:

- Same OS image / runtime stack across runs
- Same browser channel/version
- Same viewport(s), locale, timezone, and device scale assumptions
- Same font set installed and loaded before capture
- Animations disabled during capture
- Stable seed data and deterministic API state

Recommended workflow:
1. Run standard release E2E gate first (`npm run test:e2e:release`).
2. Run visual suite only in canonical mode (`npm run test:e2e:visual`).
3. Approve snapshot changes only from canonical environment output.
4. Treat non-canonical local visual drift as advisory unless reproduced canonically.

---

## 4) API gate regression smoke (recommended each release)

From `client/` E2E suite (`api-gates.spec.ts`), confirm:
- Anonymous requests return expected `401/403` on protected routes.
- Non-admin staff forbidden where expected.
- Admin routes return expected payload shape on privileged endpoints.

---

## 5) Manual release spot checks (quick)

- Open Back Office shell and navigate key workspaces:
  - Operations
  - POS
  - Reports
  - Settings
- Open Help drawer from:
  - Back Office header
  - POS top bar
- If release includes UI density/layout work:
  - Run responsive checks on phone/tablet presets
  - Review visual baseline specs as needed

---

## 6) Data/migration safety checks

If migrations are included:
- Verify migration files are numbered and present in `migrations/`.
- Confirm no destructive SQL (`DROP` / broad `DELETE`) without explicit approval.
- Validate server boot after migration apply.

---

## 7) Commit/push discipline

Before pushing release update:

```bash
git status
git log --oneline -n 5
```

Ensure:
- No accidental runtime artifacts/logs/backups are tracked.
- Only intended release files are included.
- Commit message clearly indicates release scope.

Push:

```bash
git push origin main
```

---

## 8) Post-push verification

- Confirm CI starts and all required jobs run.
- Review failing jobs immediately; if red on required checks, treat release as blocked.
- Record release notes/changelog updates if not already done.
- If visual checks are enabled for the release, verify they ran in the canonical environment before accepting snapshot updates.

---

## 9) Troubleshooting quick map

- **`test:e2e` missing at repo root:** run from `client/` or use `npm --prefix client run test:e2e`.
- **`ERR_CONNECTION_REFUSED :43173`:** start `npm run dev:e2e` first, or leave Playwright auto-boot enabled.
- **API gate skips:** ensure seed users and DB are loaded (admin + non-admin test staff).
- **Build succeeds but E2E flaky:** rerun with `--workers=1` and inspect first failure trace/screenshots.

---

## 10) Required reminder for checkout/revenue-impacting releases

For any checkout/revenue/tender/tax logic changes, always run:

```bash
npm run test:e2e:release
npm run test:e2e:high-risk
npm run test:e2e:phase2
npm run test:e2e:tender
```

Equivalent explicit forms:

```bash
cd client
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e -- --workers=1
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e -- e2e/high-risk-regressions.spec.ts --workers=1
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e -- e2e/phase2-finance-and-help-lifecycle.spec.ts --workers=1
E2E_BASE_URL="http://localhost:43173" E2E_API_BASE="http://127.0.0.1:43300" npm run test:e2e -- e2e/tender-matrix-contract.spec.ts --workers=1
```

This is a release gate, not optional.

---

## Known limitations / deferred hardening

- **API base centralization:** remaining direct **`VITE_API_BASE ?? "http://127.0.0.1:3000"`** callsites should be consolidated on the shared helper. Deferred from this RC.
- **POS UI E2E subset:** `phase2-tender-ui`, `pos-golden`, `tax-exempt-and-stripe-branding`, and the UI-open path in `exchange-wizard` are release gates again. The POS shell exposes explicit register-ready and cashier-overlay contracts for deterministic helpers.

---

**Last reviewed:** 2026-04-21
