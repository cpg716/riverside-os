# AGENTS.md — Riverside OS

Instructions for coding agents (Cursor Agent, Codex, Zed Agent, etc.) working in this repository.

Riverside OS is a production retail POS/ERM platform for formalwear and wedding retail. It runs as a Tauri 2 desktop application with a React + Vite frontend and a Rust Axum API backed by PostgreSQL.

---

## Mission

The main shell component is a critical part of the application that manages UI state and renders content based on user interactions and application state. In v0.2.0, the **Persistent Top Bar** architecture was introduced as the universal navigation anchor, moving away from fragmented headers. It supports various modes such as POS (Point of Sale), Insights (analytics and reporting tools), and Wedding (wedding-related functionalities). The component includes features like sidebar navigation, the new Top Bar navigation, global search drawer, deep link handling, permissions and access control, theme mode, error handling, and navigation and routing.

- **Terminology Note**: Avoid technical terms like "Node" in user-facing UI. Use **Register #[n]**.
- **Access Status**: Use **Staff Access** (standard identity) and **Manager Access** (privileged override status).
- **Identity**: Use **Access PIN** for the 4-digit credential. Internal **Employee Tracking IDs** are auto-assigned and not used for login.

### Branding & Identity (v0.2.1+)

- **Primary Brand Anchor**: The Riverside Logo Icon (`logo1.png`) is the universal anchor for navigation and secure entry points (Register PIN entry).
- **Full Identity**: The full logo-with-name (`riverside_logo.jpg`) is reserved for primary unauthenticated entry points like the `BackofficeSignInGate`.
- **Top Bar Branding**: Do not render the logo in the `GlobalTopBar`. The sidebar rail is the sole authority for visual identity.
- **Unified Staff Profile**: Every workstation mode (BO, POS) utilizes the same `StaffProfilePanel` for account management.
  - **Context-Aware Permissions**: Sensitivity-aware fields (Role, Economics, Permissions) are view-only in POS mode but fully editable in Back Office.
  - **CRM Linkage**: Staff are encouraged to link their personal customer account to their profile for automatic discount application and transaction history.
- **Staff Identity Prioritization**: The UI MUST always prioritize the **Authenticated Staff Member** (`staffDisplayName`) over the register session owner (`cashierName`). The persona shown in the Top Bar and sidebar MUST reflect the person who explicitly signed in at the gate.
- **POS Settings Restriction**: In POS mode, the navigation menu specifically restricts access to 'Staff Profile' and 'Printers & Scanners'. All other administrative settings are hidden to prevent unauthorized station configuration.
- **Unified Auth Guard**: The `BackofficeSignInGate` is the authoritative root guard for the POS, Back Office, and Insights shells. "Logout" or "Change Staff Member" globally clears the persona and returns the workstation to the sign-in entry point.


Help maintain, debug, and extend Riverside OS safely inside the existing architecture.

### v0.3.4 Staff Scheduling & Event Invariants

RiversideOS v0.3.4 introduces a refined scheduling model focused on privacy, multi-staff events, and operational clarity.

- **Strict "Published Only" Visibility**: 
  - Staff View, Staff Profiles, and the live Appointments Scheduler **MUST ONLY** consume **Published** weekly schedules. 
  - Drafts and the Master Template are planning tools only and MUST NOT be visible in public-facing roster views.
- **Badge-First Notifications**: 
  - Prefer subtle icons/badges (Alert circles, "M" badges) for schedule warnings (Conflicts, Overrides, Meetings) rather than aggressive full-cell coloring or borders.
- **Highlighter Authority**: 
  - Solid Yellow (`#fff176`) is the authoritative color for the manual highlighter tool, used to emphasize specific shifts for printing.
- **Meeting Symmetry**: 
  - Store Events recorded in the "Store Events" header MUST be visually reflected in the individual shift boxes of all attendees via the "M" badge.

### v0.3.0 Operational Perfection

RiversideOS v0.3.0 is a refinement release focused on operator clarity, trust, and efficiency rather than new modules.

- Prefer visibility over hidden state.
- Prefer guided workflows over memory-based workflows.
- Prefer human-readable labels, timelines, and rule explanations over internal jargon.
- Prefer lightweight operational summaries and data-quality signals over dense reporting or speculative scoring.
- When in doubt, preserve existing server truth and improve the operator-facing surface around it rather than introducing new backend behavior.

Priorities, in order:

1. Preserve financial correctness
2. Preserve auditability
3. Maintain WowDash design system (glassmorphism, Inter typography)
4. Preserve existing project patterns
5. Ship focused, production-safe changes
6. Keep lint, typecheck, and build status at zero errors

This is an existing production-oriented codebase. Prefer understanding and extending current patterns over introducing new abstractions.

---

## Read first

Before making substantial changes, read these in order:

1. **`.cursorrules`** — Non-negotiable project rules (Rust/Axum/sqlx/money/handler thinness)
2. **`README.md`** — Overview, quick start, documentation catalog
3. **`DEVELOPER.md`** — Architecture, folder map, runbooks, API overview, migration references
4. **`CHANGELOG.md`** — Recent shipped behavior and current direction
5. **`docs/releases/`** — Current release notes, PR summary, and GitHub release copy when working near a release cut

