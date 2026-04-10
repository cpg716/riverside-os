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
- **`ui-input`** uses **`--app-input-border`** and **`--app-input-bg`** for consistent light/dark field contrast.
- **Back Office density** (see inventory): `density-compact` on **POS** launchpad, customers, alterations, orders; **`density-standard`** elsewhere unless there is a deliberate POS-adjacent reason.
- **Emerald “terminal” completion** (POS parity on critical commits): For actions that **finalize** inventory, wedding pipeline steps, or irreversible CRM commits, use the same **emerald + bottom border** treatment as POS (**`UI_STANDARDS.md`** § Design Invariants). Examples: **`ReceivingBay`** Post inventory, WM **Action Dashboard** **Done**, **Customers** merge confirm. **`bg-app-accent`** remains appropriate for general primary navigation and non-terminal confirms.

## Modal and drawer accessibility

- Hook: **`client/src/hooks/useDialogAccessibility.ts`** — focus trap, Tab cycle, optional Escape handling, focus restore on close, optional **`initialFocusRef`**.
- Pair with **`role="dialog"`**, **`aria-modal="true"`**, and **`aria-labelledby`** pointing at a stable title element id.
- **`client/src/components/layout/DetailDrawer.tsx`** uses the hook (unique title id per instance). ROS modals that overlay the shell should follow the same pattern; see the sweep notes in **`client/UI_WORKSPACE_INVENTORY.md`**.

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

**Last reviewed:** 2026-04-08
