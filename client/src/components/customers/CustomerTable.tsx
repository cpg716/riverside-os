import { Gem, Wallet, Heart, MoreHorizontal, UserCheck, ShieldCheck, Mail, Phone, ExternalLink } from "lucide-react";
import { CustomerBrowseRow } from "./CustomerWorkspaceTypes";

interface CustomerTableProps {
  rows: CustomerBrowseRow[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string, shift: boolean) => void;
  onSelectAll: () => void;
  onOpenCustomer: (id: string) => void;
  onOpenTransaction: (id: string) => void;
  onOpenShipment: (id: string) => void;
}

export default function CustomerTable({
  rows,
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onOpenCustomer,
  onOpenTransaction,
  onOpenShipment,
}: CustomerTableProps) {
  return (
    <div className="flex-1 overflow-auto no-scrollbar pb-24">
      <table className="w-full border-separate border-spacing-0">
        <thead className="sticky top-0 z-10 bg-app-surface/80 backdrop-blur-md">
          <tr className="border-b border-app-border">
            <th className="w-12 px-4 py-3 border-b border-app-border">
              <input
                type="checkbox"
                checked={rows.length > 0 && selectedIds.size === rows.length}
                onChange={onSelectAll}
                className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
              />
            </th>
            <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">
              Code / Flags
            </th>
            <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">
              Customer Details
            </th>
            <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">
              Financial Status
            </th>
            <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">
              Registry / Ops
            </th>
            <th className="px-4 py-3 text-right text-[10px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const isSelected = selectedIds.has(r.id);
            return (
              <tr
                key={r.id}
                onClick={() => onOpenCustomer(r.id)}
                className={`group cursor-pointer border-b border-app-border transition-all hover:bg-app-accent/[0.03] ${
                  isSelected ? "bg-app-accent/[0.05]" : ""
                }`}
              >
                <td
                  className="px-4 py-4 text-center border-b border-app-border/40"
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleSelect(r.id, e.shiftKey);
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {}}
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                </td>
                <td className="px-4 py-4 border-b border-app-border/40">
                  <div className="flex flex-col gap-1.5">
                    <span className="font-mono text-xs font-black tracking-tighter text-app-text">
                      {r.customer_code}
                    </span>
                    <div className="flex gap-1.5">
                      {r.is_vip && (
                        <div
                          title="VIP Premium"
                          className="h-5 w-5 flex items-center justify-center rounded-lg bg-amber-500/10 text-amber-500 border border-amber-500/20"
                        >
                          <Gem size={12} />
                        </div>
                      )}
                      {Number(r.open_balance_due) > 0 && (
                        <div
                          title="Balance Due"
                          className="h-5 w-5 flex items-center justify-center rounded-lg bg-rose-500/10 text-rose-500 border border-rose-500/20"
                        >
                          <Wallet size={12} />
                        </div>
                      )}
                      {r.wedding_soon && (
                        <div
                          title="Upcoming Wedding"
                          className="h-5 w-5 flex items-center justify-center rounded-lg bg-pink-500/10 text-pink-500 border border-pink-500/20"
                        >
                          <Heart size={12} />
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4 border-b border-app-border/40">
                  <div className="flex flex-col">
                    <p className="text-base font-black italic tracking-tighter text-app-text transition-colors group-hover:text-app-accent">
                      {r.first_name} {r.last_name}
                    </p>
                    {r.company_name && (
                      <p className="text-[11px] font-bold text-app-text-muted uppercase tracking-tight opacity-70">
                        {r.company_name}
                      </p>
                    )}
                    <div className="mt-1.5 flex items-center gap-3 opacity-60 group-hover:opacity-100 transition-opacity">
                      {r.email && (
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-app-text-muted">
                          <Mail size={12} className="text-app-accent" />
                          {r.email}
                        </div>
                      )}
                      {r.phone && (
                        <div className="flex items-center gap-1.5 text-[10px] font-bold text-app-text-muted">
                          <Phone size={12} className="text-app-accent" />
                          {r.phone}
                        </div>
                      )}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4 border-b border-app-border/40">
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center justify-between gap-4 border-b border-app-border/20 pb-1">
                      <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
                        Lifetime
                      </span>
                      <span className="text-xs font-black text-app-text italic">
                        ${r.lifetime_sales}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
                        Balance
                      </span>
                      <span
                        className={`text-xs font-black italic ${Number(r.open_balance_due) > 0 ? "text-rose-500" : "text-emerald-500"}`}
                      >
                        ${r.open_balance_due}
                      </span>
                    </div>
                  </div>
                </td>
                <td className="px-4 py-4 border-b border-app-border/40">
                  <div className="flex flex-col gap-1.5">
                    {r.wedding_party_name ? (
                      <div className="inline-flex items-center gap-2 rounded-lg bg-indigo-500/5 px-2.5 py-1 border border-indigo-500/10">
                        <UserCheck size={12} className="text-indigo-500" />
                        <span className="text-[10px] font-black italic tracking-tight text-indigo-700 dark:text-indigo-300">
                          {r.wedding_party_name}
                        </span>
                      </div>
                    ) : (
                      <div className="inline-flex items-center gap-2 rounded-lg bg-app-surface-2 px-2.5 py-1 border border-app-border opacity-40">
                        <ShieldCheck size={12} />
                        <span className="text-[10px] font-black uppercase tracking-widest">
                          Retail Only
                        </span>
                      </div>
                    )}

                    {r.active_shipment_status && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenShipment(r.id);
                        }}
                        className="inline-flex items-center gap-2 rounded-lg bg-app-accent/10 px-2.5 py-1 border border-app-accent/20 cursor-pointer hover:bg-app-accent/20"
                      >
                        <Activity size={12} className="text-app-accent" />
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">
                          {r.active_shipment_status}
                        </span>
                      </div>
                    )}
                  </div>
                </td>
                <td className="px-4 py-4 text-right border-b border-app-border/40">
                  <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onOpenTransaction(r.id);
                      }}
                      className="h-8 w-8 flex items-center justify-center rounded-xl bg-app-surface-2 border border-app-border text-app-text-muted hover:text-app-accent hover:border-app-accent transition-all active:scale-95"
                      title="View Transactions"
                    >
                      <ExternalLink size={14} />
                    </button>
                    <button
                      className="h-8 w-8 flex items-center justify-center rounded-xl bg-app-surface-2 border border-app-border text-app-text-muted hover:text-app-text transition-all active:scale-95"
                      title="More Actions"
                    >
                      <MoreHorizontal size={14} />
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Activity({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  );
}
