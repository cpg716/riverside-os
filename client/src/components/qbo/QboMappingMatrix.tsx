import { useEffect, useState } from "react";
import { Info, Settings2, ShieldCheck } from "lucide-react";
import type {
  AccountMapping,
  QboMatrixAccount,
  RosGlAccount,
} from "./QboMappingLogic";
import { QBO_MATRIX_FINANCIAL_ACCOUNTS } from "./QboMappingLogic";

export interface QboMappingMatrixProps {
  categories: { id: string; name: string }[];
  customTypes: readonly { id: string; label: string }[];
  tenders: readonly { id: string; label: string }[];
  accounts: QboMatrixAccount[];
  rosAccounts: RosGlAccount[];
  initialMappings: Record<string, AccountMapping>;
  onSave: (mappings: Record<string, AccountMapping>) => Promise<void>;
}

function QboAccountSelect({
  valueId,
  accounts,
  onPick,
  placeholder,
  ariaLabel,
}: {
  valueId: string;
  accounts: QboMatrixAccount[];
  onPick: (id: string, name: string) => void;
  placeholder: string;
  ariaLabel: string;
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
      aria-label={ariaLabel}
      className="ui-input w-full min-w-[10rem] max-w-full px-3 py-2 text-xs font-semibold focus:ring-2 focus:ring-app-accent-2/25"
    >
      <option value="">{placeholder}</option>
      {accounts.map((a) => (
        <option key={a.id} value={a.id}>
          {a.account_number ? `${a.account_number} · ${a.name}` : `No GL# · ${a.name}`}
        </option>
      ))}
    </select>
  );
}

function RosAccountSelect({
  value,
  accounts,
  onPick,
  ariaLabel,
}: {
  value: string;
  accounts: RosGlAccount[];
  onPick: (accountNumber: string) => void;
  ariaLabel: string;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onPick(event.target.value)}
      aria-label={ariaLabel}
      className="ui-input w-full min-w-[10rem] max-w-full px-3 py-2 text-xs font-semibold focus:ring-2 focus:ring-app-accent-2/25"
    >
      <option value="">Select ROS GL#</option>
      {accounts.map((account) => (
        <option
          key={account.account_number}
          value={account.account_number}
          disabled={account.account_type === "Non-Posting"}
        >
          {account.account_number} · {account.account_name}
          {account.account_type === "Non-Posting" ? " (non-posting)" : ""}
        </option>
      ))}
    </select>
  );
}

function MappingPair({
  label,
  mapping,
  rosAccounts,
  qboAccounts,
  qboPlaceholder,
  onRosPick,
  onQboPick,
}: {
  label: string;
  mapping: AccountMapping | undefined;
  rosAccounts: RosGlAccount[];
  qboAccounts: QboMatrixAccount[];
  qboPlaceholder: string;
  onRosPick: (accountNumber: string) => void;
  onQboPick: (id: string, name: string) => void;
}) {
  const qboAccount = qboAccounts.find(
    (account) => account.id === mapping?.qbo_account_id,
  );
  const rosNumber = mapping?.ros_gl_account_number ?? "";
  const qboNumber = qboAccount?.account_number?.trim() ?? "";
  const hasBothAccounts = Boolean(rosNumber && mapping?.qbo_account_id);
  const numbersMatch = Boolean(hasBothAccounts && qboNumber === rosNumber);

  return (
    <div className="min-w-[12rem] space-y-2">
      <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
        ROS GL#
      </label>
      <RosAccountSelect
        value={rosNumber}
        accounts={rosAccounts}
        onPick={onRosPick}
        ariaLabel={`${label} ROS GL number`}
      />
      <label className="block text-[9px] font-black uppercase tracking-widest text-app-text-muted">
        QBO GL#
      </label>
      <QboAccountSelect
        valueId={mapping?.qbo_account_id ?? ""}
        accounts={qboAccounts}
        onPick={onQboPick}
        placeholder={qboPlaceholder}
        ariaLabel={`${label} QBO GL number`}
      />
      {hasBothAccounts ? (
        <p
          className={`text-[10px] font-bold ${
            numbersMatch ? "text-emerald-700" : "text-amber-700"
          }`}
        >
          {numbersMatch
            ? `GL# match · ${rosNumber}`
            : qboNumber
              ? `Review · ROS ${rosNumber} / QBO ${qboNumber}`
              : `Review · QBO account has no GL#`}
        </p>
      ) : (
        <p className="text-[10px] font-semibold text-app-text-muted">
          Select both sides to verify the GL# crosswalk.
        </p>
      )}
    </div>
  );
}

