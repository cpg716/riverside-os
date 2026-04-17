# Client UI conventions (ROS)

Single reference for **React/Vite** layout, tokens, modal accessibility, lazy loading, and the **embedded Wedding Manager** subtree. Product-facing staff copy lives under `docs/staff/`; this file is for implementers.

## Related docs

| Artifact | Use |
|----------|-----|
| [`UI_STANDARDS.md`](../UI_STANDARDS.md) | **Zero-browser-dialog** policy; `useToast`, `ConfirmationModal`, `PromptModal` examples. |
| [`client/UI_WORKSPACE_INVENTORY.md`](../client/UI_WORKSPACE_INVENTORY.md) | Sidebar/POS tab → component map, **`density-*`** assignment, **`React.lazy`** list, overlay sweep checklist — **update when adding or renaming tabs**. |
| [`DEVELOPER.md`](../DEVELOPER.md) § **Frontend concepts** | Shell integration, POS search, shared primitives summary. |
| [`docs/ROS_UI_CONSISTENCY_PLAN.md`](ROS_UI_CONSISTENCY_PLAN.md) | Full-app **`data-theme`** / `dark:` / typography sweep; **Phases 1–5** complete (2026-04-08); guest **`/shop`** deferred; Phase 5 E2E + **`RegisterSessionBootstrap`** shell idempotency. |
| [`docs/SEARCH_AND_PAGINATION.md`](SEARCH_AND_PAGINATION.md) | Large-catalog APIs and UI paging; optional Meilisearch; **Settings → Integrations** search reindex. |
| [`docs/CI_CD_AND_CODE_HYGIENE_STANDARDS.md`](CI_CD_AND_CODE_HYGIENE_STANDARDS.md) | **Zero-Error Baseline** requirements, `exhaustive-deps` stabilization, and Logic Separation rules. |
| [`docs/ONLINE_STORE.md`](ONLINE_STORE.md) | Guest **`/shop`** shell (**`PublicStorefront.tsx`**, incl. **`/shop/account/*`**): **TanStack Query**, **`client/src/components/ui-shadcn/`** + **`[data-storefront]`** tokens (separate from BO **`ui-*`**). |

## WowDash Design System (v0.2.0+)

The "WowDash" aesthetic is the premium SaaS-inspired visual identity for Riverside OS. It prioritizes clarity, depth, and data-rich visualization.

### Design Tokens & Aesthetics
- **Glassmorphism**: High-level containers use `bg-app-surface/50` combined with `backdrop-blur-md` for a layered, premium feel.
- **Typography**: Standardizes on **Inter** (or **Outfit**) with a hierarchy that favors high-impact tracking for titles and clear, accessible weights for data.
- **Shadows**: Soft, multi-layered shadows (`shadow-xl`) for elevated grid cards.
- **Color Palette**: Uses curated HSL-tailored colors (Blue, Emerald, Orange, Rose, Purple) for functional signals rather than generic browser defaults.
- **Transaction Terminology**: All staff-facing and internal labels have been standardized from "Orders" to **"Transactions"** (e.g., Transaction History, Transaction Details). "Orders" is reserved specifically for logistical fulfillment objects.

### Full-Width Workspace & Root Scrolling (v0.2.0+)
Riverside OS has transitioned from a windowed/nested-scroll model to a **high-performance, full-width, and natively scrollable** layout.

