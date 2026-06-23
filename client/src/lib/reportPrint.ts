import { isTauri } from "@tauri-apps/api/core";
import { openPrintableHtml, printExistingWindowAsync } from "./browserPrint";
import { printTextReport } from "./printerBridge";

export type ReportPrintRoute =
  | "tauri-report-printer"
  | "tauri-report-preview"
  | "browser-print-dialog";

export interface ReportPrintResult {
  route: ReportPrintRoute;
}

export interface ReportPrintDocumentRequest {
  title: string;
  text: string;
  html?: string;
  filename?: string;
  width?: number;
  height?: number;
  preferFormattedPreview?: boolean;
}

function escapeReportHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function plainTextReportHtml(title: string, text: string): string {
  return `<!doctype html>
<html>
  <head>
    <title>${escapeReportHtml(title)}</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color: #111827; padding: 32px; }
      pre { white-space: pre-wrap; line-height: 1.45; font-size: 12px; }
      @media print { body { padding: 0; } }
    </style>
  </head>
  <body><pre>${escapeReportHtml(text)}</pre></body>
</html>`;
}

export async function printReportDocument(
  request: ReportPrintDocumentRequest,
): Promise<ReportPrintResult> {
  if (!request.text.trim()) {
    throw new Error("Report content is empty.");
  }

  if (isTauri()) {
    if (request.preferFormattedPreview && request.html?.trim()) {
      await openPrintableHtml(request.html, request.title, {
        filename: request.filename,
        width: request.width,
        height: request.height,
      });
      return { route: "tauri-report-preview" };
    }
    await printTextReport(request.text);
    return { route: "tauri-report-printer" };
  }

  const width = request.width ?? 950;
  const height = request.height ?? 950;
  const targetWindow = window.open("", "_blank", `width=${width},height=${height}`);
  if (!targetWindow) {
    throw new Error("Print preview was blocked. Please allow popups for Riverside and try again.");
  }

  targetWindow.document.open();
  targetWindow.document.write(request.html ?? plainTextReportHtml(request.title, request.text));
  targetWindow.document.close();
  await printExistingWindowAsync(targetWindow);
  return { route: "browser-print-dialog" };
}

export async function printPlainTextReport(
  request: Omit<ReportPrintDocumentRequest, "html">,
): Promise<ReportPrintResult> {
  return printReportDocument({
    ...request,
    html: plainTextReportHtml(request.title, request.text),
  });
}
