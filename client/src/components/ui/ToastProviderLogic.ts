import { createContext, useContext } from "react";

export type ToastType = "success" | "error" | "info";

export interface Toast {
  id: string;
  message: string;
  type: ToastType;
  count?: number;
}

export interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void;
  removeToast: (id: string) => void;
}

export const APP_TOAST_EVENT = "ros-app-toast";

export interface AppToastEventDetail {
  message: string;
  type?: ToastType;
}

export function dispatchAppToast(message: string, type: ToastType = "info") {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AppToastEventDetail>(APP_TOAST_EVENT, {
      detail: { message, type },
    }),
  );
}

export const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}
