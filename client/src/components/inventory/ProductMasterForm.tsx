import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import VariationsBuilder, {
  type GeneratedVariationRow,
} from "./VariationsBuilder";
import { apiUrl } from "../../lib/apiUrl";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import {
  Plus,
  Info,
  Sparkles,
  Settings2,
  DollarSign,
  Layers,
  CheckCircle2,
  Globe,
  Bell,
  PackagePlus,
} from "lucide-react";

interface Category {
  id: string;
  name: string;
  is_clothing_footwear: boolean;
  matrix_row_axis_key?: string | null;
  matrix_col_axis_key?: string | null;
}

interface ProductMasterFormProps {
  onCreated?: () => void;
}

type FormStep = "shell" | "financials" | "matrix" | "review";

export default function ProductMasterForm({
  onCreated,
}: ProductMasterFormProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = getBaseUrl();

  const [step, setStep] = useState<FormStep>("shell");
  const [categories, setCategories] = useState<Category[]>([]);

  // Shell Info
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");

  // Financials
  const [baseRetail, setBaseRetail] = useState("0.00");
  const [baseCost, setBaseCost] = useState("0.00");

  // Options
  const [imagesRaw] = useState("");
  const [trackLowStockTemplate, setTrackLowStockTemplate] = useState(false);
  const [publishVariantsToWeb, setPublishVariantsToWeb] = useState(false);

  // Matrix
  const [rows, setRows] = useState<GeneratedVariationRow[]>([]);
  const [axes, setAxes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(apiUrl(baseUrl, "/api/categories"), {
          headers: apiAuth(),
        });
        const data = r.ok ? ((await r.json()) as unknown) : [];
        setCategories(Array.isArray(data) ? (data as Category[]) : []);
      } catch {
        setCategories([]);
      }
    })();
  }, [baseUrl, apiAuth]);

  const categoryBadge = useMemo(
    () => categories.find((c) => c.id === categoryId),
    [categories, categoryId],
  );

  const canContinueToFinancials = name.trim() && categoryId;
  const baseRetailCents = parseMoneyToCents(baseRetail || "0");
  const baseCostCents = parseMoneyToCents(baseCost || "0");
  const hasInvalidGeneratedRows = rows.some(
    (row) => !row.sku.trim() || row.stock_on_hand < 0,
  );
  const canSubmitProduct =
    !busy &&
    name.trim().length > 0 &&
    rows.length > 0 &&
    baseRetailCents >= 0 &&
    baseCostCents >= 0 &&
    !hasInvalidGeneratedRows;

  const submitProduct = async () => {
    if (!name.trim() || rows.length === 0) return;
    if (baseRetailCents < 0) {
      toast("Benchmark retail must be non-negative.", "error");
      return;
    }
    if (baseCostCents < 0) {
      toast("Average acquisition cost must be non-negative.", "error");
      return;
    }
    if (hasInvalidGeneratedRows) {
      toast(
        "Each generated SKU must be present and start with non-negative stock.",
        "error",
      );
      return;
    }
    setBusy(true);
    try {
      const images = imagesRaw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean)
        .slice(0, 5);
      const res = await fetch(apiUrl(baseUrl, "/api/products"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          category_id: categoryId || null,
          name: name.trim(),
          brand: brand.trim() || null,
          description: description.trim() || null,
          base_retail_price: centsToFixed2(baseRetailCents),
          base_cost: centsToFixed2(baseCostCents),
          variation_axes: axes,
          images,
          track_low_stock: trackLowStockTemplate,
          publish_variants_to_web: publishVariantsToWeb,
          variants: rows,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Failed to create product");
      }

      // Success Cleanup
      setName("");
      setBrand("");
      setDescription("");
      setBaseRetail("0.00");
      setBaseCost("0.00");
      setRows([]);
      setStep("shell");
      setTrackLowStockTemplate(false);
      setPublishVariantsToWeb(false);
      onCreated?.();
      toast("Catalog synchronization successful. Matrix generated.", "success");
    } catch (e) {
      toast(
        e instanceof Error ? e.message : "Failed to create product",
        "error",
      );
    } finally {
      setBusy(false);
    }
  };

  const StepIndicator = ({
    id,
    current,
    label,
    icon: Icon,
  }: {
    id: FormStep;
    current: FormStep;
    label: string;
    icon: React.ComponentType<{ size?: number }>;
  }) => (
    <div
      className={`flex items-center gap-2 px-4 py-2 rounded-2xl transition-all ${
        id === current
          ? "bg-app-accent text-white shadow-lg shadow-app-accent/20"
          : "text-app-text-muted opacity-40 hover:opacity-100"
      }`}
    >
      <Icon size={16} />
      <span className="text-[10px] font-black uppercase tracking-widest">
        {label}
      </span>
    </div>
  );

  return (
    <div className="flex flex-col gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Navigation Header */}
      <nav className="flex items-center gap-2 p-2 rounded-[2rem] border border-app-border bg-app-surface-2 self-start">
        <StepIndicator
          id="shell"
          current={step}
          label="Identity"
          icon={Sparkles}
        />
        <div className="h-4 w-px bg-app-border" />
        <StepIndicator
          id="financials"
          current={step}
          label="Revenue"
          icon={DollarSign}
        />
        <div className="h-4 w-px bg-app-border" />
        <StepIndicator
          id="matrix"
          current={step}
          label="Configuration"
          icon={Settings2}
        />
        <div className="h-4 w-px bg-app-border" />
        <StepIndicator
          id="review"
          current={step}
          label="Validation"
          icon={CheckCircle2}
        />
      </nav>

      <main className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          {/* STEP 1: SHELL */}
          {step === "shell" && (
            <section className="rounded-[2.5rem] border border-app-border bg-app-surface p-8 shadow-sm">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-black italic tracking-tighter text-app-text uppercase">
                    Catalog Identity
                  </h2>
                  <p className="text-xs font-bold text-app-text-muted mt-1 uppercase tracking-widest">
                    Base template definition and branding
                  </p>
                </div>
                <div className="h-12 w-12 rounded-2xl bg-violet-100 flex items-center justify-center text-violet-600">
                  <Plus size={24} />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">
                    Product Name
                  </label>
                  <input
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="e.g. Italian Wool Suit (Super 120s)"
                    className="ui-input h-14 text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">
                    Brand Portfolio
                  </label>
                  <input
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="e.g. Riverside Private Label"
                    className="ui-input h-14 text-sm font-bold"
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">
                    Classification
                  </label>
                  <select
                    value={categoryId}
                    onChange={(e) => setCategoryId(e.target.value)}
                    className="ui-input h-14 text-sm font-bold"
                  >
                    <option value="">Select global category...</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">
                    Asset Description
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="Describe textures, fits, and special care instructions..."
                    className="ui-input h-14 py-3 text-sm font-bold resize-none"
                  />
                </div>
              </div>

              <div className="mt-8 flex justify-end">
                <button
                  onClick={() => setStep("financials")}
                  disabled={!canContinueToFinancials}
                  className="ui-btn-primary px-10 py-4 h-auto rounded-2xl text-[10px] font-black uppercase tracking-widest disabled:opacity-30 transition-all"
                >
                  Configure Revenue & Space
                </button>
              </div>
            </section>
          )}

          {/* STEP 2: FINANCIALS */}
          {step === "financials" && (
            <section className="rounded-[2.5rem] border border-app-border bg-app-surface p-8 shadow-sm">
              <div className="mb-6 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-black italic tracking-tighter text-app-text uppercase">
                    Financial Architecture
                  </h2>
                  <p className="text-xs font-bold text-app-text-muted mt-1 uppercase tracking-widest">
                    Pricing targets and channel visibility
                  </p>
                </div>
                <div className="h-12 w-12 rounded-2xl bg-emerald-100 flex items-center justify-center text-emerald-600">
                  <DollarSign size={24} />
                </div>
              </div>

              <div className="grid gap-6 md:grid-cols-2">
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1 italic">
                      Benchmark Retail (USD)
                    </label>
                    <input
                      value={baseRetail}
                      onChange={(e) => setBaseRetail(e.target.value)}
                      type="number"
                      min="0"
                      className="ui-input h-16 text-2xl font-black tabular-nums tracking-tighter"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1 italic">
                      Average Acquisition Cost (USD)
                    </label>
                    <input
                      value={baseCost}
                      onChange={(e) => setBaseCost(e.target.value)}
                      type="number"
                      min="0"
                      className="ui-input h-16 text-xl font-black tabular-nums tracking-tighter text-app-text-muted"
                    />
                  </div>
                </div>

                <div className="space-y-3 bg-app-surface-2 rounded-3xl p-6 border border-app-border">
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted mb-2">
                    Automated Rules
                  </h4>
                  <label className="flex items-start gap-4 p-3 rounded-2xl bg-app-surface border border-app-border/40 cursor-pointer group hover:border-app-accent/40 transition-all">
                    <div className="pt-1">
                      <input
                        type="checkbox"
                        checked={trackLowStockTemplate}
                        onChange={(e) =>
                          setTrackLowStockTemplate(e.target.checked)
                        }
                        className="h-5 w-5 rounded-lg border-app-border bg-app-surface text-app-accent"
                      />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-black uppercase tracking-tight text-app-text group-hover:text-app-accent transition-colors flex items-center gap-2">
                        <Bell size={14} /> Low-Stock Monitoring
                      </span>
                      <span className="text-[10px] text-app-text-muted font-bold mt-0.5 leading-tight">
                        Generate alerts in the morning digest when inventory
                        depletes.
                      </span>
                    </div>
                  </label>

                  <label className="flex items-start gap-4 p-3 rounded-2xl bg-app-surface border border-app-border/40 cursor-pointer group hover:border-app-accent/40 transition-all">
                    <div className="pt-1">
                      <input
                        type="checkbox"
                        checked={publishVariantsToWeb}
                        onChange={(e) =>
                          setPublishVariantsToWeb(e.target.checked)
                        }
                        className="h-5 w-5 rounded-lg border-app-border bg-app-surface text-app-accent"
                      />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-xs font-black uppercase tracking-tight text-app-text group-hover:text-app-accent transition-colors flex items-center gap-2">
                        <Globe size={14} /> Global Storefront Sync
                      </span>
                      <span className="text-[10px] text-app-text-muted font-bold mt-0.5 leading-tight">
                        Mark all generated SKUs as published in the online
                        boutique.
                      </span>
                    </div>
                  </label>
                </div>
              </div>

              <div className="mt-8 flex justify-between">
                <button
                  onClick={() => setStep("shell")}
                  className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all"
                >
                  Back to Identity
                </button>
                <button
                  onClick={() => setStep("matrix")}
                  className="ui-btn-primary px-10 py-4 h-auto rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all"
                >
                  Construct Configuration Matrix
                </button>
              </div>
            </section>
          )}

          {/* STEP 3: MATRIX */}
          {step === "matrix" && (
            <div className="space-y-6">
              <VariationsBuilder
                onGenerated={(generated, axisNames) => {
                  setRows(generated);
                  setAxes(axisNames);
                  if (generated.length > 0) setStep("review");
                }}
              />
              <button
                onClick={() => setStep("financials")}
                className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all"
              >
                Back to Financials
              </button>
            </div>
          )}

          {/* STEP 4: REVIEW */}
          {step === "review" && (
            <section className="rounded-[2.5rem] border border-app-border bg-app-surface p-8 shadow-sm">
              <div className="mb-8 flex items-center justify-between">
                <div>
                  <h2 className="text-2xl font-black italic tracking-tighter text-app-border uppercase">
                    Final Validation
                  </h2>
                  <p className="text-xs font-bold text-app-text-muted mt-1 uppercase tracking-widest">
                    Reviewing {rows.length} SKU definitions for commit
                  </p>
                </div>
                <div className="h-12 w-12 rounded-2xl bg-amber-100 flex items-center justify-center text-amber-600">
                  <PackagePlus size={24} />
                </div>
              </div>

              <div className="rounded-[2rem] border border-app-border overflow-hidden bg-app-surface-2 shadow-inner mb-8">
                <div className="max-h-[400px] overflow-auto">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead className="sticky top-0 bg-app-surface border-b border-app-border z-10">
                      <tr>
                        <th className="px-6 py-4 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                          SKU Code
                        </th>
                        <th className="px-6 py-4 font-black uppercase tracking-widest text-app-text-muted opacity-60">
                          Matrix Position
                        </th>
                        <th className="px-6 py-4 text-right font-black uppercase tracking-widest text-app-text-muted opacity-60">
                          Initial SOH
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-app-border/40">
                      {rows.map((r, i) => (
                        <tr
                          key={`${r.sku}-${i}`}
                          className="hover:bg-app-surface/50 transition-colors group"
                        >
                          <td className="px-6 py-4 font-mono font-black text-app-text group-hover:text-app-accent">
                            {r.sku}
                          </td>
                          <td className="px-6 py-4">
                            <span className="rounded-lg bg-app-surface border border-app-border px-2 py-1 text-[10px] font-black uppercase tracking-tight text-app-text-muted">
                              {r.variation_label}
                            </span>
                          </td>
                          <td className="px-6 py-4 text-right font-black tabular-nums text-app-text-muted">
                            {r.stock_on_hand}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex items-center justify-between gap-6 p-6 rounded-3xl bg-emerald-50 border border-emerald-200">
                <div className="flex items-center gap-4">
                  <div className="h-10 w-10 rounded-full bg-emerald-600 text-white flex items-center justify-center shadow-lg shadow-emerald-500/20">
                    <CheckCircle2 size={24} />
                  </div>
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-emerald-900">
                      Master Form Ready
                    </p>
                    <p className="text-[10px] font-bold text-emerald-700/80">
                      Non-negative pricing, valid categories, and unique SKUs are
                      required before these models can be committed.
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={submitProduct}
                  disabled={!canSubmitProduct}
                  className="h-14 px-8 rounded-2xl bg-emerald-600 text-white text-[10px] font-black uppercase tracking-widest shadow-xl shadow-emerald-500/30 hover:brightness-110 active:scale-95 transition-all disabled:opacity-50"
                >
                  {busy
                    ? "Committing Models..."
                    : `Sync ${rows.length} Definitions`}
                </button>
              </div>

              <div className="mt-8">
                <button
                  onClick={() => setStep("matrix")}
                  className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text transition-all"
                >
                  Refine Matrix
                </button>
              </div>
            </section>
          )}
        </div>

        {/* SIDEBAR: CONTEXTUAL HELP */}
        <aside className="space-y-6">
          <section className="rounded-[2rem] border border-app-border bg-app-surface p-6 shadow-sm">
            <div className="flex items-center gap-2 text-app-accent mb-4">
              <Info size={18} />
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">
                Contextual Help
              </h4>
            </div>

            <div className="space-y-1.5 p-4 rounded-2xl bg-app-surface-2 border border-app-border/40">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text mb-1">
                Taxation Logic
              </p>
              <div className="flex items-center gap-2">
                <span
                  className={`h-2 w-2 rounded-full ${categoryBadge?.is_clothing_footwear ? "bg-emerald-500" : "bg-app-text-muted"}`}
                />
                <span className="text-[10px] font-bold text-app-text leading-tight">
                  {categoryBadge?.is_clothing_footwear
                    ? "Clothing Exemption detected. NY sales under $110 will be tax-free."
                    : "General merchandise rules apply to this classification."}
                </span>
              </div>
            </div>

            <div className="space-y-1.5 p-4 rounded-2xl bg-app-surface-2 border border-app-border/40 mt-4">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text mb-1">
                Matrix Engine
              </p>
              <p className="text-[10px] font-bold text-app-text-muted leading-relaxed">
                Constructor creates a Cartesian product of all attributes. 3
                Sizes x 3 Colors = 9 SKUs. Riverside OS automatically generates
                sequential SKU codes using the template prefix.
              </p>
            </div>
          </section>

          <section className="rounded-[2rem] border border-app-border bg-violet-600 p-6 shadow-xl shadow-violet-600/20 text-white">
            <div className="flex items-center gap-2 mb-4 opacity-80">
              <Layers size={18} />
              <h4 className="text-[10px] font-black uppercase tracking-[0.2em]">
                Audit Readiness
              </h4>
            </div>
            <p className="text-[11px] font-medium leading-relaxed opacity-90">
              Every product creation is logged with the current staff ID and a
              system correlation ID. Ensure your descriptions are
              customer-friendly as they will propogate to the Online Store and
              printed receipts.
            </p>
          </section>
        </aside>
      </main>
    </div>
  );
}
