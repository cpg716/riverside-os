import { isTauri } from "@tauri-apps/api/core";
import { openDesktopTextPreview } from "./desktopFileBridge";

export function printExistingWindow(targetWindow: Window): void {
  const runPrint = () => {
    const execute = () => {
      targetWindow.focus();
      targetWindow.print();
    };

    if (typeof targetWindow.requestAnimationFrame === "function") {
      targetWindow.requestAnimationFrame(() => {
        targetWindow.requestAnimationFrame(execute);
      });
      return;
    }

    execute();
  };

  if (targetWindow.document.readyState === "complete") {
    runPrint();
    return;
  }

  targetWindow.addEventListener("load", runPrint, { once: true });
}

export function writeAndPrintDocumentWindow(
  targetWindow: Window,
  html: string,
): void {
  targetWindow.document.open();
  targetWindow.document.write(html);
  targetWindow.document.close();
  printExistingWindow(targetWindow);
}

export async function openPrintableHtml(
  html: string,
  title: string,
  options?: { filename?: string; width?: number; height?: number },
): Promise<"tauri-preview" | "browser-print" | "blocked"> {
  if (isTauri()) {
    await openDesktopTextPreview(options?.filename ?? `${title}.html`, html);
    return "tauri-preview";
  }

  const width = options?.width ?? 900;
  const height = options?.height ?? 900;
  const targetWindow = window.open("", "_blank", `width=${width},height=${height}`);
  if (!targetWindow) return "blocked";
  writeAndPrintDocumentWindow(targetWindow, html);
  return "browser-print";
}

export function writeAndPrintHtmlFrame(html: string, title: string): void {
  const frame = document.createElement("iframe");
  frame.title = title;
  frame.setAttribute("aria-hidden", "true");
  frame.style.position = "fixed";
  frame.style.right = "0";
  frame.style.bottom = "0";
  frame.style.width = "1px";
  frame.style.height = "1px";
  frame.style.border = "0";
  frame.style.opacity = "0";
  frame.style.pointerEvents = "none";

  const cleanup = () => {
    window.setTimeout(() => frame.remove(), 1000);
  };

  frame.addEventListener("load", () => {
    const targetWindow = frame.contentWindow;
    if (!targetWindow) {
      cleanup();
      return;
    }
    targetWindow.addEventListener("afterprint", cleanup, { once: true });
    printExistingWindow(targetWindow);
    window.setTimeout(cleanup, 30_000);
  }, { once: true });

  document.body.appendChild(frame);

  const frameDocument = frame.contentDocument;
  if (!frameDocument) {
    cleanup();
    throw new Error("Could not create the print frame.");
  }
  frameDocument.open();
  frameDocument.write(html);
  frameDocument.close();
}
