import { useEffect, useState } from "react";
import { Info, Settings2, ShieldCheck } from "lucide-react";
import type {
  AccountMapping,
  QboMatrixAccount,
} from "./QboMappingLogic";

export interface QboMappingMatrixProps {
  categories: { id: string; name: string }[];
  customTypes: readonly { id: string; label: string }[];
  tenders: readonly { id: string; label: string }[];
  accounts: QboMatrixAccount[];
  initialMappings: Record<string, AccountMapping>;
  onSave: (mappings: Record<string, AccountMapping>) => Promise<void>;
}

function AccountSelect({
  valueId,
  accounts,
  onPick,
  placeholder,
}: {
  valueId: string;
  accounts: QboMatrixAccount[];
  onPick: (id: string, name: string) => void;
  placeholder: string;
}) {
  return (
    <select
      value={valueId}
      onChange={(e) => {
        const id = e.target.value;
        if (!id) {
          onPick("", "");
          return;
        }
        const name = accounts.find((a) => a.id === id)?.name ?? id;
        onPick(id, name);
      }}
      className="ui-input w-full min-w-[10rem] max-w-full px-3 py-2 text-xs font-semibold focus:ring-2 focus:ring-app-accent-2/25"
    >
      <option value="">{placeholder}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </select>
  );
}

