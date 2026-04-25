---
id: settings-meilisearch-settings-panel
title: "Meilisearch Settings"
order: 1090
summary: "Check Meilisearch sync health, distinguish Refresh from Rebuild, and understand which search indices ROS keeps current."
source: client/src/components/settings/MeilisearchSettingsPanel.tsx
last_scanned: 2026-04-23
tags: settings, meilisearch, search, reindex
status: published
---

# Meilisearch Settings

<!-- help:component-source -->
_Linked component: `client/src/components/settings/MeilisearchSettingsPanel.tsx`._
<!-- /help:component-source -->

## What this is

Use this Settings panel to verify whether the optional Meilisearch search engine is configured, whether each search index has synced successfully, and whether a full rebuild is needed.

## When to use it

Use this panel when inventory, customer, wedding, order, transaction, alteration, or Help Center search feels stale or blank.

## Before you start

- You need Settings admin access.
- PostgreSQL is still the source of truth. Meilisearch only accelerates fuzzy search.
- Search-capable screens fall back to SQL search when Meilisearch is unavailable.

## Steps

1. Open Settings, then Meilisearch.
2. Use Refresh to reload the health view. This does not rebuild any index.
3. Review row counts, last sync times, and any stale warnings.
4. Use Rebuild all indices after a restore, Meilisearch wipe, or major import if search results are stale.

## What to watch for

- Meilisearch does not update itself directly from PostgreSQL. ROS updates search through server write hooks after records are saved.
- Refresh only reloads this dashboard. It does not push new data into Meilisearch.
- Rebuild all indices pushes PostgreSQL records into Meilisearch and refreshes row counts.
- A stale warning means the dashboard has not recorded a successful rebuild or incremental update for that index in more than 24 hours.
- Stale can be normal for a quiet module with no recent writes. It needs follow-up when search results look wrong, the store just restored/imported data, or staff changed records in that module and the timestamp did not move.
- Fulfillment Orders are indexed as `ros_fulfillment_orders`; financial Transactions are indexed as `ros_transactions`; older `ros_orders` health rows are retired.
- Normal record changes update their affected documents through server-side write hooks. A full rebuild is the repair path when those hooks were missed or the search service was offline.

## What happens next

After a successful rebuild, the panel should show current timestamps and updated row counts for the active indices.

## Related workflows

- Search and pagination: `docs/SEARCH_AND_PAGINATION.md`
- Store deployment: `docs/STORE_DEPLOYMENT_GUIDE.md`