Then read the domain doc most relevant to the task.

### Domain docs to consult before changing business-critical behavior

- **Orders / wedding orders / fulfillment** — `docs/TRANSACTIONS_AND_WEDDING_ORDERS.md`
- **Deposits** — `docs/DEPOSIT_OPERATIONS.md`
- **Returns / refunds / exchanges** — `docs/TRANSACTION_RETURNS_EXCHANGES.md`
- **Revenue recognition / reporting basis** — `docs/BOOKED_VS_FULFILLED.md`, `docs/REPORTING_BOOKED_AND_RECOGNITION.md`
- **Layaway lifecycle** — `docs/LAYAWAY_OPERATIONS.md`
- **Staff permissions / auth** — `docs/STAFF_PERMISSIONS.md`
- **Customer Hub / RBAC** — `docs/CUSTOMER_HUB_AND_RBAC.md`
- **Search / pagination / Meilisearch** — `docs/SEARCH_AND_PAGINATION.md`
- **Hardware / Printers / Scanners** — `docs/HARDWARE_MANAGEMENT.md`
- **ROS Dev Center / Ops command center** — `docs/ROS_DEV_CENTER.md`
- **Appointments / scheduler** — `docs/APPOINTMENTS_AND_CALENDAR.md`
- **Notification center** — `docs/PLAN_NOTIFICATION_CENTER.md`
- **Stripe vault / credits** — `docs/STRIPE_POWER_INTEGRATION.md`
- **Shipping / Shippo** — `docs/SHIPPING_AND_SHIPMENTS_HUB.md`
- **Online store** — `docs/ONLINE_STORE.md`
- **Counterpoint bridge / sync** — `docs/COUNTERPOINT_SYNC_GUIDE.md`, `docs/PLAN_COUNTERPOINT_ROS_SYNC.md`
- **UI conventions** — `docs/CLIENT_UI_CONVENTIONS.md`, `docs/ROS_UI_CONSISTENCY_PLAN.md`
- **Staff manuals impacted by workflow changes** — `docs/staff/README.md`

If a change affects a staff-facing workflow, update the relevant staff docs in the same PR when practical.

---

## What this repo is

**Riverside OS** = PostgreSQL + **Rust Axum API** (`server/`) + **React/Vite UI** (`client/`) packaged with **Tauri 2** (`client/src-tauri/`).

Primary codepaths:

- POS (incl. full parity for Customers, Shipping, Orders, Loyalty, Gift Cards, Alterations, Layaways, and integrated Wedding Management)
- Inventory (incl. POS-optimized Receiving)
- Weddings / parties (Standalone and Integrated Hub)
- Customers / CRM
- Register sessions
- Reporting / insights
- Settings / integrations

Tauri 2 is utilized directly for native hardware bridging, including async TCP ESC/POS thermal printing via `client/src-tauri/src/hardware.rs`.

Reference-only trees like **`NexoPOS-master/`**, **`odoo-19.0/`**, and **`riverside-wedding-manager/`** are not part of the minimal workspace. They are not build dependencies.

---

## Stack

### Backend

- Rust
- Axum 0.8+
- sqlx
- PostgreSQL
- `rust_decimal` for all money math
- `tracing` / `tracing-subscriber`

### Frontend

- React 19
- TypeScript
- Tailwind CSS
- Vite

### Desktop / native

- Tauri 2

### Quality / tooling

- Playwright
- `cargo fmt`
- `npm run lint`
- `npm run typecheck`
- `npm run build`

---

## Non-negotiable invariants

### Shell Architecture & Invariants

The main shell component is the central hub of Riverside OS. It manages global state (POS vs. Back Office), theme tokens (WowDash), and navigation routing.

- **Conditional Rendering**: Renders `PosShell`, `InsightsShell`, or `WeddingShell` based on the active mode.
- **WowDash Design System**:
  - Uses `backdrop-blur-md` and semi-transparent backgrounds for glassmorphism.
  - Standardized `DashboardStatsCard` and `DashboardGridCard` for all dashboards.
  - Primary Typography: **Inter** / **Outfit** sans-serif.
- **Permissions**: Every tab and sub-section check `useBackofficeAuth` and `useStaffPermissions` before mounting.
- **Error Handling**: Uses global `ErrorOverlay` and `useToast` for all operational failures.
- **Drawers & Modals**: Preferred for complex editing (e.g., `RelationshipHubDrawer`, `TaskChecklistDrawer`).
- **Full-Width Workspace & Root Scrolling (v0.2.0+)**:
  - All primary workspaces MUST utilize the full viewport width and follow an edge-to-edge "Flush" design pattern.
  - Native browser scrolling at the root level is mandatory for workstations (1080p, 1440p) and iPad Pro 11".
  - Avoid `h-screen` or `overflow-hidden` on main workspace containers.
  - Use `sticky` positioning for persistent navigation bars and sidebar menus.
  - Exception: `Alterations Hub` preserves the windowed/nested-scroll model for tactical density.
