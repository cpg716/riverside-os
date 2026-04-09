# Metabase reporting (Riverside OS)

This note ties **Back Office Insights** (Metabase in an iframe) to **data governance** work. It pairs with **Back Office → Reports** (curated API tiles): Riverside **Admin role** gates **Margin pivot** in Reports; **Metabase staff vs admin logins** gate margin and private exploration in Insights.

**Booked vs fulfilled:** See **[`docs/REPORTING_BOOKED_AND_FULFILLED.md`](REPORTING_BOOKED_AND_FULFILLED.md)** — migration **`106_reporting_order_recognition.sql`**, **`reporting.order_recognition_at`**, **`daily_order_totals_fulfilled`**.

## Phase 1 (shipped)

- **Staff UX:** **Insights** opens **`InsightsShell`** with same-origin **`/metabase/`** (see **`DEVELOPER.md`** §3c, **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`**).
- **Proxy:** **`server/src/api/metabase_proxy.rs`** forwards **`/metabase/*`** to **`RIVERSIDE_METABASE_UPSTREAM`** (default **`http://127.0.0.1:3001`**). Compose services **`metabase`** + **`metabase-db`** start with **`docker compose up -d`** (see **`docker-compose.yml`**).
- **Operational APIs:** Commission ledger and finalize remain on **`/api/insights/*`** and are used from **Staff → Commission payouts** — see **`docs/STAFF_PERMISSIONS.md`**.

## Phase 2 (shipped baseline)

- **Migration `90_reporting_insights.sql`:** schema **`reporting`** with views **`orders_core`**, **`order_lines`**, **`daily_order_totals`**. Role **`metabase_ro`** (no password in migration — set with **`ALTER ROLE metabase_ro WITH PASSWORD '…'`** as superuser).
- **Migration `106_reporting_order_recognition.sql`:** adds **`reporting.order_recognition_at(...)`** (fulfilled-revenue clock: pickup = **`fulfilled_at`**, ship = **`shipment_event`** label / in_transit / delivered patches), **`orders_core` / `order_lines`** columns **`order_recognition_at`** and **`order_recognition_business_date`**, and **`reporting.daily_order_totals_fulfilled`**. Existing **`daily_order_totals`** stays **booked-date** only — use the new view for fulfillment day aggregates; see **`ThingsBeforeLaunch.md`** (Metabase section).
- **Migration `107_reporting_order_lines_margin.sql`:** extends **`reporting.order_lines`** with **`unit_cost`**, **`line_extended_cost`**, **`line_gross_margin_pre_tax`** (pre-tax line revenue minus extended cost — same definition as **`GET /api/insights/margin-pivot`**). Metabase questions can aggregate margin by **`order_business_date`** (booked) or **`order_recognition_business_date`** (fulfilled); **`REST /api/insights/*`** remains for app and **Admin-only** margin pivot over HTTP.
- **Migration `96_reporting_business_day_geo_loyalty.sql`:** extends Metabase-friendly reporting without widening **`public`** grants:
  - **`reporting.effective_store_timezone()`** — **`SECURITY DEFINER`** reads **`store_settings.receipt_config`** (same source as Receipt settings / register “store day”). **`metabase_ro`** has **`EXECUTE`** only (not **`SELECT`** on **`store_settings`**).
  - **`orders_core`** / **`order_lines`** — **`order_business_date`**, customer **`customer_code`**, **`customer_display_name`**, **`customer_company_name`**, **`customer_postal_code`** / **`city`** / **`state`** (no street lines), **`customer_loyalty_points`**, **`operator_name`**, **`primary_salesperson_name`**.
  - **`daily_order_totals`** — aggregates by **`order_business_date`** (replaces UTC **`order_day_utc`**; refresh Metabase questions that used the old column).
  - **`loyalty_point_ledger`**, **`order_loyalty_accrual`**, **`loyalty_reward_issuances`** — loyalty movement, per-order earn, and reward issuance with customer geo for “sales / loyalty by area.”
- **Metabase connection:** database **`riverside_os`**, user **`metabase_ro`**, browse schema **`reporting`** only (no **`SELECT`** on **`public.*`** by default).
- **Settings → Integrations → Insights (Metabase):** **`store_settings.insights_config`** via **`GET`/`PATCH /api/settings/insights`** (`settings.admin`): data-access policy note, optional **JWT SSO** toggle, synthetic email domain for JWT claims, free-text notes for collections / Metabase groups.
- **JWT handoff:** When **`RIVERSIDE_METABASE_JWT_SECRET`** (≥16 chars) is set and Settings enable SSO, **`POST /api/insights/metabase-launch`** returns an **`iframe_src`** pointing at **`/metabase/auth/sso?jwt=…`**. Metabase must have **Authentication → JWT** configured with the **same signing string**; this capability is **only on Metabase Pro / Enterprise**. **Store policy:** remain **OSS-only** and **do not** rely on JWT SSO — see **Future plan (OSS access model)** below.

**Primary exploration** for ad-hoc analytics should move to **Metabase on `reporting.*`**; **`/api/insights/*`** remains for **operational** flows — align detail in **`docs/AI_REPORTING_DATA_CATALOG.md`** as views grow.

Track architecture and checklist in **`docs/PLAN_METABASE_INSIGHTS_EMBED.md`** §13.

---

## Operational standard: Staff Metabase login vs Admin Metabase login

**Riverside does not choose your Metabase user.** Anyone with **`insights.view`** can open **Back Office → Insights** and reach the Metabase iframe; **what they see afterward depends on which Metabase account they log into**. That is how you **control margin, cost columns, and other private cuts** in Metabase without relying on Riverside staff PIN alone.

**Recommended store policy**

1. **At least two Metabase account classes** (shared or per-person accounts inside each class — ops choice for auditability):
   - **Staff (Metabase)** — **View** only on **staff-safe** collections (no margin dashboards, no exploratory folders with **`line_gross_margin_pre_tax`** / cost unless you explicitly allow). Tight **data permissions** on **`reporting.*`**; consider **no native SQL** for this group on OSS.
   - **Admin (Metabase)** — builders and viewers of **full** reporting including **margin** (migration **107** columns on **`reporting.order_lines`**), draft collections, and ad-hoc questions as policy allows.
2. **Issue credentials accordingly:** floor managers and sales staff get **Staff** Metabase logins; owners, controllers, and IT get **Admin** Metabase logins. **Do not** hand the Admin Metabase password to everyone who has **`insights.view`** in Riverside.
3. **Pair with Back Office → Reports:** **Margin pivot** there stays **Riverside Admin role only** (API-enforced). Metabase **Admin** logins mirror the same sensitivity boundary for exploratory content.

**OSS baseline (no Metabase Enterprise)**

- Use **Metabase Open Source** with **no JWT SSO** from Riverside unless you adopt paid JWT (leave **`RIVERSIDE_METABASE_JWT_SECRET`** unset when staying OSS-only).
- **Single DB connection** to Postgres: prefer **`metabase_ro`** + schema **`reporting`** only; separation is **Metabase groups + collections**, not separate DB roles for each person.

**Collections and groups**

- **Staff / Approved** (or similar) collection: dashboards and questions leadership approves for general staff.
- **Reporting – Staff:** **View** on Staff/Approved; **No access** on internal or margin-heavy collections.
- **Reporting – Admin** (or Metabase **Administrators**): full access to curate and browse as needed.

**Network**

- Keep Metabase on **store LAN**, **Tailscale**, or equivalent — **`REMOTE_ACCESS_GUIDE.md`**.

Implement in **Metabase Admin** (People, Groups, Permissions, Collections). **Settings → Integrations → Insights** can record your policy in **Staff note** and **Collections / groups** fields for trainers.
