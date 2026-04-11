# Release QA Checklist (ROS)

**Purpose:** Single pre-release runbook for validating Riverside OS before tagging or shipping.

**Applies to:** Back Office, POS, checkout/revenue logic, settings/integrations, and Help Center changes.

---

## 0) Preconditions

- You are on the intended release branch (`main` for direct releases, or a validated release branch).
- Database/services are available for local verification.
- No uncommitted local changes you don’t intend to ship.

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

### Terminal 1 (repo root): start app stack

```bash
npm run dev
```

### Terminal 2: run tests from client

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npm run test:e2e -- --workers=1
```

### Root shortcuts (recommended for release flow)

From repo root, use these shortcuts:

```bash
npm run test:e2e:release
npm run test:e2e:visual
```

- `test:e2e:release` runs the standard release gate suite.
- `test:e2e:visual` runs visual baselines with `E2E_RUN_VISUAL=1`.

> If you see `ERR_CONNECTION_REFUSED` to `localhost:5173`, the UI server is not running.

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

---

## 9) Troubleshooting quick map

- **`test:e2e` missing at repo root:** run from `client/` or use `npm --prefix client run test:e2e`.
- **`ERR_CONNECTION_REFUSED :5173`:** start `npm run dev` first.
- **API gate skips:** ensure seed users and DB are loaded (admin + non-admin test staff).
- **Build succeeds but E2E flaky:** rerun with `--workers=1` and inspect first failure trace/screenshots.

---

## 10) Required reminder for checkout/revenue-impacting releases

For any checkout/revenue/tender/tax logic changes, always run:

```bash
npm run test:e2e:release
```

Equivalent explicit form:

```bash
cd client
E2E_BASE_URL="http://localhost:5173" E2E_API_BASE="http://127.0.0.1:3000" npm run test:e2e -- --workers=1
```

This is a release gate, not optional.

---

**Last reviewed:** 2026-04-11