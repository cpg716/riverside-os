import { useShellBackdropLayer } from "./ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

export default function RegisterRequiredModal({
  open,
  title = "Open or join a till",
  message = "This action needs an active till session. Enter POS, then open Register #1 or join an open lane, and try again.",
  onClose,
  onGoToRegister,
}: {
  open: boolean;
  title?: string;
  message?: string;
  onClose: () => void;
  onGoToRegister: () => void;
}) {
  useShellBackdropLayer(open);
  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: true,
  });

  if (!open) return null;

  return (
    <div className="ui-overlay-backdrop flex items-center justify-center p-4 z-[220]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-md animate-workspace-snap outline-none"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="ui-modal-header">
          <h2 id={titleId} className="text-lg font-black text-app-text">
            {title}
          </h2>
        </div>
        <div className="ui-modal-body space-y-4">
          <p className="ui-type-instruction-muted">{message}</p>
        </div>
        <div className="ui-modal-footer flex gap-3">
          <button type="button" onClick={onClose} className="ui-btn-secondary flex-1 py-3">
            Not now
          </button>
          <button
            type="button"
            onClick={() => {
              onGoToRegister();
              onClose();
            }}
            className="ui-btn-primary flex-1 py-3 text-sm font-black"
          >
            Go to POS
          </button>
        </div>
      </div>
    </div>
  );
}
