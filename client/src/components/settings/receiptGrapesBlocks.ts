import type { Editor } from "grapesjs";

/**
 * Receipt-only blocks + merge tokens (server: `receipt_studio_html.rs` / `receipt_escpos_raster`).
 */
export function registerReceiptStudioBlocks(editor: Editor) {
  const bm = editor.BlockManager;
  const existing = bm
    .getAll()
    .find((b: { getId: () => string }) => b.getId() === "ros-receipt-store-name");
  if (existing) {
    return;
  }

  bm.add("ros-receipt-store-name", {
    label: "Store title",
    category: "Receipt",
    media: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6h16M4 12h10M4 18h16"/></svg>`,
    content:
      '<h1 style="margin:0 0 8px;font-size:16px;font-weight:800;text-align:center">{{ROS_STORE_NAME}}</h1>',
  });

  bm.add("ros-receipt-order-meta", {
    label: "Order meta",
    category: "Receipt",
    content: `<div style="text-align:center;font-size:12px;line-height:1.4">
  <p style="margin:0 0 4px">{{ROS_ORDER_DATE}}</p>
  <p style="margin:0;font-weight:700">Order {{ROS_ORDER_ID}}</p>
  <p style="margin:4px 0 0">{{ROS_CUSTOMER_NAME}}</p>
</div>`,
  });

  bm.add("ros-receipt-items", {
    label: "Line items",
    category: "Receipt",
    content: `<div style="margin:8px 0">{{ROS_ITEMS_TABLE}}</div>`,
  });

  bm.add("ros-receipt-payments", {
    label: "Payment & totals",
    category: "Receipt",
    content: `<div style="font-size:12px;line-height:1.45">
  <p style="margin:0 0 4px"><strong>Payment</strong> {{ROS_PAYMENT_SUMMARY}}</p>
  <p style="margin:0">Total {{ROS_TOTAL}} · Paid {{ROS_AMOUNT_PAID}} · Due {{ROS_BALANCE_DUE}}</p>
  <p style="margin:4px 0 0;font-size:11px">Status {{ROS_STATUS}}</p>
</div>`,
  });

  bm.add("ros-receipt-footer", {
    label: "Footer lines",
    category: "Receipt",
    content: `<div style="margin-top:12px;padding-top:8px;border-top:1px dashed #ccc;font-size:10px;color:#444;text-align:center">{{ROS_FOOTER_LINES}}</div>`,
  });

  bm.add("ros-receipt-header-lines", {
    label: "Header lines (brand)",
    category: "Receipt",
    content: `<div style="text-align:center;font-size:11px;color:#333;margin-bottom:8px">{{ROS_HEADER_LINES}}</div>`,
  });

  bm.add("ros-receipt-qr-placeholder", {
    label: "QR (URL placeholder)",
    category: "Receipt",
    content: `<div style="text-align:center;margin:12px 0;font-size:10px;color:#555">
  <div style="display:inline-block;padding:8px;border:1px dashed #aaa;border-radius:4px">
    QR: scan or replace with image block<br/>
    <span style="font-family:monospace">{{ROS_ORDER_ID_FULL}}</span>
  </div>
</div>`,
  });
}
