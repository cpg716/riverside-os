# Help Center Automation

## Purpose

Riverside now has a repo-owned Help Center refresh path that combines:

- checked-in **AIDocs** configuration for guided/manual authoring
- deterministic **Playwright** screenshot capture for shipped Help assets
- bundled Help manifest regeneration
- optional Help search reindex through the existing admin API

This exists so the in-app Help Center can be refreshed without depending on a
single developer remembering the steps.

## What AIDocs handles

`docs/aidocs-config.yml` enables:

- `aidocs check` environment validation
- repo-local `/docs:*` command discovery for Claude/Cursor style workflows
- governed manual authoring outside the runtime app

Current install sources:

- `brew install binarcode/aidocs/aidocs`
- `uv tool install aidocs`
- `uv tool install aidocs --from git+https://github.com/binarcode/aidocs-cli.git`

## What the repo scripts handle

The shipped Help Center still uses:

- markdown manuals in `client/src/assets/docs/*-manual.md`
- screenshots in `client/src/assets/images/help/**`
- generated manifests:
  - `client/src/lib/help/help-manifest.generated.ts`
  - `server/src/logic/help_corpus_manuals.generated.rs`

Deterministic screenshot capture is handled by:

- `client/scripts/help-screenshot-specs.mjs`
- `client/scripts/capture-help-screenshots.mjs`

The top-level refresh entrypoint is:

```bash
npm run generate:help:refresh
```

By default it will:

1. run `aidocs check` if `uv` is available
2. auto-boot the local E2E stack when the app is not already running
3. capture configured Help screenshots with Playwright
4. run `npm run generate:help`

Optional reindex:

```bash
npm run generate:help:refresh -- --reindex-search
```

Useful flags:

```bash
npm run generate:help:refresh -- --no-auto-boot
npm run generate:help:refresh -- --skip-screenshots
npm run generate:help:refresh -- --skip-generate-help
npm run generate:help:screenshots -- --list
npm run generate:help:screenshots -- --target settings-help-center-library
```

## Current deterministic screenshot set

The checked-in capture script currently refreshes these shipped Help assets:

