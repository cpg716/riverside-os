# PLAN: Riverside OS v0.2.0 — Polish & Excellence (The Cinematic Shift)

**Status:** **Historical / superseded by v0.3.x operational refinement.** Keep this as design history for the v0.2.0 polish push; current UI rules live in **[`AGENTS.md`](../AGENTS.md)**, **[`docs/CLIENT_UI_CONVENTIONS.md`](./CLIENT_UI_CONVENTIONS.md)**, and **[`docs/ROS_UI_CONSISTENCY_PLAN.md`](./ROS_UI_CONSISTENCY_PLAN.md)**.

Objective: Elevate Riverside OS from a feature-complete "Beta" to a pixel-perfect, production-hardened, premium retail platform. We are transitioning from functional components to a "Cinematic GUI" standard characterized by deep contrast, fluid motion, and brand-first aesthetics.

---

## 1. The GUI Benchmark (The North Stars)

_Goal: Every page must match the visual flair and density of our top-tier modules._

### 1.1 Gold Standard Components
- **Order Pipeline**: `OrdersWorkspace.tsx` (Sidebar-driven navigation, high-density stats strip).
- **Alterations Hub**: `CustomerAlterationsPanel.tsx` (Pro-grade status badges, heavy typography, soft-glow backgrounds).
- **Loyalty Registry**: `LoyaltyWorkspace.tsx` (KPI cards, gradient-bordered panels, interactive Letter Designer).
- **Commission Manager**: `CommissionPayoutsPanel.tsx` (Slide-over audit depth, tabular-num precision).

### 1.2 The "Cinematic" Design Language
- **Emerald Pulse Pattern**: Standardize terminal completion visual (e.g., `bg-emerald-600` + `border-b-8 border-emerald-800`).
- **Typography Invariants**:
  - Chrome/Labels: `font-black uppercase tracking-[0.2em] text-[10px]`
  - Financials/Values: `font-black tabular-nums tracking-tighter`
- **Surface Depth**: Transition legacy flat cards to `rounded-[32px]` glassmorphic containers with `backdrop-blur-md` and semi-transparent backgrounds (`bg-app-surface/60` or `bg-slate-950/80`).
- **Shadow Physics**: Implement multi-layered shadows for primary drawers to give a "floating" sensation over background data.

---

## 2. Priority I: Theme Hardening (Uniformity Debt)

_Goal: Eliminate hardcoded colors to ensure 100% Light/Dark mode perfection._

### 2.1 Color Variable Migration
- **Target**: Replace all instances of hardcoded grayscales (`slate-*`, `zinc-*`, `gray-*`) with semantic CSS tokens from `index.css`.
- **Findings**: Significant debt identified in `Cart.tsx`, `CustomItemPromptModal.tsx`, `NexoCheckoutDrawer.tsx`, and `CommissionManagerWorkspace.tsx`.
- **Action**: Map `slate-500` -> `--app-text-muted`, `bg-zinc-900` -> `--app-surface` (theme aware), etc.

### 2.2 Global Control Uniformity
- **Audit**: Ensure `ui-input`, `ui-btn-primary`, and `ui-btn-secondary` are used exclusively, removing ad-hoc `rounded-lg` or `border-zinc-300` overrides.

---

## 3. Priority II: Visual Debt Remediation (The Audit Manifest)

_Goal: Modernize "Sparse" pages and "Just-a-list" layouts. TOUCH EVERY PAGE._

### 3.1 Audit Manifest (Status & Classification)