- **Standardized Stacking & Portaling Mandate (v0.3.3+)**:
  - All overlays (Modals, Drawers, Wizards) MUST be portaled to `#drawer-root`.
  - Enforce tiered `z-index`: **`z-100`** (Drawers), **`z-200`** (Modals/Wizards), **`z-300`** (System Priority/Toasts).
  - Use the **`.ui-overlay-backdrop`** class for consistent layering and background behavior.
  - This is non-negotiable for preventing "buried" interactive elements in nested flows.

### Money / tax / financial integrity

- Never use `f32` or `f64` for money
- Server-side money must use `rust_decimal::Decimal`
- Do not derive financial logic from rounded display values
- SQL aggregate sums must use explicit `ROUND(..., 2)` or `::numeric` casting where needed to avoid sub-penny drift
- Tax calculations must remain mathematically consistent with the server source of truth
- **Variable Shadowing**: Never shadow the outer `transaction_id` (Retail Sale) with an inner `transaction_id` (Payment/Movement) in checkout handlers. This prevents Foreign Key violations in `payment_allocations`.
- **Tax Category Casing**: Always treat `tax_category` (e.g., "Clothing") as case-insensitive during $110 exemption evaluation.

### Transactions vs. Fulfillment Orders (Terminology)

- **Transactions (`transactions` / `TXN-XXXX`)**: The financial ledger representing a customer checkout event. Handles payment, tax, and revenue mapping.
- **Fulfillment Orders (`fulfillment_orders` / `ORD-XXXX`)**: The logistical state of physical goods. Handles procurement, shipment, special orders, and pickups.
- **Three Primary Fulfillment Types**:
  1. **Special Order**: Out-of-stock catalog items (Special Order Line).
  2. **Custom Order**: Made-To-Measure (MTM) items where **price and cost vary with every order** (Manual Entry at booking).
  3. **Wedding Order**: Group-linked items for a specific wedding party.
- **Strict Rule**: Never use the term "Order" ambiguously. Code and docs MUST specify whether they are operating on the financial _Transaction_ or the logistical _Fulfillment Order_.
- **Wedding Member Nomenclature**:
  - Use `transaction_id` for links to the financial ledger (`transactions`).
  - Use `fulfillment_order_id` (via `transaction_lines`) for logistical status.
- **Procurement Nomenclature**:
  - Use `purchase_order_id` for logistical vendor links (PO-XXXX).
  - Never use `purchase_transaction_id` for procurement logistics.

### Handler / service boundaries

- Keep handlers thin
- Do not put tax tables, pricing logic, employee pricing logic, or fulfillment business rules inside route handlers
- Put business logic in `server/src/logic/` or `server/src/services/`

### Database discipline

- Never edit schema directly
- Always use numbered SQL migrations
- All migrations must be idempotent
- Use `IF NOT EXISTS` guards where appropriate
- When changing PostgreSQL views and the column shape changes, prepend `DROP VIEW IF EXISTS`
- Multi-step writes must use transactions from first mutation through commit
- Never mix transaction-bound writes with direct `.execute(&state.db)` calls in the middle of the flow

### sqlx discipline

- Prefer `query_as` + `bind`
- If changing sqlx macros, run:

```bash
cd server
cargo sqlx prepare --workspace
```

### Error handling and logging

- Prefer domain-specific errors
- Map `sqlx::Error::RowNotFound` and similar expected failures explicitly
- Do not collapse domain failures into generic 500s
- Do not use `eprintln!`
- Use structured `tracing::*` logs

### UI discipline

- Never use `alert()`, `confirm()`, or `prompt()`
- Use `useToast`, `ConfirmationModal`, `PromptModal`, or established drawer patterns
- Complex admin editing should prefer drawer / slideout-first patterns
- Never ask users to type raw UUIDs manually; use search-and-select patterns

### Build baseline

- Zero lint errors
- Zero typecheck errors
- `cargo fmt` is required
- Do not add temporary auth bypasses, PIN bypasses, or dev-only shortcuts into production code

### React / client architecture

- Hooks must stay at the top level
- Async functions used by effects must be wrapped appropriately
- Prefer separating shared logic, types, and constants into sibling logic files when needed for Fast Refresh stability
- Prefer native `fetch` for new endpoints
- Do not expand axios use for new code without a clear reason

### Transparency

