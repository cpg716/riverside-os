import { useCallback, useEffect, useState } from "react";
import { ClipboardList } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

const STAFF_SOP_MAX_BYTES = 131_072;

export default function StoreStaffPlaybookCard() {
  const baseUrl = getBaseUrl();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [staffSopMarkdown, setStaffSopMarkdown] = useState("");
  const [staffSopLoaded, setStaffSopLoaded] = useState(false);
  const [staffSopBusy, setStaffSopBusy] = useState(false);

  const loadStaffSop = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    setStaffSopLoaded(false);
    try {
      const res = await fetch(`${baseUrl}/api/settings/staff-sop`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as { markdown?: string };
        setStaffSopMarkdown(typeof j.markdown === "string" ? j.markdown : "");
      } else {
        setStaffSopMarkdown("");
      }
    } catch {
      setStaffSopMarkdown("");
    } finally {
      setStaffSopLoaded(true);
    }
  }, [backofficeHeaders, baseUrl, hasPermission]);

  useEffect(() => {
    void loadStaffSop();
  }, [loadStaffSop]);

  const saveStaffSop = async () => {
    if (staffSopBusy || !hasPermission("settings.admin")) return;
    if (new TextEncoder().encode(staffSopMarkdown).length > STAFF_SOP_MAX_BYTES) {
      toast(
        `Store playbook is too large (max ${STAFF_SOP_MAX_BYTES} bytes UTF-8)`,
        "error",
      );
      return;
    }
    setStaffSopBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/staff-sop`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ markdown: staffSopMarkdown }),
      });
      if (res.ok) {
        const j = (await res.json()) as { markdown?: string };
        setStaffSopMarkdown(
          typeof j.markdown === "string" ? j.markdown : staffSopMarkdown,
        );
        toast("Store staff playbook saved", "success");
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Could not save store playbook", "error");
      }
    } catch {
      toast("Could not save store playbook", "error");
    } finally {
      setStaffSopBusy(false);
    }
  };

  if (!hasPermission("settings.admin")) return null;

  const byteLength = new TextEncoder().encode(staffSopMarkdown).length;

  return (
    <section className="ui-card p-4 sm:p-6 lg:p-8">
      <div className="mb-4 flex items-start gap-3">
        <ClipboardList
          className="mt-0.5 h-5 w-5 shrink-0 text-app-accent"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Store staff playbook
          </h3>
          <p className="mt-1 text-xs font-medium leading-relaxed text-app-text-muted">
            Store-specific staff notes, policies, contacts, and seasonal
            guidance. Signed-in staff can read this from the Help Center flow.
          </p>
        </div>
      </div>
      {!staffSopLoaded ? (
        <p className="text-sm font-medium text-app-text-muted">Loading...</p>
      ) : (
        <>
          <textarea
            value={staffSopMarkdown}
            onChange={(event) => setStaffSopMarkdown(event.target.value)}
            spellCheck={false}
            className="ui-input min-h-[320px] w-full resize-y font-mono text-sm leading-relaxed"
            placeholder={
              "# Store playbook\n\nFill tables for your location: manager phone, void policy, cash tolerance, seasonal notes."
            }
            aria-label="Store staff playbook markdown"
          />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              UTF-8 size{" "}
              <span
                className={
                  byteLength > STAFF_SOP_MAX_BYTES
                    ? "text-red-600"
                    : "text-app-text"
                }
              >
                {byteLength}
              </span>
              {" / "}
              {STAFF_SOP_MAX_BYTES} bytes
            </p>
            <button
              type="button"
              disabled={staffSopBusy}
              onClick={() => void saveStaffSop()}
              className="ui-btn-primary h-11 px-6 text-sm font-black disabled:opacity-50"
            >
              {staffSopBusy ? "Saving..." : "Save playbook"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