| Section | Debt Level | Required Polish Action |
| :--- | :---: | :--- |
| **Alterations Hub** | 1 (Star) | Purge `slate-*` hardcoded colors; Tune slide animations. |
| **Loyalty Registry** | 1 (Star) | Standardize gradient borders; Audit for hardcoded grays. |
| **Commission Payouts** | 1 (Star) | Tabular-num audit; standardizing "Audit Depth" drawers. |
| **Order Workspace** | 2 (Modern) | Add `backdrop-blur` to pipeline sidebar; Shimmer on "Priority" tags. |
| **Inventory Grid** | 1 (Star) | **COMPLETED** — Emerald Pulse patterns; High-density Matrix matrix overhaul. |
| **Customers CRM** | 1 (Star) | **COMPLETED** — Name-dominant high-density list cards; glassmorphic slideouts. |
| **Scheduler** | 1 (Star) | **COMPLETED** — Glassmorphic overhaul; Staff presence "Pulse" dots. |
| **Gift Cards** | 1 (Star) | **COMPLETED** — Card-based high-density overhaul; Cinematic Issuance UI. |
| **Reports Hub** | 1 (Star) | **COMPLETED** — Card-based Metric groups; Tabular-num precision overhaul. |
| **Tasks** | 1 (Star) | **COMPLETED** — Cinematic checklist with "Emerald terminal" completion effects. |
| **POS Checkout** | 1 (Star) | **COMPLETED** — Touch-first h-16 targets; Zero-redundancy financials; Audited Tax Hardening; Deep-link navigation support; Stripe Power branding. |
| **Settings** | 1 (Star) | **COMPLETED** — Convert integration forms to high-fidelity "Productivity Cards." |
| **Morning Compass** | 2 (Modern) | Add "Shadow Force" priority scoring visuals; Pulse on "Due Soon." |
| **Wedding Manager** | 2 (Modern) | Sync JSX buttons with POS emerald/noir brand pattern. |
| **Notifications** | 1 (Star) | **COMPLETED** — Cinematic "Inbox" with glassmorphic message previews. |
| **Operations** | 2 (Modern) | High-level KPI "Glow" effects; Shimmer on active alerts. |
| **QuickBooks (QBO)** | 1 (Star) | **COMPLETED** — Overhaul logs into high-density "Activity Feed" cards. |
| **Bug Reports** | 1 (Star) | **COMPLETED** — Pro-grade triage cards with glassmorphic screenshot overlays. |
| **Data Fidelity** | 1 (Star) | **COMPLETED** — "Maximum Sync" 2018+ historical parity; Calculated Lifetime Sales via aggregation; UI "Away Mode" polling (3-fail auto-halt). |

---

## 4. Priority III: Fluidity & Cinematic Performance

_Goal: Interaction speed that matches visual quality._

### 4.1 Frame-Perfect Transitions
- **Action**: Standardize `workspace-snap` animation (14px translate-x + 0.32s curve) for all tab/page switches.
- **Slide-overs**: Animate audit drawers based on entry-point (Right-to-Left slide-in).

### 4.2 Skeleton Parity
- **Action**: Every benchmark page must have a pixel-matched Skeleton state. Eliminate "Flicker to Content."

### 4.3 Input Persistence
- **Action**: Finalize `useFormDraft` to prevent data loss in high-stakes POS and Wedding workflows.

---

## 5. Global Invariants (Touch Every Page)

_Goal: Uniform cinematic markers across the entire application._

### 5.1 Completion Protocol (Success Protocol)
- **Pattern**: Every "Success" event (Save, Sync, Issue, Complete) must use the **Emerald Terminal Completion**:
  - `bg-emerald-600` + `border-b-8 border-emerald-800`
  - Subtle `shimmer` or `animate-pulse` on final element.

### 5.2 The "Gray Purge"
- **Mandate**: No hardcoded Tailwind grays (`slate`, `zinc`, `neutral`). 
- **Variable Alignment**: Map legacy classes to `--app-text-muted`, `--app-surface`, and `--app-border`.

### 5.3 Touch Ergonomics & POS Surface
- **Hardware Optimization**: Interfaces must be optimized for **24" Touch PCs** (Desktop POS) and **11" iPad Pros** (Mobile POS).
- **Target Size Invariant**: All primary action buttons and hit targets must maintain a minimum `48x48px` physical size, regardless of visual border size.
- **Scroll Physics**: Standardize `touch-pan-y` and momentum scrolling across all high-density lists.
- **No-Stick States**: Ensure `:hover` states do not "stick" on touch-only devices by using `hover:hover:bg-...` or theme-aware active states.
- **Hardware Pulse**: Native hardware status (Printers, Scanners) must be visible in the POS chrome with "Live" color states (Emerald = Connected, Rose = Offline).

---

## 6. Execution Roadmap

1. **Sprint 1 (Hardening)**: **COMPLETED** — Global "Gray Purge" sweep + Skeleton parity + Finalizing `useFormDraft`.
2. **Sprint 2 (Modernization)**: **COMPLETED** — Overhaul Sparse components (Scheduler, Gift Cards, Reports, QBO, Bug Reports) to card-based grids.
3. **Sprint 3 (The Overhaul)**: **COMPLETED** — Modernized Inventory and Customer lists with high-density card patterns.
4. **Sprint 4 (Cinematic Flair)**: **ACTIVE** — Implementation of pulse/glow effects and glassmorphic drawer depth app-wide.
5. **Sprint 5 (QA Gate)**: Pixel-perfect verification across Light/Dark modes + Keyboard-Only parity check.
