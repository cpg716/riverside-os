# CI/CD and Code Hygiene Standards (ROS)

This document outlines the architectural and linting standards required to maintain the **Zero-Error CI/CD Baseline** for Riverside OS. Adherence to these rules is mandatory for all PRs to ensure the automated pipeline remains green and the application remains performant.

## The Zero-Error Baseline

The goal of the CI repository is to maintain **0 ESLint errors** and **0 architectural regression warnings**. Warnings are treated as failures and must be resolved before merging.

| Check | Tool | Command |
|-------|------|---------|
| Client Lint | ESLint | `npm run lint` (in `client/`) |
| Client Build | Vite | `npm run build` (in `client/`) |
| Server Lint | Clippy | `cargo clippy --workspace --all-targets -- -D warnings` |
| Server Format | rustfmt | `cargo fmt --all --check` |


## Generated help artifacts

The client build regenerates the Help manifest and server help-corpus files. CI now verifies those generated files are current before client lint/typecheck:

- `client/src/lib/help/help-manifest.generated.ts`
- `server/src/logic/help_corpus_manuals.generated.rs`

When a workflow change or component/manual update affects Help generation, run:

```bash
npm run generate:help
```

before lint/build so local validation matches GitHub Actions.

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

### Dependabot queue controls

Dependabot version updates are intentionally bounded so a monthly dependency refresh cannot consume the GitHub-hosted runner pool:

- Each configured ecosystem/directory may keep at most **two** version-update PRs open.
- Routine minor/patch updates are grouped into one PR, major updates into a second PR, and security updates into a separate security group.
- The ten package locations run monthly at staggered hourly times from **02:00 through 11:00 America/New_York** instead of starting together.
- Dependabot PRs that change only `package.json`, `package-lock.json`, or `npm-shrinkwrap.json` inside an isolated companion app skip the full Riverside server/client Playwright matrix. The required Client Lint check instead runs `npm ci` and that companion's build (or JavaScript syntax check for bridge services).
- Human PRs, `main` pushes, release commits, and any change outside those isolated dependency manifests always run the full Lint and blocking Playwright suites.

The isolated companion paths are:

- `counterpoint-bridge/`
- `deployment/counterpoint-bridge-gui/`
- `deployment/manager-app/`
- `deployment/server-manager-app/`
- `ros-dev/`
- `tools/counterpoint-bridge/`

Do not add a new Dependabot package location without giving it a staggered time, a bounded PR limit, and appropriate CI scope classification.

### Pruning Failed Runs
```bash
# Bulk delete all failed runs for the current repository
gh run list --status failure --limit 100 --json databaseId --jq '.[].databaseId' | xargs -I {} gh run delete {}
```

## Server-Side Hygiene (Rust)

1. **Toolchain Pinning:** The project is strictly pinned to **Rust 1.91**. Ensure your `rust-toolchain.toml` includes both `clippy` and `rustfmt`.
2. **Clippy Compliance:** Code must pass `cargo clippy --workspace --all-targets -- -D warnings` without warnings.
3. **Deterministic Formatting:** Always run `cargo fmt --all` before committing (`cargo fmt --all --check` is run in CI).
4. **Decimal for Currency:** Never use `f32`/`f64` for money. Use `rust_decimal::Decimal`.
5. **Sequential Integration Testing:** Server integration tests share database tables. Running tests in parallel causes deadlocks or constraint violations. Always run tests sequentially via `cargo test --workspace -- --test-threads=1`. Ensure the local DB is up and the `DATABASE_URL` is configured (loaded from `server/.env`).

## Validation Workflow

Before pushing any major refactor, executors should run the following locally:

1. `cd client && npm run lint`
2. `cargo clippy --workspace --all-targets -- -D warnings`
3. `cargo fmt --all --check`
4. `cargo test --workspace -- --test-threads=1`
5. `cd client && npm run build` (to catch type errors in production builds)

**Last reviewed:** 2026-07-11
