# Inventory Migration Workbench — Design Specification

> **Status**: Draft · v0.1 · 2026-05-27
> **Replaces**: The monolithic Counterpoint Sync pipeline for inventory — all existing bridge + server ingest infrastructure is **reused**, but the UI and workflow are replaced with a guided, step-by-step workbench.

---

## 1. Problem Statement

The current Counterpoint Sync imports all entities in a single pipeline pass. The user needs a **guided migration workbench** where:

1. **Inventory is imported first** and made correct before anything else.
2. **Three data sources** (CP SQL bridge, Lightspeed CSV, Counterpoint CSV export) are merged to produce the cleanest inventory.
3. **AI (Gemma)** assists with product naming, category assignment, and variation detection.
4. **SKU gaps** (items with only `I-XXXXXX` and no `B-XXXXXX` barcode) are detected, surfaced for assignment, and labels can be printed.
5. **Sequential, gated steps** ensure each entity is reviewed and approved before the next one loads.
6. The entire import is **deleteable and restartable** from a fresh baseline.

---

## 2. What Already Exists (Reusable)

| Component | Location | Status |
|-----------|----------|--------|
| CP SQL bridge (polls CP, posts to ROS) | `counterpoint-bridge/index.mjs` | ✅ Keep as-is |
| Server ingest: catalog, inventory, categories, vendors | `server/src/logic/counterpoint_sync.rs` | ✅ Reuse |
| Category master upsert (display name → ROS category) | `execute_counterpoint_category_masters_batch()` | ✅ Reuse |
| Catalog upsert (products + grid/matrix variants) | `execute_counterpoint_catalog_batch()` | ✅ Reuse |
| Variant upsert with `counterpoint_item_key` | `upsert_variant()` | ✅ Reuse |
| `is_identifier_like_text()` — detects I-/B- codes | logic function | ✅ Reuse |
| Lightspeed CSV reference import | `import_lightspeed_normalization_reference()` | ✅ Reuse |
| Barcode alias preflight + persist | `preflight/persist_counterpoint_barcode_aliases()` | ✅ Reuse |
| Normalization preview (LS vs ROS comparison) | `preview_counterpoint_lightspeed_normalization_candidates()` | ✅ Reuse |
| Quarantine system | `counterpoint_ingest_quarantine` table + logic | ✅ Reuse |
| Registry health + barcode alias health | Existing endpoints | ✅ Reuse |
| Fresh baseline reset | `reset-preview` + `reset-execute` endpoints | ✅ Reuse |
| Inventory verification (CSV comparison) | `inventory-verification` endpoint | ✅ Reuse |
| Landing verification + fidelity diagnostics | Existing endpoints | ✅ Reuse |
| Gemma LLM (local, on Server PC) | `RIVERSIDE_LLAMA_UPSTREAM` → Ollama/Gemma | ✅ Available |
| ROSIE diagnostics analysis route | `POST /api/ops/rosie/diagnostics/analyze` | ✅ Reuse pattern |
| Inventory brain (velocity, recommendations) | `server/src/logic/inventory_brain.rs` | ✅ Reuse for post-import |
| POS label printing | Existing ESC/POS label routes | ✅ Reuse |
| Settings UI panel (5,644 lines) | `CounterpointSyncSettingsPanel.tsx` | ⚠️ Refactor into wizard |

---

## 3. Workbench Flow — Step-by-Step

```
┌─────────────────────────────────────────────────────┐
│              INVENTORY MIGRATION WORKBENCH           │
│                                                     │
│  Step 1: DATA SOURCES                               │
│  ├── Connect CP SQL bridge (existing)               │
│  ├── Upload Lightspeed CSV                          │
│  ├── Upload Counterpoint CSV export                 │
│  └── Status: 3/3 sources loaded ✓                   │
│                                                     │
│  Step 2: CATEGORIES                                 │
│  ├── Import CP category masters (by name)           │
│  ├── Review/map categories → ROS categories         │
│  ├── AI suggest category cleanup                    │
│  └── Approve categories ✓                           │
│                                                     │
│  Step 3: VENDORS                                    │
│  ├── Import vendors from CP                         │
│  └── Approve vendor list ✓                          │
│                                                     │
│  Step 4: CATALOG + INVENTORY                        │
│  ├── Import CP catalog (products + variants)        │
│  ├── Cross-reference with Lightspeed CSV names      │
│  ├── Cross-reference with CP CSV export             │
│  ├── AI review: naming, variations, categories      │
│  ├── Review quarantined items                       │
│  ├── Import inventory quantities                    │
│  └── Approve catalog + inventory ✓                  │
│                                                     │
│  Step 5: SKU GAP REVIEW                             │
│  ├── Detect items with I-XXXXXX only (no B-XXXXXX)  │
│  ├── Assign new SKUs / barcodes                     │
│  ├── Print barcode labels                           │
│  └── Approve SKU assignments ✓                      │
│                                                     │
│  Step 6: VERIFICATION                               │
│  ├── Landing verification (counts match CP)         │
│  ├── Fidelity diagnostics (field-level match)       │
│  ├── Category coverage (all items categorized)      │
│  ├── Variant integrity (grid items have cells)      │
│  └── Sign off inventory ✓                           │
│                                                     │
│  ── INVENTORY GATE PASSED ──                        │
│  (Subsequent steps unlock: Customers, Tickets, etc.)│
└─────────────────────────────────────────────────────┘
```

