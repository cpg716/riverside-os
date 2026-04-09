# ROS UI consistency — Cursor plan stub

**Canonical document:** [`docs/ROS_UI_CONSISTENCY_PLAN.md`](../../docs/ROS_UI_CONSISTENCY_PLAN.md)

**Status:** Phases **1–5** complete (2026-04-08). Guest public **`/shop`** typography/theme pass remains **deferred** per that doc.

**Phase 5 highlights (implementation):**

- Client production build + Playwright `client/e2e/` with API + Vite; visual baseline PNGs under `client/e2e/visual-baselines.spec.ts-snapshots/`.
- [`client/src/components/layout/RegisterSessionBootstrap.tsx`](../../client/src/components/layout/RegisterSessionBootstrap.tsx): `applyShellForLoggedInRole` only when open register **`session_id`** changes.

Do not duplicate long checklists here—edit the Markdown doc above for future work or regressions.
