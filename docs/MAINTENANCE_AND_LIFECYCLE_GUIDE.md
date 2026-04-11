# Maintenance and Lifecycle Guide — Riverside OS

This guide outlines the strategy for keeping Riverside OS (ROS) modern, secure, and compatible with 3rd-party integrations over many years.

## 1. The "No-Rot" Philosophy
ROS is designed to avoid the "legacy trap" where old code becomes too dangerous to touch. We achieve this through:
- **Aggressive Dependency Patching**: Weekly automated updates for all libraries.
- **Integration Heartbeats**: Continuous monitoring of 3rd-party API health.
- **Scheduled Infrastructure Upgrades**: Periodic movement to newer long-term support (LTS) versions of core engines (Postgres, Rust, Node).

## 2. Automated Maintenance Systems

### A. Dependabot (Package Level)
Dependabot is configured in `.github/dependabot.yml`. It performs:
- **NPM Updates**: Weekly checks for `client/` and `counterpoint-bridge/`.
- **Cargo Updates**: Weekly checks for `server/`.
- **Security Alerts**: Immediate PR generation for CVEs in the dependency tree.

### B. Maintenance Engine (Logic Level)
The Maintenance Engine (`server/src/logic/maintenance.rs`) is a background worker that runs daily at **03:00 AM local time**. Its roles include:
- **API Version Audits**: Checking if our current target versions for Stripe, Shippo, and Podium are approaching their sunset dates.
- **Database Hygiene**: Running `VACUUM ANALYZE` and checking migration integrity.
- **Sanity Checks**: Verifying that core integrations (like Meilisearch) are reachable and healthy.

## 3. How to Add a New Lifecycle Check

When adding a new 3rd-party API or a major piece of open-source software, you **must** register it in the maintenance engine:

1.  Open `server/src/logic/maintenance.rs`.
2.  Create a new private async function for the check.
3.  Add a `WARN` or `ERROR` log if the software or API version is more than **12 months old**.

Example Stub:
```rust
async fn check_shippo_api_version(db: &PgPool) -> Result<(), anyhow::Error> {
    const SHIPPO_VERSION_DATE: &str = "2024-02-15"; // Our current target
    // Logic to compare current date vs. version policy
    Ok(())
}
```

## 4. Manual Audit Lifecycle

While the engine is automated, the following manual reviews are recommended every **6 months**:

| Component | Audit Task |
|-----------|------------|
| **Rust Toolchain** | Update `rust-toolchain.toml` to the latest stable release. |
| **Tauri Shell** | Check for major Tauri 2.x -> 3.x migration paths. |
| **React/Vite** | Review major version changes in `client/package.json`. |
| **PostgreSQL** | Check for newer Docker image versions (e.g., PG 16 -> 17). |

## 5. Reporting
Maintenance failures and integration warnings are logged to `tracing`. Critical failures are also recorded in `integration_alert_state` (migration 61), which triggers notifications for Staff with `admin` roles in the **Morning Digest**.