- Intelligence-driven decisions must include visible reasoning/explainer strings
 - Audit-sensitive actions must remain traceable
 
 ### Return & Exchange Policy (v0.3.2+)
 Riverside OS enforces a global **60-day return window**.
 - **Staff Authorization (<= 60 days)**: Standard staff with `orders.modify` can process returns/exchanges for transactions booked within the last 60 days.
 - **Manager Override (> 60 days)**: Transactions older than 60 days strictly require a **Manager PIN** (staff member with `orders.modify` or `admin` role) to authorize the modification.
 - **Wizard Pattern**: Complex post-sale adjustments (Exchanges) MUST use the **Phase-Based Wizard** pattern (wide-workspace, guided phases, active instruction cards).
 
 ### RBAC Auto-Synchronization (v0.3.2+)
 - **Profile Parity**: Changing a staff member's **Role** in the Back Office profile MUST automatically synchronize their **`staff_permission`** set and **`max_discount_percent`** from the new role's template.
 - **Manual Overrides**: The synchronization logic must attempt to preserve existing manual user overrides while ensuring the staff member attains the mandatory baseline of their new role.
 
 ### Codex & ROSIE Invariants (v0.3.2+)
 - **Narrow Audit Mandate**: When given directions, the agent MUST adhere to the structured mindset defined in **`codex_prompt_template.md`**. This includes tracing behavior end-to-end, identifying real (not theoretical) issues, and proposing the smallest correct fix.
 - **ROSIE Safety Rails**: When touching AI features (ROSIE), the agent MUST strictly follow the **ROSIE Rules** in **`codex_prompt_template.md`** (No raw SQL, no RBAC bypass, server-validated tool execution, and user-confirmed mutations).
 - **Scope Locking**: Do not broaden scope, switch branches, or redesign entire systems unless explicitly requested.

---

## Core business rules

### Revenue recognition

- Revenue is recognized on fulfillment / pickup, not on initial order booking
- Booked activity and fulfilled activity are separate reporting concepts
- Reports must distinguish “booked/sale” from “fulfilled/pickup” correctly

### Tax rules

- Tax is calculated at the line-item level
- Client-side price changes must trigger tax recalculation
- Tax-exempt orders must carry a `tax_exempt_reason`
- Do not infer effective tax rates from rounded totals

### Transaction / custom transaction inventory model

```text
Checkout         → stock_on_hand unchanged for order / wedding_order / custom / layaway lines
PO receipt       → stock_on_hand += qty AND reserved_stock += min(qty, open_special_qty)
Pickup (fulfill) → stock_on_hand -= qty AND reserved_stock -= qty (if reserved) OR on_layaway -= qty
available_stock  = stock_on_hand - reserved_stock - on_layaway
```

Do not decrement `stock_on_hand` at checkout for `DbFulfillmentType::Order` (Special), `DbFulfillmentType::Custom`, or equivalent order-style flows.

### Wedding group payments

- Group disbursements must flow through `wedding_disbursements`
- Do not manually decrement balances without corresponding `payment_allocation` rows
- `CheckoutRequest.total_price` is lines + shipping only
- Do not fold wedding disbursement amounts into `total_price`

### Auth / authorization

- Do not weaken PIN verification or middleware auth
- Preserve auditable manager approval flows
- Admin bypass behavior must remain explicit and logged
- Always use **PIN** or **Access PIN** terminology in user-facing labels and docs
- **Identity Selection**: Identity dropdown + explicit staff selection before **Access PIN** entry is the universal system behavior.
- **Auto-assigned Tracking ID**: Staff IDs (Internal Code) are auto-assigned for reporting and should not be manually managed unless audit recovery is required.

### Receipt privacy

- Customer-facing receipts must use masked naming rules where required
- Internal screens and reports use full names

### POS financial presentation

- The checkout footer should use **Balance Due** as the primary anchor
- Do not introduce redundant “Grand Total” / “Transaction Total” duplication in final payment UX
- Checkout ledgers must separate Net Retail, Shipping, and Taxes
- CHECK tenders must capture `check_number`

---

## Where to make changes

