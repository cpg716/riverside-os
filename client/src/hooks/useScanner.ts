/**
 * useScanner — detects HID laser scanner input vs. manual keyboard entry.
 *
 * HID scanners fire characters extremely rapidly (< 80ms apart) and terminate
 * with an Enter keypress. Manual typing at human speed is ignored.
 *
 * Usage:
 *   useScanner({ onScan: (code, source) => handleScan(code, source) });
 */
import { useCallback, useEffect, useRef } from "react";

export type ScanSource = "laser" | "camera";

export interface UseScannerOptions {
  /** Called when a valid scanner burst is detected. */
  onScan: (code: string, source: ScanSource) => void;
  /** Whether the hook is actively listening. Default: true */
  enabled?: boolean;
  /** Minimum code length to be considered a valid scan. Default: 4 */
  minLength?: number;
  /** Maximum milliseconds between consecutive chars to be a scanner event. Default: 80 */
  charIntervalMs?: number;
}

export function useScanner({
  onScan,
  enabled = true,
  minLength = 4,
  charIntervalMs = 80,
}: UseScannerOptions): void {
  const bufferRef = useRef<string>("");
  const lastKeyTimeRef = useRef<number>(0);
  const onScanRef = useRef(onScan);

  // Keep callback ref fresh without re-registering listeners
  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const flush = useCallback(() => {
    const code = bufferRef.current.trim();
    bufferRef.current = "";
    if (code.length >= minLength) {
      onScanRef.current(code, "laser");
    }
  }, [minLength]);

  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const now = Date.now();
      const target = e.target as HTMLElement;

      // Ignore events inside input/textarea/select elements —
      // the ReceivingBay has its own dedicated hidden input for laser mode.
      // We only capture global events for InventoryControlBoard scanning.
      const tag = target.tagName.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        return;
      }

      if (e.key === "Enter") {
        // Check it was a scanner burst (not an empty manual Enter)
        if (bufferRef.current.length >= minLength) {
          const elapsed = now - lastKeyTimeRef.current;
          // The last char before Enter must also have been fast
          if (elapsed < charIntervalMs * 3) {
            flush();
            e.preventDefault();
            return;
          }
        }
        bufferRef.current = "";
        return;
      }

      // Only accumulate printable single chars
      if (e.key.length !== 1) return;

      const elapsed = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (bufferRef.current.length > 0 && elapsed > charIntervalMs) {
        // Too slow — this is a human typist, reset buffer
        bufferRef.current = "";
      }

      bufferRef.current += e.key;
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [enabled, minLength, charIntervalMs, flush]);
}

/**
 * Specialized variant used inside a controlled <input> element.
 * Watches `value` for rapid completion and fires onScan.
 * Designed for the ReceivingBay hidden scan input.
 */
export function useInputScanner({
  value,
  enabled = true,
}: {
  value: string;
  enabled?: boolean;
}): void {
  const lastLenRef = useRef(0);
  const lastTimeRef = useRef(0);

  useEffect(() => {
    if (lastTimeRef.current === 0) {
      lastTimeRef.current = Date.now();
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;

    const now = Date.now();
    const prevLen = lastLenRef.current;
    const currLen = value.length;

    if (currLen > prevLen) {
      lastTimeRef.current = now;
    } 

    lastLenRef.current = currLen;
  }, [value, enabled]);

  return;
}
