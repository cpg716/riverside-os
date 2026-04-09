import { useEffect, useState } from "react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { X } from "lucide-react";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface TenderTotal {
  payment_method: string;
  total_amount: string;
  tx_count: number;
}

interface OverrideSummary {
  reason: string;
  line_count: number;
  total_delta: string;
}

interface XReport {
  report_type: string;
  session_id: string;
  opening_float: string;
  net_cash_adjustments: string;
  expected_cash: string;
  tenders: TenderTotal[];
  cash_adjustments: unknown[];
  override_summary: OverrideSummary[];
}

interface Props {
  sessionId: string;
  cashierName?: string | null;
  registerOrdinal?: number | null;
  onClose: () => void;
}

export default function RegisterXReportModal({
  sessionId,
  cashierName,
  registerOrdinal,
  onClose,
}: Props) {
  useShellBackdropLayer(true);
  const { dialogRef, titleId } = useDialogAccessibility(true, { onEscape: onClose });
  const [data, setData] = useState<XReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let c = false;
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/sessions/${sessionId}/x-report`,
        );
        if (!res.ok) throw new Error("Could not load X-report");
        const j = (await res.json()) as XReport;
        if (!c) setData(j);
      } catch (e) {
        if (!c)
          setErr(e instanceof Error ? e.message : "Failed to load report");
      }
    })();
    return () => {
      c = true;
    };
  }, [sessionId]);

  return (
    <div className="ui-overlay-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal flex max-h-[90vh] max-w-lg flex-col outline-none"
      >
        <div className="ui-modal-header flex items-center justify-between">
          <div>
            <h2 id={titleId} className="text-lg font-black text-app-text">
              X-Report (mid-shift)
            </h2>
            <p className="text-[10px] font-bold uppercase text-app-text-muted">
              Does not close the till · manager peek
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ui-touch-target rounded-lg text-app-text-muted hover:bg-app-surface"
            aria-label="Close"
          >
            <X size={22} aria-hidden />
          </button>
        </div>
        <div className="ui-modal-body flex-1 overflow-y-auto text-sm">
          {err ? (
            <p className="text-red-600">{err}</p>
          ) : !data ? (
            <p className="text-app-text-muted">Loading…</p>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-app-text-muted">
                Cashier:{" "}
                <strong>{cashierName ?? "—"}</strong>
                {registerOrdinal != null ? (
                  <>
                    {" "}
                    · Session #{registerOrdinal}
                  </>
                ) : null}
              </p>
              <div className="rounded-xl border border-app-border bg-app-surface p-3">
                <div className="flex justify-between">
                  <span className="text-app-text-muted">Opening float</span>
                  <span className="font-mono font-bold">
                    $
                    {centsToFixed2(parseMoneyToCents(data.opening_float || "0"))}
                  </span>
                </div>
                <div className="mt-1 flex justify-between">
                  <span className="text-app-text-muted">Net adjustments</span>
                  <span className="font-mono font-bold">
                    {parseMoneyToCents(data.net_cash_adjustments || "0") >= 0
                      ? "+"
                      : ""}
                    $
                    {centsToFixed2(
                      parseMoneyToCents(data.net_cash_adjustments || "0"),
                    )}
                  </span>
                </div>
                <div className="mt-2 flex justify-between border-t border-app-border pt-2 font-black">
                  <span>Expected cash</span>
                  <span className="font-mono text-emerald-800">
                    $
                    {centsToFixed2(parseMoneyToCents(data.expected_cash || "0"))}
                  </span>
                </div>
              </div>
              <div>
                <p className="mb-2 text-[10px] font-black uppercase text-app-text-muted">
                  Tenders
                </p>
                <table className="w-full text-left text-xs">
                  <tbody className="divide-y">
                    {data.tenders.map((t) => (
                      <tr key={t.payment_method}>
                        <td className="py-1 capitalize">
                          {t.payment_method.replace(/_/g, " ")}
                        </td>
                        <td className="py-1 text-center">{t.tx_count}</td>
                        <td className="py-1 text-right font-mono">
                          $
                          {centsToFixed2(parseMoneyToCents(String(t.total_amount)))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div>
                <p className="mb-2 text-[10px] font-black uppercase text-app-text-muted">
                  Override reasons (session)
                </p>
                <ul className="space-y-1 text-xs">
                  {data.override_summary.length === 0 ? (
                    <li className="text-app-text-muted">None</li>
                  ) : (
                    data.override_summary.map((o) => (
                      <li
                        key={o.reason}
                        className="flex justify-between gap-2"
                      >
                        <span>{o.reason}</span>
                        <span className="shrink-0 font-mono text-app-text-muted">
                          {o.line_count} lines · Δ $
                          {centsToFixed2(parseMoneyToCents(String(o.total_delta)))}
                        </span>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
