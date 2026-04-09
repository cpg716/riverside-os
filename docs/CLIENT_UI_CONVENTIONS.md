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

## Architectural Hygiene

- **Logic Separation:** To maintain **Fast Refresh** compliance and "Thin Components," complex transformation logic, shared interfaces, and pure helpers must reside in dedicated logic files (e.g., `ComponentLogic.ts`) rather than the component file.
- **Hook Stability:** All asynchronous functions consumed by `useEffect` must be wrapped in **`useCallback`**. External constants (e.g., `baseUrl`) must be excluded from dependency arrays.
- **Unauthenticated Fetches:** Never eagerly fetch authenticated backend metadata (e.g. from `/api/pos/*` or `/api/staff/*`) on component load without first asserting `apiAuth()` yields valid auth headers (like `x-riverside-pos-session-token` or `x-riverside-staff-pin`). If missing, early return `useEffect` logic to prevent 401 Unauthorized console spam.

## Theme (light / dark / system)

- **Source of truth:** `<html data-theme="light">` or `data-theme="dark"`, driven by **`ros.theme.mode`** in `localStorage` (`light` | `dark` | `system`) and **`prefers-color-scheme`** when mode is `system`.
- **Staff app:** [`client/src/App.tsx`](../client/src/App.tsx) persists the user’s choice and applies the resolved theme.
- **Public `/shop`:** [`client/src/main.tsx`](../client/src/main.tsx) calls **`syncDocumentThemeFromStorage`** on load and **`installDocumentThemeListeners`** so guest shop tracks the same keys (including system theme changes and cross-tab storage updates).
- **Tailwind `dark:` variants:** [`client/tailwind.config.js`](../client/tailwind.config.js) uses **`darkMode: ["selector", '[data-theme="dark"]']`** so `dark:*` utilities match `data-theme` (not a separate `.dark` class).
- **CSS variables:** App surfaces use **`--app-*`** from [`client/src/index.css`](../client/src/index.css) (`:root` vs `[data-theme="dark"]`). Prefer **`var(--app-*)`** / primitives over hardcoded **`bg-white`** / **`text-zinc-*`** where semantics should follow theme.
- **Storefront tokens:** `[data-storefront="true"]` defines `--sf-*`; **`[data-theme="dark"][data-storefront="true"]`** darkens the guest palette so `/shop` is not light-only when staff theme is dark.

## Typography roles (`ui-type-*`)

- **`ui-type-chrome`** — Very short UI chrome: chips, 1–3 word labels, dense table headers, keypad hints. Uppercase / tight tracking is appropriate.
- **`ui-type-instruction`** / **`ui-type-instruction-muted`** — **Reading copy**: modal/drawer paragraphs, multi-line hints, compliance notes, any full sentence. **Do not** apply uppercase + widest tracking to instructional blocks.
- **`ui-type-title`** — Drawer/modal titles; use **sentence case** for names (e.g. customer names); reserve heavy uppercase for intentional product voice.

**Status tints:** prefer **`ui-caution-text`**, **`ui-info-text`**, **`ui-positive-text`** over one-off `amber-*` / `sky-*` + `dark:` pairs when adding new callouts.

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
