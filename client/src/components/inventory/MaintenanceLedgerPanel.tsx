import React, { useEffect, useState, useMemo, useCallback } from "react";
import {
  Search,
  ShieldAlert,
  Truck,
  ChevronDown,
  Calendar,
  DollarSign,
  Package,
  TrendingDown,
  ArrowUpRight,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
// Unused centsToFixed2 removed

interface MaintenanceRow {
  id: string;
  created_at: string;
  tx_type: "damaged" | "return_to_vendor";
  quantity_delta: number;
  unit_cost: string | null;
  notes: string | null;
  variant_id: string;
  sku: string;
  product_name: string;
  brand: string | null;
  category_name: string | null;
  vendor_name: string | null;
  staff_name: string | null;
}

export interface MaintenanceLedgerPanelProps {
  type: "damaged" | "return_to_vendor";
}

export const MaintenanceLedgerPanel: React.FC<MaintenanceLedgerPanelProps> = ({
  type,
}) => {
  const { backofficeHeaders } = useBackofficeAuth();
  const [rows, setRows] = useState<MaintenanceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const apiHeaders = useMemo(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams({ tx_type: type, search });
      const res = await fetch(`/api/products/maintenance?${qs}`, {
        headers: apiHeaders,
      });
      if (!res.ok) throw new Error("Fetch failed");
      const data = await res.json();
      setRows(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [type, search, apiHeaders]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const stats = useMemo(() => {
    let totalQty = 0;
    let totalValue = 0;
    for (const r of rows) {
      const q = Math.abs(r.quantity_delta);
      totalQty += q;
      totalValue += q * parseFloat(r.unit_cost || "0");
    }
    return { totalQty, totalValue };
  }, [rows]);

  return (
    <div className="flex flex-col gap-8 animate-in fade-in slide-in-from-bottom-6 duration-1000">
      {/* Executive Financial Dashboard */}
      <div className="grid grid-cols-1 gap-6 md:grid-cols-3">
        <div className="group relative overflow-hidden rounded-[32px] border border-app-border bg-app-surface/40 p-8 transition-all duration-500 hover:shadow-2xl hover:shadow-app-accent/10">
          <div className="absolute -right-4 -top-4 opacity-[0.03] grayscale transition-all duration-700 group-hover:scale-110 group-hover:opacity-[0.08]">
            {type === "damaged" ? (
              <ShieldAlert size={140} />
            ) : (
              <Truck size={140} />
            )}
          </div>
          <div className="flex items-center gap-5">
            <div
              className={`flex h-14 w-14 items-center justify-center rounded-2xl ${type === "damaged" ? "bg-red-500/10 text-red-500 shadow-[0_0_20px_rgba(239,68,68,0.2)]" : "bg-app-accent/10 text-app-accent shadow-[0_0_20px_rgba(var(--app-accent-rgb),0.2)]"}`}
            >
              {type === "damaged" ? (
                <ShieldAlert size={32} />
              ) : (
                <Truck size={32} />
              )}
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted italic opacity-60">
                Inventory Movements
              </p>
              <div className="flex items-baseline gap-2">
                <p className="text-4xl font-black tracking-tighter text-app-text">
                  {rows.length}
                </p>
                <span className="text-xs font-bold text-app-text-muted">
                  records filtered
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="group relative overflow-hidden rounded-[32px] border border-app-border bg-app-surface/40 p-8 transition-all duration-500 hover:shadow-2xl hover:shadow-emerald-500/10">
          <div className="absolute -right-4 -top-4 opacity-[0.03] grayscale transition-all duration-700 group-hover:scale-110 group-hover:opacity-[0.08]">
            <Package size={140} />
          </div>
          <div className="flex items-center gap-5">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.2)]">
              <Package size={32} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted italic opacity-60">
                Deficit Capacity
              </p>
              <div className="flex items-baseline gap-2">
                <p className="text-4xl font-black tracking-tighter text-app-text">
                  {stats.totalQty}
                </p>
                <span className="text-xs font-bold text-app-text-muted">
                  total units
                </span>
              </div>
            </div>
          </div>
        </div>

        <div className="group relative overflow-hidden rounded-[32px] border border-app-border bg-app-surface/40 p-8 transition-all duration-500 hover:shadow-2xl hover:shadow-amber-500/10">
          <div className="absolute -right-4 -top-4 opacity-[0.03] grayscale transition-all duration-700 group-hover:scale-110 group-hover:opacity-[0.08]">
            <DollarSign size={140} />
          </div>
          <div className="flex items-center gap-5">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.2)]">
              <TrendingDown size={32} />
            </div>
            <div>
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted italic opacity-60">
                Financial Realization
              </p>
              <div className="flex items-baseline gap-2">
                <p className="text-4xl font-black tracking-tighter text-app-text">
                  $
                  {stats.totalValue.toLocaleString(undefined, {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </p>
                <span className="text-xs font-bold text-app-text-muted">
                  USD extended loss
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* High-Resolution Discovery Engine */}
      <div className="flex items-center gap-4 rounded-[32px] border border-app-border bg-app-surface/60 p-2 shadow-2xl backdrop-blur-2xl ring-1 ring-white/5">
        <div className="relative flex-1">
          <Search className="absolute left-5 top-1/2 h-4 w-4 -translate-y-1/2 text-app-text-muted opacity-40" />
          <input
            type="text"
            placeholder="Trace audit: SKU, Product Name, or Notes..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-transparent py-4 pl-14 pr-4 text-sm font-black tracking-tight text-app-text outline-none focus:ring-0 placeholder:text-app-text-muted/30"
          />
        </div>
        <div className="h-10 w-px bg-app-border/20" />
        <button className="group flex items-center gap-3 rounded-[20px] bg-app-surface-2 px-6 py-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted transition-all hover:bg-app-surface-3 hover:text-app-text">
          <Calendar size={14} className="opacity-40 group-hover:opacity-100" />
          <span>Trailing 30 Days</span>
          <ChevronDown
            size={14}
            className="opacity-20 group-hover:opacity-100"
          />
        </button>
      </div>

      {/* Maintenance Audit Table */}
      <div className="overflow-hidden rounded-[40px] border border-app-border/50 bg-app-surface shadow-[0_20px_50px_rgba(0,0,0,0.1)] ring-1 ring-black/5">
        <div className="max-h-[700px] overflow-y-auto no-scrollbar">
          <table className="w-full text-left border-separate border-spacing-0">
            <thead className="sticky top-0 z-20 bg-app-surface-2/95 backdrop-blur-3xl border-b border-app-border">
              <tr className="h-16">
                <th className="px-8 border-b border-app-border/40 text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
                  Timeline
                </th>
                <th className="px-8 border-b border-app-border/40 text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
                  Canonical Product
                </th>
                <th className="px-8 border-b border-app-border/40 text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
                  Quantity
                </th>
                <th className="px-8 border-b border-app-border/40 text-[10px) font-black uppercase tracking-[0.3em] text-app-text-muted">
                  Financial Integrity
                </th>
                <th className="px-8 border-b border-app-border/40 text-[10px] font-black uppercase tracking-[0.3em] text-app-text-muted">
                  Fulfillment Attribution
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/20">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-40 text-center">
                    <div className="flex flex-col items-center gap-4">
                      <div className="h-10 w-10 border-4 border-app-accent border-b-transparent rounded-full animate-spin" />
                      <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted animate-pulse">
                        Synchronizing Ledger Data...
                      </p>
                    </div>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-40 text-center">
                    <div className="flex flex-col items-center gap-6 opacity-20 grayscale">
                      <Package size={64} />
                      <p className="text-xs font-black uppercase tracking-[0.2em] italic">
                        No historical movements in current buffer
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const qty = Math.abs(row.quantity_delta);
                  const cost = parseFloat(row.unit_cost || "0");
                  return (
                    <tr
                      key={row.id}
                      className="group transition-all duration-300 hover:bg-app-accent/[0.02]"
                    >
                      <td className="px-8 py-6 whitespace-nowrap">
                        <div className="flex flex-col">
                          <span className="font-black text-app-text leading-none">
                            {new Date(row.created_at).toLocaleDateString()}
                          </span>
                          <span className="mt-1.5 text-[10px] font-bold uppercase tracking-widest text-app-text-muted opacity-50">
                            {new Date(row.created_at).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </span>
                        </div>
                      </td>
                      <td className="px-8 py-6">
                        <div className="flex flex-col min-w-[240px]">
                          <span className="font-black text-app-text group-hover:text-app-accent transition-colors leading-tight">
                            {row.product_name}
                          </span>
                          <div className="mt-1.5 flex items-center gap-2">
                            <span className="rounded bg-app-surface-2 px-2 py-0.5 font-mono text-[11px] font-bold text-app-text-muted border border-app-border/50">
                              {row.sku}
                            </span>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40">
                              {row.brand || "Generics"}
                            </span>
                          </div>
                        </div>
                      </td>
                      <td className="px-8 py-6">
                        <div
                          className={`flex h-10 w-10 items-center justify-center rounded-xl text-sm font-black tabular-nums shadow-inner ${type === "damaged" ? "bg-red-500/10 text-red-500" : "bg-app-accent/10 text-app-accent"}`}
                        >
                          -{qty}
                        </div>
                      </td>
                      <td className="px-8 py-6">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-2">
                            <span className="font-black text-app-text tabular-nums tracking-tighter text-lg leading-none">
                              ${(qty * cost).toFixed(2)}
                            </span>
                            <ArrowUpRight
                              size={14}
                              className="opacity-20 translate-y-0.5"
                            />
                          </div>
                          <span className="mt-1 text-[10px] font-bold text-app-text-muted opacity-40 italic">
                            ${cost.toFixed(2)} base unit cost
                          </span>
                        </div>
                      </td>
                      <td className="px-8 py-6">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center gap-2">
                            <Truck size={14} className="opacity-40" />
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text truncate max-w-[150px]">
                              {row.vendor_name || "Self Discretion"}
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="h-4 w-4 rounded-full bg-app-accent/10 flex items-center justify-center text-app-accent text-[8px] font-black">
                              {row.staff_name ? row.staff_name.charAt(0) : "S"}
                            </div>
                            <span className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              {row.staff_name || "System / Auto"}
                            </span>
                          </div>
                          <p className="max-w-[180px] truncate text-[11px] font-semibold text-app-text-muted italic opacity-60">
                            "{row.notes || "No audit trail memo"}"
                          </p>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
