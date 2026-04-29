# Codex AUDIT Prompt — Riverside OS

Use this only when you explicitly want deeper tracing before implementation.

```text
MODE: AUDIT

Work in /Users/cpg/riverside-os on the current branch.

Do NOT create or switch branches.
Do NOT implement changes unless explicitly requested.
Do NOT broaden beyond the listed area.

Area:
<Exact system, module, workflow, or feature>

Concern:
<What you are worried about or trying to verify>

Read ONLY:
- <file 1>
- <file 2>
- <relevant doc/test if needed>

Task:
1. Trace current behavior end-to-end only within the listed area.
2. Identify real issues, not theoretical ones.
3. Classify each issue:
   - correctness/runtime risk
   - UX/flow confusion
   - missing docs/tests
   - business/financial/auth/reporting risk
4. Propose the smallest safe fix for each confirmed issue.
5. Do NOT edit code.

Surface alignment check:
- identify duplicate navigation, including sidebar vs inline vs contextual entry points
- identify competing entry points for the same staff job
- identify leftover UI from previous structures
- identify what should be removed or hidden from the primary path

UI clarity check:
- identify technical or internal terms that should be removed from staff-facing UI
- identify over-explained or verbose copy
- identify unclear wording
- identify where users must understand system concepts to proceed

Layout resilience check:
- identify UI that is too tall instead of using available width
- identify overlays, drawers, menus, or popovers that can appear off-screen
- identify scroll-position issues
- identify non-responsive layouts

If additional files are required:
- STOP
- list the exact files needed
- do NOT continue scanning

Output:
- confirmed current behavior
- issues found
- duplication issues
- unclear UI wording
- layout problems
- risk level for each issue
- recommended smallest fixes
- recommended removals
- files likely needing changes
- validation that would be required
```
