# Integrations scope (final list)

**Purpose:** Single canonical list of **third-party and external-system posture** for Riverside OS — **not** the full online store spec (shipped baseline: [`ONLINE_STORE.md`](./ONLINE_STORE.md); roadmap: [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md)).

**Status:** Store policy / architecture agreement (2026-04). Update this file when posture changes.

---

## Summary table

| # | Area | Posture | Notes |
|---|------|---------|--------|
| 1 | **Stripe** | **In use** | Payments: in-repo Terminal / intents and refund paths; extend for web checkout as the storefront ships. |
| 2 | **ROS-native online store** | **In progress** | First-party `/shop` + `/api/store`; not a separate e-commerce platform. |
| 3 | **Podium** | **Sole customer messaging + email** | SMS, web chat/widget, and **transactional email** stay on Podium — **no parallel ESP** for that role. |
| 4 | **Calendar federation** (e.g. Google / Microsoft) | **Out of scope** | Internal scheduler and appointments remain ROS-native. |
| 5 | **External alteration / work-order SaaS** | **Out of scope** | No sync to third-party alteration trackers. |
| 6 | **NuORDER** | **In use** | Wholesale API client (OAuth 1.0) for catalog, media, and order sync — **`docs/NUORDER_INTEGRATION.md`**. |
| 7 | **Shippo** | **In use** | Shipping rates and foundation in-repo (`logic/shippo.rs`, store APIs); deepen labels/tracking with checkout as needed. |
| 8 | **Loyalty** | **ROS-native** | Current program in ROS is sufficient; no third-party loyalty platform required. |
| 9 | **E-sign** (DocuSign, etc.) | **Out of scope** | Not a near-term integration. |
| 10 | **ADP** | **Optional / narrow** | If integrated, scope narrowly: e.g. **HR master → staff provisioning** and/or **approved time export → payroll** — not full payroll inside ROS. |
| 11 | **Web / storefront analytics** | **First-party preferred** | Feasible to own: server-side events + Postgres / Insights; optional self-hosted analytics (e.g. Plausible, Umami, PostHog) or UTM capture — product choice. |
| 12 | **Hardware** (printers, terminals) | **Accept as-is** | Tauri / existing patterns; no additional integration mandate. |
| 13 | **Meilisearch** (self-hosted search) | **Optional in-repo** | Sidecar in **`docker-compose.yml`**; ROS indexes variants, store catalog, customers, weddings, orders from PostgreSQL with SQL hydration + **ILIKE** fallback. Env **`RIVERSIDE_MEILISEARCH_URL`** / **`RIVERSIDE_MEILISEARCH_API_KEY`**; admin reindex in **Settings → Integrations** or **`POST /api/settings/meilisearch/reindex`**. See [`SEARCH_AND_PAGINATION.md`](./SEARCH_AND_PAGINATION.md), [`STORE_DEPLOYMENT_GUIDE.md`](./STORE_DEPLOYMENT_GUIDE.md). |
| 14 | **OpenTelemetry** (OTLP collector / APM) | **Optional** | First-party API emits **OTLP** traces when **`OTEL_*`** / **`RIVERSIDE_OTEL_ENABLED`** are set — vendor-agnostic (Jaeger, Grafana Tempo, Datadog agent, etc.). See [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](./OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md). |

---

## Related docs

| Topic | Document |
|-------|----------|
| NuORDER (wholesale catalog, media, and order sync) | [`NUORDER_INTEGRATION.md`](./NUORDER_INTEGRATION.md) |
| Optional Meilisearch (fuzzy search, reindex) | [`SEARCH_AND_PAGINATION.md`](./SEARCH_AND_PAGINATION.md), [`STORE_DEPLOYMENT_GUIDE.md`](./STORE_DEPLOYMENT_GUIDE.md) |
| Podium SMS, widget, webhook, transactional paths | [`PLAN_PODIUM_SMS_INTEGRATION.md`](./PLAN_PODIUM_SMS_INTEGRATION.md) |
| Shippo rates, shipments hub, POS/store shipping | [`SHIPPING_AND_SHIPMENTS_HUB.md`](./SHIPPING_AND_SHIPMENTS_HUB.md) (shipped baseline), [`PLAN_SHIPPO_SHIPPING.md`](./PLAN_SHIPPO_SHIPPING.md) (roadmap) |
| E-commerce module (catalog, checkout, phases) | [`PLAN_ONLINE_STORE_MODULE.md`](./PLAN_ONLINE_STORE_MODULE.md); shipped APIs + `/shop`: [`ONLINE_STORE.md`](./ONLINE_STORE.md) |
| Marketing lists (historical plan; contrast with Podium-as-email above) | [`PLAN_CONSTANT_CONTACT_INTEGRATION.md`](./PLAN_CONSTANT_CONTACT_INTEGRATION.md) |
| QBO | Staff: [`docs/staff/qbo-bridge.md`](./staff/qbo-bridge.md) |
| Counterpoint bridge | [`tools/counterpoint-bridge/README.md`](../tools/counterpoint-bridge/README.md) |
| Visual Crossing weather | [`WEATHER_VISUAL_CROSSING.md`](./WEATHER_VISUAL_CROSSING.md) |
| OpenTelemetry OTLP (optional traces) | [`OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md`](./OBSERVABILITY_TRACING_AND_OPENTELEMETRY.md) |

---

## Change log

| Date | Change |
|------|--------|
| 2026-04-05 | Initial **final list** captured as standalone doc. |
| 2026-04-06 | Added **Meilisearch** as optional self-hosted search (shipped in-repo). |
