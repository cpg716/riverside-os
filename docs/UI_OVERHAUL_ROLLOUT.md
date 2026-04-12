# UI Overhaul Rollout Plan (Safety-First)

Overview
- The UI overhaul is introduced behind a feature flag: UI_OVERHAUL_ENABLED.
- The baseline UI remains the default state (flag off).
- Rollout is staged: staging QA, canary, production behind a controlled toggle.

Goals
- Minimize risk to users while validating the new UI path.
- Provide quick rollback if issues surface.
- Track changes audibly with small, reviewable PRs and tests.

Rollout Stages
- Stage 0: Flag off (default). Full stability of the existing UI.
- Stage 1: Flag on in staging. Smoke test core flows (login, dashboard, POS). Ensure no API breaks.
- Stage 2: Canary (a subset) with flag on. Monitor frontend metrics and error rates.
- Stage 3: Production with gated rollout. Monitor, and revert if QA flags indicate issues.

What to validate at each stage
- Build health: npm run lint, npm run build (0 errors).
- Visual parity checks: ensure no accidental regressions in critical layouts when switching states.
- Functionality checks: login, dashboard rendering, POS flows, customer/workspace navigation.
- Performance: load times, render times; ensure the placeholder path does not introduce regressions.

Roll-back mechanism
- If any issue is detected, switch UI_OVERHAUL_ENABLED to false and revert to the stable UI path.
- Document the incident and fix in a PR with a trimmed scope, ensuring CI remains green.

Governance
- Each stage should be documented in PRs with a short, testable scope.
- Tests (unit/integration) should be added for core gating paths where feasible.
- CI gates must require lint/build success before merging.

This document is designed to accompany the ongoing work on feat/ui-overhaul and its sub-branches.

## Step 3: Quick QA Checklist (manual)
- Set VITE_UI_OVERHAUL_ENABLED=true in your environment for the staging server.
- Load the app and verify the placeholder UI renders (look for the header "New UI Overhaul — Placeholder").
- Verify the skeleton cards render (three cards) and the small QA note badge is present.
- Confirm that the baseline UI is still visible when the flag is off (toggle flag off and reload).
- Record any visual diffs and report back with screenshots or notes in the PR.

## Step 4: Stepwise automation plan (future)
- Add a small unit test to cover gating paths (flag on renders placeholder, flag off renders old UI).
- Add an integration test to verify the flag toggle path across environments.
- Extend the placeholder gradually into a proper skeleton/UI components behind the flag.