| Task                                         | Likely locations                                                                                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| New REST endpoint                            | `server/src/api/<module>.rs`, register in `server/src/api/mod.rs`; use `{id}` style path params                                                                    |
| Business / pricing / tax / fulfillment logic | `server/src/logic/`, `server/src/services/`                                                                                                                        |
| SQL enums / DB-aligned types                 | `server/src/models/` + migrations                                                                                                                                  |
| New UI screen / tab                          | `client/src/App.tsx`, `client/src/components/...`, `Sidebar.tsx` if new nav                                                                                        |
| Reporting / Insights / Metabase              | `server/src/api/insights.rs`, `server/src/api/metabase_proxy.rs`, `client/src/components/reports/`, `client/src/components/layout/InsightsShell.tsx`               |
| POS / checkout UX                            | `client/src/components/pos/`                                                                                                                                       |
| Register manager dashboard                   | `client/src/components/pos/RegisterDashboard.tsx`, `PosShell.tsx`, `PosSidebar.tsx`, related server staff metrics                                                  |
| Till group / multi-lane register             | `server/src/api/sessions.rs`, `client/src/components/pos/RegisterOverlay.tsx`, `CloseRegisterModal.tsx`, register gate context                                     |
| Parked sales / RMS charges                   | `server/src/logic/pos_parked_sales.rs`, `server/src/logic/pos_rms_charge.rs`, `server/src/api/pos*.rs`, `client/src/components/pos/*`, `RmsChargeAdminSection.tsx` |
| Shell / layout / drawers                     | `client/src/components/layout/`                                                                                                                                    |
| Unified Engine / Host Mode                   | `client/src-tauri/src/unified_server.rs`, `server/src/launcher.rs`                                                                                                 |
| Customers CRM / Hub                          | `client/src/components/customers/`                                                                                                                                 |
| Transactions / fulfillment / returns         | `server/src/api/transactions.rs`, `server/src/logic/`, `client/src/components/orders/`                                                                             |
| Scheduler / appointments                     | `client/src/components/scheduler/`, `client/src/lib/weddingApi.ts`                                                                                                 |
| Inventory / control board / importer         | `client/src/components/inventory/`, related server inventory routes                                                                                                |
| Notifications / inbox                        | `server/src/api/notifications.rs`, `server/src/logic/notifications.rs`, notification UI                                                                            |
| ROS Dev Center ops board / guarded actions   | `server/src/api/ops.rs`, `server/src/logic/ops_dev_center.rs`, `client/src/components/settings/RosDevCenterPanel.tsx`, `docs/ROS_DEV_CENTER.md`                 |
| Staff tasks / scheduling                     | `server/src/api/tasks.rs`, `server/src/logic/tasks.rs`, `server/src/logic/staff_schedule.rs`, `client/src/components/tasks/`                                       |
| Settings / Hardware / Scanners               | `server/src/api/settings.rs`, `PrintersAndScannersPanel.tsx`, `SettingsWorkspace.tsx`                                                                                                               |
| Weather / Visual Crossing                    | `server/src/logic/weather.rs`, `server/src/api/weather.rs`, settings UI                                                                                            |
| Podium SMS / inbox / reviews                 | `server/src/logic/podium*.rs`, `messaging.rs`, `api/webhooks.rs`, customer podium routes, Settings + Inbox UI                                                      |
| Meilisearch                                  | `server/src/logic/meilisearch_*.rs`, `api/help.rs`, settings reindex UI                                                                                            |
| Online store                                 | `server/src/api/store*.rs`, `server/src/logic/store_*.rs`, `client/src/components/store*`, `PublicStorefront.tsx`                                                  |
| Stripe vault / credits                       | `server/src/logic/stripe_vault.rs`, `server/src/api/payments.rs`, `StripeVaultCardModal.tsx`, POS checkout UI                                                      |
| Tauri / hardware bridge                      | `client/src-tauri/`                                                                                                                                                |
| Observability / OTLP                         | `server/src/observability/`, `server/src/main.rs`                                                                                                                  |

Follow existing module patterns before creating new abstractions.

---

## High-risk areas that require extra caution

Any change touching these areas must be treated as high risk:

- Checkout
- Deposits
- Revenue recognition
- Tax
- Fulfillment / pickup
- Returns / refunds / exchanges
- Register session lifecycle
- PIN / auth / manager approval
- Receipt rendering
- Reporting views
- Counterpoint sync
- QBO journal logic
- Stripe vault / credits
- Notification deep-link contracts

---

## Required checks before considering work done

### Always

```bash
cargo fmt
cd client && npm run lint
cd client && npm run typecheck
```

### Often required

```bash
npm run check:server
cd client && npm run build
```

### When changing server queries or sqlx macros

```bash
cd server
cargo sqlx prepare --workspace
```

### When changing checkout / tax / deposits / fulfillment / revenue logic

- Add or update Playwright coverage
- Re-check reporting implications
- Update relevant docs if workflow behavior changed

### When changing dashboard interfaces or shared queue types

Synchronize all duplicated/shared interface definitions immediately

At minimum, watch for:

- `PriorityDashboardBundle` (formerly MorningCompass)
- `RushTransactionRow`
- `PosTransactionOptions`

### When renaming section IDs, tabs, or navigation keys

Update corresponding sidebar, route, and deep-link mappings in the same change

### When changing user-visible workflows

Update relevant `docs/staff/*.md` manuals when practical

---

## Auth model (do not modify casually)

```text
Back Office gated routes:
  Header: x-riverside-staff-code   (Employee Tracking ID; auto-resolved)
  Header: x-riverside-staff-pin    (Access PIN hash)
  Permission: route-specific key checked by middleware::require_staff_with_permission
  Admin role: DbStaffRole::Admin implies full permission catalog

POS routes:
  authenticate_pos_staff() — verifies cashier/PIN from unified auth
  Primary login: POST /api/staff/verify-cashier-code (Internal; legacy mapping)
  Unified PIN auth: POST /api/staff/admin/{id}/set-pin
  POS verification: POST /api/staff/verify-pin (Standard)
```

Manager approvals must continue to record `authorize_action` and `authorize_metadata`.

---

## API / routing notes

### Axum state

- `build_router()` returns `Router<AppState>`
- Only `main.rs` calls `.with_state(state)` before serving

### Static gateway

- Do not hardcode `127.0.0.1` for the server listener
- Use `0.0.0.0` or env-driven binding
- Preserve SPA fallback for non-API routes

### Client API base URL

Use:

```ts
import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
```

for new fetch calls unless a project-specific helper already exists.

### Staff-or-POS session polling

- Under `BackofficeAuthProvider`, use `mergedPosStaffHeaders(backofficeHeaders)`
- Use `sessionPollAuthHeaders()` only where provider context is unavailable
- Do not break register bootstrap semantics

