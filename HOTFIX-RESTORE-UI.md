Hotfix: Restore Frontend Baseline (UI overhaul rollback)

- Goal: Return client/ frontend to the known-good baseline from origin/main and establish a safe path for future visual overhaul.
- Branch: fix/restore-ui, created from origin/main.
- What we did:
  - Created hotfix branch from origin/main to isolate the rollback work.
  - Restored the frontend (client/) to the origin/main baseline so all visuals, components, and UI wiring align with the previous stable state.
- What remains / next steps:
  - Validate the restore locally (lint, type checks, build, smoke tests).
  - Open a PR that documents the rollback rationale and a plan for safer incremental overhaul (feature-flagged, review gates).
  - Implement a feature-flag approach or a dedicated feature branch for any future visual changes, with gradual merges.
- Rollback plan for future PRs:
  - Work behind a feature flag to enable the new visuals in a controlled path.
  - Use a guardrail (CI gate + manual QA) before merging frontend changes into main.
  - Maintain a clear revert path by keeping changes on a separate branch until approved.

Rationale: A visible overhaul introduced significant breakages. Restoring the baseline ensures stability for users and provides a scaffold for a safer, incremental UI refresh.
 
