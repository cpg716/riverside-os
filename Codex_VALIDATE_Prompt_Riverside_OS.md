# Codex VALIDATE Prompt — Riverside OS

Use this when you only want Codex to check existing changes.

```text
MODE: VALIDATE

Work in /Users/cpg/riverside-os on the current branch.

Do NOT create or switch branches.
Do NOT modify files unless explicitly asked.
Do NOT analyze architecture.
Do NOT propose redesigns.

Scope:
<What changed or what should be checked>

Validation requested:
- <targeted test command or check>
- <lint/typecheck/build only if needed>

Task:
1. Inspect git status and relevant diff only.
2. Run the requested validation.
3. If validation fails, identify the smallest likely cause.
4. Do NOT fix unless explicitly requested.

UX clarity check:
- confirm wording is clear and non-technical
- confirm the next action is obvious
- confirm the workflow is understandable without training

Layout check:
- test at top and bottom scroll positions
- confirm overlays are visible
- confirm width usage is appropriate
- confirm there is no unnecessary vertical stacking

Output:
- git status summary
- validation commands run
- pass/fail results
- errors found, if any
- smallest recommended next step
```
