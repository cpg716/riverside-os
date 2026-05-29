# Audit Report: Universal Search (May 2026 Re-Audit)

**Date:** 2026-05-29
**Previous Audit:** 2026-04-08 (as part of Technical Audit)
**Version Audited:** v0.85.0 (commit `73cdd56`)
**Auditor:** Devin (AI assistant)
**Scope:** End-to-end trace of universal search aggregation — permission-scoped multi-source query, Meilisearch hybrid fallback to SQL, 8 parallel data sources, operational search (18+ domains), help corpus search, SKU exact match, and shortcut intent matching.

---

## 1. Executive Summary

Universal Search (`GET /search/universal`) is a **permission-scoped aggregation endpoint** that searches across 8+ data sources in parallel. Each source is gated by the staff member's effective permissions — a user only sees results for domains they have access to. The system uses a **hybrid search model**: Meilisearch for fuzzy matching when available, with automatic fallback to SQL `ILIKE` when Meilisearch is down or returns no results.

**Overall Status:** Production Ready — 0 blockers, 0 regressions.

---

## 2. Architecture Trace

### 2.1 Query Flow
```
GET /search/universal?q=smith&limit=8
  → Auth: require_authenticated_staff
  → Resolve effective_permissions
  → Spawn 8 parallel futures (tokio::join!)
  → Each source: check permission → query (Meili or SQL) → transform results
  → Merge all results + collect failed sources
  → Return unified response
```

### 2.2 Data Sources (Permission-Gated)
| Source | Permission | Meilisearch? | SQL Fallback? |
|:---|:---|:---|:---|
| Customers | `customers.hub_view` | ✅ `customer_search_ids` | ✅ ILIKE on name/email/phone/code |
| Products/SKU | `catalog.view` | ✅ Variant search | ✅ Exact SKU match + ILIKE |
| Orders | `orders.view` | — | ✅ `query_paged_transactions` |
| Shipments | `shipments.view` | — | ✅ `list_shipments` with search |
| Weddings | `weddings.view` | ✅ `wedding_party_search_ids` | ✅ Party list query |
| Alterations | `alterations.manage` | — | ✅ SQL customer/item search |
| Help | — (always available) | ✅ `help_search_hits` | ✅ Local corpus search |
| Operational | 18+ permissions | — | ✅ Per-domain SQL searches |

### 2.3 Meilisearch Hybrid Fallback
```
If Meilisearch available:
  → Query Meilisearch for UUID primary keys
  → If results: hydrate from PostgreSQL (JOINs for full data)
  → If no results or error: fall back to SQL ILIKE
If Meilisearch unavailable:
  → SQL ILIKE search directly
```

Logged on fallback: `"universal customer Meilisearch failed; using SQL"`

### 2.4 Operational Search (18+ Domains)
Permission-gated sub-searches within the operational_hits array:
- **Customers** → `customers.hub_view`
- **Transactions/Payments** → `payments.view` or `register.reports`
- **Insights** → `insights.view`
- **Settings** → `settings.admin`
- **QBO** → `qbo.view`
- **Receiving** → `procurement.view`
- **Physical Inventory** → `physical_inventory.view`
- **Gift Cards** → `gift_cards.manage`
- **Loyalty** → `loyalty_program.settings`
- **Notifications** → `notifications.view`
- **Tasks** → `tasks.view_team`
- **Shipments** → `shipments.view`

Each source runs independently — failures are logged and added to `sources_failed` without breaking the overall search.

### 2.5 Help Corpus Search (Two Paths)
**Meilisearch path**: Uses the `help` index with configured search attributes.
**Local fallback path** (`local_help_search_hits`):
- Loads help chunk docs from compiled corpus
- Term-based scoring: title match (+12), heading match (+8), body match (+10 per matched term)
- Results sorted by score then manual rank
- Capped at 40 results

### 2.6 SKU Exact Match
Products source includes a deterministic SKU exact match:
- If query matches a known SKU exactly → returned as `sku_hit` (separate from fuzzy product results)
- This enables instant barcode scanner resolution

### 2.7 Shortcut Intent Matching
`shortcut_ids(&q, &perms)` maps search queries to navigation shortcuts:
- Permission-aware: only shortcuts the user can access are suggested
- Deterministic pattern matching (not LLM-based in the search endpoint itself)

---

## 3. Response Shape
```json
{
    "query": "smith",
    "sources_failed": [],
    "customers": [...],
    "sku_hit": null,
    "products": [...],
    "orders": [...],
    "shipments": [...],
    "weddings": [...],
    "alterations": [...],
    "help_hits": [...],
    "operational_hits": [...],
    "shortcuts": [...]
}
```

### 3.1 Limits
- `DEFAULT_LIMIT = 8`, `MAX_LIMIT = 12` per source
- Operational hits: `limit.min(4)` per sub-domain, truncated to overall limit after merge
- Total result capped per source to avoid response bloat

---

## 4. Comparison with April 2026 Audit

| Area | April 2026 | May 2026 | Status |
|:---|:---|:---|:---|
| Permission gating | Documented | Verified: 18+ permission keys enforced | ✅ No regression |
| Parallel execution | Not documented | Verified: tokio::join! across 8 sources | ✅ New finding |
| Meilisearch fallback | Not documented | Verified: hybrid model with SQL fallback | ✅ New finding |
| Help corpus search | Not documented | Verified: dual-path (Meili + local scoring) | ✅ New finding |
| SKU exact match | Not documented | Verified: deterministic barcode resolution | ✅ New finding |
| Source failure isolation | Not documented | Verified: per-source error handling, sources_failed | ✅ New finding |
| Operational search | Not documented | Verified: 18+ permission-gated sub-domains | ✅ New finding |

---

## 5. Conclusion

**0 blockers, 0 regressions.** Universal Search is production-ready with excellent resilience (per-source failure isolation, Meilisearch fallback), comprehensive permission gating, and efficient parallel execution.
