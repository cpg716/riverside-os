import { createContext, useContext, useState, useCallback, ReactNode } from "react";
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback((message: string, type: ToastType = "info") => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);

    // Auto-dismiss after 4 seconds
    setTimeout(() => {
      removeToast(id);
    }, 4000);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toast, removeToast }}>
      {children}
      <div className="fixed bottom-6 right-6 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto toast-slide-in flex items-center gap-3 rounded-2xl border border-app-border bg-app-surface py-3 pl-4 pr-3 shadow-xl max-w-sm"
          >
            {t.type === "success" && <CheckCircle2 className="h-5 w-5 shrink-0 text-app-success" />}
            {t.type === "error" && <AlertTriangle className="h-5 w-5 shrink-0 text-app-danger" />}
            {t.type === "info" && <Info className="h-5 w-5 shrink-0 text-app-accent" />}
            
            <p className="flex-1 text-sm font-medium text-app-text">{t.message}</p>
            
            <button
              type="button"
              onClick={() => removeToast(t.id)}
              className="ml-auto shrink-0 rounded-full p-1 text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
              aria-label="Dismiss notification"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
