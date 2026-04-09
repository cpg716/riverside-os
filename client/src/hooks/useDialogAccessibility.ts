import type { RefObject } from "react";
import { useEffect, useId, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hasAttribute("disabled") && (el.offsetParent !== null || el.getClientRects().length > 0),
  );
}

/**
 * Focus trap, Escape, restore focus, and ids for aria-labelledby on modal dialogs.
 */
export function useDialogAccessibility(
  isOpen: boolean,
  options: {
    onEscape?: () => void;
    /** When false, Escape is ignored (e.g. while a request is in flight). Default true if onEscape is set. */
    closeOnEscape?: boolean;
    /** If inside the dialog, receives focus when the dialog opens (e.g. prompt input). */
    initialFocusRef?: RefObject<HTMLElement | null>;
  } = {},
) {
  const { onEscape, closeOnEscape, initialFocusRef } = options;
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const previousActiveRef = useRef<HTMLElement | null>(null);
  const onEscapeRef = useRef(onEscape);
  const allowEscapeRef = useRef(Boolean(onEscape) && closeOnEscape !== false);

  useEffect(() => {
    onEscapeRef.current = onEscape;
    allowEscapeRef.current = Boolean(onEscape) && closeOnEscape !== false;
  }, [onEscape, closeOnEscape]);

  useEffect(() => {
    if (!isOpen) return;

    previousActiveRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const container = dialogRef.current;
    if (!container) return;

    const focusFirst = () => {
      const preferred = initialFocusRef?.current;
      if (preferred && container.contains(preferred)) {
        preferred.focus();
        return;
      }
      const nodes = focusableIn(container);
      (nodes[0] ?? container).focus();
    };
    const raf = requestAnimationFrame(focusFirst);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && allowEscapeRef.current && onEscapeRef.current) {
        e.preventDefault();
        e.stopPropagation();
        onEscapeRef.current();
        return;
      }
      if (e.key !== "Tab") return;

      const nodes = focusableIn(container);
      if (nodes.length === 0) return;

      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement;

      if (e.shiftKey) {
        if (active === first || (active && !container.contains(active))) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [isOpen, initialFocusRef]);

  useEffect(() => {
    if (isOpen) return;
    const prev = previousActiveRef.current;
    if (prev?.isConnected) prev.focus();
  }, [isOpen]);

  return { dialogRef, titleId };
}
