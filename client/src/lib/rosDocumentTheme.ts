/** Staff + `/shop` share `ros.theme.mode` and `<html data-theme="light|dark">`. */

export type ThemeMode = "light" | "dark" | "system";

export function readStoredThemeMode(): ThemeMode {
  const saved = window.localStorage.getItem("ros.theme.mode");
  if (saved === "light" || saved === "dark" || saved === "system") return saved;
  return "light";
}

export function resolveThemeMode(mode: ThemeMode): "light" | "dark" {
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

export function applyDocumentTheme(resolved: "light" | "dark"): void {
  document.documentElement.setAttribute("data-theme", resolved);
}

/** Call on cold load (e.g. `main.tsx`) and when `themeMode` changes (App). */
export function syncDocumentThemeFromStorage(): void {
  applyDocumentTheme(resolveThemeMode(readStoredThemeMode()));
}

/**
 * Subscribe to OS theme and `localStorage` changes so `/shop` (no App mount)
 * stays aligned with staff Settings.
 */
export function installDocumentThemeListeners(): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => syncDocumentThemeFromStorage();
  const onStorage = (e: StorageEvent) => {
    if (e.key === "ros.theme.mode") onChange();
  };
  mq.addEventListener("change", onChange);
  window.addEventListener("storage", onStorage);
  return () => {
    mq.removeEventListener("change", onChange);
    window.removeEventListener("storage", onStorage);
  };
}
