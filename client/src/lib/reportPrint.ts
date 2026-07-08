import { isTauri } from "@tauri-apps/api/core";
import { printExistingWindowAsync } from "./browserPrint";
import { printTextReport } from "./printerBridge";
import { dispatchAppToast } from "../components/ui/ToastProviderLogic";

export type ReportPrintRoute =
  | "tauri-report-printer"
  | "tauri-formatted-print"
  | "tauri-report-preview"
  | "browser-print-dialog";

export type ReportPrintAction = "print" | "preview";

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
  action?: ReportPrintAction;
}

let activeReportPreview: HTMLElement | null = null;

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

function closeActiveReportPreview() {
  activeReportPreview?.remove();
  activeReportPreview = null;
}

function openInAppReportPreview(request: ReportPrintDocumentRequest) {
  closeActiveReportPreview();

  const overlay = document.createElement("div");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.className = "ui-overlay-backdrop fixed inset-0 z-200 flex items-center justify-center bg-black/45 p-3";

  const modal = document.createElement("div");
  modal.className = "ui-modal flex h-[94dvh] w-full max-w-6xl flex-col overflow-hidden rounded-3xl";

  const header = document.createElement("div");
  header.className = "ui-modal-header flex flex-wrap items-center justify-between gap-3";

  const titleGroup = document.createElement("div");
  const eyebrow = document.createElement("p");
  eyebrow.className = "text-[10px] font-black uppercase tracking-widest text-app-text-muted";
  eyebrow.textContent = "Report Preview";
  const title = document.createElement("h2");
  title.className = "text-xl font-black text-app-text";
  title.textContent = request.title;
  titleGroup.append(eyebrow, title);

  const actions = document.createElement("div");
  actions.className = "flex items-center gap-2";

  const printButton = document.createElement("button");
  printButton.type = "button";
  printButton.className = "ui-btn-primary px-4 py-2 text-xs font-black";
  printButton.textContent = "Print";
  printButton.addEventListener("click", () => {
    printButton.setAttribute("disabled", "true");
    printButton.textContent = "Printing...";
    void printFormattedReport(request)
      .then(() => {
        printButton.textContent = "Sent";
        dispatchAppToast("Formatted report sent to print.", "success");
      })
      .catch((error) => {
        printButton.removeAttribute("disabled");
        printButton.textContent = "Print";
        dispatchAppToast(error instanceof Error ? error.message : "Report could not print.", "error");
      });
  });

  const closeButton = document.createElement("button");
  closeButton.type = "button";
  closeButton.className = "ui-btn-secondary px-4 py-2 text-xs font-black";
  closeButton.textContent = "Close";
  closeButton.addEventListener("click", closeActiveReportPreview);

  actions.append(printButton, closeButton);
  header.append(titleGroup, actions);

  const body = document.createElement("div");
  body.className = "ui-modal-body min-h-0 flex-1 overflow-hidden bg-app-surface-2 p-0";
  const frame = document.createElement("iframe");
  frame.title = `${request.title} preview`;
  frame.className = "h-full w-full border-0 bg-white";
  frame.setAttribute("sandbox", "");
  frame.srcdoc = request.html ?? plainTextReportHtml(request.title, request.text);
  body.append(frame);

  modal.append(header, body);
  overlay.append(modal);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeActiveReportPreview();
  });
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      closeActiveReportPreview();
      document.removeEventListener("keydown", onKeyDown);
    }
  };
  document.addEventListener("keydown", onKeyDown);

  (document.getElementById("drawer-root") ?? document.body).append(overlay);
  activeReportPreview = overlay;
}

async function printFormattedReport(request: ReportPrintDocumentRequest): Promise<void> {
  if (!request.html) {
    await printTextReport(request.text);
    return;
  }

  const frame = document.createElement("iframe");
  frame.title = `${request.title} print`;
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "1px";
  frame.style.height = "1px";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";

  try {
    document.body.appendChild(frame);
    const frameDocument = frame.contentDocument;
    const frameWindow = frame.contentWindow;
    if (!frameDocument || !frameWindow) {
      throw new Error("Could not create the formatted report print frame.");
    }
    frameDocument.open();
    frameDocument.write(request.html);
    frameDocument.close();
    await printExistingWindowAsync(frameWindow);
  } finally {
    window.setTimeout(() => frame.remove(), 1000);
  }
}

export async function printReportDocument(
  request: ReportPrintDocumentRequest,
): Promise<ReportPrintResult> {
  if (!request.text.trim()) {
    throw new Error("Report content is empty.");
  }

  if (isTauri()) {
    if (request.action === "preview" || (request.preferFormattedPreview && request.action !== "print")) {
      openInAppReportPreview(request);
      return { route: "tauri-report-preview" };
    }
    if (request.html) {
      await printFormattedReport(request);
      return { route: "tauri-formatted-print" };
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
