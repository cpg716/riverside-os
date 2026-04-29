# Codex IMPLEMENT Prompt — Riverside OS

Use this for normal coding work: specific bugs, UI fixes, failing tests, small feature adjustments, or targeted hardening.

```text
MODE: IMPLEMENT

Work in /Users/cpg/riverside-os on the current branch.

Do NOT create or switch branches.
Do NOT broaden scope.
Do NOT perform a full audit.

Goal:
<ONE clear sentence describing the outcome>

Known issue:
<Exact bug / gap / behavior mismatch>

Expected behavior:
<What should happen instead>

Modify ONLY these files:
- <file 1>
- <file 2>

If additional files are required:
- STOP
- list the exact files needed
- do NOT continue

Constraints:
- smallest safe fix only
- no refactors
- no redesigns
- no unrelated changes
- preserve all existing invariants: money, tax, auth, fulfillment, reporting, auditability

Execution rules:
- inspect only listed files
- follow at most 1 level of direct dependencies
- do not recursively explore dependency chains
- do not explore alternative approaches unless required
- choose the safest, simplest correct solution
- do not restate unchanged code
- return minimal diff

Clarity rules:
- remove technical or internal wording from staff-facing surfaces
- prefer simple staff-facing language
- reduce text; do not expand it unless required for correctness
- make actions obvious without explanation
- avoid exposing system concepts users should not need to understand

Layout rules:
- avoid overly tall single-column layouts
- use horizontal space effectively
- ensure overlays and drawers appear in the viewport
- prevent scroll-to-see UI problems
- use collision or flip logic for dropdowns in scroll containers

If unclear within 2–3 files:
- STOP and ask for clarification

Validation:
Run only relevant checks:
- lint if frontend changed
- cargo fmt if Rust changed
- targeted tests only

Do NOT run full build or pack unless required.

Output:
- files changed
- exact fix made
- validation performed
- remaining risk, if any
- git diff summary
```
