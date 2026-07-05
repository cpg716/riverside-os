# Metabase OSS Integration Review

**Date:** 2026-07-05  
**Scope:** Riverside OS Metabase / Insights integration against current Metabase OSS documentation.

## Result

Riverside's Metabase architecture is viable for the free open source install:

- Metabase runs as the official OSS Docker image.
- Metabase application metadata is stored in a separate PostgreSQL service, not in `riverside_os`.
- ROS analytics data should be exposed through the `metabase_ro` reporting-only database connection and `reporting.*` views.
- Metabase credentials and JWT secret are managed in-app at **Settings → Integrations → Insights**. Environment variables are fallback/bootstrap only.

## Fixes Applied

- Updated the Metabase image pin from `metabase/metabase:v0.60.1` to `metabase/metabase:v0.62.3.x`.
- Added OSS-safe Compose defaults:
  - `MB_SITE_NAME=Riverside Insights`
  - `JAVA_TIMEZONE=America/New_York`
  - `MB_ANON_TRACKING_ENABLED=false`
  - `MB_ENABLE_PUBLIC_SHARING=false`
  - optional pass-through for native `MB_ENCRYPTION_SECRET_KEY`
- Removed proxy-side HTML/CSS/JS rebranding injection. Current Metabase docs classify custom appearance / white-labeling as Pro / Enterprise.
- Clarified that free OSS launch uses saved Staff/Admin Metabase shared-auth credentials; JWT SSO is paid Metabase only.
- Updated staff/admin docs, AI reporting docs, release QA notes, and generated Help artifacts.

## Official Doc Findings

- Production Docker installs should use a production application database for Metabase metadata, with `MB_DB_TYPE=postgres` and related `MB_DB_*` values.
- `MB_ENCRYPTION_SECRET_KEY` can encrypt database connection credentials stored in Metabase's application database when set before adding database connections.
- JWT-based authentication is available only on Metabase Pro / Enterprise.
- Custom appearance / white-labeling is available only on Metabase Pro / Enterprise.
- Guest embeds are available on OSS, but they are simple embed surfaces and do not provide full ad-hoc Metabase exploration.
- Public links are intentionally public; keeping them disabled by default is correct for Riverside store data.

## Business Decisions Needed

1. **Metabase identity model:** keep two shared Metabase accounts (Staff/Admin) for OSS, or manually provision per-person Metabase users for better Metabase-side auditability.
2. **Paid SSO:** decide whether Riverside should stay OSS-only or buy Metabase Pro / Enterprise for JWT SSO and full app embedding.
3. **Public / guest embeds:** decide whether any dashboard should ever be visible outside ROS and Metabase login. Current default is off.
4. **Metabase encryption secret:** before production Metabase database connections are created, decide and store a stable `MB_ENCRYPTION_SECRET_KEY`. Changing it later can affect Metabase's ability to decrypt stored connection details.
5. **Production edge proxy:** for full Metabase live behavior, decide whether production should terminate `/metabase/` at nginx/Caddy with WebSocket upgrade support instead of relying only on the Axum proxy.

## Validation

- `docker compose config`
- `cargo fmt`
- `cargo fmt --check`
- `npm run generate:help`
- `npm run typecheck`
- `npm run check:server`
- `npm run check:help-impact`
- `npm run check:reports`
- `git diff --check`
