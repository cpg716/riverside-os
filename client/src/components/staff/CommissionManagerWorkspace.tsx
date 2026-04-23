import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useCallback, useEffect, useMemo } from "react";
import {
  Percent,
  Receipt,
  Zap,
  Settings,
  Plus,
  Trash2,
  Layers,
  X,
} from "lucide-react";
import CommissionPayoutsPanel from "./CommissionPayoutsPanel";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ComboEditorModal from "./ComboEditorModal";
import ConfirmationModal from "../ui/ConfirmationModal";

const baseUrl = getBaseUrl();

const DNA = {
  bg: "bg-app-bg",
  surface: "bg-app-surface border-app-border",
  accent: "text-emerald-600 dark:text-emerald-400",
  accentBg: "bg-emerald-600 dark:bg-emerald-500",
  muted: "text-app-text-muted",
  heading: "text-[10px] font-black uppercase tracking-widest text-app-text-muted",
};

type TabId = "payouts" | "rates" | "promos";

type MatchType = "category" | "product" | "variant";

interface CategoryCommissionRow {
  category_id: string;
  category_name: string;
  commission_rate: string | number;
}

interface CommissionRule {
  id: string;
  label: string | null;
  match_type: MatchType;
  match_id: string;
  override_rate: string | null;
  fixed_spiff_amount: string;
  is_active: boolean;
}

interface ComboItem {
  match_type: MatchType;
  match_id: string;
  qty_required: number;
}

interface ComboRule {
  id: string;
  label: string;
  reward_amount: string;
  is_active: boolean;
  items: ComboItem[];
}

interface CategoryOption {
  category_id: string;
  category_name: string;
}

interface RuleDraft {
  id: string | null;
  label: string;
  match_type: MatchType;
  match_id: string;
  override_rate: string;
  fixed_spiff_amount: string;
  is_active: boolean;
}

/** Commission rate stored as 0–1 decimal → percent label for the grid (not currency). */
function pctFromDecimal(d: string | number): string {
  const v = typeof d === "number" ? d : Number.parseFloat(String(d));
  if (!Number.isFinite(v)) return "0";
  return (v * 100).toFixed(2);
}

/** Cashier-entered percent string → 0–1 decimal for PATCH payloads (not currency). */
function decimalFromPctInput(s: string): number | null {
  const t = s.trim().replace(/%/g, "");
  const v = Number.parseFloat(t);
  if (!Number.isFinite(v) || v < 0 || v > 100) return null;
  return v / 100;
}

