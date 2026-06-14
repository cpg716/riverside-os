import { getBaseUrl } from "../../lib/apiConfig";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Gift, Sparkles } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useNotificationCenterOptional } from "../../context/NotificationCenterContextLogic";

const baseUrl = getBaseUrl();

type BirthdayGreetingResponse = {
  show: boolean;
  title?: string | null;
  body?: string | null;
  birthday_local_date: string;
};

export default function StaffBirthdayGreetingModal() {
  const { backofficeHeaders, permissionsLoaded, staffCode, staffPin, staffId } =
    useBackofficeAuth();
  const notificationCenter = useNotificationCenterOptional();
  const [greeting, setGreeting] = useState<BirthdayGreetingResponse | null>(null);
  const [checkingKey, setCheckingKey] = useState("");
  const [saving, setSaving] = useState(false);

  const sessionKey = useMemo(() => {
    if (!permissionsLoaded || !staffCode.trim() || !staffPin.trim() || !staffId.trim()) {
      return "";
    }
    return `${staffId}:${staffCode.trim()}`;
  }, [permissionsLoaded, staffCode, staffId, staffPin]);

  useEffect(() => {
    if (!sessionKey || checkingKey === sessionKey) return;
    setCheckingKey(sessionKey);
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/birthday-greeting/today`, {
          headers: backofficeHeaders(),
        });
        if (!res.ok) return;
        const data = (await res.json()) as BirthdayGreetingResponse;
        if (!cancelled && data.show) {
          setGreeting(data);
          void notificationCenter?.refreshUnread();
        }
      } catch {
        /* Birthday greetings should never block staff login. */
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [backofficeHeaders, checkingKey, notificationCenter, sessionKey]);

  const dismiss = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await fetch(`${baseUrl}/api/staff/birthday-greeting/seen`, {
        method: "POST",
        headers: backofficeHeaders(),
      });
    } catch {
      /* The next login can safely retry the seen marker. */
    } finally {
      setGreeting(null);
      setSaving(false);
    }
  };

  if (!greeting?.show) return null;

  const root = document.getElementById("drawer-root") ?? document.body;
  return createPortal(
    <div className="ui-overlay-backdrop fixed inset-0 z-200 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-2xl border border-app-border bg-app-surface p-6 text-app-text shadow-2xl">
        <div className="mb-5 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border border-app-accent/30 bg-app-accent/10 text-app-accent">
            <Gift size={24} />
          </div>
          <div>
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Riverside Staff
            </p>
            <h2 className="text-xl font-black">{greeting.title}</h2>
          </div>
        </div>
        <p className="text-sm leading-6 text-app-text-muted">{greeting.body}</p>
        <div className="mt-6 flex justify-end">
          <button
            type="button"
            onClick={() => void dismiss()}
            disabled={saving}
            className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-xs"
          >
            <Sparkles size={15} />
            {saving ? "Saving..." : "Start the day"}
          </button>
        </div>
      </div>
    </div>,
    root,
  );
}