---

## Workspace Mirroring & Component Reuse

To ensure institutional consistency and minimize code duplication, major tactical hubs are mirrored between the Back Office (BO) and POS shells. The following sections utilize the same foundation components across both surfaces:

- **Customers Hub**: Full CRM capabilities, joint accounts, and relationship tracking.
- **Shipping Hub**: Full Shippo integration, rate quoting, and shipment tracking.
- **Orders Hub**: Full order management, historical sales, and fulfillment tracking.
- **Loyalty & Gift Cards**: Balance management and transaction history.
- **Alterations**: Work queue and fitting hub.
- **Layaways**: Installment tracking and fulfillment.

When modifying these components, verify behavior in both **Operations** (BO) and **Register** (POS) modes.

---

## UX alignment notes

### Global shell

The main shell component is the central hub of the application, responsible for managing UI state and rendering content based on user interactions and application state. It supports various modes such as POS (Point of Sale), Insights (analytics and reporting tools), and Wedding (wedding-related functionalities). The component includes features like sidebar navigation, global search drawer, deep link handling, permissions and access control, theme mode, error handling, and navigation and routing.

- **Standalone Architecture**: `server/` (Rust Axum) + `client/` (React/Tauri).
- **Unified Hybrid Model (v0.2.1+)**: The Tauri shell optionally embeds the backend engine as a background service, allowing for "Single PC Server" deployments where the UI and API update together.
- **AppShell Architecture**: In v0.2.0, the `AppShell` component was introduced as a strict boundary for authenticated users. The `GlobalTopBar` and persistent navigation layouts MUST only be rendered within the `AppShell`.
- Unauthenticated interfaces (e.g., `BackofficeSignInGate`) must sit outside the `AppShell` to maintain clean, centered layouts without navigational chrome.
- Register and Weddings are embedded inside the main Back Office shell.
- Do not reintroduce aggressive redirects to external shells.

1. **Sidebar Navigation**:

   - Open the Sidebar: Click on the hamburger icon in the top-left corner of the screen.
   - Select a Section: Choose from the available sections such as POS, Insights, Wedding, etc., to navigate between different parts of the application.

2. **Global Search Drawer**:

   - Open the Search Drawer: Click on the search icon in the top-right corner of the screen.
   - Enter Search Query: Type your query to search for customers, products, and wedding party customers.
   - Select a Result: Click on the desired result to view more details.

3. **Deep Link Handling**:
   - Access via URL: Use deep links to directly access specific features like alterations, procurement, inventory product hub, QBO sync logs, etc.
   - Example: `https://app.example.com/alterations` will take you directly to the alterations section.

4. **Settings Navigation & Unified Workspace (v0.2.1+)**:
   - The **Settings** module uses a unified `SettingsWorkspace` across both Back Office and POS shells.
   - **Profile-First Default**: All settings entry points MUST default to the **Staff Profile** section.
   - **Sidebar Authority**: The global sidebar (or POS rail) is the sole authority for sub-section selection. Internal tab-switching within the workspace is deprecated.
   - **Terminal Overrides**: POS-specific hardware settings are integrated as the **Terminal Overrides** sub-section within the unified workspace.

### POS design invariants

- **WowDash Aesthetic**: The POS dashboard ("Register Manager") uses glassmorphism and the standardized card grid.
- **Permissions**: Floor staff roles are gated during register attachment; manager approval PINs use Argon2 and require a `authorize_action` log.
- **Theme**: Supports light/dark mode via `:root` CSS variables.
- **Hardware**: Async TCP ESC/POS thermal printing for receipts and bag tags.

### POS search

1. **Global Search Drawer**:
   - Open the Search Drawer: Click on the search icon in the top-right corner of the screen.
   - Enter Search Query: Type your query to search for customers, products, and wedding party customers.
   - Select a Result: Click on the desired result to view more details.

### Customers workspace

1. **Global Search Drawer**:
   - Open the Search Drawer: Click on the search icon in the top-right corner of the screen.
   - Enter Search Query: Type your query to search for customers, products, and wedding party customers.
   - Select a Result: Click on the desired result to view more details.

### Operational Surfaces

- **Operations Hub**: Replaces tactical terminology (Morning Dashboard). Focuses on trend visualization and the central Action Board.
- **Opt-in Scheduling**: Staff (salesperson/support) only appear in "Team on Floor" if explicitly scheduled via `staff_weekly_availability` or day exceptions. Default is OFF.
- **Responsive**: All operational surfaces must handle 1080p and 1440p using `DashboardGridCard`.

### Global shell

- Register and Weddings are embedded inside the main Back Office shell
- Do not reintroduce aggressive redirects to external shells

### POS navigation

- Back Office sidebar item **POS** is the launchpad into `PosShell`
- Subsection **Register** opens the POS launchpad
- Inside POS mode, the rail provides direct access to mirrored hubs:
  - **Register**: The selling surface (`Cart.tsx`)
  - **Customers**: Full mirrored BO Customers workspace
  - **Shipping**: Full mirrored BO Shipments hub
  - **Inventory**: POS-optimized product list and receiving
  - **Weddings**: Full integrated Wedding Management Hub (v0.2.1+)
  - **Alterations / Loyalty / Gift Cards / Layaways**: Standardized mirrored workspaces
