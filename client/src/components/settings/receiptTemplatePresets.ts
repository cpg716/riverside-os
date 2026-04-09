import { defaultReceiptStudioProjectPages } from "./ReceiptStudioEditor";

export type ReceiptTemplatePreset = {
  id: string;
  label: string;
  description: string;
  project: Record<string, unknown>;
};

const narrowClassic = defaultReceiptStudioProjectPages();

const compact: Record<string, unknown> = {
  pages: [
    {
      name: "Receipt",
      component: `<div style="box-sizing:border-box;max-width:576px;font-family:system-ui,sans-serif;padding:12px;font-size:11px;line-height:1.3;color:#000">
  <p style="margin:0;text-align:center;font-weight:800">{{ROS_STORE_NAME}}</p>
  <p style="margin:4px 0 0;text-align:center;font-size:10px">{{ROS_ORDER_DATE}} · {{ROS_ORDER_ID}}</p>
  <p style="margin:2px 0 8px;text-align:center">{{ROS_CUSTOMER_NAME}}</p>
  {{ROS_ITEMS_TABLE}}
  <p style="margin:6px 0 0">{{ROS_PAYMENT_SUMMARY}}</p>
  <p style="margin:2px 0 0"><strong>Totals</strong> {{ROS_TOTAL}} / {{ROS_AMOUNT_PAID}} / due {{ROS_BALANCE_DUE}}</p>
</div>`,
    },
  ],
};

const branded: Record<string, unknown> = {
  pages: [
    {
      name: "Receipt",
      component: `<div style="box-sizing:border-box;max-width:576px;font-family:Georgia,serif;padding:16px;font-size:12px;line-height:1.4;color:#111">
  <div style="text-align:center;font-size:10px;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:10px">{{ROS_HEADER_LINES}}</div>
  <h1 style="margin:0;font-size:18px;font-weight:700;text-align:center">{{ROS_STORE_NAME}}</h1>
  <p style="margin:6px 0 0;text-align:center">{{ROS_ORDER_DATE}}</p>
  <p style="margin:4px 0 0;text-align:center">#{{ROS_ORDER_ID}} · {{ROS_CUSTOMER_NAME}}</p>
  <div style="height:1px;background:#333;margin:12px 0"></div>
  {{ROS_ITEMS_TABLE}}
  <p style="margin:10px 0 4px"><strong>Payment</strong> {{ROS_PAYMENT_SUMMARY}}</p>
  <p style="margin:0">Total {{ROS_TOTAL}} · Paid {{ROS_AMOUNT_PAID}} · Due {{ROS_BALANCE_DUE}}</p>
  <p style="margin:8px 0 0;text-align:center;font-size:10px;font-style:italic">{{ROS_FOOTER_LINES}}</p>
</div>`,
    },
  ],
};

export const RECEIPT_TEMPLATE_PRESETS: ReceiptTemplatePreset[] = [
  {
    id: "classic",
    label: "Classic (576px)",
    description: "Default balanced layout for TM-m30III width",
    project: narrowClassic,
  },
  {
    id: "compact",
    label: "Compact",
    description: "Dense copy for short receipts",
    project: compact,
  },
  {
    id: "branded",
    label: "Branded header",
    description: "Header lines + serif title",
    project: branded,
  },
];
