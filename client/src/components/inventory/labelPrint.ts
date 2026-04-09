export interface ShelfLabelItem {
  sku: string;
  productName: string;
  variation: string;
}

function labelBody(item: ShelfLabelItem): string {
  const varHtml = item.variation || "—";
  return `<section class="label-page">
  <div class="sku">${escapeHtml(item.sku)}</div>
  <div class="sub">${escapeHtml(item.productName)}</div>
  <div class="var">${escapeHtml(varHtml)}</div>
</section>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** One thermal-style label in a new tab; triggers print dialog. */
export function openSingleShelfLabel(item: ShelfLabelItem): void {
  openShelfLabelsWindow([item]);
}

/** Multi-page document — one section per SKU; primary bulk-print path for Zebra workflow. */
export function openShelfLabelsWindow(items: ShelfLabelItem[]): void {
  if (items.length === 0) return;
  const w = window.open("", "_blank", "width=420,height=320");
  if (!w) return;

  const pages = items.map(labelBody).join("\n");
  w.document.write(`<!DOCTYPE html><html><head><title>Shelf labels (${items.length})</title>
  <style>
    @page { size: 4in 2.5in; margin: 0.15in; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 0; }
    .label-page {
      page-break-after: always;
      padding: 12px;
      min-height: 2.2in;
      box-sizing: border-box;
    }
    .label-page:last-child { page-break-after: auto; }
    .sku { font-size: 22px; font-weight: 900; letter-spacing: 0.04em; }
    .sub { font-size: 11px; color: #475569; margin-top: 6px; }
    .var { font-size: 13px; font-weight: 700; margin-top: 8px; }
    .foot { font-size: 9px; color: #94a3b8; margin-top: 12px; }
  </style></head><body>
  ${pages}
  <p class="foot" style="padding:12px">Thermal / Zebra — Riverside OS · ${items.length} label(s)</p>
  </body></html>`);
  w.document.close();
  w.focus();
  w.print();
}