- `client/src/assets/images/help/help-center-drawer/example.png`
- `client/src/assets/images/help/settings-help-center-settings-panel/example.png`
- `client/src/assets/images/help/settings-rosie-settings-panel/example.png`
- `client/src/assets/images/help/remote-access/panel-main.png`
- `client/src/assets/images/help/pos/register-dashboard.png`
- `client/src/assets/images/help/pos/cart-empty.png`
- `client/src/assets/images/help/pos/cart-with-lines.png`
- `client/src/assets/images/help/pos/nexo-checkout-drawer.png`
- `client/src/assets/images/help/pos/receipt-summary.png`
- `client/src/assets/images/help/pos/receipt-preview.png`
- `client/src/assets/images/help/pos/exchange-return-wizard.png`
- `client/src/assets/images/help/pos/wedding-lookup-drawer.png`
- `client/src/assets/images/help/reports/catalog.png`
- `client/src/assets/images/help/reports/sales-by-day-loaded.png`
- `client/src/assets/images/help/insights/metabase-main.png`
- `client/src/assets/images/help/inventory-control-board/main.png`
- `client/src/assets/images/help/inventory-receiving-bay/main.png`
- `client/src/assets/images/help/inventory-purchase-order-panel/main.png`
- `client/src/assets/images/help/customers-workspace/main.png`
- `client/src/assets/images/help/customers-workspace/add-customer.png`
- `client/src/assets/images/help/customers-workspace/duplicate-review.png`
- `client/src/assets/images/help/orders-workspace/main.png`
- `client/src/assets/images/help/alterations-workspace/main.png`
- `client/src/assets/images/help/scheduler-workspace/main.png`
- `client/src/assets/images/help/operations-operational-home/main.png`
- `client/src/assets/images/help/operations-operational-home/timeline.png`
- `client/src/assets/images/help/operations-operational-home/customer-notifications.png`
- `client/src/assets/images/help/staff-schedule-panel/main.png`
- `client/src/assets/images/help/settings-printers-and-scanners-panel/main.png`
- `client/src/assets/images/help/settings-printers-and-scanners-panel/tag-designer.png`
- `client/src/assets/images/help/settings-counterpoint-sync-settings-panel/main.png`
- `client/src/assets/images/help/settings-ros-dev-center-panel/main.png`
- `client/src/assets/images/help/bug-report-flow/help-drawer.png`
- `client/src/assets/images/help/bug-report-flow/help-settings.png`
- `client/src/assets/images/help/bug-report-flow/rosie-settings.png`
- `client/src/assets/images/help/layout-backoffice-sign-in-gate/main.png`
- `client/src/assets/images/help/notifications-notification-center-drawer/main.png`
- `client/src/assets/images/help/qbo-workspace/connection.png`
- `client/src/assets/images/help/qbo-workspace/mappings.png`
- `client/src/assets/images/help/qbo-workspace/staging.png`
- `client/src/assets/images/help/loyalty-workspace/eligible.png`
- `client/src/assets/images/help/loyalty-workspace/adjust-points.png`
- `client/src/assets/images/help/staff-workspace/team.png`
- `client/src/assets/images/help/staff-workspace/commissions.png`
- `client/src/assets/images/help/settings-backups/main.png`
- `client/src/assets/images/help/settings-helcim-settings-panel/main.png`
- `client/src/assets/images/help/settings-meilisearch-settings-panel/main.png`
- `client/src/assets/images/help/settings-receipt-builder-panel/main.png`
- `client/src/assets/images/help/settings-bug-reports-settings-panel/main.png`
- `client/src/assets/images/help/customers-customer-relationship-hub-drawer/customers-workspace.png`
- `client/src/assets/images/help/customers-customer-relationship-hub-drawer/orders-workspace.png`
- `client/src/assets/images/help/customers-customer-relationship-hub-drawer/wedding-lookup.png`
- `client/src/assets/images/help/customers-podium-messaging-inbox-section/customers-workspace.png`
- `client/src/assets/images/help/customers-podium-messaging-inbox-section/podium-settings.png`
- `client/src/assets/images/help/customers-podium-messaging-inbox-section/operations-inbox-context.png`
- `client/src/assets/images/help/customers-rms-charge-admin-section/customers-workspace.png`
- `client/src/assets/images/help/customers-rms-charge-admin-section/orders-workspace.png`
- `client/src/assets/images/help/customers-rms-charge-admin-section/checkout-context.png`
- `client/src/assets/images/help/customers-shipments-hub-section/customers-workspace.png`
- `client/src/assets/images/help/customers-shipments-hub-section/orders-workspace.png`
- `client/src/assets/images/help/customers-shipments-hub-section/remote-access-context.png`
- `client/src/assets/images/help/gift-cards-workspace/register-dashboard.png`
- `client/src/assets/images/help/gift-cards-workspace/cart-with-gift-card.png`
- `client/src/assets/images/help/gift-cards-workspace/checkout-drawer.png`
- `client/src/assets/images/help/inventory-bulk-bar/inventory-list.png`
- `client/src/assets/images/help/inventory-bulk-bar/receiving.png`
- `client/src/assets/images/help/inventory-bulk-bar/purchase-orders.png`
- `client/src/assets/images/help/inventory-physical-inventory-workspace/inventory-list.png`
- `client/src/assets/images/help/inventory-physical-inventory-workspace/physical-inventory.png`
- `client/src/assets/images/help/inventory-physical-inventory-workspace/receiving-context.png`
- `client/src/assets/images/help/inventory-product-hub-drawer/inventory-list.png`
- `client/src/assets/images/help/inventory-product-hub-drawer/receiving-context.png`
- `client/src/assets/images/help/inventory-product-hub-drawer/purchase-orders-context.png`
- `client/src/assets/images/help/inventory-product-master-form/inventory-list.png`
- `client/src/assets/images/help/inventory-product-master-form/receiving-context.png`
- `client/src/assets/images/help/inventory-product-master-form/purchase-orders-context.png`

More flows can be added safely by extending
`client/scripts/help-screenshot-specs.mjs`.

## CI automation

The scheduled/manual workflow is:

- `.github/workflows/help-center-automation.yml`

It:

1. boots a deterministic database + API
2. installs Node, Rust, uv, and AIDocs
3. runs the refresh command without local auto-boot
4. uploads screenshots and generated Help artifacts
5. optionally opens a PR when Help assets changed

## Extending the pipeline

To add a new Help screenshot:

1. add a target in `client/scripts/help-screenshot-specs.mjs`
2. point it at the output path under `client/src/assets/images/help/...`
3. implement the UI steps in `client/scripts/capture-help-screenshots.mjs`
4. run `npm run generate:help:refresh`
5. verify the target manual references the same filename

Keep flows deterministic. Prefer:

- seeded E2E staff
- seeded test-support fixtures
- stable routes and labels
- light-mode desktop captures
