Title: feat(ui-overhaul): add feature-flag scaffolding for incremental UI overhaul

Body:
- Introduces a minimal feature-flag scaffold to gate the UI overhaul: UI_OVERHAUL_ENABLED (defaults to false).
- The flag is read from VITE_UI_OVERHAUL_ENABLED and can be toggled via environment during deployment.
- This initial patch does not modify the existing UI rendering paths; it provides the building block for a safe, incremental rollout.
- Plan for next steps:
  1. Wire the flag into App.tsx (or the central rendering path) to toggle between old UI and new UI skeleton.
  2. Create a small, isolated New UI skeleton that can be progressively fleshed out while the old UI remains active.
  3. Add minimal tests for the gating path (flag off renders old UI; flag on renders the skeleton).
  4. Gate the rollout with staged environment flags (staging → canaries → prod).

Rationale: A controlled, flag-based rollout minimizes risk, reduces blast radius, and enables rapid rollback if issues arise.