export default function QboMappingMatrix({
  categories,
  customTypes,
  tenders,
  accounts,
  initialMappings,
  onSave,
}: QboMappingMatrixProps) {
  const [mappings, setMappings] = useState<Record<string, AccountMapping>>(
    initialMappings,
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMappings(initialMappings);
  }, [initialMappings]);

  const updateMapping = (key: string, qboId: string, qboName: string) => {
    setMappings((prev) => {
      const next = { ...prev };
      if (!qboId) {
        delete next[key];
        return next;
      }
      next[key] = {
        ros_id: key,
        qbo_account_id: qboId,
        qbo_account_name: qboName,
      };
      return next;
    });
  };

  return (
    <div className="space-y-8">
      <section className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 px-5 py-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Category mappings
            </h3>
            <p className="mt-1 text-[10px] font-bold uppercase text-app-text-muted">
              Revenue, inventory asset, and COGS per ROS category
            </p>
          </div>
          <Settings2 size={18} className="text-app-text-muted" aria-hidden />
        </div>

        <div className="w-full min-w-0 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm md:min-w-[640px] xl:min-w-[720px]">
            <thead className="border-b border-app-border bg-app-surface-2/50 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-5 py-3">Category</th>
                <th className="px-5 py-3">Revenue (income)</th>
                <th className="px-5 py-3">Inventory (asset)</th>
                <th className="px-5 py-3">COGS (expense)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {categories.map((cat) => (
                <tr
                  key={cat.id}
                  className="transition-colors hover:bg-app-surface-2/30"
                >
                  <td className="px-5 py-4 font-bold text-app-text">
                    {cat.name}
                  </td>
                  <td className="px-5 py-4">
                    <AccountSelect
                      valueId={mappings[`rev_${cat.id}`]?.qbo_account_id ?? ""}
                      accounts={accounts}
                      onPick={(id, name) => updateMapping(`rev_${cat.id}`, id, name)}
                      placeholder="e.g. 4010 Sales"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <AccountSelect
                      valueId={mappings[`inv_${cat.id}`]?.qbo_account_id ?? ""}
                      accounts={accounts}
                      onPick={(id, name) => updateMapping(`inv_${cat.id}`, id, name)}
                      placeholder="e.g. 1200 Inventory"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <AccountSelect
                      valueId={mappings[`cogs_${cat.id}`]?.qbo_account_id ?? ""}
                      accounts={accounts}
                      onPick={(id, name) =>
                        updateMapping(`cogs_${cat.id}`, id, name)
                      }
                      placeholder="e.g. 5000 COGS"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2 px-5 py-4">
          <div>
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Custom garment mappings
            </h3>
            <p className="mt-1 text-[10px] font-bold uppercase text-app-text-muted">
              Optional overrides for Custom order revenue, inventory, and COGS by garment type
            </p>
          </div>
          <ShieldCheck size={18} className="text-app-text-muted" aria-hidden />
        </div>

        <div className="w-full min-w-0 overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-sm md:min-w-[640px] xl:min-w-[720px]">
            <thead className="border-b border-app-border bg-app-surface-2/50 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-5 py-3">Custom type</th>
                <th className="px-5 py-3">Revenue (income)</th>
                <th className="px-5 py-3">Inventory (asset)</th>
                <th className="px-5 py-3">COGS (expense)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {customTypes.map((customType) => (
                <tr
                  key={customType.id}
                  className="transition-colors hover:bg-app-surface-2/30"
                >
                  <td className="px-5 py-4 font-bold text-app-text">
                    {customType.label}
                  </td>
                  <td className="px-5 py-4">
                    <AccountSelect
                      valueId={mappings[`custom_rev_${customType.id}`]?.qbo_account_id ?? ""}
                      accounts={accounts}
                      onPick={(id, name) =>
                        updateMapping(`custom_rev_${customType.id}`, id, name)
                      }
                      placeholder="Optional custom revenue account"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <AccountSelect
                      valueId={mappings[`custom_inv_${customType.id}`]?.qbo_account_id ?? ""}
                      accounts={accounts}
                      onPick={(id, name) =>
                        updateMapping(`custom_inv_${customType.id}`, id, name)
                      }
                      placeholder="Optional custom inventory account"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <AccountSelect
                      valueId={mappings[`custom_cogs_${customType.id}`]?.qbo_account_id ?? ""}
                      accounts={accounts}
                      onPick={(id, name) =>
                        updateMapping(`custom_cogs_${customType.id}`, id, name)
                      }
                      placeholder="Optional custom COGS account"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <section className="rounded-2xl border border-app-border bg-app-surface shadow-sm">
          <div className="border-b border-app-border px-5 py-4">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Payment (tender) mapping
            </h3>
            <p className="mt-1 text-[10px] font-bold uppercase text-app-text-muted">
              Cash, card clearing, AR — gift card redemptions debit liability when
              mapped (see journal logic)
            </p>
          </div>
          <div className="space-y-4 p-5">
            {tenders.map((t) => (
              <div key={t.id} className="flex flex-col gap-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {t.label}
                </label>
                <AccountSelect
                  valueId={mappings[`tender_${t.id}`]?.qbo_account_id ?? ""}
                  accounts={accounts}
                  onPick={(id, name) =>
                    updateMapping(`tender_${t.id}`, id, name)
                  }
                  placeholder="Select QBO account"
                />
              </div>
            ))}
          </div>
        </section>

        <section className="rounded-2xl border border-app-border bg-app-surface shadow-sm">
          <div className="border-b border-app-border px-5 py-4">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Clearing, tax &amp; liabilities
            </h3>
          </div>
          <div className="space-y-4 p-5">
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Sales tax payable
                <Info size={12} className="text-app-accent-2" aria-hidden />
              </label>
              <AccountSelect
                valueId={mappings.tax_sales?.qbo_account_id ?? ""}
                accounts={accounts}
                onPick={(id, name) => updateMapping("tax_sales", id, name)}
                placeholder="2100 · Sales tax payable"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Customer deposit holding
                <Info size={12} className="text-app-accent-2" aria-hidden />
              </label>
              <AccountSelect
                valueId={mappings.deposit_holding?.qbo_account_id ?? ""}
                accounts={accounts}
                onPick={(id, name) =>
                  updateMapping("deposit_holding", id, name)
                }
                placeholder="2050 · Customer deposits"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Gift card liability
                <Info size={12} className="text-app-accent-2" aria-hidden />
              </label>
              <AccountSelect
                valueId={mappings.gc_liability?.qbo_account_id ?? ""}
                accounts={accounts}
                onPick={(id, name) => updateMapping("gc_liability", id, name)}
                placeholder="2110 · Gift card liability"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                GC marketing / loyalty expense
              </label>
              <AccountSelect
                valueId={mappings.gc_marketing?.qbo_account_id ?? ""}
                accounts={accounts}
                onPick={(id, name) => updateMapping("gc_marketing", id, name)}
                placeholder="6200 · Marketing expense"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Inventory invoice holding
              </label>
              <AccountSelect
                valueId={mappings.invoice_holding?.qbo_account_id ?? ""}
                accounts={accounts}
                onPick={(id, name) =>
                  updateMapping("invoice_holding", id, name)
                }
                placeholder="2040 · Accrued vendor invoice"
              />
            </div>
          </div>
        </section>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 rounded-2xl border border-dashed border-app-input-border bg-app-surface-2 p-4">
        <p className="max-w-md text-right text-xs text-app-text-muted">
          Changes apply to Daily Journal Staging. Nothing posts to QuickBooks
          until you approve and send the daily summary.
        </p>
        <button
          type="button"
          onClick={() => {
            setBusy(true);
            void onSave(mappings).finally(() => setBusy(false));
          }}
          disabled={busy}
          className="flex items-center gap-2 rounded-xl bg-app-accent px-6 py-3 text-sm font-black uppercase tracking-widest text-white transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
        >
          <ShieldCheck size={18} aria-hidden />
          {busy ? "Saving…" : "Save mappings"}
        </button>
      </div>
    </div>
  );
}