export default function CommissionManagerWorkspace() {
  const { hasPermission } = useBackofficeAuth();
  const canViewPayouts =
    hasPermission("insights.view") && hasPermission("insights.commission_finalize");
  const canManageCommission = hasPermission("staff.manage_commission");
  const availableTabs = useMemo(
    () => [
      ...(canViewPayouts ? (["payouts"] as TabId[]) : []),
      ...(canManageCommission ? (["rates", "promos"] as TabId[]) : []),
    ],
    [canManageCommission, canViewPayouts],
  );
  const [activeTab, setActiveTab] = useState<TabId>(availableTabs[0] ?? "payouts");

  useEffect(() => {
    if (!availableTabs.includes(activeTab)) {
      setActiveTab(availableTabs[0] ?? "payouts");
    }
  }, [activeTab, availableTabs]);

  return (
    <div
      className={`flex flex-1 flex-col overflow-hidden ${DNA.bg} text-app-text`}
    >
      <header className="flex items-center justify-between border-b border-app-border bg-app-surface px-6 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-500 shadow-inner">
            <Percent
              size={20}
              className="drop-shadow-[0_0_8px_rgba(16,185,129,0.3)]"
            />
          </div>
          <div>
            <h1 className="line-height-tight text-lg font-bold tracking-tight text-app-text">
              Commissions
            </h1>
            <p className="mt-0.5 text-[10px] font-bold uppercase tracking-widest text-emerald-500/60">
              Payouts, rates, and incentives
            </p>
          </div>
        </div>

        <nav className="flex items-center gap-1 rounded-full border border-app-border bg-app-surface-2 p-1">
          {canViewPayouts ? (
            <TabButton
              active={activeTab === "payouts"}
              onClick={() => setActiveTab("payouts")}
              icon={<Receipt size={14} />}
              label="Payouts"
            />
          ) : null}
          {canManageCommission ? (
            <TabButton
              active={activeTab === "rates"}
              onClick={() => setActiveTab("rates")}
              icon={<Percent size={14} />}
              label="Rates"
            />
          ) : null}
          {canManageCommission ? (
            <TabButton
              active={activeTab === "promos"}
              onClick={() => setActiveTab("promos")}
              icon={<Zap size={14} />}
              label="Rules & SPIFFs"
            />
          ) : null}
        </nav>
      </header>

      <main className="flex-1 overflow-hidden p-6">
        {activeTab === "payouts" && (
          <div className="flex h-full flex-col gap-6">
            <div className="flex-1 overflow-auto rounded-2xl border border-app-border bg-app-surface p-1">
              <CommissionPayoutsPanel />
            </div>
          </div>
        )}

        {activeTab === "rates" && <CommissionRatesSection />}

        {activeTab === "promos" && <PromoManagerSection />}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-full px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
        active
          ? "bg-emerald-600 text-white shadow-lg shadow-emerald-600/20"
          : "text-app-text-muted hover:text-app-text"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function PromoManagerSection() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();

  const [rules, setRules] = useState<CommissionRule[]>([]);
  const [combos, setCombos] = useState<ComboRule[]>([]);
  const [loading, setLoading] = useState(true);

  const [showRuleModal, setShowRuleModal] = useState(false);
  const [editingRule, setEditingRule] = useState<CommissionRule | null>(null);

  const [showComboModal, setShowComboModal] = useState(false);
  const [editingCombo, setEditingCombo] = useState<ComboRule | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<{
    id: string;
    isCombo: boolean;
  } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [rRes, cRes] = await Promise.all([
        fetch(`${baseUrl}/api/staff/commissions/rules`, {
          headers: backofficeHeaders(),
        }),
        fetch(`${baseUrl}/api/staff/commissions/combos`, {
          headers: backofficeHeaders(),
        }),
      ]);

      if (rRes.ok) setRules((await rRes.json()) as CommissionRule[]);
      if (cRes.ok) setCombos((await cRes.json()) as ComboRule[]);
    } catch {
      toast("Failed to load promo rules", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const deleteRule = async () => {
    if (!deleteTarget) return;
    try {
      const endpoint = deleteTarget.isCombo
        ? `combos/${deleteTarget.id}`
        : `rules/${deleteTarget.id}`;
      const res = await fetch(`${baseUrl}/api/staff/commissions/${endpoint}`, {
        method: "DELETE",
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Delete failed");
      toast("Rule deleted", "success");
      setDeleteTarget(null);
      await loadAll();
    } catch {
      toast("Failed to delete rule", "error");
    }
  };

  return (
    <div className="grid h-full grid-cols-12 gap-6 overflow-hidden">
      <div className="col-span-8 flex flex-col gap-4 overflow-hidden">
        <div className="flex items-center justify-between">
          <h2 className={DNA.heading}>Active SPIFF Rules</h2>
          <button
            type="button"
            onClick={() => {
              setEditingRule(null);
              setShowRuleModal(true);
            }}
            className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-500 shadow-lg shadow-emerald-500/5 transition-all active:scale-95 hover:bg-emerald-500/20"
          >
            <Plus size={14} />
            Create Rule
          </button>
        </div>

        <div className="flex-1 overflow-auto rounded-2xl border border-app-border bg-app-surface">
          <table className="w-full text-left text-[11px]">
            <thead className={`sticky top-0 ${DNA.bg} ${DNA.heading}`}>
              <tr>
                <th className="px-6 py-4">Description</th>
                <th className="px-4 py-4 text-center">Specificity</th>
                <th className="px-4 py-4 text-right text-emerald-500">
                  Incentive
                </th>
                <th className="px-4 py-4 text-center">Status</th>
                <th className="px-6 py-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y border-app-border text-app-text">
              {loading ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-12 text-center text-[9px] font-bold uppercase tracking-widest text-slate-500"
                  >
                    Analyzing promo matrix...
                  </td>
                </tr>
              ) : rules.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-6 py-12 text-center text-[10px] font-black uppercase tracking-widest text-slate-500 opacity-20"
                  >
                    No active SPIFF rules
                  </td>
                </tr>
              ) : (
                rules.map((rule) => (
                  <tr
                    key={rule.id}
                    className="group transition-colors hover:bg-emerald-500/5"
                  >
                    <td className="px-6 py-4">
                      <div className="font-bold uppercase tracking-tight text-app-text">
                        {rule.label || "Unnamed Rule"}
                      </div>
                      <div className="font-mono text-[9px] tracking-tighter text-app-text-muted">
                        {rule.id.slice(0, 8)}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-center">
                      <span className="rounded border border-app-border bg-app-surface-2 px-2 py-0.5 text-[9px] font-bold uppercase tracking-tighter text-app-text-muted">
                        {rule.match_type}
                      </span>
                    </td>
                    <td className="px-4 py-4 text-right">
                      {rule.override_rate && (
                        <div className="text-[9px] font-bold text-emerald-400/30 line-through">
                          Standard %
                        </div>
                      )}
                      <div className="whitespace-nowrap font-mono text-md font-black text-emerald-400">
                        {rule.override_rate
                          ? `${(parseFloat(rule.override_rate) * 100).toFixed(0)}%`
                          : ""}
                        {rule.override_rate &&
                        parseFloat(rule.fixed_spiff_amount) > 0
                          ? " + "
                          : ""}
                        {parseFloat(rule.fixed_spiff_amount) > 0
                          ? `$${parseFloat(rule.fixed_spiff_amount).toFixed(2)}`
                          : ""}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-center">
                        <div
                          className={`h-1.5 w-1.5 rounded-full ${
                            rule.is_active
                              ? "bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.8)]"
                              : "bg-slate-700"
                          }`}
                        />
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-6 py-4 text-right">
                      <div className="flex justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                        <button
                          type="button"
                          onClick={() => {
                            setEditingRule(rule);
                            setShowRuleModal(true);
                          }}
                          className="rounded p-1.5 text-slate-500 transition-colors hover:bg-emerald-500/10 hover:text-emerald-400"
                        >
                          <Settings size={14} />
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({ id: rule.id, isCombo: false })
                          }
                          className="rounded p-1.5 text-slate-500 transition-colors hover:bg-red-500/10 hover:text-red-500"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="col-span-4 flex flex-col gap-4 overflow-hidden">
        <h2 className={DNA.heading}>Combo Rewards</h2>
        <div className="flex-1 space-y-4 overflow-auto rounded-2xl border border-app-border bg-app-surface-2 p-4">
          {combos.length === 0 && !loading && (
            <div className="rounded-xl border border-dashed border-white/10 p-6 text-center">
              <Layers
                className="mx-auto mb-3 text-slate-600 shadow-sm"
                size={24}
              />
              <p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
                No active bundles
              </p>
            </div>
          )}

          {combos.map((combo) => (
            <div
              key={combo.id}
              className="group rounded-xl border border-app-border bg-app-surface p-4 shadow-sm transition-all hover:border-emerald-500/20"
            >
              <div className="mb-3 flex items-center justify-between border-b border-app-border pb-2">
                <span className="text-[11px] font-bold uppercase tracking-tighter text-emerald-400">
                  {combo.label}
                </span>
                <span className="font-mono text-[12px] font-black text-emerald-500">
                  ${parseFloat(combo.reward_amount).toFixed(2)}
                </span>
              </div>
              <div className="space-y-2">
                {combo.items?.map((it, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between text-[10px] text-slate-400"
                  >
                    <div className="flex items-center gap-2">
                      <div className="h-1 w-1 rounded-full bg-app-border" />
                      <span className="font-bold capitalize text-app-text-muted">
                        {it.match_type}:
                      </span>
                    </div>
                    <span className="font-mono font-black text-app-text">
                      x{it.qty_required}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  type="button"
                  onClick={() =>
                    setDeleteTarget({ id: combo.id, isCombo: true })
                  }
                  className="text-[9px] font-black uppercase tracking-widest text-red-500/60 transition-colors hover:text-red-500"
                >
                  Delete Bundle
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              setEditingCombo(null);
              setShowComboModal(true);
            }}
            className="w-full rounded-lg bg-emerald-500 py-3 text-[10px] font-black uppercase tracking-widest text-slate-950 shadow-lg shadow-emerald-500/20 transition-all active:scale-95 hover:bg-emerald-400"
          >
            Configure Combo
          </button>
        </div>
      </div>

      {showRuleModal && (
        <RuleEditorModal
          rule={editingRule}
          onClose={() => setShowRuleModal(false)}
          onSaved={() => {
            setShowRuleModal(false);
            void loadAll();
          }}
        />
      )}

      {showComboModal && (
        <ComboEditorModal
          combo={editingCombo}
          onClose={() => setShowComboModal(false)}
          onSaved={() => {
            setShowComboModal(false);
            void loadAll();
          }}
        />
      )}

      <ConfirmationModal
        isOpen={deleteTarget != null}
        title="Delete rule?"
        message="This action cannot be undone."
        confirmLabel="Delete"
        variant="danger"
        onConfirm={() => void deleteRule()}
        onClose={() => setDeleteTarget(null)}
      />
    </div>
  );
}

function CommissionRatesSection() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [rows, setRows] = useState<CategoryCommissionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyCategoryId, setBusyCategoryId] = useState<string | null>(null);

  const loadRows = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/category-commissions`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load category rates");
      const data = (await res.json()) as CategoryCommissionRow[];
      setRows(Array.isArray(data) ? data : []);
    } catch {
      setRows([]);
      toast("Failed to load category commission rates", "error");
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, toast]);

  useEffect(() => {
    void loadRows();
  }, [loadRows]);

  const saveRate = useCallback(
    async (categoryId: string, pctStr: string) => {
      const rate = decimalFromPctInput(pctStr);
      if (rate === null) {
        toast("Enter a commission rate between 0% and 100%.", "error");
        return;
      }
      setBusyCategoryId(categoryId);
      try {
        const res = await fetch(
          `${baseUrl}/api/staff/admin/category-commissions/${encodeURIComponent(categoryId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...backofficeHeaders() },
            body: JSON.stringify({ commission_rate: rate }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Could not save category commission rate");
        }
        toast("Category commission rate saved.", "success");
        await loadRows();
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not save category commission rate", "error");
      } finally {
        setBusyCategoryId(null);
      }
    },
    [backofficeHeaders, loadRows, toast],
  );

  return (
    <section className="flex h-full flex-col gap-4 overflow-hidden">
      <div className="rounded-2xl border border-app-border bg-app-surface px-4 py-3">
        <p className="text-sm text-app-text-muted">
          Category overrides apply to commission-eligible staff when a sale line maps to that category.
          Commission remains fulfillment-based, and Sales Support continues to earn no commission.
        </p>
      </div>
      <div className="flex-1 overflow-auto rounded-2xl border border-app-border bg-app-surface">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 border-b border-app-border bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <tr>
              <th className="px-4 py-3">Category</th>
              <th className="px-4 py-3">Override %</th>
              <th className="px-4 py-3 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={3} className="px-4 py-12 text-center text-app-text-muted">
                  Loading category rates…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-12 text-center text-app-text-muted">
                  No category overrides configured.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <CategoryRateRow
                  key={row.category_id}
                  row={row}
                  disabled={busyCategoryId === row.category_id}
                  onSave={(pct) => void saveRate(row.category_id, pct)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CategoryRateRow({
  row,
  disabled,
  onSave,
}: {
  row: CategoryCommissionRow;
  disabled: boolean;
  onSave: (pct: string) => void;
}) {
  const [local, setLocal] = useState(pctFromDecimal(row.commission_rate));

  useEffect(() => {
    setLocal(pctFromDecimal(row.commission_rate));
  }, [row.commission_rate]);

  return (
    <tr className="border-b border-app-border/50">
      <td className="px-4 py-3 font-semibold text-app-text">{row.category_name}</td>
      <td className="px-4 py-3">
        <input
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          disabled={disabled}
          className="ui-input w-24 py-1.5 font-mono text-sm"
        />
      </td>
      <td className="px-4 py-3 text-right">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onSave(local)}
          className="ui-btn-primary px-3 py-1.5 disabled:opacity-50"
        >
          Apply
        </button>
      </td>
    </tr>
  );
}

function RuleEditorModal({
  rule,
  onClose,
  onSaved,
}: {
  rule: CommissionRule | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();

  const [loading, setLoading] = useState(false);
  const [categories, setCategories] = useState<CategoryOption[]>([]);

  const [formData, setFormData] = useState<RuleDraft>({
    id: rule?.id || null,
    label: rule?.label || "",
    match_type: rule?.match_type || "category",
    match_id: rule?.match_id || "",
    override_rate: rule?.override_rate
      ? (parseFloat(rule.override_rate) * 100).toFixed(0).toString()
      : "",
    fixed_spiff_amount: rule?.fixed_spiff_amount
      ? parseFloat(rule.fixed_spiff_amount).toString()
      : "0",
    is_active: rule ? rule.is_active : true,
  });

  useEffect(() => {
    const loadCats = async () => {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/category-commissions`,
        {
          headers: backofficeHeaders(),
        },
      );
      if (res.ok) setCategories((await res.json()) as CategoryOption[]);
    };
    void loadCats();
  }, [backofficeHeaders]);

  const save = async () => {
    if (!formData.match_id) {
      toast("Select a target category/product", "error");
      return;
    }
    if (!formData.label) {
      toast("Label required", "error");
      return;
    }

    setLoading(true);
    try {
      const body = {
        ...formData,
        override_rate: formData.override_rate
          ? (parseFloat(formData.override_rate) / 100).toString()
          : null,
        fixed_spiff_amount: parseFloat(formData.fixed_spiff_amount) || 0,
      };

      const res = await fetch(`${baseUrl}/api/staff/commissions/rules`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backofficeHeaders(),
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) throw new Error("Save failed");
      toast("Rule saved", "success");
      onSaved();
    } catch {
      toast("Failed to save rule", "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6 backdrop-blur-sm">
      <div className="w-full max-w-lg rounded-3xl border border-app-border bg-app-surface p-8 shadow-2xl animate-in fade-in zoom-in duration-200">
        <div className="mb-8 flex items-center justify-between">
          <div>
            <h3 className="line-height-tight text-lg font-black uppercase tracking-tight text-app-text">
              {rule ? "Edit Rule" : "Create SPIFF Rule"}
            </h3>
            <p className="mt-1 font-mono text-[10px] font-bold uppercase tracking-widest text-emerald-500/60">
              SPECIFICITY OVERRIDE ENGINE
            </p>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-full p-2 text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
          >
            <X size={20} />
          </button>
        </div>

        <div className="space-y-6">
          <div className="space-y-1.5">
            <label htmlFor="rule-label" className={DNA.heading}>
              Description / Label
            </label>
            <input
              id="rule-label"
              name="label"
              className="w-full rounded-xl border-app-border bg-app-surface px-4 py-3 text-sm font-bold text-app-text ui-input focus:border-emerald-500/40"
              placeholder="e.g. Seasonal Silk Tie Bonus"
              value={formData.label}
              onChange={(e) =>
                setFormData({ ...formData, label: e.target.value })
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="rule-match-type" className={DNA.heading}>
                Specificity
              </label>
              <select
                id="rule-match-type"
                name="match_type"
                className="w-full rounded-xl border-app-border bg-app-surface px-4 py-3 text-sm font-bold text-app-text ui-input appearance-none"
                value={formData.match_type}
                onChange={(e) => {
                  const next = e.target.value;
                  if (
                    next === "category" ||
                    next === "product" ||
                    next === "variant"
                  ) {
                    setFormData({
                      ...formData,
                      match_type: next,
                      match_id: "",
                    });
                  }
                }}
              >
                <option value="category">Category</option>
                <option value="product" disabled>
                  Product (Coming)
                </option>
                <option value="variant" disabled>
                  Variant (Coming)
                </option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="rule-match-id" className={DNA.heading}>
                Target {formData.match_type}
              </label>
              {formData.match_type === "category" ? (
                <select
                  id="rule-match-id"
                  name="match_id"
                  className="w-full rounded-xl border-app-border bg-app-surface px-4 py-3 text-sm font-bold text-app-text ui-input appearance-none"
                  value={formData.match_id}
                  onChange={(e) =>
                    setFormData({ ...formData, match_id: e.target.value })
                  }
                >
                  <option value="">Select Category...</option>
                  {categories.map((c) => (
                    <option key={c.category_id} value={c.category_id}>
                      {c.category_name}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="ui-input flex h-[46px] items-center rounded-xl border-app-border bg-app-surface px-4 py-3 text-[10px] italic text-app-text-muted">
                  Picker disabled
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label htmlFor="rule-rate" className={DNA.heading}>
                Commission Rate %
              </label>
              <div className="relative">
                <input
                  id="rule-rate"
                  name="override_rate"
                  type="number"
                  className="w-full rounded-xl border-app-border bg-app-surface py-3 pl-4 pr-10 font-mono text-sm font-black tabular-nums text-emerald-600 dark:text-emerald-400 ui-input"
                  placeholder="Override"
                  value={formData.override_rate}
                  onChange={(e) =>
                    setFormData({ ...formData, override_rate: e.target.value })
                  }
                />
                <div className="absolute right-4 top-1/2 -translate-y-1/2 font-bold text-slate-600">
                  %
                </div>
              </div>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="rule-spiff" className={DNA.heading}>
                Fixed SPIFF ($)
              </label>
              <div className="relative">
                <input
                  id="rule-spiff"
                  name="fixed_spiff_amount"
                  type="number"
                  className="w-full rounded-xl border-app-border bg-app-surface py-3 pl-8 pr-4 font-mono text-sm font-black tabular-nums text-emerald-600 dark:text-emerald-400 ui-input"
                  placeholder="0.00"
                  value={formData.fixed_spiff_amount}
                  onChange={(e) =>
                    setFormData({
                      ...formData,
                      fixed_spiff_amount: e.target.value,
                    })
                  }
                />
                <div className="absolute left-4 top-1/2 -translate-y-1/2 font-bold text-slate-600">
                  $
                </div>
              </div>
            </div>
          </div>

          <label htmlFor="rule-active" className="flex items-center gap-3">
            <input
              id="rule-active"
              name="is_active"
              type="checkbox"
              checked={formData.is_active}
              onChange={(e) =>
                setFormData({ ...formData, is_active: e.target.checked })
              }
              className="h-4 w-4 rounded border-app-border bg-app-surface text-emerald-500"
            />
            <span className="text-xs font-bold uppercase tracking-widest text-app-text">
              Rule is active
            </span>
          </label>
        </div>

        <div className="mt-8 flex items-center gap-3 border-t border-app-border pt-8">
          <button
            type="button"
            disabled={loading}
            onClick={() => void save()}
            className="flex-1 rounded-2xl bg-emerald-500 py-4 text-[10px] font-black uppercase tracking-widest text-slate-950 shadow-xl shadow-emerald-500/20 transition-all active:scale-95 hover:bg-emerald-400 disabled:opacity-50"
          >
            {loading ? "Syncing Rule..." : rule ? "Update Rule" : "Create Rule"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl bg-app-surface-2 px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
          >
            Exit
          </button>
        </div>
      </div>
    </div>
  );
}
