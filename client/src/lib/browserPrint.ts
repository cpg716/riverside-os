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
