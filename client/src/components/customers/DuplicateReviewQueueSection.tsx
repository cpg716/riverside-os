import { getBaseUrl } from "../../lib/apiConfig";
import { Fragment, useCallback, useEffect, useState } from "react";
import { AlertTriangle, Copy, ExternalLink, Trash2 } from "lucide-react";
import type { Customer } from "../pos/CustomerSelector";
import { CustomerRelationshipHubDrawer } from "./CustomerRelationshipHubDrawer";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

const baseUrl = getBaseUrl();

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
  onOpenTransactionInBackoffice,
}: {
  onNavigateAllCustomers: () => void;
  onOpenWeddingParty: (partyId: string) => void;
  onStartSale: (c: Customer) => void;
  onNavigateRegister?: () => void;
  onAddToWedding?: () => void;
  onBookAppointment?: () => void;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [rows, setRows] = useState<QueueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<string | null>(null);
  const [hubCustomer, setHubCustomer] = useState<Customer | null>(null);
  const [dismissTarget, setDismissTarget] = useState<QueueRow | null>(null);
  const [compareRowId, setCompareRowId] = useState<string | null>(null);

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
      setLoadError(null);
      setLastLoadedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    } catch (e) {
      setLoadError("Could not refresh duplicate review queue.");
      toast(e instanceof Error ? e.message : "Could not refresh duplicate review queue.", "error");
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

      {loadError ? (
        <div className="rounded-xl border border-app-warning/40 bg-app-warning/10 px-4 py-3 text-sm text-app-text">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex gap-3">
              <AlertTriangle size={18} className="mt-0.5 shrink-0 text-app-warning" />
              <div>
                <p className="font-black">{loadError}</p>
                <p className="text-xs text-app-text-muted">
                  {rows.length > 0
                    ? `Showing last loaded duplicate pairs${lastLoadedAt ? ` from ${lastLoadedAt}` : ""}. Refreshing is safe and does not merge or dismiss customers.`
                    : "No duplicate pairs loaded. Refresh again before treating the queue as clear."}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void load()}
              className="rounded-lg border border-app-warning/40 bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
            >
              Try Again
            </button>
          </div>
        </div>
      ) : null}

      <section
        className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden p-5"
        data-testid="crm-duplicate-review-queue"
      >
        {loading ? (
          <p className="text-sm text-app-text-muted">Loading queue…</p>
        ) : rows.length === 0 ? (
          <div className="text-sm text-app-text-muted">
            <p className="font-bold text-app-text">
              {loadError ? "Duplicate review queue could not refresh." : "No pending pairs."}
            </p>
            <p className="mt-1">
              {loadError
                ? "Retry is safe. Do not treat the queue as clear until refresh succeeds."
              : "This is a valid empty queue after the latest successful refresh."}
            </p>
          </div>
        ) : (
          <>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto lg:hidden">
            {rows.map((row) => (
              <article
                key={row.id}
                className="rounded-xl border border-app-border bg-app-surface p-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Queued {new Date(row.created_at).toLocaleString()}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-app-text">
                      {row.reason || "Possible duplicate pair"}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      copyPairCodes(row.customer_a_code, row.customer_b_code)
                    }
                    className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-text"
                  >
                    <Copy size={12} aria-hidden />
                    Codes
                  </button>
                </div>

                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Customer A
                    </p>
                    <p className="mt-1 font-mono text-xs font-black text-app-text">
                      {row.customer_a_code}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">
                      {row.customer_a_display}
                    </p>
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
                      className="mt-3 inline-flex min-h-9 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                    >
                      <ExternalLink size={12} aria-hidden />
                      Hub A
                    </button>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                    <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                      Customer B
                    </p>
                    <p className="mt-1 font-mono text-xs font-black text-app-text">
                      {row.customer_b_code}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-app-text-muted">
                      {row.customer_b_display}
                    </p>
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
                      className="mt-3 inline-flex min-h-9 items-center gap-1 rounded-lg border border-app-border bg-app-surface px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                    >
                      <ExternalLink size={12} aria-hidden />
                      Hub B
                    </button>
                  </div>
                </div>

                <div className="mt-3 flex flex-wrap justify-end gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setCompareRowId((current) =>
                        current === row.id ? null : row.id,
                      )
                    }
                    className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                  >
                    <ExternalLink size={12} aria-hidden />
                    {compareRowId === row.id ? "Hide Compare" : "Compare"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDismissTarget(row)}
                    className="inline-flex min-h-9 items-center gap-1 rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-red-900"
                  >
                    <Trash2 size={12} aria-hidden />
                    Dismiss
                  </button>
                </div>

                {compareRowId === row.id ? (
                  <div className="mt-3 rounded-xl border border-app-accent/20 bg-app-accent/5 p-3 text-xs">
                    <p className="font-black uppercase tracking-widest text-app-text-muted">
                      Next safe action
                    </p>
                    <p className="mt-1 text-app-text-muted">
                      Open both hubs to review details, then merge from All Customers when the match is confirmed.
                    </p>
                    <button
                      type="button"
                      onClick={onNavigateAllCustomers}
                      className="mt-3 rounded-lg border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                    >
                      Merge in All Customers
                    </button>
                  </div>
                ) : null}
              </article>
            ))}
          </div>

          <div className="hidden min-h-0 flex-1 overflow-auto lg:block">
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
                  <Fragment key={row.id}>
                  <tr
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
                          onClick={() => setCompareRowId((current) => current === row.id ? null : row.id)}
                          className="inline-flex items-center gap-1 rounded-lg border border-app-accent/30 bg-app-accent/10 px-2 py-1 text-[9px] font-black uppercase tracking-wider text-app-accent"
                        >
                          <ExternalLink size={12} aria-hidden />
                          {compareRowId === row.id ? "Hide" : "Compare"}
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
                  {compareRowId === row.id ? (
                    <tr className="border-t border-app-border bg-app-surface-2/70">
                      <td colSpan={5} className="px-3 py-3">
                        <div className="grid gap-3 text-xs md:grid-cols-[1fr_auto_1fr]">
                          <div className="rounded-xl border border-app-border bg-app-surface p-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Customer A
                            </p>
                            <p className="mt-1 font-mono text-xs font-black text-app-text">
                              {row.customer_a_code}
                            </p>
                            <p className="mt-1 font-bold text-app-text-muted">
                              {row.customer_a_display}
                            </p>
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
                              className="mt-3 inline-flex rounded-lg border border-app-border bg-app-surface-2 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                            >
                              Open Hub A
                            </button>
                          </div>
                          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 py-3 text-center">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Review reason
                            </p>
                            <p className="max-w-[12rem] text-xs font-semibold text-app-text">
                              {row.reason || "Possible duplicate pair"}
                            </p>
                            <button
                              type="button"
                              onClick={onNavigateAllCustomers}
                              className="rounded-lg border border-app-accent/30 bg-app-accent/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                            >
                              Merge in All Customers
                            </button>
                          </div>
                          <div className="rounded-xl border border-app-border bg-app-surface p-3">
                            <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                              Customer B
                            </p>
                            <p className="mt-1 font-mono text-xs font-black text-app-text">
                              {row.customer_b_code}
                            </p>
                            <p className="mt-1 font-bold text-app-text-muted">
                              {row.customer_b_display}
                            </p>
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
                              className="mt-3 inline-flex rounded-lg border border-app-border bg-app-surface-2 px-3 py-1.5 text-[9px] font-black uppercase tracking-wider text-app-accent"
                            >
                              Open Hub B
                            </button>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          </>
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
          onOpenTransactionInBackoffice={onOpenTransactionInBackoffice}
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
