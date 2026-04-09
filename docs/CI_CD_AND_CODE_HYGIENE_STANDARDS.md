# CI/CD and Code Hygiene Standards (ROS)

This document outlines the architectural and linting standards required to maintain the **Zero-Error CI/CD Baseline** for Riverside OS. Adherence to these rules is mandatory for all PRs to ensure the automated pipeline remains green and the application remains performant.

## The Zero-Error Baseline

The goal of the CI repository is to maintain **0 ESLint errors** and **0 architectural regression warnings**. Warnings are treated as failures and must be resolved before merging.

| Check | Tool | Command |
|-------|------|---------|
| Client Lint | ESLint | `npm run lint` (in `client/`) |
| Client Build | Vite | `npm run build` (in `client/`) |
| Server Lint | Clippy | `cargo clippy --all-targets -- -D warnings` |
| Server Format | rustfmt | `cargo fmt --check` |

## React Hook Stability (`exhaustive-deps`)

To prevent infinite re-rendering loops and stale closures, all hooks must strictly adhere to the `react-hooks/exhaustive-deps` rule.

### 1. Stabilization with `useCallback`
All asynchronous data-fetching functions or event handlers defined within a component that are consumed by `useEffect` MUST be wrapped in `useCallback`.

```tsx
// ✅ Correct: load is stabilized
const load = useCallback(async () => {
  const res = await fetch(`${baseUrl}/api/data`, { headers: apiAuth() });
  // ...
}, [apiAuth]);

useEffect(() => {
  void load();
}, [load]); // load is a safe dependency
```

### 2. Dependency Pruning
Exclude static constants and module-level variables from dependency arrays. Including them triggers unnecessary linting warnings and mental overhead.

```tsx
// ✅ Correct: baseUrl is static, exclude it
const baseUrl = import.meta.env.VITE_API_BASE;

useEffect(() => {
  fetch(`${baseUrl}/api/...`);
}, [apiAuth]); // Do not include baseUrl
```

## Fast Refresh and Logic Separation

To ensure reliable Hot Module Replacement (HMR) and follow the "Thin Component" architectural principle, non-component code should be moved to dedicated logic files.

### 1. The `.ts` Logic Pattern
If a file exports a React component, it should **not** export helpers, interfaces, or classes that are consumed by other files. Move these to a sibling logic file (e.g., `ComponentLogic.ts`).

- **UI File (`MyComponent.tsx`):** Exports the default component only.
- **Logic File (`MyComponentLogic.ts`):** Exports interfaces, schemas, transformation functions, and pure logic.

### 2. Context Providers
Context files are a common source of Fast Refresh warnings. To achieve zero-warning status, splitting providers from their context/hooks is required.

- **Provider File (`MyContext.tsx`):** Exports the Provider component only.
- **Logic File (`MyContextLogic.ts`):** Exports the Context object, types, and the custom `useContext` hook.

**Example `App.tsx` consumption:**
```tsx
import { MyProvider } from "./context/MyContext";
import { useMyHook } from "./context/MyContextLogic";
```

## GitHub Actions Run Management

To maintain a clean workflow history, developers and agents are encouraged to use the **GitHub CLI (`gh`)** to prune failed or redundant runs.

### Pruning Failed Runs
```bash
# Bulk delete all failed runs for the current repository
gh run list --status failure --limit 100 --json databaseId --jq '.[].databaseId' | xargs -I {} gh run delete {}
```

## Server-Side Hygiene (Rust)

1. **Toolchain Pinning:** The project is strictly pinned to **Rust 1.88**. Ensure your `rust-toolchain.toml` includes both `clippy` and `rustfmt`.
2. **Clippy Compliance:** Code must pass `cargo clippy -- -D warnings` without warnings.
3. **Deterministic Formatting:** Always run `cargo fmt` before committing (`cargo fmt --check` is run in CI).
4. **Decimal for Currency:** Never use `f32`/`f64` for money. Use `rust_decimal::Decimal`.

## Validation Workflow

Before pushing any major refactor, executors should run the following locally:

1. `cd client && npm run lint`
2. `cd server && cargo clippy -- -D warnings && cargo fmt --check`
3. `cd client/src-tauri && cargo clippy -- -D warnings && cargo fmt --check`
4. `cd client && npm run build` (to catch type errors in production builds)

**Last reviewed:** 2026-04-09
