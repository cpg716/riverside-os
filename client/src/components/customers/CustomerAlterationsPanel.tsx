import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type AlterationRow = {
  id: string;
  customer_id: string;
  status: string;
  due_at: string | null;
  notes: string | null;
  created_at: string;
};

export default function CustomerAlterationsPanel({
  apiAuth,
  highlightAlterationId,
  onHighlightConsumed,
}: {
  apiAuth: () => HeadersInit;
  highlightAlterationId?: string | null;
  onHighlightConsumed?: () => void;
}) {
  const { toast } = useToast();
  const rowRefs = useRef<Record<string, HTMLLIElement | null>>({});
  const [rows, setRows] = useState<AlterationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [customerId, setCustomerId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations`, { headers: apiAuth() });
      if (!res.ok) throw new Error("load");
      setRows((await res.json()) as AlterationRow[]);
    } catch {
      toast("Could not load alterations.", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const id = highlightAlterationId?.trim();
    if (!id || rows.length === 0) return;
    if (!rows.some((r) => r.id === id)) return;
    const el = rowRefs.current[id];
    el?.scrollIntoView({ block: "center", behavior: "smooth" });
    onHighlightConsumed?.();
  }, [highlightAlterationId, rows, onHighlightConsumed]);

  const createOrder = async () => {
    const cid = customerId.trim();
    if (!cid) {
      toast("Enter a customer UUID.", "error");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          customer_id: cid,
          notes: notes.trim() || null,
        }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Create failed", "error");
        return;
      }
      toast("Alteration created", "success");
      setNotes("");
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = async (id: string, status: string) => {
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/alterations/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(b.error ?? "Update failed", "error");
        return;
      }
      void load();
    } catch {
      toast("Network error", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ui-page flex min-h-0 flex-1 flex-col gap-4 p-4">
      <div>
        <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Tailoring
        </p>
        <h2 className="text-2xl font-black text-app-text">Alterations</h2>
      </div>

      <section className="ui-card space-y-3 p-4">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          New work order
        </h3>
        <label className="block text-[10px] font-black uppercase text-app-text-muted">
          Customer ID
          <input
            value={customerId}
            onChange={(e) => setCustomerId(e.target.value)}
            className="ui-input mt-1 w-full font-mono text-sm"
            placeholder="UUID from customer profile"
          />
        </label>
        <label className="block text-[10px] font-black uppercase text-app-text-muted">
          Notes
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            className="ui-input mt-1 min-h-[72px] w-full text-sm"
          />
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => void createOrder()}
          className="ui-btn-primary px-4 py-2"
        >
          Create
        </button>
      </section>

      <section className="ui-card min-h-0 flex-1 overflow-auto p-4">
        <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          Recent ({rows.length})
        </h3>
        {loading ? (
          <p className="text-sm text-app-text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-app-text-muted">No alteration orders yet.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((r) => (
              <li
                key={r.id}
                ref={(el) => {
                  rowRefs.current[r.id] = el;
                }}
                className={`flex flex-wrap items-center justify-between gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 ${
                  highlightAlterationId === r.id ? "ring-2 ring-app-accent/40" : ""
                }`}
              >
                <div>
                  <p className="font-mono text-xs text-app-text-muted">{r.id.slice(0, 8)}…</p>
                  <p className="text-sm font-bold text-app-text">
                    Customer {r.customer_id.slice(0, 8)}… ·{" "}
                    <span className="uppercase">{r.status}</span>
                  </p>
                  {r.notes ? (
                    <p className="text-xs text-app-text-muted">{r.notes}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-1">
                  {["in_work", "ready", "picked_up"].map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={busy || r.status === s}
                      onClick={() => void setStatus(r.id, s)}
                      className="rounded-lg border border-app-border px-2 py-1 text-[9px] font-black uppercase tracking-tight text-app-text hover:bg-app-accent/10"
                    >
                      {s.replace("_", " ")}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
