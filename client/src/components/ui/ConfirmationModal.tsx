import { AlertTriangle, Check, X } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

interface ConfirmationModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'success' | 'info';
  loading?: boolean;
}

export default function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = 'info',
  loading = false,
}: ConfirmationModalProps) {
  useShellBackdropLayer(isOpen);
  const { dialogRef, titleId } = useDialogAccessibility(isOpen, {
    onEscape: onClose,
    closeOnEscape: !loading,
  });

  if (!isOpen) return null;

  const getVariantStyles = () => {
    switch (variant) {
      case 'danger':
        return {
          icon: <AlertTriangle className="text-red-500" size={24} />,
          button: "bg-red-600 border-red-800 shadow-red-900/20",
          accent: "border-red-500/20 bg-red-500/5",
        };
      case 'success':
        return {
          icon: <Check className="text-emerald-500" size={24} />,
          button: "bg-emerald-600 border-emerald-800 shadow-emerald-900/20",
          accent: "border-emerald-500/20 bg-emerald-500/5",
        };
      default:
        return {
          icon: <AlertTriangle className="text-app-accent" size={24} />,
          button: "bg-app-accent border-app-accent/80 shadow-app-accent/20",
          accent: "border-app-accent/20 bg-app-accent/5",
        };
    }
  };

  const styles = getVariantStyles();

  return (
    <div className="ui-overlay-backdrop flex items-center justify-center p-4">
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
            <div className={`p-2 rounded-xl border ${styles.accent}`}>
              {styles.icon}
            </div>
            <h3
              id={titleId}
              className="text-lg font-black uppercase tracking-tight text-app-text italic"
            >
              {title}
            </h3>
          </div>
          {!loading && (
            <button
              type="button"
              onClick={onClose}
              className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-all"
              aria-label="Dismiss"
            >
              <X size={20} aria-hidden />
            </button>
          )}
        </div>

        <div className="ui-modal-body py-6">
          <p id={`${titleId}-desc`} className="ui-type-instruction-muted whitespace-pre-wrap">
            {message}
          </p>
        </div>

        <div className="ui-modal-footer flex gap-3">
          <button
            type="button"
            disabled={loading}
            onClick={onClose}
            className="ui-btn-secondary flex-1"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => {
              onConfirm();
            }}
            className={`flex-1 min-h-11 touch-manipulation rounded-xl border-b-4 px-4 py-2 text-[10px] font-black uppercase tracking-[0.2em] text-white shadow-lg transition-all active:translate-y-1 active:border-b-0 hover:brightness-110 disabled:opacity-50 ${styles.button}`}
          >
            {loading ? "Processing..." : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
