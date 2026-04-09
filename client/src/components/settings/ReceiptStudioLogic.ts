/** Placeholders are merged server-side (see `receipt_studio_html.rs`). */
export const DEFAULT_RECEIPT_DOCUMENT_HTML = `<div class="ros-receipt-root" style="box-sizing:border-box;max-width:576px;font-family:system-ui,-apple-system,sans-serif;padding:16px;font-size:12px;line-height:1.35;color:#111">
  <h1 style="margin:0 0 8px;font-size:16px;font-weight:800;text-align:center">{{ROS_STORE_NAME}}</h1>
  <p style="margin:0 0 4px;text-align:center">{{ROS_ORDER_DATE}}</p>
  <p style="margin:0 0 4px;text-align:center;font-weight:700">Order {{ROS_ORDER_ID}}</p>
  <p style="margin:0 0 8px;text-align:center">{{ROS_CUSTOMER_NAME}}</p>
  <div style="margin:8px 0">{{ROS_ITEMS_TABLE}}</div>
  <p style="margin:8px 0 0"><strong>Payment</strong> {{ROS_PAYMENT_SUMMARY}}</p>
  <p style="margin:4px 0">Total {{ROS_TOTAL}} · Paid {{ROS_AMOUNT_PAID}} · Due {{ROS_BALANCE_DUE}}</p>
  <p style="margin:4px 0 0;font-size:11px">Status {{ROS_STATUS}}</p>
  <div style="margin-top:12px;padding-top:8px;border-top:1px dashed #ccc;font-size:10px;color:#444;text-align:center">{{ROS_FOOTER_LINES}}</div>
</div>`;

/** Epson TM-m30III ~80 mm printable column ≈ 576 dots at 203 dpi — canvas device for WYSIWYG. */
export const RECEIPT_DEVICE_ID = "epson-tm-m30-80mm";

export type ProjectShape = Record<string, unknown> & {
  pages?: unknown[];
};

export function normalizeStudioProject(raw: unknown): ProjectShape {
  const p = raw as ProjectShape | null;
  if (p && Array.isArray(p.pages) && p.pages.length > 0) {
    return p;
  }
  return {
    pages: [
      {
        name: "Receipt",
        component: DEFAULT_RECEIPT_DOCUMENT_HTML,
      },
    ],
  };
}

export function defaultReceiptStudioProjectPages() {
  return normalizeStudioProject(null);
}
