# Riverside OS Codex Prompt Templates

```text
Work in /Users/cpg/riverside-os on the current branch.

Do NOT create a new branch.
Do NOT switch branches.
Do NOT broaden scope.

MODE: IMPLEMENT

This is a narrow <AREA> implementation pass.
Do not audit broadly unless the listed files prove the issue cannot be fixed safely.

Current state:
- describe what has already been done
- describe what is known to be working
- describe the remaining confusion / gap / risk
- include any critical constraints (e.g., deployment model, POS vs Back Office separation)

Goal:
State clearly what you want to achieve in ONE sentence.

Focus areas:
- list exact surfaces to inspect
- UI, API, docs, runtime, etc.
- keep this tight and relevant

Read FIRST:
- list specific files/folders
- list related docs
- list tests/specs

Task:
1. Inspect only the listed files and direct dependencies needed to make the fix safely
2. Identify real issues (not theoretical)
3. Classify issues:
   - correctness/runtime risk
   - UX/flow confusion
   - missing docs/tests
4. Answer key questions relevant to this pass
5. Propose the smallest correct fix
6. Apply changes ONLY if:
   - clear
   - safe
   - scoped
7. Update docs/help ONLY if behavior changes
8. Keep scope tight
9. Do NOT commit

Rules:
- do not refactor broadly
- do not redesign entire systems
- do not weaken tests
- do not add arbitrary waits
- do not fix unrelated issues
- prefer operator clarity over internal correctness
- respect existing system contracts

Validation:
- cargo fmt --check --manifest-path client/src-tauri/Cargo.toml
- mkdir -p client/test-results && npm run lint
- npm --prefix client run build
- npm run pack
- run targeted tests if relevant

Output:
- exact gap found
- exact files changed
- exact fix made
- exact tests added/updated
- exact docs/manual/help updated
- validation results
- final git diff summary
```

## Audit Prompt (Explicit AUDIT Requests Only)

```text
Work in /Users/cpg/riverside-os on the current branch.

Do NOT create a new branch.
Do NOT switch branches.
Do NOT broaden scope.

MODE: AUDIT

This is a narrow <AREA> audit and hardening pass.

Current state:
- describe what has already been done
- describe what is known to be working
- describe the remaining confusion / gap / risk
- include any critical constraints (e.g., deployment model, POS vs Back Office separation)

Goal:
State clearly what you want to achieve in ONE sentence.

Focus areas:
- list exact surfaces to inspect
- UI, API, docs, runtime, etc.
- keep this tight and relevant

Read FIRST:
- list specific files/folders
- list related docs
- list tests/specs

Task:
1. Trace current behavior end to end
2. Identify real issues (not theoretical)
3. Classify issues:
   - correctness/runtime risk
   - UX/flow confusion
   - missing docs/tests
4. Answer key questions relevant to this pass
5. Propose the smallest correct fix
6. Apply changes ONLY if:
   - clear
   - safe
   - scoped
7. Update docs/help ONLY if behavior changes
8. Keep scope tight
9. Do NOT commit

Rules:
- do not refactor broadly
- do not redesign entire systems
- do not weaken tests
- do not add arbitrary waits
- do not fix unrelated issues
- prefer operator clarity over internal correctness
- respect existing system contracts

Validation:
- cargo fmt --check --manifest-path client/src-tauri/Cargo.toml
- mkdir -p client/test-results && npm run lint
- npm --prefix client run build
- npm run pack
- run targeted tests if relevant

Output:
- exact gap found
- exact files changed
- exact fix made
- exact tests added/updated
- exact docs/manual/help updated
- validation results
- final git diff summary
```

ROSIE Rules (only apply when touching ROSIE or AI features)

- do not introduce raw SQL or direct DB access from model paths
- do not bypass RBAC or route-level auth
- model must not invent data not returned by tools
- all tool execution must be server-validated
- no autonomous mutations; require user confirmation and audit
- preserve supplier/vendor and supplier_code in catalog logic
- no uncontrolled memory or learning paths
- respect docs/ROSIE_OPERATING_CONTRACT.md
- stack/runtime assumptions must match docs/ROSIE_HOST_STACK.md
- stack/runtime assumptions must match docs/ROSIE_HOST_STACK.md

ROSIE Pre-Flight Checklist (apply when touching ROSIE or AI features)

Before making changes, verify:
- This change respects docs/ROSIE_OPERATING_CONTRACT.md
- No raw SQL or direct DB access is introduced
- All data access goes through approved APIs/tools
- RBAC behavior matches the underlying routes exactly
- No new mutation path exists without explicit confirmation and audit
- Supplier/vendor and supplier_code are preserved in catalog logic
- No uncontrolled memory or learning path is introduced

ROSIE Rules (only apply when touching ROSIE or AI features)

- do not introduce raw SQL or direct DB access from model paths
- do not bypass RBAC or route-level auth
- model must not invent data not returned by tools
- all tool execution must be server-validated
- no autonomous mutations; require user confirmation and audit
- preserve supplier/vendor and supplier_code in catalog logic
- no uncontrolled memory or learning paths
- respect docs/ROSIE_OPERATING_CONTRACT.md
