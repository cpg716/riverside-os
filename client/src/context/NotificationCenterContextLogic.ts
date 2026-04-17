import { createContext, useContext } from "react";

export type NotificationDeepLink = Record<string, unknown> & {
  type?: string;
};

/** Safely extract a trimmed string value from a NotificationDeepLink payload field. */
export function linkStr(link: NotificationDeepLink, key: string): string {
  const v = link[key];
  return typeof v === "string" ? v.trim() : "";
}

export type NotificationRow = {
  staff_notification_id: string;
  notification_id: string;
  created_at: string;
  kind: string;
  title: string;
  body: string;
  deep_link: NotificationDeepLink;
  source: string;
  read_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
};

export type NotificationCenterContextValue = {
  unread: number;
  /** Unread Podium inbound SMS/email staff rows (Operations → Inbox); subset of `unread`. */
  podiumInboxUnread: number;
  refreshUnread: () => Promise<void>;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  canView: boolean;
};

export const NotificationCenterContext =
  createContext<NotificationCenterContextValue | null>(null);

export function useNotificationCenter(): NotificationCenterContextValue {
  const ctx = useContext(NotificationCenterContext);
  if (!ctx) {
    throw new Error("useNotificationCenter requires NotificationCenterProvider");
  }
  return ctx;
}

/** Optional: returns null when outside `NotificationCenterProvider` (e.g. tests). */
export function useNotificationCenterOptional(): NotificationCenterContextValue | null {
  return useContext(NotificationCenterContext);
}
