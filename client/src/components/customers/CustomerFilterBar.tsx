import React from "react";
import { Search, UserPlus, Upload, Activity, X as CloseIcon } from "lucide-react";
import WeddingPartySearchInput from "../ui/WeddingPartySearchInput";
import { CustomerGroup } from "./CustomerWorkspaceTypes";

interface CustomerFilterBarProps {
  q: string;
  setQ: (v: string) => void;
  weddingPartyQuery: string;
  setWeddingPartyQuery: (v: string) => void;
  vipOnly: boolean;
  setVipOnly: (v: boolean) => void;
  balanceDueOnly: boolean;
  setBalanceDueOnly: (v: boolean) => void;
  weddingSoonOnly: boolean;
  setWeddingSoonOnly: (v: boolean) => void;
  groupFilterCode: string;
  setGroupFilterCode: (v: string) => void;
  customerGroups: CustomerGroup[];
  loading: boolean;
  refresh: () => void;
  onPickImportFile: () => void;
  onShowAddDrawer: () => void;
  onImportFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  importFileRef: React.RefObject<HTMLInputElement | null>;
  totalCount: number;
}

export default function CustomerFilterBar({
  q,
  setQ,
  weddingPartyQuery,
  setWeddingPartyQuery,
  vipOnly,
  setVipOnly,
  balanceDueOnly,
  setBalanceDueOnly,
  weddingSoonOnly,
  setWeddingSoonOnly,
  groupFilterCode,
  setGroupFilterCode,
  customerGroups,
  loading,
  refresh,
  onPickImportFile,
  onShowAddDrawer,
  onImportFileChange,
  importFileRef,
  totalCount,
}: CustomerFilterBarProps) {
  const filterChip = (
    active: boolean,
    label: string,
    onClick: () => void,
    onRemove?: () => void,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest transition-colors ${
        active
          ? "ui-control-chip ui-control-chip-active shadow-sm"
          : "ui-control-chip"
      }`}
    >
      {label}
      {active && onRemove ? (
        <span
          role="presentation"
          onClick={(ev) => {
            ev.stopPropagation();
            onRemove();
          }}
          className="rounded-full bg-app-surface px-1 text-[9px] text-app-text-muted"
        >
          ×
        </span>
      ) : null}
    </button>
  );

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-4 border-b border-app-border bg-app-surface-2/30 px-5 py-4 backdrop-blur-xl">
        <div className="relative group min-w-[300px] flex-1">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted group-focus-within:text-app-accent transition-colors"
            size={16}
          />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, code, company, contact..."
            className="ui-input w-full pl-10 text-sm font-bold bg-white/50 backdrop-blur-sm border-app-border focus:border-app-accent shadow-sm"
          />
        </div>

        <div className="flex items-center gap-2">
          <div className="relative group w-64">
            {weddingPartyQuery ? (
              <div className="flex h-9 items-center justify-between rounded-xl border border-app-accent bg-app-accent/5 px-3">
                <span className="truncate text-[10px] font-black uppercase tracking-widest text-app-accent">
                  Party: {weddingPartyQuery}
                </span>
                <button
                  type="button"
                  onClick={() => setWeddingPartyQuery("")}
                  className="ml-2 text-app-accent hover:text-black"
                >
                  <CloseIcon size={12} />
                </button>
              </div>
            ) : (
              <WeddingPartySearchInput
                placeholder="Filter by party…"
                onSelect={(p) =>
                  setWeddingPartyQuery(p.party_name || p.groom_name)
                }
              />
            )}
          </div>

          <button
            type="button"
            onClick={onShowAddDrawer}
            className="flex items-center gap-2 rounded-xl bg-app-accent px-4 py-2 text-xs font-black uppercase tracking-tight text-white shadow-lg shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95"
          >
            <UserPlus size={16} />
            Add Customer
          </button>

          <button
            type="button"
            onClick={onPickImportFile}
            className="flex items-center justify-center rounded-xl bg-app-surface-2 p-2.5 text-app-text-muted border border-app-border hover:bg-app-surface transition-colors"
            title="Import CSV"
          >
            <Upload size={18} />
          </button>
          <input
            type="file"
            ref={importFileRef}
            className="hidden"
            accept=".csv"
            onChange={onImportFileChange}
          />

          <button
            type="button"
            onClick={refresh}
            className={`flex items-center justify-center rounded-xl bg-app-surface-2 p-2.5 text-app-text-muted border border-app-border hover:bg-app-surface transition-colors ${loading ? "animate-spin" : ""}`}
          >
            <Activity size={18} />
          </button>
        </div>
      </div>

      <div className="flex shrink-0 items-center justify-between border-b border-app-border/50 bg-app-surface/40 px-5 py-2.5 backdrop-blur-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-50 mr-2">
            Quick Filters
          </span>
          {filterChip(
            vipOnly,
            "VIP only",
            () => setVipOnly(!vipOnly),
            () => setVipOnly(false),
          )}
          {filterChip(
            balanceDueOnly,
            "Balance due",
            () => setBalanceDueOnly(!balanceDueOnly),
            () => setBalanceDueOnly(false),
          )}
          {filterChip(
            weddingSoonOnly,
            "Upcoming Wedding",
            () => setWeddingSoonOnly(!weddingSoonOnly),
            () => setWeddingSoonOnly(false),
          )}

          <div className="h-4 w-[1px] bg-app-border/40 mx-2" />

          <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-80">
            Segment
            <select
              value={groupFilterCode}
              onChange={(e) => setGroupFilterCode(e.target.value)}
              className="ui-input max-w-[140px] appearance-none py-1 text-xs font-black bg-transparent border-none text-app-accent underline underline-offset-4"
            >
              <option value="">All Groups</option>
              {customerGroups.map((g) => (
                <option key={g.id} value={g.code}>
                  {g.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-40">
          {totalCount} records detected
        </div>
      </div>
    </>
  );
}
