# Weather and Visual Crossing

Riverside OS uses the [Visual Crossing Timeline Weather API](https://www.visualcrossing.com/resources/documentation/weather-api/timeline-weather-api/) when enabled and a key is available. Requests use **`contentType=json`**, **`unitGroup`** `us` or `metric`, **`include`** `days` or `days,current`, and a **`timeline/{location}/{start}/{end}`** path (date range required for dashboard history and short forecast). If live weather is off or the key is missing, the server uses deterministic mock daily data (Buffalo-style) so dashboards and snapshots still work.

## Configuration

- **Storage:** `store_settings.weather_config` (JSONB), migration **`46_weather_config.sql`**. If the column is missing (migration not applied), `load_store_weather_settings` falls back to defaults and logs at **debug** only (no noisy startup warning for SQLSTATE `42703`).
- **Admin UI:** **Settings → Integrations → Weather**; **`GET`/`PATCH`** **`/api/settings/weather`** (settings admin) for `enabled`, `location`, `unit_group` (`us` | `metric`), and `timezone` (IANA). Save the Visual Crossing API key in the credentials card on the same page.

### Runtime flag

The Visual Crossing API key is Settings-managed. The only environment override left here is the non-secret enable/disable flag.

| Env var | Notes |
|---------|--------|
| **`RIVERSIDE_VISUAL_CROSSING_ENABLED`** | When set to **`1`**, **`true`**, **`yes`**, or **`on`** (case-insensitive), forces **`enabled: true`** for weather logic regardless of DB. **`0`**, **`false`**, **`no`**, **`off`** force **`enabled: false`**. |

**Precedence:** For API calls, effective settings = Settings values + the optional runtime enabled override. Credentials do not belong in environment files.

**`search_path`:** Weather quota and EOD-finalize SQL use the **`public.`** schema qualifier so tables resolve even when the DB role’s `search_path` omits `public` (which otherwise yields “relation does not exist” despite migrations being applied). Startup logs **`search_path`** in **`PostgreSQL startup context`** (`db_startup_diag`).

## HTTP API (unauthenticated)

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/weather/history?from=YYYY-MM-DD&to=YYYY-MM-DD` | Daily rows for chart ranges |
| `GET` | `/api/weather/forecast` | JSON `{ days, current }` — today/tomorrow dailies plus optional **`currentConditions`** when VC is on (`include=days,current`) |
| `GET` | `/api/weather/health` | **New** Live connectivity + latency check |

## Hardening (v0.70.x)

- **Retry Logic**: Visual Crossing Timeline requests retry up to **2 times** with exponential backoff (300ms → 600ms) on network timeouts, connection errors, and HTTP 5xx.
- **Health Check**: `GET /api/weather/health` probes the API with a single-day request without consuming additional quota. Returns `configured`, `reachable`, `latency_ms`, `message`.

These routes are intentionally **not** staff-gated so dashboards and feeds can load without Back Office headers.

## Where weather is stored

- **`transactions.weather_snapshot`** — set at checkout (daily summary for that calendar day).
- **`register_sessions.weather_snapshot`** — set when the register session is **closed** (Z-report path), using that day’s daily fetch.

## End-of-day refresh (final daily values)

Migration **`47_weather_snapshot_finalize_ledger.sql`** adds **`weather_snapshot_finalize_ledger`**. If this migration is not applied, the hourly worker skips EOD finalize (logs at **debug**, no error spam). Apply **`47`** (and **`48`** for the VC pull counter) for full behavior.

The hourly background worker (see `server/src/launcher.rs`) calls **`maybe_finalize_daily_weather_snapshots`** after **local hour ≥ 3** (default), **once per store-local calendar day**, and:

1. Fetches **seven days** of finalized daily data from Visual Crossing (`yesterday - 6` through `yesterday` in store timezone) in **one** Timeline request.
2. Updates **`weather_snapshot`** on closed **`register_sessions`** and **`transactions`** whose local **`closed_at`** / **`booked_at`** date matches each day.

Requires VC enabled with a valid key; failures do not advance the ledger (retried on a later tick).

**Env:** `RIVERSIDE_WEATHER_FINALIZE_AFTER_LOCAL_HOUR` (default `3`, store-local).

## API pull budget (under 900/day)

Migration **`48_weather_vc_daily_usage.sql`** adds **`weather_vc_daily_usage`** (`usage_date` **UTC**, `pull_count`). Each **successful** Timeline HTTP response (parsed JSON with at least one day in range) increments the counter for that UTC day. Network/HTTP/JSON failures **release** the reserved slot (counter decrement) so bad calls do not burn quota.

Migration **`112_weather_vc_request_cache.sql`** adds **`weather_vc_request_cache`** so identical Visual Crossing Timeline requests are deduped across ROS server restarts and across multiple running ROS processes. Successful responses are cached for the configured TTL. HTTP **429 Too Many Requests** writes a shared cooldown entry for at least 30 minutes, so another worker or dashboard request falls back to mock weather instead of immediately calling Visual Crossing again.

| Env var | Default | Notes |
|---------|---------|--------|
| `RIVERSIDE_WEATHER_VC_MAX_PULLS_PER_DAY` | `850` | Hard cap **1–900** |
| `RIVERSIDE_WEATHER_VC_CACHE_SECONDS` | `900` | In-process and DB-backed dedupe of identical Timeline requests (no DB increment, no HTTP on cache hit) |

See [Runtime flag](#runtime-flag) for **`RIVERSIDE_VISUAL_CROSSING_ENABLED`**.

**Other cost controls:** Session weather **backfill** groups sessions by **`opened_at` date** so each distinct date costs one Timeline call, not one per session. Identical `history`/`forecast`/checkout ranges hit the in-memory or DB cache within the TTL.

## Related code

- `server/src/logic/weather.rs` — VC client, mock fallback, quota, cache, finalize.
- `server/src/api/weather.rs` — `history`, `forecast`.
- `server/src/api/settings.rs` — weather config read/write.
- `scripts/ros_migration_build_probes.sql` — includes probes through the **latest** numbered migration for `migration-status-docker.sh` (weather probes remain **46–48**; see **`DEVELOPER.md`** for the full migration table).
