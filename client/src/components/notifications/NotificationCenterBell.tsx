import { Bell } from "lucide-react";
import { useNotificationCenter } from "../../context/NotificationCenterContext";

type Props = {
  /** Extra classes for the trigger button (shell-specific spacing). */
  className?: string;
};

export default function NotificationCenterBell({ className = "" }: Props) {
  const { unread, openDrawer, canView } = useNotificationCenter();
  if (!canView) return null;
  return (
    <button
      type="button"
      onClick={() => openDrawer()}
      className={`relative inline-flex touch-manipulation items-center justify-center rounded-lg border border-app-border bg-app-surface-2 p-2 text-app-text shadow-sm transition-colors hover:bg-app-border/20 ${className}`.trim()}
      aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
    >
      <Bell size={18} strokeWidth={2} aria-hidden />
      {unread > 0 ? (
        <span className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-rose-600 px-1 text-[10px] font-black text-white">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </button>
  );
}
