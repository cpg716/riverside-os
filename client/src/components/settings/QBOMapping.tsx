import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";
import { useToast } from "../ui/ToastProvider";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";

type MappingTab = "sales" | "inventory" | "expenses";

interface QboAccount {
  id: string;
  name: string;
  account_type: string | null;
  account_number: string | null;
  is_active: boolean;
}

interface LedgerMapping {
  id: string;
  internal_key: string;
  internal_description: string | null;
  qbo_account_id: string | null;
}

interface MappingRowDef {
  key: string;
  description: string;
}

const TAB_ROWS: Record<MappingTab, MappingRowDef[]> = {
  sales: [
    { key: "REVENUE_CLOTHING", description: "Suits / clothing revenue" },
    { key: "REVENUE_FOOTWEAR", description: "Footwear revenue" },
    { key: "REVENUE_SERVICE", description: "Alteration/service revenue" },
  ],
  inventory: [
    { key: "INV_ASSET", description: "Inventory asset account" },
    { key: "COGS_DEFAULT", description: "COGS default for sold goods" },
  ],
  expenses: [
    { key: "COGS_FREIGHT", description: "Inbound freight (PO)" },
    { key: "EXP_SHIPPING", description: "Shipping expense passthrough" },
    {
      key: "RMS_R2S_PAYMENT_CLEARING",
      description: "R2S payment collections (pass-through clearing / liability)",
    },
  ],
};

export default function QBOMapping() {
  const [activeTab, setActiveTab] = useState<MappingTab>("inventory");
  const [accounts, setAccounts] = useState<QboAccount[]>([]);
  const [mappings, setMappings] = useState<LedgerMapping[]>([]);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();

  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  const accountNameById = useMemo(
    () => new Map(accounts.map((a) => [a.id, a.name])),
    [accounts],
  );

  const refreshData = useCallback(async () => {
    const h = backofficeHeaders();
    const [accountsRes, mappingsRes] = await Promise.all([
      fetch(`${baseUrl}/api/qbo/accounts-cache`, { headers: h }),
      fetch(`${baseUrl}/api/qbo/mappings`, { headers: h }),
    ]);
    if (accountsRes.ok) {
      const a = (await accountsRes.json()) as QboAccount[];
      setAccounts(a);
    }
    if (mappingsRes.ok) {
      const m = (await mappingsRes.json()) as LedgerMapping[];
      setMappings(m);
      const next: Record<string, string> = {};
      for (const row of m) {
        if (row.qbo_account_id) next[row.internal_key] = row.qbo_account_id;
      }
      setSelected(next);
    }
  }, [baseUrl, backofficeHeaders]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  const handleRefreshAccounts = async () => {
    await fetch(`${baseUrl}/api/qbo/accounts-cache/refresh`, {
      method: "POST",
      headers: backofficeHeaders(),
    });
    await refreshData();
  };

  const handleSave = async (row: MappingRowDef) => {
    const accountId = selected[row.key];
    if (!accountId) return;
    setSavingKey(row.key);
    try {
      const res = await fetch(`${baseUrl}/api/qbo/mappings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({
          internal_key: row.key,
          internal_description: row.description,
          qbo_account_id: accountId,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to save mapping");
      }
      toast(`Mapping for ${row.key} saved.`, "success");
      await refreshData();
    } catch (err) {
      toast(err instanceof Error ? err.message : "Failed to save mapping", "error");
    } finally {
      setSavingKey(null);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-8">
      <div className="mb-8 flex items-end justify-between border-b border-app-border pb-6">
        <div>
          <h1 className="text-3xl font-black uppercase italic tracking-tighter text-app-text">
            Financial Mappings
          </h1>
          <p className="font-medium text-app-text-muted">
            QuickBooks Online Integration Center
          </p>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2">
            <CheckCircle2 size={16} className="text-emerald-600" />
            <span className="text-xs font-black uppercase tracking-widest text-emerald-700">
              QBO Linked
            </span>
          </div>
          <button
            type="button"
            onClick={() => void handleRefreshAccounts()}
            className="flex items-center gap-2 rounded-xl bg-app-surface-2 px-4 py-2 text-xs font-bold text-app-text-muted transition-all hover:bg-app-border/40"
          >
            <RefreshCw size={14} /> Refresh Accounts
          </button>
        </div>
      </div>

      <div className="mb-8 flex w-fit gap-1 rounded-2xl bg-app-surface-2 p-1">
        {(["sales", "inventory", "expenses"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-xl px-8 py-3 text-xs font-black uppercase tracking-widest transition-all ${
              activeTab === tab
                ? "bg-app-surface text-app-accent-2 shadow-sm"
                : "text-app-text-muted hover:text-app-text"
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-sm">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="border-b border-app-border bg-app-surface-2">
              <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Internal Category
              </th>
              <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                QuickBooks GL Account
              </th>
              <th className="px-6 py-4 text-right text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Action
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-app-border">
            {TAB_ROWS[activeTab].map((row) => {
              const mapped = mappings.find((m) => m.internal_key === row.key);
              const selectedValue = selected[row.key] ?? mapped?.qbo_account_id ?? "";
              return (
                <tr key={row.key} className="transition-colors hover:bg-app-surface-2">
                  <td className="px-6 py-6">
                    <div className="text-sm font-black uppercase text-app-text">
                      {row.key.replace(/_/g, " ")}
                    </div>
                    <p className="text-xs text-app-text-muted">{row.description}</p>
                  </td>
                  <td className="px-6 py-6">
                    <select
                      value={selectedValue}
                      onChange={(e) =>
                        setSelected((prev) => ({ ...prev, [row.key]: e.target.value }))
                      }
                      className="rounded-lg border-none bg-app-surface-2 px-4 py-2 text-sm font-bold text-app-accent-2 outline-none focus:ring-2 focus:ring-app-accent-2"
                    >
                      <option value="">Select account...</option>
                      {accounts.map((acct) => (
                        <option key={acct.id} value={acct.id}>
                          {acct.name}
                        </option>
                      ))}
                    </select>
                    {selectedValue && accountNameById.get(selectedValue) && (
                      <p className="mt-1 text-xs text-app-text-muted">
                        Active: {accountNameById.get(selectedValue)}
                      </p>
                    )}
                  </td>
                  <td className="px-6 py-6 text-right">
                    <button
                      type="button"
                      disabled={!selectedValue || savingKey === row.key}
                      onClick={() => void handleSave(row)}
                      className="text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-accent-2 disabled:opacity-40"
                    >
                      {savingKey === row.key ? "Saving..." : "Save"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8 flex items-start gap-4 rounded-2xl border border-app-accent-2/25 bg-app-accent-2/10 p-4">
        <AlertCircle className="shrink-0 text-app-accent-2" size={20} />
        <div>
          <p className="mb-1 text-xs font-bold uppercase tracking-widest text-app-text">
            Accounting Note
          </p>
          <p className="text-xs leading-relaxed text-app-accent-2">
            Ensure your inventory asset account is classified as Other Current
            Asset. Inbound freight is intentionally mapped separately to support
            true landed-cost reporting.
          </p>
        </div>
      </div>
    </div>
  );
}
