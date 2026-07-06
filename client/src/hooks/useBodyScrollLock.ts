import { useEffect } from "react";

let lockDepth = 0;
let savedOverflow: string | null = null;

function acquireBodyScrollLock(): () => void {
  if (typeof document === "undefined") return () => {};

  let released = false;
  if (lockDepth === 0) {
    savedOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockDepth += 1;

  return () => {
    if (released) return;
    released = true;
    lockDepth = Math.max(0, lockDepth - 1);
    if (lockDepth === 0) {
      document.body.style.overflow = savedOverflow ?? "";
      savedOverflow = null;
    }
  };
}

export function useBodyScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    return acquireBodyScrollLock();
  }, [locked]);
}
