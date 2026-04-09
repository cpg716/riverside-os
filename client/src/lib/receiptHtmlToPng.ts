import html2canvas from "html2canvas";

const TARGET_WIDTH = 576;

/**
 * Rasterize merged receipt HTML for **ESCPOS_RECEIPT_WIDTH_DOTS** (576) thermal width.
 * Uses a hidden iframe so styles isolate from the app shell.
 */
export async function receiptHtmlToPngBase64(fragmentHtml: string): Promise<string> {
  const iframe = document.createElement("iframe");
  iframe.setAttribute(
    "style",
    `position:fixed;left:-10000px;top:0;width:${TARGET_WIDTH}px;min-height:400px;border:0;background:#fff`,
  );
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) {
    document.body.removeChild(iframe);
    throw new Error("iframe document unavailable");
  }

  const fullDoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#fff;box-sizing:border-box;}
    *{box-sizing:border-box;}
  </style></head><body>${fragmentHtml}</body></html>`;

  doc.open();
  doc.write(fullDoc);
  doc.close();

  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });

  const body = doc.body;
  const canvas = await html2canvas(body, {
    scale: 2,
    useCORS: true,
    logging: false,
    backgroundColor: "#ffffff",
    width: Math.min(body.scrollWidth, TARGET_WIDTH),
    windowWidth: TARGET_WIDTH,
  });

  document.body.removeChild(iframe);

  const dataUrl = canvas.toDataURL("image/png");
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}