---

## 4. New Server Endpoints Required

### 4.1 Workbench State

```
GET  /api/settings/counterpoint-sync/workbench/state
```
Returns the current step, which steps are complete, and what data is loaded.

```json
{
  "current_step": "catalog",
  "steps": {
    "data_sources": { "status": "complete", "cp_bridge": true, "lightspeed_csv": true, "cp_csv": true },
    "categories": { "status": "complete", "total": 42, "mapped": 42, "approved_at": "..." },
    "vendors": { "status": "complete", "total": 18, "approved_at": "..." },
    "catalog": { "status": "in_progress", "products": 1200, "variants": 3400, "quarantined": 12 },
    "sku_gaps": { "status": "locked", "items_missing_barcode": null },
    "verification": { "status": "locked" }
  },
  "can_reset": true
}
```

### 4.2 CSV Upload (Counterpoint Export)

```
POST /api/settings/counterpoint-sync/workbench/upload-cp-csv
Content-Type: multipart/form-data
```
Parses a Counterpoint product export CSV and stores it as a reference table (similar to `lightspeed_normalization_reference_rows`). Fields: item_no, description, category, barcode, price, cost, qty_on_hand.

### 4.3 Multi-Source Merge Preview

```
POST /api/settings/counterpoint-sync/workbench/merge-preview
```
Compares all 3 sources (CP SQL-imported products, Lightspeed reference, CP CSV reference) and returns:
- Items where names differ across sources
- Items where categories differ
- Items where variations differ
- AI-suggested best name/category for each conflict

### 4.4 SKU Gap Detection

```
GET  /api/settings/counterpoint-sync/workbench/sku-gaps
```
Queries `product_variants` for items where:
- `sku` matches `I-\d+` pattern (item number used as SKU)
- `barcode` is NULL or empty
- No active entry in `product_variant_barcode_aliases`

Returns a list with product name, current SKU, suggested new B-SKU, and print-ready flag.

### 4.5 SKU Assignment

```
PATCH /api/settings/counterpoint-sync/workbench/sku-gaps/assign
```
Body: `{ assignments: [{ variant_id, new_sku, new_barcode }] }`

Updates `product_variants.sku` and `product_variants.barcode` for the given variants.

### 4.6 Step Approval

```
POST /api/settings/counterpoint-sync/workbench/approve-step
Body: { step: "categories" | "vendors" | "catalog" | "sku_gaps" | "verification" }
```
Records approval timestamp and staff ID. Unlocks the next step.

### 4.7 AI-Assisted Cleanup

```
POST /api/settings/counterpoint-sync/workbench/ai-review
Body: { scope: "names" | "categories" | "variations", limit: 50 }
```
Sends a batch of items to the local Gemma model for analysis. Returns suggestions for:
- **names**: Clean product names from identifier-like names
- **categories**: Suggest correct category from description + existing category list
- **variations**: Detect items that should be matrixed (same description, different size/color)

---

## 5. New UI Component

### `InventoryMigrationWorkbench.tsx`

Replaces the current `CounterpointSyncSettingsPanel` as the primary integration surface during pre-go-live migration. The existing panel remains available under "Advanced" for raw bridge monitoring.

**Key UX principles:**
- **Step indicator** at top showing progress (1-6)
- **Each step is a full-width card** with its own sub-actions
- **Steps are locked** until the previous step is approved
- **Reset button** always visible — calls existing baseline reset
- **AI suggestions** appear inline with accept/reject buttons
- **Print labels** button on SKU gap review opens the existing ESC/POS label flow

### Step 1: Data Sources
- Bridge status indicator (reuse existing `bridgeLive` polling)
- Lightspeed CSV file upload with drag-and-drop
- Counterpoint CSV file upload with drag-and-drop
- Green checkmarks when each source has data

### Step 2: Categories
- Table of CP categories with display names
- Dropdown to map each to a ROS category (reuse existing `categoryRows` + `categoryOptions`)
- "AI Suggest" button sends unmapped categories to Gemma
- "Approve Categories" button locks step

### Step 3: Vendors
- Table of imported vendors
- Simple review + approve

### Step 4: Catalog + Inventory
- Summary cards: products, variants, quarantined, name warnings
- Multi-source comparison table (CP SQL vs Lightspeed vs CP CSV)
- Inline name editing
- Quarantine review panel
- "AI Review Names" button for batch cleanup
- Import inventory quantities
- Approve

### Step 5: SKU Gap Review
- Table of items with `I-XXXXXX` only (no barcode)
- Auto-suggest next available B-SKU
- Inline SKU assignment
- "Print Labels" button for selected items
- Approve