- Do not relabel the whole shell “Register”

### POS design invariants

- Terminal completion actions use emerald completion styling:
  - `bg-emerald-600`
  - `border-b-8`
  - `border-emerald-800`
- Drawers should aim for zero-scroll on 1080p where practical
- Variant selection confirmation includes numpad-based `%` and `$` modifiers
- Hardware payment flows should preserve high-fidelity simulation overlays where already established
- Maintain zero-browser-dialog architecture across operational workspaces

### POS search

- Keep the multi-threaded resolution strategy in `Cart.tsx`
- Do not regress to simplistic SKU-only or fuzzy-only behavior
- Preserve the exact `PAYMENT` search exception for RMS charge payment line injection

### Customers workspace

- Keep the browse list scrollable using the existing flex/min-h layout discipline
- Add customer remains a `DetailDrawer` slideout, not a centered full-screen modal
- Preserve sidebar subsection sync for add/edit flows

### CRM density

- Customer Name is the primary visual anchor in list rows
- Preserve high-density, name-dominant CRM presentation patterns

### PWA / remote

- Respect responsive behavior using `sm:`, `md:`, `lg:` aggressively for staff and operational surfaces
- Keep the sidebar toggle behavior for small screens

---

## Observability

Use structured tracing:

```rust
tracing::error!(error = %e, "descriptive failure message");
tracing::warn!(error = %e, "warning message");
tracing::info!(staff_id = %id, event = "some_event", "business event");
```

Do not leave ad hoc `println!` / `eprintln!` debugging in production paths.

All external sync/webhook-style flows should continue to use the project’s async dispatch patterns.

---

## Messaging & notifications

Automated customer pings are handled by `MessagingService` in `server/src/logic/messaging.rs`.

- Pickup/status messaging checks opt-in state before send/log behavior
- Shared read-all behavior for common team notifications is intentional
- Notification deep-link payloads must stay consistent with frontend router expectations
- Do not invent new payload shapes casually

Examples of valid payload shapes:

```json
{"type": "transaction", "transaction_id": "..."}
{"type": "inventory", "section": "list", "product_id": "..."}
{"type": "settings", "section": "bug-reports", "bug_report_id": "..."}
```

---

## Logistics & printing

The system supports multiple thermal print modes via receipt/ZPL builders.

Key expectations:

- Customer receipts remain customer-safe
- Bag tag mode continues to support physical item labeling
- Professional report printing remains distinct from thermal receipt output
- Zebra layouts must preserve current operational sizing assumptions

---

## Commands

### Core dev

```bash
npm run check:server
npm run bump <new_version>
cd client && npm run build
npm run dev
```

### Local services

```bash
docker compose up -d
./scripts/apply-migrations-docker.sh
./scripts/migration-status-docker.sh
```

### Optional Meilisearch

```bash
docker compose up -d meilisearch
./scripts/ros-meilisearch-reindex-local.sh
```

### E2E

```bash
cd client
npm run test:e2e -- --list
E2E_BASE_URL="http://localhost:5173" npm run test:e2e
E2E_BASE_URL="http://localhost:5173" npx playwright test --workers=1
E2E_BASE_URL="http://localhost:5173" npm run test:e2e:update-snapshots
```

### E2E notes

- Use `localhost` rather than `127.0.0.1` for browser tests where required
- Dashboard-related tests should tolerate slower CI timing
- Keep `docs/E2E_REGRESSION_MATRIX.md` current when coverage changes

---

## Local database / migration notes

- Local dev uses Docker Compose `db`
- `DATABASE_URL` should use `localhost:5433`, not `5432`
- The migration ledger is `public.ros_schema_migrations`

- Use the scripts in `scripts/` rather than inventing ad hoc migration workflows

## Migration numbering safety

- Never rename or renumber existing migrations
- Always create a new migration for changes
- Preserve migration order across branches
- Verify migration sequence before making changes

### Migration truth rule

Do not hardcode a stale migration ceiling in AGENTS.

When you need the latest migration:

- inspect `migrations/`

- confirm with `DEVELOPER.md`
- confirm with migration-status scripts

If docs disagree, the actual migration files and current code win.

---

## Counterpoint sync notes

- `COUNTERPOINT_SYNC_TOKEN` protects `/api/sync/counterpoint/*`
- Never log the token
- Prefer HTTPS when ROS is not localhost
- Preserve the separation between M2M ingest and staff-gated settings/admin flows
- Do not casually change sync payload shapes, provenance semantics, or mapping-table assumptions

Customers continue to use `customer_code` as the core import/upsert identity.
Do not create duplicate Lightspeed-style matching columns.

### Historical Sync & Lifetime Sales (2018 Hardening)

