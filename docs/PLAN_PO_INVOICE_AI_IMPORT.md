# PO & Invoice AI Assisted Import Plan

**Status:** Prepared design plan; not a live import feature yet.

**Goal:** Let staff upload vendor purchase orders, invoices, packing slips, or receiving paperwork and have ROSIE prepare a reviewed draft instead of forcing manual line entry.

## Scope

- Accept vendor paperwork as PDF, image, CSV, or spreadsheet input.
- Extract vendor name, invoice number, PO number, dates, freight, item identifiers, descriptions, quantities, unit cost, and extended cost.
- Match extracted lines to existing ROS products and variations using SKU, UPC, vendor SKU, style, color, size, and vendor.
- Create one of three human-reviewed drafts:
  - draft standard purchase order
  - draft direct invoice
  - staged receipt against an existing submitted PO
- Require staff review before any stock, cost, or QBO-facing ledger state changes.

## Guardrails

- No direct stock mutation during AI extraction.
- No automatic product creation without staff review.
- No automatic unit-cost update without staff confirmation.
- No silent vendor matching when multiple vendor candidates exist.
- No QBO staging until the receiving or invoice workflow reaches the same posted state as manual receiving.
- Store the source document, extraction confidence, reviewer, and final posting link for audit.

## Suggested workflow

1. Staff opens **Inventory** → **Receive Stock** or **Order Stock**.
2. Staff clicks **Import vendor paperwork**.
3. ROS uploads the document and asks ROSIE to extract structured candidate lines.
4. ROS shows a review grid grouped by exact matches, likely matches, and unresolved lines.
5. Staff confirms vendor, invoice/PO number, freight, dates, and line matches.
6. ROS creates a draft PO, draft direct invoice, or staged receipt.
7. Staff completes the existing **Post Receipt** or **Submit PO** workflow.

## Acceptance criteria

- Existing manual PO, direct invoice, and receiving flows still work unchanged.
- Import errors leave the source document and review state recoverable.
- Duplicate invoice numbers for the same vendor are blocked or require manager override.
- Posted receipts remain idempotent and cannot double-add stock.
- QBO staging sees the same financial source state as manual receiving.