- **Edge-to-Edge Design**: Main workspace containers must utilize the full viewport width and remove redundant shadows/rounded corners to create a "Flush" professional feel.
- **Root Scrolling**: Avoid `h-screen` and `overflow-hidden` on main application containers. The root document handles scrolling, eliminating "window-inside-window" scrollbars.
- **Sticky Persistence**: The `GlobalTopBar` and `Sidebar` use `sticky top-0` and `sticky left-0` with high z-index to remain accessible while the workspace content scrolls behind them.
- **Resolution Optimization**: Layouts must handle 1080p, 1440p, and iPad 11 Pro (11") resolutions gracefully. Use `max-w-[1200px]` or `max-w-7xl` centered for content that becomes too sparse on ultra-wide screens, but allow the outer background to flush to the edges.
- **Exception (Alterations Hub)**: The Alterations Hub remains the legacy exception using the windowed/drawer model for tactical density. New workspaces MUST follow the full-width model.

### Persistent Top Bar (v0.2.0+)
Riverside OS utilize a persistent, touch-friendly Top Bar that remains visible across all shells (POS, Insights, Wedding Manager, Back Office).

- **Identity & Context**: Displays the logged-in staff member (Avatar + Name) and the **Register Access** status.
- **Access Toggles**: Standard staff session is indicated by **Staff Access** (green icon). Privileged status for overrides is indicated by **Manager Access** (crown icon).
- **Universal Search**: Centered lookup for Customers and Products, accessible from any operational section.
- **Global Actions**: Quick access to Bug Reporting, Help Center, Theme Toggle (Sun/Moon), and Notifications.
- **Breadcrumbs**: Dynamic navigation path on the left for quick context-switching and section exits.
- **Shell-Specific Data**: Right-side injection slot for shell-specific status (e.g., POS Register Balance).

### Dashboard Primitives
Located in `client/src/components/ui/`, these components serve as the foundation for all operational views:

- **`DashboardStatsCard`**: Canonical KPI component.
  - **Features**: Integrated `recharts` sparklines, trend indicators (Up/Down), and semantic status icons.
  - **Props**: `title`, `value`, `trend`, `sparklineData`, `color`, `icon`.
- **`DashboardGridCard`**: The standard container for daily action widgets.
  - **Features**: Standardized header with Icon + Title + Subtitle; support for footer actions and scrolling lists.
  - **Usage**: Use for "Morning Compass", "Activity Feed", and "Floor Matrix" logic.

## Search and Lookup Components

Riverside OS follows a **search-first administrative mandate**. Direct entry of UUIDs or SKUs is discouraged in favor of fuzzy-search components that provide immediate visual feedback.

- **`CustomerSearchInput`**: The canonical component for customer lookups. Supports searching by Name, Customer Code, Phone, or Email. Used in Tasks, Appointments, Gift Cards, and Loyalty adjustments.
- **`VariantSearchInput`**: The canonical component for product/variant lookups. Supports fuzzy SKU and Name matching. Used in Physical Inventory and Catalog management.
- **Implementation Pattern**:
  - Components should generally be "optional-link" or "required-search" depending on the business logic.
  - Alway display a "Selected: [Name]" or similar label below the search input when an ID is resolved to provide the operator with visual confirmation.
  - For long lists, ensure the component handles "Load more" semantics if provided by the underlying API.

## Primitives and density

- Prefer **`density-compact`** / **`density-standard`**, **`ui-card`**, **`ui-input`**, **`ui-btn-primary`**, **`ui-btn-secondary`**, **`ui-pill`** before bespoke Tailwind. Definitions live in **`client/src/index.css`** (`@layer utilities`) and **`client/tailwind.config.js`** (`theme.colors.app`).
- **`StaffMiniSelector`**: The canonical component for in-line or high-density staff attribution (Avatar + Name dropdown). Replaces standard `<select>` in POS cart lines and headers for consistent, visual staff selection.
- **`ui-input`** uses **`--app-input-border`** and **`--app-input-bg`** for consistent light/dark field contrast.
- **Back Office density** (see inventory): `density-compact` on **POS** launchpad, customers, alterations, orders; **`density-standard`** elsewhere unless there is a deliberate POS-adjacent reason.
- **POS Cart Layout**: Prioritize horizontal width over vertical height. Line items use a grid/flex layout with Product Info/Salesperson on the left, Fulfillment in the middle, and QTY/SALE controls on the right.
- **Emerald “terminal” completion** (POS parity on critical commits): For actions that **finalize** inventory, wedding pipeline steps, or irreversible CRM commits, use the same **emerald + bottom border** treatment as POS (**`UI_STANDARDS.md`** § Design Invariants). Examples: **`ReceivingBay`** Post inventory, WM **Action Dashboard** **Done**, **Customers** merge confirm. **`bg-app-accent`** remains appropriate for general primary navigation and non-terminal confirms.

## Modal and drawer accessibility

- Hook: **`client/src/hooks/useDialogAccessibility.ts`** — focus trap, Tab cycle, optional Escape handling, focus restore on close, optional **`initialFocusRef`**.
- Pair with **`role="dialog"`**, **`aria-modal="true"`**, and **`aria-labelledby`** pointing at a stable title element id.
- **`client/src/components/layout/DetailDrawer.tsx`** uses the hook (unique title id per instance). ROS modals that overlay the shell should follow the same pattern; see the sweep notes in **`client/UI_WORKSPACE_INVENTORY.md`**.
- **Admin Workflow Pattern**: Prefer **`DetailDrawer`** slideouts for high-density resource management (e.g., **`StaffEditDrawer`**, **`CustomerRelationshipHubDrawer`**, **`ProductHubDrawer`**) to maintain context and shell stability. Centered modals (`ConfirmationModal`, `PromptModal`) are reserved for atomic intent checks and transient inputs.

## Code splitting (`client/src/App.tsx` and POS)

- Heavy Back Office workspaces load via **`React.lazy`** + **`Suspense`** (e.g. Inventory, QBO, Insights, Wedding Manager on the BO tab, Orders, Alterations on the BO path, Staff, Gift Cards, Loyalty, Settings, Scheduler).
- **`PosShell`**: the **Alterations** POS tab uses **`lazy(() => import(...AlterationsWorkspace))`** + **`Suspense`** (same pattern as BO) so the alterations bundle is not pulled in on initial POS load.
- **`WeddingManagerApp`** may still ship in the main chunk when imported by **`WeddingShell`** — avoid duplicate lazy boundaries that fight eager imports for that path.

## Embedded Wedding Manager (`client/src/components/wedding-manager/`)

- **Layout and interaction parity** with the upstream WM UX; **surfaces** should use **app tokens** (`bg-app-surface`, `text-app-text`, etc.) so dark mode matches the shell—no full visual redesign.
- **Stack**: **`context/ModalContext.jsx`** + **`components/GlobalModal.jsx`**. The salesperson picker resolves a Promise via a **ref** for **`resolve`** plus explicit open state so **`onClose` / `onSelect`** are not stale when the parent re-renders (e.g. socket updates).
- **Buttons**: every **`<button>`** must declare **`type="button"`** or **`type="submit"`** (only for the primary control inside a real form). Prevents accidental submission when actions sit inside a **`<form>`** wrapper.

## E2E and build

- **E2E:** Prefer **`E2E_BASE_URL=http://localhost:5173`** (see **`.cursorrules`** / **`AGENTS.md`**). Layout smoke: **`client/e2e/pwa-responsive.spec.ts`**.
- Release gate: **`cd client && npm run build`**.

**Last reviewed:** 2026-04-15 (v0.2.0 WowDash Pass)

## POS Register Design & Financial Parity

The POS checkout system is a high-stakes operational environment requiring extreme visual clarity and touch precision.

- **Touch-First Operational Density**: All primary payment and numeric interaction targets MUST be optimized for finger-based usage. Tenders and payment methods MUST utilize large targets (e.g., `h-16` or higher) with clear, high-contrast labels.
- **Stripe Unified Branding**: To ensure operational clarity, integrated payment methods must be explicitly labeled as **STRIPE CARD**, **STRIPE MANUAL**, or **STRIPE VAULT**. This branding signal prioritizes the processor name as the anchor.
- **Zero Redundancy Discipline**: Redundant total displays are prohibited. The checkout footer MUST display only the **Balance Due** as the singular, high-punch financial anchor. Avoid duplicating 'Remaining' or 'Grand Total' labels in the same view.
- **Tax Exemption UI**: When an order is marked as tax-exempt, the UI MUST strike through tax lines and dynamically update the **Balance Due**. A required reasoning selector must be provided and persisted for the audit trail.
- **Tax Parity Invariant**: Every line calculation (manual, discount, override) MUST use `calculateNysErieTaxStringsForUnit` on the client. Server-side `checkout_validate.rs` is authoritative. Search results (`InventoryControlRow`) and single-variant hydration (`get_variant`) MUST include the authoritative `tax_category` to prevent divergence.
- **Revenue Protocol compliance**: All ledgers MUST explicitly separate Net Retail, Shipping, and dual Taxes (NYS + Local). Never consolidate these into a single "Total" line.