- **Jan 1, 2018 Baseline**: All historical sales and inventory movement must be synced from this date forward to ensure full lifecycle auditability.
- **Calculation over Static Fields**: Customer **Lifetime Sales** are never pulled as a static value. They are calculated dynamically by aggregating all imported `transactions` with `booked_at >= '2018-01-01'`.
- **2018 Historical Floor**: The bridge is configured to pull all transactional history (tickets, payments, inventory movement) from **January 1st, 2018**, providing a complete audit trail for financial reporting.

---

## Versioning

- The root `package.json` version is the source of truth
- `client`, `server`, and `tauri` version values must remain synchronized
- Follow SemVer
- Use `npm run bump <new_version>` for coordinated updates
- Update `CHANGELOG.md` with release notes for shipped changes

---

## AI behavior expectations

When working on a task:

1. Find the source of truth first
2. Trace side effects before proposing a fix
3. Respect financial, tax, auth, and audit constraints
4. Prefer production-ready patches over pseudo-code
5. Call out migrations, tests, docs, and downstream files that need updates

For substantial changes, identify:

- affected files
- business-risk areas
- migration needs
- sqlx prepare needs
- required tests
- docs that should be updated

Prefer:

- small, focused patches
- minimal safe refactors
- centralized business logic
- established project conventions
- strongly typed APIs and domain-safe errors

Avoid:

- broad rewrites without strong justification
- duplicate business logic across client and server
- unnecessary new dependencies
- bypassing established auth or audit flows
- stale assumptions from old docs when code says otherwise

When requirements are unclear, do not invent critical financial, tax, fulfillment, auth, or reporting behavior. State the assumption and choose the safest implementation.

---

## Repo truth rules

If documentation conflicts:

1. Current code and current migrations win
2. Then `DEVELOPER.md`
3. Then `README.md`
4. Then current `CHANGELOG.md`
5. Then older historical notes

Do not assume stale docs are authoritative without checking implementation.

---

## Deep reference appendix

Use this section as a repo map and extended reference, not as the primary source of truth over code.

### Key docs / references

- `docs/ORBSTACK_GUIDE.md`
- `docs/MAINTENANCE_RUNBOOK.md`
- `docs/BRIDGE_SYNC_TROUBLESHOOTING.md`
- `REMOTE_ACCESS_GUIDE.md`
- `docs/PWA_AND_REGISTER_DEPLOYMENT_TASKS.md`
- `INVENTORY_GUIDE.md`
- `BACKUP_RESTORE_GUIDE.md`
- `docs/MAINTENANCE_AND_LIFECYCLE_GUIDE.md`
- `docs/CATALOG_IMPORT.md`
- `docs/CUSTOMERS_LIGHTSPEED_REFERENCE.md`
- `docs/CUSTOMER_HUB_AND_RBAC.md`
- `docs/SEARCH_AND_PAGINATION.md`
- `docs/OFFLINE_OPERATIONAL_PLAYBOOK.md`
- `docs/WEATHER_VISUAL_CROSSING.md`
- `docs/PLAN_NOTIFICATION_CENTER.md`
- `docs/PLAN_PODIUM_SMS_INTEGRATION.md`
- `docs/PLAN_PODIUM_REVIEWS.md`
- `docs/STAFF_TASKS_AND_REGISTER_SHIFT.md`
- `docs/STAFF_SCHEDULE_AND_CALENDAR.md`
- `docs/REGISTER_DASHBOARD.md`
- `docs/TILL_GROUP_AND_REGISTER_OPEN.md`
- `docs/RETIRED_DOCUMENT_SUMMARIES.md`
- `docs/staff/README.md`
- `docs/AI_REPORTING_DATA_CATALOG.md`
- `docs/DAILY_SALES_REPORTS.md`
- `docs/TRANSACTION_RECORD_HUB_GUIDE.md`
- `docs/CLIENT_UI_CONVENTIONS.md`
- `docs/SHIPPING_AND_SHIPMENTS_HUB.md`
- `docs/ONLINE_STORE.md`
- `docs/RECEIPT_BUILDER_AND_DELIVERY.md`
- `docs/PLAN_BUG_REPORTS.md`
- `docs/OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`
- `docs/COMMISSION_AND_SPIFF_OPERATIONS.md`
- `client/src/assets/docs/lockout-manual.md`

### Additional high-signal reminders

- Use `reporting.*` schema views for user-facing reporting extraction where applicable
- Avatar/static file readers must handle both `client/` and `../client/` path cases
- Shared dashboard interfaces must stay synchronized
- `ToastProviderLogic` expects `toast(message: string, type?: ToastType)`
- Do not pass object payloads to the toast helper if the current implementation expects a string
- Preserve `RegisterSessionBootstrap` semantics around session-id-based shell reapplication
- Keep POS and Back Office terminology aligned with the current product language
- Preserve existing Stripe branding: `STRIPE CARD`, `STRIPE MANUAL`, `STRIPE VAULT`

---

## If unsure

Stop and verify against:

- `.cursorrules`
- `DEVELOPER.md`
- the nearest domain doc
- the current implementation pattern in code

Do not guess on money, tax, fulfillment, auth, reporting, or migration behavior.
