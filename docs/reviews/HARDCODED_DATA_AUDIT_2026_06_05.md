# Hardcoded Operational Data Audit — 2026-06-05

## Scope

Reviewed app code for user-facing hardcoded, mock, demo, sample, fallback, and fixed-date values that could be mistaken for current operational data.

Primary search patterns included:
- `mock`, `demo`, `sample`, `stub`, `placeholder`, `fallback`, `hardcoded`
- fixed operational dates such as `2024-01-01` / `2030-12-31`
- old store contact details
- hardcoded weather/location labels
- seeded staff/customer names in runtime UI

Excluded from findings:
- tests and test-support fixtures
- generated Help manuals and screenshots
- docs examples that are clearly command examples or historical review dates
- static catalogs, labels, enum maps, UI option lists, and keyboard layouts

## Fixed in this pass

### Weather cards used hardcoded location labels

**Finding:** Operations Dashboard and Register Dashboard rendered `Buffalo, NY` even though weather location is configurable in Settings and server weather fetch already uses `store_settings.weather_config.location`.

**Fix:** `/api/weather/forecast` now returns the effective configured location, and both dashboards render that value. If missing, the UI shows `Store weather` rather than a false location.

Files:
- `server/src/logic/weather.rs`
- `client/src/components/operations/OperationalHome.tsx`
- `client/src/components/pos/RegisterDashboard.tsx`

### Weather health used env-only Buffalo check

**Finding:** Weather health checks used `RIVERSIDE_VISUAL_CROSSING_API_KEY` and a hardcoded `Buffalo,NY,US` probe, even though runtime weather config is Settings-managed.

**Fix:** Weather health now loads effective Settings-managed weather config and probes the configured location/unit group.

Files:
- `server/src/logic/weather.rs`
- `server/src/api/weather.rs`
- `server/src/logic/integration_heartbeat.rs`
- `server/src/logic/ops_dev_center.rs`

### Staff attendance query used fixed date range

**Finding:** Staff edit drawer loaded schedule exceptions from `2024-01-01` to `2030-12-31`.

**Fix:** The range is now relative to the current date: two years back through one year forward.

File:
- `client/src/components/staff/StaffEditDrawer.tsx`

### Receipt preview fallback contact info was stale

**Finding:** Receipt Builder client preview fallback used old store contact data while the server defaults use the current store address, phone, and email.

**Fix:** Client preview fallbacks and placeholders now match server defaults.

File:
- `client/src/components/settings/ReceiptBuilderPanel.tsx`

### Register weather fallback showed fake conditions

**Finding:** Register Dashboard showed `72°` and `Clear Skies` if weather did not load.

**Fix:** It now shows `—` and `Weather unavailable`.

File:
- `client/src/components/pos/RegisterDashboard.tsx`

## Accepted / intentional hardcoded values

- **Receipt preview transaction/customer/item values:** sample data for receipt template preview only.
- **Shippo demo/stub rates:** explicitly labeled as demo/stub and blocked from label purchase where appropriate.
- **Weather mock fallback:** explicitly labeled `Mock Weather`; retained so dashboards stay functional without Visual Crossing.
- **Localhost / 127.0.0.1 defaults:** valid local desktop/server defaults, usually paired with remote-access warnings.
- **Static UI maps:** permission maps, report catalogs, label maps, keyboard layouts, and status option lists are product constants, not stale operational data.
- **Historical docs dates:** retained as evidence/history, not live app data.

## Remaining risks

- ROSIE token-cost estimates still use a placeholder `$0.50 / 1M tokens` rate. This is not customer/store operational data, but it should become provider/model-configurable before relying on AI cost reporting.
- Receipt preview still uses sample customer/item names by design. If staff confuse previews with real receipts, the preview UI should add a stronger “Sample preview” label.
- Weather mock data remains Buffalo-style. It is visibly labeled as mock, but the fallback generator itself is not location-specific.
- Some docs still mention older local evidence dates and deployment examples. These are acceptable as historical docs, but should not be rendered as live readiness proof.
