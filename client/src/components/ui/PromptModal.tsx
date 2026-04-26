import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Keyboard, Hash } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

/** Return `false` to keep the modal open (e.g. invalid PIN). Otherwise it closes after submit. */
export type PromptModalSubmitResult = void | boolean;

interface PromptModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (
    value: string,
  ) =>
    | PromptModalSubmitResult
    | Promise<PromptModalSubmitResult>;
  title: string;
  message: string;
  placeholder?: string;
  defaultValue?: string;
  type?: "text" | "numeric";
  confirmLabel?: string;
}

export default function PromptModal({
  isOpen,
  onClose,
  onSubmit,
  title,
  message,
  placeholder = "Enter value...",
  defaultValue = "",
  type = 'text',
  confirmLabel = "Submit",
}: PromptModalProps) {
  const [value, setValue] = useState(defaultValue);
  const [submitBusy, setSubmitBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useShellBackdropLayer(isOpen);
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    initialFocusRef: inputRef,
  });

  useEffect(() => {
    if (isOpen) {
      setValue(defaultValue);
      setSubmitBusy(false);
    }
  }, [isOpen, defaultValue]);

  if (!isOpen) return null;

  const handleNumpad = (key: string) => {
    if (key === 'BACK') {
      setValue(prev => prev.slice(0, -1));
    } else if (key === 'CLEAR') {
      setValue("");
    } else {
      // Limit to one decimal
      if (key === '.' && value.includes('.')) return;
      setValue(prev => prev + key);
    }
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (submitBusy) return;
    setSubmitBusy(true);
    try {
      const result = onSubmit(value);
      const resolved = result instanceof Promise ? await result : result;
      if (resolved !== false) {
        onClose();
      } else {
        setValue("");
        queueMicrotask(() => inputRef.current?.focus());
      }
    } catch {
      /* Stay open; caller may toast */
      setValue("");
      queueMicrotask(() => inputRef.current?.focus());
    } finally {
      setSubmitBusy(false);
    }
  };

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div
      className="ui-overlay-backdrop flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={`${titleId}-desc`}
        tabIndex={-1}
        className="ui-modal w-full max-w-md animate-in zoom-in-95 duration-300 outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ui-modal-header flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl border border-app-accent/20 bg-app-accent/5 text-app-accent">
              {type === "numeric" ? <Hash size={24} aria-hidden /> : <Keyboard size={24} aria-hidden />}
            </div>
            <h3 id={titleId} className="text-lg font-black uppercase tracking-tight text-app-text italic">
              {title}
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-all"
            aria-label="Dismiss"
          >
            <X size={20} aria-hidden />
          </button>
        </div>

        <div className="ui-modal-body py-6 space-y-6">
          <div>
            <p id={`${titleId}-desc`} className="ui-type-instruction-muted mb-4 whitespace-pre-wrap">
              {message}
            </p>
            <form
              onSubmit={(ev) => {
                void handleSubmit(ev);
              }}
            >
              <label htmlFor={`${titleId}-field`} className="sr-only">
                {placeholder}
              </label>
              <input
                id={`${titleId}-field`}
                ref={inputRef}
                type="text"
                inputMode={type === "numeric" ? "decimal" : "text"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={placeholder}
                className="ui-input h-14 w-full border-2 text-xl font-black italic tracking-tight shadow-inner focus:border-app-accent"
                autoComplete="off"
              />
            </form>
          </div>

          {type === 'numeric' && (
            <div className="grid grid-cols-3 gap-2 bg-app-surface-2 p-4 rounded-3xl border border-app-border">
              {["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0", "BACK"].map(key => (
                <button
                  key={key}
                  type="button"
                  onClick={() => handleNumpad(key)}
                  className={`flex h-14 min-h-[44px] touch-manipulation items-center justify-center rounded-2xl border border-app-border text-lg font-black transition-all ${
                    key === "BACK"
                      ? "bg-app-danger/10 text-app-danger"
                      : "bg-app-surface text-app-text shadow-sm hover:bg-app-surface-2"
                  }`}
                >
                  {key === 'BACK' ? '←' : key}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setValue("")}
                className="col-span-3 h-12 rounded-2xl border border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:bg-app-surface hover:text-app-text transition-all"
              >
                Clear Input
              </button>
            </div>
          )}
        </div>

        <div className="ui-modal-footer flex gap-3">
          <button
            type="button"
            disabled={submitBusy}
            onClick={onClose}
            className="ui-btn-secondary flex-1 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={submitBusy}
            onClick={() => void handleSubmit()}
            className="flex-1 min-h-11 touch-manipulation rounded-xl border-b-4 border-app-success bg-app-success px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white shadow-lg shadow-app-success/20 transition-all hover:brightness-110 active:translate-y-1 active:border-b-0 disabled:opacity-50"
          >
            {submitBusy ? "…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    root
  );
}
