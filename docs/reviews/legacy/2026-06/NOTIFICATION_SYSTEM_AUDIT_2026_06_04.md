# Notification System Audit — 2026-06-04

## Scope

Reviewed the ROS notification center architecture, server delivery controls, event generators, drawer presentation, lifecycle actions, history behavior, and known notification-fatigue controls.

## Current Strengths

- Canonical `app_notification` rows fan out to per-staff `staff_notification` rows, so each staff member has independent read, complete, dismiss, and history state.
- High-volume operational sweeps use bundled `notification_bundle` rows instead of one inbox row per entity.
- Delivery preferences are enforced server-side for configurable categories, while mandatory system/financial/security alerts still deliver.
- Unknown notification kinds are blocked from fan-out and logged as suppressions until they are reviewed.
- Health metrics already track 7-day volume by kind, stale unread rows, broadcast volume, generator status, and delivery suppressions.

## Fixes Applied

- Generic system alerts now emit as reviewed `ops_alert` notifications instead of unreviewed `system_alert`, so they are not silently suppressed.
- Generic system alerts now dedupe by a normalized 15-minute bucket to avoid repeated pool/backup/runtime alerts flooding admin inboxes.
- `GET /api/notifications` now supports `search`, including inbox and history searches across title, body, kind, source, and deep-link payload.
- The notification drawer now includes a search bar for active inbox and earlier/history rows.
- Notification search now has a PostgreSQL GIN full-text index for title/body/kind/source, plus a JSONB index for deep-link payloads.
- Deep-link record search now uses exact recursive JSON scalar matching instead of text fallback matching.
- `GET /api/notifications` now supports server-side `severity`, `category`, and `source` filters.
- The notification drawer exposes severity, category, and exact-source filters next to inbox/history search.
- Notification health now returns fatigue warnings for stale unread buildup, high 24h volume, broadcast volume, and dominant/stale kinds.
- Repeated identical toasts are condensed into one visible toast with a repeat count, and visible toasts are capped.

## Remaining Risks

- Some event-driven emitters still create one row per event when the event is intentionally audit-worthy. That is correct for financial/security failures, but fatigue warnings should be watched in notification health.

## Recommended Next Fixes

1. Promote repeated fatigue warnings to ROS Dev Center operational alerts if they persist across multiple days.
