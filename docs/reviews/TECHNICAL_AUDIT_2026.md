# Riverside OS Technical Audit (April 2026)

This document summarizes the technical state of the Riverside OS codebase across backend and frontend domains, focusing on architectural invariants, financial integrity, and security.

## Core Pillars

### 1. Financial Integrity
- **Mandatory Decimal Math**: All financial calculations MUST use `rust_decimal::Decimal`. Floating-point types (`f32`, `f64`) are prohibited for currency.
- **NYS Tax Logic**: Implementation follows Pub. 718-C for Erie County. Items under $110.00 in clothing/footwear categories are eligible for state tax exemption while retaining local tax. Logic resides in `server/src/logic/tax.rs`.

### 2. Transactional Safety
- **Handler Thinness**: Controllers (`server/src/api/`) are thin; business logic is encapsulated in `server/src/logic/`.
- **Atomic Mutations**: All multi-mutation operations (e.g., Checkout, Reconcile, Physical Inventory Post) use `db.begin()` and explicit `commit()` to ensure atomicity.
- **Idempotency**: Checkout operations use a `checkout_client_id` provided by the client to prevent duplicate orders during network retries.

### 3. Permissions & RBAC
- **Auth Model**: 4-digit staff codes + optional PIN hashes. Role-based permissions are resolved via `StaffPermission` records in PostgreSQL.
- **Admin Bypass**: The `admin` role is the only bypass to explicit permission checks.
- **Client Enforcement**: `BackofficeAuthContext` ensures UI parity with server-side gates.

## Backend Architecture
- **Framework**: Axum 0.8 with `tokio` for async execution.
- **Database**: PostgreSQL 16 managed via `sqlx`.
- **Telemetry**: Structured logging via `tracing` with an optional OpenTelemetry OTLP integration.

## Front-end Pattern
- **State Management**: React 19 using Context for global state (Auth, Registry, Notifications).
- **Styling**: Vanilla CSS tokens in `index.css` paired with Tailwind utility classes for layout.
- **Hydration**: POS and Back Office use the same shell logic but different sidebars, determined by the staff role and active session.

---
*Last Updated: 2026-04-08*
*Status: Hardened*