export default function QboMappingMatrix({
  categories,
  customTypes,
  tenders,
  accounts,
  rosAccounts,
  initialMappings,
  onSave,
}: QboMappingMatrixProps) {
  const [mappings, setMappings] =
    useState<Record<string, AccountMapping>>(initialMappings);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMappings(initialMappings);
  }, [initialMappings]);

  const updateMapping = (
    key: string,
    updates: Partial<Omit<AccountMapping, "ros_id">>,
  ) => {
    setMappings((prev) => {
      const current = prev[key] ?? {
        ros_id: key,
        ros_gl_account_number: "",
        qbo_account_id: "",
        qbo_account_name: "",
      };
      const updated = { ...current, ...updates };
      const next = { ...prev };
      if (!updated.ros_gl_account_number && !updated.qbo_account_id) {
        delete next[key];
        return next;
      }
      next[key] = updated;
      return next;
    });
  };

  return (
    <div className="space-y-8">
      <div className="rounded-2xl border border-app-accent/20 bg-app-accent/5 px-5 py-4">
        <p className="text-sm font-black text-app-text">ROS GL# ↔ QBO GL# review</p>
        <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text-muted">
          ROS GL# comes from Riverside&apos;s approved account list. QBO GL# comes from the live
          QuickBooks connection and remains the posting destination. A matching badge confirms the
          numbers agree; a review badge asks accounting to verify the crosswalk before staging.
        </p>
      </div>
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
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-app-border bg-app-surface-2/50 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-5 py-3">Category</th>
                <th className="px-5 py-3">Revenue GL mapping</th>
                <th className="px-5 py-3">Inventory GL mapping</th>
                <th className="px-5 py-3">COGS GL mapping</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {categories.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-5 py-5 text-xs font-semibold text-app-text-muted"
                  >
                    No Riverside categories loaded. Refresh the page after
                    Inventory categories are synced or created; category-level
                    revenue, inventory, and COGS mappings appear here.
                  </td>
                </tr>
              ) : (
                categories.map((cat) => (
                  <tr
                    key={cat.id}
                    className="transition-colors hover:bg-app-surface-2/30"
                  >
                    <td className="px-5 py-4 font-bold text-app-text">
                      {cat.name}
                    </td>
                    <td className="px-5 py-4">
                      <MappingPair
                        label={`${cat.name} revenue`}
                        mapping={mappings[`rev_${cat.id}`]}
                        rosAccounts={rosAccounts}
                        qboAccounts={accounts}
                        onRosPick={(accountNumber) =>
                          updateMapping(`rev_${cat.id}`, {
                            ros_gl_account_number: accountNumber,
                          })
                        }
                        onQboPick={(id, name) =>
                          updateMapping(`rev_${cat.id}`, {
                            qbo_account_id: id,
                            qbo_account_name: name,
                          })
                        }
                        qboPlaceholder="Select QBO revenue account"
                      />
                    </td>
                    <td className="px-5 py-4">
                      <MappingPair
                        label={`${cat.name} inventory`}
                        mapping={mappings[`inv_${cat.id}`]}
                        rosAccounts={rosAccounts}
                        qboAccounts={accounts}
                        onRosPick={(accountNumber) =>
                          updateMapping(`inv_${cat.id}`, {
                            ros_gl_account_number: accountNumber,
                          })
                        }
                        onQboPick={(id, name) =>
                          updateMapping(`inv_${cat.id}`, {
                            qbo_account_id: id,
                            qbo_account_name: name,
                          })
                        }
                        qboPlaceholder="Select QBO inventory account"
                      />
                    </td>
                    <td className="px-5 py-4">
                      <MappingPair
                        label={`${cat.name} COGS`}
                        mapping={mappings[`cogs_${cat.id}`]}
                        rosAccounts={rosAccounts}
                        qboAccounts={accounts}
                        onRosPick={(accountNumber) =>
                          updateMapping(`cogs_${cat.id}`, {
                            ros_gl_account_number: accountNumber,
                          })
                        }
                        onQboPick={(id, name) =>
                          updateMapping(`cogs_${cat.id}`, {
                            qbo_account_id: id,
                            qbo_account_name: name,
                          })
                        }
                        qboPlaceholder="Select QBO COGS account"
                      />
                    </td>
                  </tr>
                ))
              )}
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
              Optional overrides for Custom order revenue, inventory, and COGS
              by garment type
            </p>
          </div>
          <ShieldCheck size={18} className="text-app-text-muted" aria-hidden />
        </div>

        <div className="w-full min-w-0 overflow-x-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="border-b border-app-border bg-app-surface-2/50 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-5 py-3">Custom type</th>
                <th className="px-5 py-3">Revenue GL mapping</th>
                <th className="px-5 py-3">Inventory GL mapping</th>
                <th className="px-5 py-3">COGS GL mapping</th>
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
                    <MappingPair
                      label={`${customType.label} revenue`}
                      mapping={mappings[`custom_rev_${customType.id}`]}
                      rosAccounts={rosAccounts}
                      qboAccounts={accounts}
                      onRosPick={(accountNumber) =>
                        updateMapping(`custom_rev_${customType.id}`, {
                          ros_gl_account_number: accountNumber,
                        })
                      }
                      onQboPick={(id, name) =>
                        updateMapping(`custom_rev_${customType.id}`, {
                          qbo_account_id: id,
                          qbo_account_name: name,
                        })
                      }
                      qboPlaceholder="Optional QBO custom revenue account"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <MappingPair
                      label={`${customType.label} inventory`}
                      mapping={mappings[`custom_inv_${customType.id}`]}
                      rosAccounts={rosAccounts}
                      qboAccounts={accounts}
                      onRosPick={(accountNumber) =>
                        updateMapping(`custom_inv_${customType.id}`, {
                          ros_gl_account_number: accountNumber,
                        })
                      }
                      onQboPick={(id, name) =>
                        updateMapping(`custom_inv_${customType.id}`, {
                          qbo_account_id: id,
                          qbo_account_name: name,
                        })
                      }
                      qboPlaceholder="Optional QBO custom inventory account"
                    />
                  </td>
                  <td className="px-5 py-4">
                    <MappingPair
                      label={`${customType.label} COGS`}
                      mapping={mappings[`custom_cogs_${customType.id}`]}
                      rosAccounts={rosAccounts}
                      qboAccounts={accounts}
                      onRosPick={(accountNumber) =>
                        updateMapping(`custom_cogs_${customType.id}`, {
                          ros_gl_account_number: accountNumber,
                        })
                      }
                      onQboPick={(id, name) =>
                        updateMapping(`custom_cogs_${customType.id}`, {
                          qbo_account_id: id,
                          qbo_account_name: name,
                        })
                      }
                      qboPlaceholder="Optional QBO custom COGS account"
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
              Cash, card clearing, AR — gift card redemptions debit liability
              when mapped (see journal logic)
            </p>
          </div>
          <div className="space-y-4 p-5">
            {tenders.map((t) => (
              <div key={t.id} className="flex flex-col gap-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {t.label}
                </label>
                <MappingPair
                  label={t.label}
                  mapping={mappings[`tender_${t.id}`]}
                  rosAccounts={rosAccounts}
                  qboAccounts={accounts}
                  onRosPick={(accountNumber) =>
                    updateMapping(`tender_${t.id}`, {
                      ros_gl_account_number: accountNumber,
                    })
                  }
                  onQboPick={(id, name) =>
                    updateMapping(`tender_${t.id}`, {
                      qbo_account_id: id,
                      qbo_account_name: name,
                    })
                  }
                  qboPlaceholder="Select QBO GL#"
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
              <MappingPair
                label="Sales tax payable"
                mapping={mappings.tax_sales}
                rosAccounts={rosAccounts}
                qboAccounts={accounts}
                onRosPick={(accountNumber) =>
                  updateMapping("tax_sales", {
                    ros_gl_account_number: accountNumber,
                  })
                }
                onQboPick={(id, name) =>
                  updateMapping("tax_sales", {
                    qbo_account_id: id,
                    qbo_account_name: name,
                  })
                }
                qboPlaceholder="Select QBO sales-tax account"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Customer deposit holding
                <Info size={12} className="text-app-accent-2" aria-hidden />
              </label>
              <MappingPair
                label="Customer deposit holding"
                mapping={mappings.deposit_holding}
                rosAccounts={rosAccounts}
                qboAccounts={accounts}
                onRosPick={(accountNumber) =>
                  updateMapping("deposit_holding", {
                    ros_gl_account_number: accountNumber,
                  })
                }
                onQboPick={(id, name) =>
                  updateMapping("deposit_holding", {
                    qbo_account_id: id,
                    qbo_account_name: name,
                  })
                }
                qboPlaceholder="Select QBO deposit liability"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Gift card liability
                <Info size={12} className="text-app-accent-2" aria-hidden />
              </label>
              <MappingPair
                label="Gift card liability"
                mapping={mappings.gc_liability}
                rosAccounts={rosAccounts}
                qboAccounts={accounts}
                onRosPick={(accountNumber) =>
                  updateMapping("gc_liability", {
                    ros_gl_account_number: accountNumber,
                  })
                }
                onQboPick={(id, name) =>
                  updateMapping("gc_liability", {
                    qbo_account_id: id,
                    qbo_account_name: name,
                  })
                }
                qboPlaceholder="Select QBO gift-card liability"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Loyalty / promo gift card expense
              </label>
              <MappingPair
                label="Loyalty or promo gift card expense"
                mapping={mappings.gc_marketing}
                rosAccounts={rosAccounts}
                qboAccounts={accounts}
                onRosPick={(accountNumber) =>
                  updateMapping("gc_marketing", {
                    ros_gl_account_number: accountNumber,
                  })
                }
                onQboPick={(id, name) =>
                  updateMapping("gc_marketing", {
                    qbo_account_id: id,
                    qbo_account_name: name,
                  })
                }
                qboPlaceholder="Select QBO marketing expense"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Donated gift card expense
              </label>
              <MappingPair
                label="Donated gift card expense"
                mapping={mappings.gc_donated}
                rosAccounts={rosAccounts}
                qboAccounts={accounts}
                onRosPick={(accountNumber) =>
                  updateMapping("gc_donated", {
                    ros_gl_account_number: accountNumber,
                  })
                }
                onQboPick={(id, name) =>
                  updateMapping("gc_donated", {
                    qbo_account_id: id,
                    qbo_account_name: name,
                  })
                }
                qboPlaceholder="Select QBO charitable expense"
              />
            </div>
            <div className="border-t border-app-border pt-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Operational income & liability accounts
              </p>
            </div>
            {QBO_MATRIX_FINANCIAL_ACCOUNTS.map((row) => (
              <div key={row.key} className="flex flex-col gap-1">
                <label className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {row.label}
                  <Info size={12} className="text-app-accent-2" aria-hidden />
                </label>
                <p className="text-[10px] font-semibold text-app-text-muted">
                  {row.help}
                </p>
                <MappingPair
                  label={row.label}
                  mapping={mappings[row.key]}
                  rosAccounts={rosAccounts}
                  qboAccounts={accounts}
                  onRosPick={(accountNumber) =>
                    updateMapping(row.key, {
                      ros_gl_account_number: accountNumber,
                    })
                  }
                  onQboPick={(id, name) =>
                    updateMapping(row.key, {
                      qbo_account_id: id,
                      qbo_account_name: name,
                    })
                  }
                  qboPlaceholder={row.placeholder}
                />
              </div>
            ))}
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
