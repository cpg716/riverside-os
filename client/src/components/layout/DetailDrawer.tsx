import { useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useShellBackdropLayer } from "./ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

interface DetailDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string | null;
  subtitle?: ReactNode;
  noPadding?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  /** Extra classes on the title (e.g. checkout accent). */
  titleClassName?: string;
  /** Panel width tailwind classes (default `max-w-xl`). */
  panelMaxClassName?: string;
  /** Pinned below the scroll region (e.g. checkout primary action). */
  footer?: ReactNode;
  /**
   * When true with `footer`, the main body does not scroll; children should use
   * `h-full min-h-0 flex flex-col` and their own `overflow-y-auto` (register checkout).
   */
  contentContained?: boolean;
  /** Backdrop button classes (default light scrim; use darker for POS payment over keypad). */
  backdropClassName?: string;
}

export default function DetailDrawer({
  isOpen,
  onClose,
  title,
  subtitle,
  children,
  actions,
  titleClassName = "",
  panelMaxClassName = "max-w-xl",
  footer,
  noPadding = false,
  contentContained = false,
  backdropClassName = "absolute inset-0 bg-black/25 backdrop-blur-[2px] transition-opacity duration-200",
}: DetailDrawerProps) {
  useShellBackdropLayer(isOpen);
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, { onEscape: onClose });

  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div
      ref={dialogRef}
      className="fixed inset-0 z-[100] flex items-end justify-end overflow-hidden font-sans outline-none sm:items-stretch"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
      aria-label={title ? undefined : "Side panel"}
      tabIndex={-1}
    >
      <button
        type="button"
        className={backdropClassName}
        onClick={onClose}
        aria-label="Close drawer"
      />

      <div
        className={`relative flex h-[92vh] w-full ${panelMaxClassName} animate-[drawerRise_0.22s_ease-out] flex-col rounded-t-2xl border border-app-border bg-app-surface shadow-[0_24px_60px_-34px_rgba(20,20,20,0.45)] sm:h-full sm:animate-[drawerSlide_0.22s_ease-out] sm:rounded-none sm:border-y-0 sm:border-r-0 sm:border-l`}
      >
        {title && (
          <header className={`shrink-0 border-b border-app-border bg-app-surface-2 ${subtitle ? 'px-4 py-4 sm:px-6' : 'px-4 py-3 sm:px-6'}`}>
            <div className={`flex items-start justify-between gap-3 sm:gap-4 ${subtitle ? 'mb-2' : ''}`}>
              <div className="min-w-0">
                <h2
                  id={titleId}
                  className={`text-xl font-black tracking-tight text-app-text ${titleClassName}`.trim()}
                >
                  {title}
                </h2>
                {subtitle ? (
                  <div className="mt-1 text-xs font-semibold leading-snug tracking-normal text-app-text/70 normal-case">
                    {subtitle}
                  </div>
                ) : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                className="ui-touch-target shrink-0 rounded-xl text-app-text-muted transition-colors hover:bg-app-surface"
                aria-label="Close drawer"
              >
                <X size={18} aria-hidden />
              </button>
            </div>

            {actions ? (
              <div className="no-scrollbar flex gap-2 overflow-x-auto pb-1">
                {actions}
              </div>
            ) : null}
          </header>
        )}

        <div
          className={`min-h-0 flex-1 ${contentContained ? "overflow-hidden" : "overflow-y-auto"} ${noPadding ? "" : "p-4 sm:p-8"} ${footer ? "" : "pb-20 sm:pb-24"}`}
        >
          {children}
        </div>
        {footer ? (
          <div className="shrink-0 border-t border-app-border bg-app-surface p-3 sm:p-4">
            {footer}
          </div>
        ) : null}
      </div>
      <style>{`
        @keyframes drawerSlide {
          from { transform: translateX(100%); opacity: 0.95; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes drawerRise {
          from { transform: translateY(100%); opacity: 0.95; }
          to { transform: translateY(0); opacity: 1; }
        }
      `}</style>
    </div>,
    root,
  );
}
