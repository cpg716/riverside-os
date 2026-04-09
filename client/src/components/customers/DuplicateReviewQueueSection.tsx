import { useCallback, useEffect, useState } from "react";
import { Copy, ExternalLink, Trash2 } from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import CustomerRelationshipHubDrawer from "./CustomerRelationshipHubDrawer";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProvider";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface QueueRow {
  id: string;
  created_at: string;
  customer_a_id: string;
  customer_b_id: string;
  customer_a_code: string;
  customer_b_code: string;
  customer_a_display: string;
  customer_b_display: string;
  score: string;
  reason: string;
  status: string;
}

export default function DuplicateReviewQueueSection({
  onNavigateAllCustomers,
  onOpenWeddingParty,
  onStartSale,
  onNavigateRegister,
  onAddToWedding,
  onBookAppointment,
  onOpenOrderInBackoffice,
}: {
  onNavigateAllCustomers: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onStartSale: (c: Customer) => void;
  onNavigateRegister?: () => void;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenOrderInBackoffice?: (orderId: string) => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [hubCustomer, setHubCustomer] = useState<Customer | null>(null);
  const [dismissTarget, setDismissTarget] = useState<QueueRow | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`${baseUrl}/api/customers/duplicate-review-queue`, {
        headers: apiAuth(),
      });
      const j = (await r.json().catch(() => [])) as unknown;
      if (!r.ok) {
        const err = j as { error?: string };
        throw new Error(err.error ?? "Could not load queue");
      }
      setRows(Array.isArray(j) ? (j as QueueRow[]) : []);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Load failed", "error");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [apiAuth, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const toCustomer = (id: string, code: string, display: string): Customer => {
    const parts = display.trim().split(/\s+/);
    const first = parts[0] ?? "";
    const last = parts.slice(1).join(" ") || "";
    return {
      id,
      customer_code: code,
      first_name: first || display || code,
      last_name: last,
      company_name: null,
      email: null,
      phone: null,
    };
  };

  const dismiss = async (id: string) => {
    try {
      const r = await fetch(
        `${baseUrl}/api/customers/duplicate-review-queue/dismiss`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ id }),
        },
      );
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(j.error ?? "Dismiss failed");
      toast("Pair removed from review queue", "success");
      setDismissTarget(null);
      await load();
    } catch (e) {
      toast(e instanceof Error ? e.message : "Dismiss failed", "error");
    }
  };

  const copyPairCodes = (a: string, b: string) => {
    void navigator.clipboard.writeText(`${a}\t${b}`);
    toast("Customer codes copied", "success");
  };

  return (
    <div className="ui-page flex min-h-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 px-1">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
            Customers
          </p>
          <h2 className="text-2xl font-black tracking-tight text-app-text">
            Duplicate review queue
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-app-text-muted">
            Pending pairs to review. Open each profile to compare, then go to{" "}
            <button
              type="button"
              className="font-bold text-app-accent underline decoration-dotted"
              onClick={onNavigateAllCustomers}
            >
              All Customers
            </button>
            , select exactly those two rows, and use{" "}
            <span className="font-semibold text-app-text">Merge</span> when you
            are sure.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          className="ui-btn-secondary px-4 py-2.5 text-[10px] font-black uppercase tracking-widest"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <section
        className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden p-5"
        data-testid="crm-duplicate-review-queue"
      >
        {loading ? (
          <p className="text-sm text-app-text-muted">Loading queue…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-app-text-muted">No pending pairs.</p>
        ) : (
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-[1] bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-3 py-2">Queued</th>
                  <th className="px-3 py-2">Customer A</th>
                  <th className="px-3 py-2">Customer B</th>
                  <th className="px-3 py-2">Reason</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    className="border-t border-app-border align-top"
                  >
                    <td className="px-3 py-2 text-xs text-app-text-muted">
                      {new Date(row.created_at).toLocaleString()}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs font-bold text-app-text">
                        {row.customer_a_code}
                      </div>
                      <div className="text-xs text-app-text-muted">
                        {row.customer_a_display}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setHubCustomer(
                            toCustomer(
                              row.customer_a_id,
                              row.customer_a_code,
                              row.customer_a_display,
                            ),
                          )
                        }
                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-app-accent"
                      >
                        <ExternalLink size={12} aria-hidden />
                        Hub
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-mono text-xs font-bold text-app-text">
                        {row.customer_b_code}
                      </div>
                      <div className="text-xs text-app-text-muted">
                        {row.customer_b_display}
                      </div>
                      <button
                        type="button"
                        onClick={() =>
                          setHubCustomer(
                            toCustomer(
                              row.customer_b_id,
                              row.customer_b_code,
                              row.customer_b_display,
                            ),
                          )
                        }
                        className="mt-1 inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-wider text-app-accent"
                      >
                        <ExternalLink size={12} aria-hidden />
                        Hub
                      </button>
                    </td>
                    <td className="px-3 py-2 text-xs text-app-text-muted">
                      {row.reason || "—"}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-wrap justify-end gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            copyPairCodes(
                              row.customer_a_code,
                              row.customer_b_code,
                            )
                          }
                          className="inline-flex items-center gap-1 rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-text"
                        >
                          <Copy size={12} aria-hidden />
                          Codes
                        </button>
                        <button
                          type="button"
                          onClick={() => setDismissTarget(row)}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-red-900"
                        >
                          <Trash2 size={12} aria-hidden />
                          Dismiss
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {hubCustomer ? (
        <CustomerRelationshipHubDrawer
          customer={hubCustomer}
          open
          onClose={() => setHubCustomer(null)}
          onOpenWeddingParty={onOpenWeddingParty}
          onStartSale={onStartSale}
          onNavigateRegister={onNavigateRegister}
          onAddToWedding={onAddToWedding}
          onBookAppointment={onBookAppointment}
          onOpenOrderInBackoffice={onOpenOrderInBackoffice}
        />
      ) : null}

      <ConfirmationModal
        isOpen={dismissTarget !== null}
        title="Dismiss this pair?"
        message="They will leave the duplicate review queue. This does not merge or delete customers."
        confirmLabel="Dismiss"
        variant="danger"
        onClose={() => setDismissTarget(null)}
        onConfirm={() => {
          if (dismissTarget) void dismiss(dismissTarget.id);
        }}
      />
    </div>
  );
}
