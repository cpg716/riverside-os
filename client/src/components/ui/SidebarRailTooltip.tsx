import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const SHOW_DELAY_MS = 280;

function mergeRefs<T>(
  ...refs: (React.Ref<T> | undefined)[]
): React.RefCallback<T> {
  return (node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") ref(node);
      else (ref as React.MutableRefObject<T | null>).current = node;
    }
  };
}

export interface SidebarRailTooltipProps {
  /** Rich label (e.g. "Customers (POS)"). */
  label: string;
  /** When false, children render unchanged (expanded sidebar). */
  enabled: boolean;
  children: React.ReactElement;
}

/**
 * Hover/focus tooltip for collapsed sidebar icon rail.
 * Fixed to viewport via portal; theme-aligned with app surfaces.
 */
export default function SidebarRailTooltip({
  label,
  enabled,
  children,
}: SidebarRailTooltipProps) {
  const triggerRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState({ top: 0, left: 0 });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const updateCoords = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setCoords({ top: r.top + r.height / 2, left: r.right + 10 });
  }, []);

  const scheduleShow = useCallback(() => {
    if (!enabled) return;
    clearTimer();
    timerRef.current = setTimeout(() => {
      updateCoords();
      setOpen(true);
    }, SHOW_DELAY_MS);
  }, [enabled, clearTimer, updateCoords]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
  }, [clearTimer]);

  useEffect(() => {
    if (!open || !enabled) return;
    const onScrollOrResize = () => updateCoords();
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open, enabled, updateCoords]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  if (!enabled) {
    return children;
  }

  const child = children;
  const childProps = child.props as Record<string, unknown> & {
    ref?: React.Ref<HTMLElement>;
    onMouseEnter?: (e: React.MouseEvent) => void;
    onMouseLeave?: (e: React.MouseEvent) => void;
    onFocus?: (e: React.FocusEvent) => void;
    onBlur?: (e: React.FocusEvent) => void;
  };

  return (
    <>
      {React.cloneElement(child, {
        ref: mergeRefs(triggerRef, childProps.ref as React.Ref<HTMLElement>),
        onMouseEnter: (e: React.MouseEvent) => {
          childProps.onMouseEnter?.(e);
          scheduleShow();
        },
        onMouseLeave: (e: React.MouseEvent) => {
          childProps.onMouseLeave?.(e);
          hide();
        },
        onFocus: (e: React.FocusEvent) => {
          childProps.onFocus?.(e);
          clearTimer();
          updateCoords();
          setOpen(true);
        },
        onBlur: (e: React.FocusEvent) => {
          childProps.onBlur?.(e);
          hide();
        },
      } as Partial<typeof childProps>)}
      {open
        ? createPortal(
            <div
              role="tooltip"
              className="pointer-events-none fixed z-[60] max-w-[240px] rounded-lg border border-app-border bg-app-surface-2 px-2.5 py-1.5 text-left text-xs font-semibold leading-snug text-app-text shadow-lg shadow-black/10"
              style={{
                top: coords.top,
                left: coords.left,
                transform: "translateY(-50%)",
              }}
            >
              {label}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
