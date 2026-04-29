# Codex Commit and Pull Request Guidance — Riverside OS

Use this when asking Codex to prepare commits or PR text.

```text
Commit guidance:
- Do not commit unless explicitly asked.
- Before committing, review git status and git diff.
- Stage only intended files.
- Use a clear conventional-style message:
  - fix: for bug fixes
  - feat: for new functionality
  - refactor: for internal restructuring without behavior change
  - docs: for documentation-only changes
  - test: for test-only changes
  - chore: for maintenance/config/build changes
- Keep the subject under 72 characters.
- Use a short body only when it explains why the change was needed.
- Never use vague messages like “update files” or “fix stuff.”
- Do not include unrelated changes.

Pull request guidance:
- Do not open or prepare a PR unless explicitly asked.
- PR summaries must include:
  1. What changed
  2. Why it changed
  3. Validation performed
  4. Risks or follow-up items
- Keep PR descriptions factual and concise.
- Mention affected areas/files when helpful.
- Do not claim tests passed unless they were actually run.
- If validation was skipped or failed, state that clearly.
- When UI changed, mention UX clarity, layout/viewport behavior, and duplicate-navigation/leftover-UI checks when performed.

Required PR format:

Summary:
- ...

Changed areas:
- ...

Validation:
- ...

Risks / follow-up:
- ...
```
