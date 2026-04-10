# AI_RULES.md — Riverside OS System Instructions

## Project Identity & Business Logic
> [!IMPORTANT]
> This is a private, proprietary POS for **Riverside Men's Shop**.
> **Revenue Recognition (Finance)**: Recognized on **Date of Pickup** (Fulfilled).
> **Booked Reporting (Activity)**: Tracked on **Date of Order Creation** (Booked).

*   **Target Environment**: 
    *   **Development**: macOS (OrbStack).
    *   **Deployment**: Strictly **Windows** (Tauri 2 Desktop App).
    *   **Invariant**: All code, file paths, and execution commands must remain Windows-compatible.

---

## Pillar 1: Version Control & Validation (Gatekeeper Protocol)
You act as the ultimate gatekeeper of the codebase. You MUST NOT commit broken or non-compliant code.

*   **Pre-Commit Verification**: Before running `git add` or `git commit`, you must:
    1.  Run `cargo fmt --check` in the `/server` directory.
    2.  Run `npm run lint` in the `/client` directory.
    3.  Verify the project compiles (`cargo check`, `npm run typecheck`).
*   **Test Enforcement**:
    *   If any core workflow is modified (Checkout, Database Logic, Revenue Recognition, Inventory Transactions), you MUST remind the user to run Playwright E2E tests: `npm run test:e2e` from the `client/` directory.
*   **Block on Failure**: If checks fail, **ABORT** the commit process immediately. Explain the error and fix the code before attempting to save again.
*   **Commit Formatting**: Mandate **Conventional Commits** prefixes:
    *   `feat:` New feature
    *   `fix:` Bug fix
    *   `chore:` Maintenance/Tooling
    *   `docs:` Documentation updates
    *   `refactor:` Internal code cleanup
*   **Release Readiness**: Before any release or push to `main`, verify the status of binary sidecars and Windows path compatibility.

---

## Pillar 2: Database & Migration Rules
Maintain absolute data integrity and accidental-deletion prevention.

*   **Migration Mandate**: Never modify the database schema directly via a SQL editor. Always generate a numbered migration file in the `migrations/` directory (e.g., `118_add_feature_table.sql`).
*   **Destructive Actions**: You are strictly forbidden from executing commands like `DROP TABLE`, `DELETE COLUMN`, or `TRUNCATE` without triple-confirmed approval from the user.
*   **SQLx Pattern**: Prefer `sqlx::query_as` with `.bind()` for development; follow the `#[sqlx(rename_all = "snake_case")]` pattern for enums.

---

## Pillar 3: Manual System & Staff Features
Code changes must align with real-world store operations.

*   **Manual Cross-Reference**: When finalizing a UI change or a new staff-facing feature, review the existing help manual corpus in `client/src/assets/docs/` and `docs/staff/`.
*   **Staff Update Prompt**: Proactively ask: *"Should we draft an update for the staff manual based on this new feature?"*
*   **Summary**: Provide a jargon-free, functional summary of the change for store staff consumption.

---

## Pillar 4: Tech Stack Lock-in
Strictly adhere to the established architectural patterns. **Do not suggest incompatible libraries.**

### Backend (Rust/Axum)
*   **Framework**: Axum 0.8 / Tokio.
*   **Database**: PostgreSQL via `sqlx` 0.8.
*   **Money**: ALWAYS use `rust_decimal`. Never use floating-point for currency.
*   **Pattern**: Thin handlers in `api/`. Business logic in `logic/`. SKU resolution in `services/`.
*   **Errors**: Use `thiserror` to map SQL errors to domain/HTTP errors (e.g., avoid 500s for "Not Found").
*   **Observability**: Structured logging via `tracing`.

### Frontend (React/Vite)
*   **Framework**: React 19 / TypeScript.
*   **Styling**: Tailwind CSS. Use established primitives: `ui-card`, `ui-input`, `ui-btn-primary`, `ui-pill`.
*   **State**: `localforage` for draft carts and offline queues.
*   **Hardware**: Tauri 2 for async hardware bridging (Thermal printers). 
*   **Zero-Dialog Rule**: Never use browser native `alert()`, `confirm()`, or `prompt()`. Use the `ToastProvider` or `ConfirmationModal` components.

### Quality Assurance
*   **Testing**: Playwright for E2E.
*   **Worker Limit**: Use `--workers=1` for suite stability.
*   **Snapshots**: Update visual snapshots only after manual verification of UI changes.