### Step 6: Verification
- Reuse existing landing verification, fidelity diagnostics
- Category coverage check
- Variant integrity check
- Final sign-off → unlocks customer/ticket/order import

---

## 6. Database Changes

### New table: `counterpoint_workbench_state`

```sql
CREATE TABLE IF NOT EXISTS counterpoint_workbench_state (
    id integer PRIMARY KEY DEFAULT 1,
    step_data_sources_status text DEFAULT 'pending',
    step_data_sources_approved_at timestamptz,
    step_data_sources_approved_by uuid,
    step_categories_status text DEFAULT 'locked',
    step_categories_approved_at timestamptz,
    step_categories_approved_by uuid,
    step_vendors_status text DEFAULT 'locked',
    step_vendors_approved_at timestamptz,
    step_vendors_approved_by uuid,
    step_catalog_status text DEFAULT 'locked',
    step_catalog_approved_at timestamptz,
    step_catalog_approved_by uuid,
    step_sku_gaps_status text DEFAULT 'locked',
    step_sku_gaps_approved_at timestamptz,
    step_sku_gaps_approved_by uuid,
    step_verification_status text DEFAULT 'locked',
    step_verification_approved_at timestamptz,
    step_verification_approved_by uuid,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    CONSTRAINT workbench_step_status_chk CHECK (
        step_data_sources_status IN ('pending', 'in_progress', 'complete') AND
        step_categories_status IN ('locked', 'pending', 'in_progress', 'complete') AND
        step_vendors_status IN ('locked', 'pending', 'in_progress', 'complete') AND
        step_catalog_status IN ('locked', 'pending', 'in_progress', 'complete') AND
        step_sku_gaps_status IN ('locked', 'pending', 'in_progress', 'complete') AND
        step_verification_status IN ('locked', 'pending', 'in_progress', 'complete')
    )
);
```

### New table: `counterpoint_csv_reference_rows`

```sql
CREATE TABLE IF NOT EXISTS counterpoint_csv_reference_rows (
    id bigserial PRIMARY KEY,
    batch_id uuid NOT NULL,
    source_row_number integer NOT NULL,
    item_no text NOT NULL,
    description text,
    long_description text,
    category_code text,
    barcode text,
    retail_price numeric,
    unit_cost numeric,
    qty_on_hand integer,
    vendor_no text,
    is_grid boolean DEFAULT false,
    raw_row jsonb NOT NULL DEFAULT '{}',
    created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counterpoint_csv_reference_batches (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    source_file_name text NOT NULL,
    source_file_hash text NOT NULL,
    row_count integer NOT NULL DEFAULT 0,
    status text NOT NULL DEFAULT 'active',
    imported_at timestamptz DEFAULT now()
);
```

---

## 7. AI Integration (Gemma)

The workbench sends structured prompts to the local Gemma model via `RIVERSIDE_LLAMA_UPSTREAM` (existing Ollama endpoint).

### Prompt Templates

**Product Name Cleanup:**
```
You are a retail inventory specialist for a formal menswear and bridal shop.

Given these Counterpoint product entries, suggest clean, human-readable product names.
Current names that look like part numbers (I-12345, B-67890) need real descriptive names.
Use the description, long_description, and category as context.

Items:
[{ item_no: "I-12345", current_name: "I-12345", description: "BLK NOTCH 2B SB", category: "TUXEDOS" }]

Return JSON array: [{ item_no, suggested_name, confidence, reasoning }]
```

**Category Suggestion:**
```
Given these products and the available ROS categories, suggest the best category for each.

Available categories: ["Tuxedos", "Suits", "Shirts", "Accessories", "Shoes", ...]
Products: [{ item_no, name, description, current_cp_category }]

Return JSON: [{ item_no, suggested_category, confidence }]
```

**Variation Detection:**
```
These products may need to be grouped as variations of a parent product.
Group items that are the same product in different sizes/colors.

Items: [{ item_no, name, description, barcode }]

Return JSON: [{ parent_name, variation_type: "size"|"color"|"size+color", items: [item_no...] }]
```

---

## 8. Implementation Order

1. **Phase 1** (This session): Create the workbench state table + API endpoints for step gating, SKU gap detection, and workbench state management.
2. **Phase 2**: Build the `InventoryMigrationWorkbench.tsx` UI component with steps 1-3 (Data Sources, Categories, Vendors).
3. **Phase 3**: Add CSV upload endpoints + multi-source merge preview + steps 4-5 (Catalog, SKU Gaps).
4. **Phase 4**: Integrate Gemma AI for name/category/variation suggestions.
5. **Phase 5**: Step 6 verification + go-live gate.

---

## 9. Migration Path

The existing `CounterpointSyncSettingsPanel` is **not deleted**. It remains available under Settings → Integrations → Counterpoint (Advanced) for:
- Raw bridge monitoring
- Staging queue management
- Direct entity import for post-go-live incremental syncs

The new `InventoryMigrationWorkbench` is the **primary surface** during pre-go-live migration, accessible from Settings → Integrations → "Migration Workbench" tab.
