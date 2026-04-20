import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../pos/CustomerSelector";

const baseUrl = getBaseUrl();

type InboxRow = {
  conversation_id: string;
  customer_id: string;
  customer_code: string;
  first_name: string;
  last_name: string;
  channel: string;
  last_message_at: string;
  snippet: string | null;
};

export default function PodiumMessagingInboxSection({
  onOpenCustomerHub,
}: {
  onOpenCustomerHub: (customer: Customer) => void;
}) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/podium/messaging-inbox?limit=80`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        setRows([]);
        return;
      }
      const data = (await res.json()) as InboxRow[];
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="ui-page flex flex-1 flex-col gap-4 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-black uppercase tracking-tight text-app-text">Inbox</h1>
          <p className="text-xs text-app-text-muted">
            Recent Podium SMS and email threads (inbound webhooks and replies). Open a row to view the full
            thread in the customer hub.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
        >
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-app-text-muted">No Podium conversations yet.</p>
      ) : (
        <div className="flex-1 rounded-xl border border-app-border bg-app-surface">
          <ul className="divide-y divide-app-border">
            {rows.map((r) => (
              <li key={r.conversation_id}>
                <button
                  type="button"
                  onClick={() =>
                    onOpenCustomerHub({
                      id: r.customer_id,
                      customer_code: r.customer_code,
                      first_name: r.first_name,
                      last_name: r.last_name,
                      company_name: null,
                      email: null,
                      phone: null,
                    })
                  }
                  className="flex w-full flex-col gap-1 px-4 py-3 text-left transition-colors hover:bg-app-surface-2/80"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <MessageSquare size={14} className="shrink-0 text-app-accent" aria-hidden />
                    <span className="font-bold text-app-text">
                      {r.first_name} {r.last_name}
                    </span>
                    <span className="font-mono text-[10px] text-app-text-muted">
                      {r.customer_code}
                    </span>
                    <span className="rounded border border-app-border bg-app-surface-2 px-1.5 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                      {r.channel}
                    </span>
                    <span className="ml-auto text-[10px] text-app-text-muted">
                      {new Date(r.last_message_at).toLocaleString()}
                    </span>
                  </div>
                  {r.snippet ? (
                    <p className="line-clamp-2 pl-[22px] text-xs text-app-text-muted">
                      {r.snippet}
                    </p>
                  ) : null}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
