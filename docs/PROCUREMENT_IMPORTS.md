# Vendor Document Import — Import PO / Invoice

Vendor Document Import is the Back Office workflow for turning vendor purchase orders,
order confirmations, packing slips, invoices, credit memos, and statements into
reviewed Riverside OS procurement drafts.

## Where It Lives

- Back Office → Inventory → Receive Stock → **Import PO / Invoice**
- The existing Catalog CSV importer remains catalog-only. It does not create PO lines
  and it does not update stock quantities.

## Supported Formats

The upload endpoint accepts:

- PDF
- JPG / JPEG
- PNG
- Word `.doc` / `.docx`
- Excel `.xls` / `.xlsx`
- CSV
- TXT
- JSON

All supported formats can be sent to ROSIE when `RIVERSIDE_ROSIE_PROCUREMENT_ENABLED=true`.
Structured formats also run through deterministic pre-parsers first so ROSIE receives
raw text/table context and the workflow still has safe fallback behavior if ROSIE is
offline.

## AI Boundary

ROSIE may extract, classify, normalize, and score. ROSIE never mutates inventory,
financial records, vendors, products, or purchase orders directly.

The Rust API remains the trust boundary:

- Uploaded files are stored in `RIVERSIDE_PROCUREMENT_IMPORT_DIR`.
- The original file SHA-256 is recorded.
- ROSIE output must match the strict procurement JSON schema.
- Money and quantities are parsed as `Decimal`.
- Staff must review unresolved, likely, new product, new variant, and ignored lines.
- Conversion creates PO/direct-invoice draft rows only.
- Stock posts only through the existing Receiving workflow.

## Workflow

1. Upload a vendor document and optionally choose vendor/document type.
2. Run ROSIE extraction.
3. ROSIE receives the original file as base64 plus deterministic raw text/table data
   where available.
4. Server validates extracted header fields and line items.
5. Run line matching.
6. Staff reviews exact, likely, unresolved, ignored, new product, and new variant lines.
7. Staff converts to:
   - Direct invoice draft
   - Standard PO draft
8. Staff opens Receiving when ready to post stock.

## Matching Rules

The deterministic matcher prioritizes:

- Exact ROS SKU
- Exact vendor UPC
- Exact barcode
- Active barcode aliases
- Vendor profile aliases learned from prior reviewed imports
- Vendor-linked product/name fallback requiring staff approval

Exact matches can auto-select `Use Existing SKU`. Likely matches require staff review.
Wrong primary-vendor matches are blocked before conversion.

## Vendor Learning

Reviewed vendor SKU, UPC, and barcode corrections can be saved to
`procurement_vendor_document_profiles`. These aliases improve future matching for the
same vendor but never bypass staff review for low-confidence lines.

## Duplicate Protection

Conversion blocks duplicate vendor invoice numbers unless the API caller explicitly
allows a duplicate. The system also warns on repeated file SHA-256 uploads.

## Configuration

```env
RIVERSIDE_PROCUREMENT_IMPORT_DIR=data/procurement-imports
RIVERSIDE_PROCUREMENT_IMPORT_MAX_BYTES=26214400
RIVERSIDE_ROSIE_PROCUREMENT_ENABLED=false
RIVERSIDE_ROSIE_PROCUREMENT_URL=http://127.0.0.1:8765/v1/procurement/extract
RIVERSIDE_ROSIE_PROCUREMENT_TIMEOUT_MS=20000
RIVERSIDE_ROSIE_PROCUREMENT_MODEL=gemma-4-E4B-it
```

The ROSIE endpoint must be local or store-controlled. Do not configure a cloud
document-processing service for this workflow.

## Troubleshooting

- **PDF/image/Word has no lines:** Confirm ROSIE procurement extraction is enabled and
  reachable.
- **CSV/XLSX has wrong columns:** Review the line grid and vendor learning aliases.
- **Duplicate invoice blocked:** Search recent imports and purchase orders for that
  vendor invoice number.
- **Line will not convert:** Resolve it to an existing SKU, create a new product,
  create a new variant, or mark it ignored.
- **Stock did not change:** Correct behavior. Open Receiving and post received units.
