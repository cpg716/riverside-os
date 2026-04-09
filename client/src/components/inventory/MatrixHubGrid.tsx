import { useState, useMemo, useRef, useCallback, useEffect } from "react";
import { Printer } from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

export interface HubVariant {
  id: string;
  sku: string;
  variation_values: Record<string, unknown>;
  variation_label: string | null;
  stock_on_hand: number;
  reorder_point: number;
  track_low_stock: boolean;
  retail_price_override: string | null;
  cost_override: string | null;
  effective_retail: string;
  web_published: boolean;
  web_price_override: string | null;
  web_gallery_order: number;
}

function hasRetailOverride(v: HubVariant): boolean {
  const o = v.retail_price_override;
  if (o == null) return false;
  return String(o).trim() !== "";
}

function strVal(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

function collectAxisKeys(variants: HubVariant[]): string[] {
  const s = new Set<string>();
  for (const v of variants) {
    for (const k of Object.keys(v.variation_values ?? {})) {
      s.add(k);
    }
  }
  return [...s];
}

function pickAxis(
  keys: string[],
  candidates: string[],
): string | null {
  const lower = keys.map((k) => k.toLowerCase());
  for (const c of candidates) {
    const cl = c.toLowerCase();
    const i = lower.findIndex(
      (x) => x === cl || x.includes(cl) || cl.includes(x),
    );
    if (i >= 0) return keys[i];
  }
  return null;
}

function detectMatrixAxes(
  categoryName: string | null,
  variationAxes: string[],
  variants: HubVariant[],
  serverRowKey: string | null | undefined,
  serverColKey: string | null | undefined,
): { rowAxis: string; colAxis: string; profile: string } {
  const keys = collectAxisKeys(variants);
  const ax = variationAxes.length ? variationAxes : keys;
  const cat = (categoryName ?? "").toLowerCase();

  const sr = serverRowKey?.trim();
  const sc = serverColKey?.trim();
  if (
    sr &&
    sc &&
    sr !== sc &&
    keys.includes(sr) &&
    keys.includes(sc)
  ) {
    return { rowAxis: sr, colAxis: sc, profile: "configured" };
  }

  let rowAxis: string | null = null;
  let colAxis: string | null = null;
  let profile = "generic";

  if (cat.includes("shirt") || cat.includes("dress")) {
    colAxis = pickAxis(keys, ["Sleeve", "Sleeve Length", "sleeve"]);
    rowAxis = pickAxis(keys, ["Neck", "neck"]);
    profile = "shirt";
  } else if (cat.includes("pant") || cat.includes("trouser")) {
    colAxis = pickAxis(keys, ["Inseam", "inseam"]);
    rowAxis = pickAxis(keys, ["Waist", "waist"]);
    profile = "pant";
  } else if (
    cat.includes("suit") ||
    cat.includes("vest") ||
    cat.includes("jacket") ||
    cat.includes("coat")
  ) {
    colAxis = pickAxis(keys, ["Length", "length", "Jacket Length"]);
    rowAxis = pickAxis(keys, ["Chest", "chest", "Size"]);
    profile = "suit";
  }

  if (!rowAxis || !colAxis) {
    const ordered = [...new Set([...ax, ...keys])];
    rowAxis = ordered[0] ?? "Row";
    colAxis = ordered[1] ?? ordered[0] ?? "Col";
    if (rowAxis === colAxis && keys.length > 1) {
      colAxis = keys.find((k) => k !== rowAxis) ?? colAxis;
    }
    profile = "generic";
  }

  return { rowAxis, colAxis, profile };
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

interface MatrixHubGridProps {
  productId: string;
  /** Template-level gate for low-stock alerts (see Product hub General tab). */
  productTrackLowStock: boolean;
  templateBaseRetail: string;
  productName: string;
  categoryName: string | null;
  variationAxes: string[];
  matrixRowAxisKey?: string | null;
  matrixColAxisKey?: string | null;
  variants: HubVariant[];
  baseUrl: string;
  onVariantUpdated: () => void;
}

export default function MatrixHubGrid({
  productId,
  productTrackLowStock,
  templateBaseRetail,
  productName,
  categoryName,
  variationAxes,
  matrixRowAxisKey,
  matrixColAxisKey,
  variants,
  baseUrl,
  onVariantUpdated,
}: MatrixHubGridProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const { rowAxis, colAxis, profile } = useMemo(
    () =>
      detectMatrixAxes(
        categoryName,
        variationAxes,
        variants,
        matrixRowAxisKey,
        matrixColAxisKey,
      ),
    [categoryName, variationAxes, variants, matrixRowAxisKey, matrixColAxisKey],
  );

  const filterKeys = useMemo(() => {
    const keys = collectAxisKeys(variants).filter(
      (k) => k !== rowAxis && k !== colAxis,
    );
    return keys;
  }, [variants, rowAxis, colAxis]);

  const [attrFilter, setAttrFilter] = useState<Record<string, string | null>>({});
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const [priceTarget, setPriceTarget] = useState<HubVariant | null>(null);
  const [priceDraft, setPriceDraft] = useState("");
  const pricePopoverRef = useRef<HTMLDivElement | null>(null);

  const { toast } = useToast();
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showSurchargePrompt, setShowSurchargePrompt] = useState(false);
  const [rowRetailTarget, setRowRetailTarget] = useState<string | null>(null);
  const [showBulkSetPrompt, setShowBulkSetPrompt] = useState(false);

  const attributeOptions = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const k of filterKeys) {
      const set = new Set<string>();
      for (const v of variants) {
        const val = strVal(v.variation_values[k]);
        if (val) set.add(val);
      }
      m[k] = [...set].sort(naturalSort);
    }
    return m;
  }, [variants, filterKeys]);

  const filteredVariants = useMemo(() => {
    return variants.filter((v) => {
      for (const k of filterKeys) {
        const want = attrFilter[k];
        if (!want) continue;
        const got = strVal(v.variation_values[k]);
        if (got !== want) return false;
      }
      return true;
    });
  }, [variants, filterKeys, attrFilter]);

  const rowKeys = useMemo(() => {
    const set = new Set<string>();
    for (const v of filteredVariants) {
      const r = strVal(v.variation_values[rowAxis]);
      if (r) set.add(r);
    }
    return [...set].sort(naturalSort);
  }, [filteredVariants, rowAxis]);

  const colKeys = useMemo(() => {
    const set = new Set<string>();
    for (const v of filteredVariants) {
      const c = strVal(v.variation_values[colAxis]);
      if (c) set.add(c);
    }
    return [...set].sort(naturalSort);
  }, [filteredVariants, colAxis]);

  const cellMap = useMemo(() => {
    const m = new Map<string, HubVariant>();
    for (const v of filteredVariants) {
      const r = strVal(v.variation_values[rowAxis]);
      const c = strVal(v.variation_values[colAxis]);
      if (!r || !c) continue;
      m.set(`${r}\0${c}`, v);
    }
    return m;
  }, [filteredVariants, rowAxis, colAxis]);

  const applyStockDelta = useCallback(
    async (variantId: string, delta: number) => {
      if (!delta) return;
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/stock-adjust`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ quantity_delta: delta }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Stock update failed", "error");
        return;
      }
      onVariantUpdated();
    },
    [apiAuth, baseUrl, onVariantUpdated, toast],
  );

  const patchRetail = useCallback(
    async (variantId: string, retailCents: number) => {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/pricing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({
            retail_price_override: centsToFixed2(retailCents),
          }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Price update failed", "error");
        return;
      }
      onVariantUpdated();
    },
    [apiAuth, baseUrl, onVariantUpdated, toast],
  );

  const patchRetailClear = useCallback(
    async (variantId: string) => {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/pricing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ clear_retail_override: true }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Could not clear override", "error");
        return;
      }
      onVariantUpdated();
    },
    [apiAuth, baseUrl, onVariantUpdated, toast],
  );

  const patchTrackLowStock = useCallback(
    async (variantId: string, next: boolean) => {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/pricing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ track_low_stock: next }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Could not update low-stock flag", "error");
        return;
      }
      onVariantUpdated();
    },
    [apiAuth, baseUrl, onVariantUpdated, toast],
  );

  const patchWebPublished = useCallback(
    async (variantId: string, next: boolean) => {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/pricing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ web_published: next }),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Could not update web visibility", "error");
        return;
      }
      onVariantUpdated();
    },
    [apiAuth, baseUrl, onVariantUpdated, toast],
  );

  const patchVariantPricingFields = useCallback(
    async (variantId: string, patch: Record<string, unknown>) => {
      const res = await fetch(
        `${baseUrl}/api/products/variants/${variantId}/pricing`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        toast(err.error ?? "Could not update variant", "error");
        return;
      }
      onVariantUpdated();
    },
    [apiAuth, baseUrl, onVariantUpdated, toast],
  );

  useEffect(() => {
    if (!priceTarget) return;
    setPriceDraft(
      centsToFixed2(parseMoneyToCents(priceTarget.effective_retail || "0")),
    );
    const onDoc = (e: MouseEvent) => {
      const el = pricePopoverRef.current;
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      setPriceTarget(null);
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDoc);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDoc);
    };
  }, [priceTarget]);

  const templateRetailTrim = String(templateBaseRetail).trim();
  const templateRetailLabel =
    templateRetailTrim !== "" &&
    Number.isFinite(Number.parseFloat(templateRetailTrim))
      ? `$${centsToFixed2(parseMoneyToCents(templateRetailTrim))}`
      : "—";

  const toggleRowSelected = (rk: string) => {
    setSelectedRows((prev) => {
      const n = new Set(prev);
      if (n.has(rk)) n.delete(rk);
      else n.add(rk);
      return n;
    });
  };

  const executeClearAllRetailOverrides = async () => {
    const res = await fetch(
      `${baseUrl}/api/products/${productId}/clear-retail-overrides`,
      { method: "POST", headers: { ...apiAuth() } },
    );
    if (!res.ok) {
      const err = (await res.json().catch(() => ({}))) as { error?: string };
      toast(err.error ?? "Clear failed", "error");
      return;
    }
    toast("All overrides cleared", "success");
    setPriceTarget(null);
    onVariantUpdated();
    setShowClearConfirm(false);
  };

  const applySurcharge = async (amount: string) => {
    const trimmed = amount.trim();
    if (!trimmed || !Number.isFinite(Number.parseFloat(trimmed))) {
      toast("Invalid amount", "error");
      return;
    }
    const deltaCents = parseMoneyToCents(trimmed);
    let processed = 0;
    for (const rk of selectedRows) {
      for (const ck of colKeys) {
        const v = cellMap.get(`${rk}\0${ck}`);
        if (!v) continue;
        const effCents = parseMoneyToCents(v.effective_retail || "0");
        const nextCents = effCents + deltaCents;
        if (nextCents < 0) {
          toast("Result would be negative — cancelled.", "error");
          return;
        }
        await patchRetail(v.id, nextCents);
        processed++;
      }
    }
    toast(`Surcharge applied to ${processed} cells`, "success");
    onVariantUpdated();
    setShowSurchargePrompt(false);
  };

  const executeRowRetail = async (amount: string) => {
    if (!rowRetailTarget) return;
    const trimmed = amount.trim();
    if (
      !trimmed ||
      !Number.isFinite(Number.parseFloat(trimmed))
    ) {
      toast("Invalid price", "error");
      return;
    }
    const priceCents = parseMoneyToCents(trimmed);
    if (priceCents < 0) {
      toast("Invalid price", "error");
      return;
    }
    for (const col of colKeys) {
      const v = cellMap.get(`${rowRetailTarget}\0${col}`);
      if (v) await patchRetail(v.id, priceCents);
    }
    toast(`Row ${rowRetailTarget} updated`, "success");
    setRowRetailTarget(null);
  };

  const executeBulkSetRetail = async (amount: string) => {
    const trimmed = amount.trim();
    if (
      !trimmed ||
      !Number.isFinite(Number.parseFloat(trimmed))
    ) {
      toast("Invalid price", "error");
      return;
    }
    const priceCents = parseMoneyToCents(trimmed);
    if (priceCents < 0) {
      toast("Invalid price", "error");
      return;
    }
    for (const v of filteredVariants) {
      await patchRetail(v.id, priceCents);
    }
    toast(`Retail set for ${filteredVariants.length} variants`, "success");
    setShowBulkSetPrompt(false);
  };

  const printAllVisible = () => {
    for (const v of filteredVariants) {
      const w = window.open("", "_blank", "width=360,height=240");
      if (!w) continue;
      const label = v.variation_label ?? `${rowAxis}/${colAxis}`;
      w.document.write(`<!DOCTYPE html><html><head><title>${v.sku}</title>
        <style>body{font-family:system-ui;padding:12px} .sku{font-size:20px;font-weight:900}</style></head><body>
        <div class="sku">${v.sku}</div><div>${productName}</div><div>${label}</div></body></html>`);
      w.document.close();
      w.print();
      w.close();
    }
  };

  return (
    <div className="space-y-4">
      {!productTrackLowStock ? (
        <p className="rounded-xl border border-amber-100 bg-amber-50/80 p-3 text-xs text-amber-900">
          Template low-stock tracking is off. Enable it on the General tab to opt in SKUs for
          admin morning alerts.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-app-border bg-app-surface-2/80 px-3 py-2 text-[10px] font-bold uppercase tracking-[0.12em] text-app-text-muted">
        <span className="text-app-text-muted">Matrix profile:</span>
        <span className="rounded-md bg-app-surface px-2 py-1 text-app-text">{profile}</span>
        <span className="text-app-text-muted">·</span>
        <span>
          Rows: <em className="not-italic text-app-text">{rowAxis}</em>
        </span>
        <span className="text-app-text-muted">·</span>
        <span>
          Cols: <em className="not-italic text-app-text">{colAxis}</em>
        </span>
        <span className="text-app-text-muted">·</span>
        <span className="text-app-text-muted">
          Base {templateRetailLabel}:{" "}
          <span className="font-semibold text-app-text-muted">inherited</span> ·{" "}
          <span className="font-bold text-app-accent">override</span>
        </span>
      </div>

      {filterKeys.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-black uppercase tracking-[0.15em] text-app-text-muted">
            Attribute filter
          </p>
          <div className="flex flex-wrap gap-2">
            {filterKeys.map((fk) => (
              <div key={fk} className="flex flex-wrap items-center gap-1">
                <span className="text-[9px] font-bold text-app-text-muted">{fk}:</span>
                <button
                  type="button"
                  onClick={() =>
                    setAttrFilter((prev) => ({ ...prev, [fk]: null }))
                  }
                  className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                    !attrFilter[fk]
                      ? "bg-app-text text-app-surface"
                      : "bg-app-border text-app-text-muted"
                  }`}
                >
                  All
                </button>
                {(attributeOptions[fk] ?? []).map((opt) => (
                  <button
                    key={opt}
                    type="button"
                    onClick={() =>
                      setAttrFilter((prev) => ({ ...prev, [fk]: opt }))
                    }
                    className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                      attrFilter[fk] === opt
                        ? "bg-app-accent text-white"
                        : "border border-app-border bg-app-surface text-app-text"
                    }`}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {rowKeys.length === 0 || colKeys.length === 0 ? (
        <div className="rounded-2xl border border-amber-100 bg-amber-50/50 p-4 text-sm text-amber-900">
          <p className="font-bold">No 2D grid for current filters.</p>
          <p className="mt-1 text-xs text-amber-800">
            Clear attribute filters or ensure variants have both “{rowAxis}” and “{colAxis}”
            on each SKU.
          </p>
        </div>
      ) : (
        <div className="w-full min-w-0 overflow-x-auto rounded-2xl border border-app-border">
          <table className="w-full min-w-[400px] border-collapse text-left text-sm sm:min-w-[480px]">
            <thead>
              <tr className="border-b border-app-border bg-app-surface-2">
                <th className="sticky left-0 z-[1] bg-app-surface-2 px-2 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {rowAxis} \ {colAxis}
                </th>
                {colKeys.map((ck) => (
                  <th key={ck} className="min-w-[5.5rem] px-1 py-2 text-center text-[10px] font-black uppercase tracking-tight text-app-text-muted">
                    {ck}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rowKeys.map((rk) => (
                <tr key={rk} className="border-b border-app-border">
                  <td className="sticky left-0 z-[1] bg-app-surface px-2 py-1">
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleRowSelected(rk)}
                      className={`flex cursor-pointer flex-col gap-0.5 rounded-lg p-1 outline-none transition-colors ${
                        selectedRows.has(rk) ? "bg-app-accent/15 ring-2 ring-app-accent" : "hover:bg-app-surface-2"
                      }`}
                    >
                      <span className="font-bold text-app-text">{rk}</span>
                      <span className="text-[9px] font-bold uppercase tracking-tight text-app-text-muted">Tap to select</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRowRetailTarget(rk)}
                      className="mt-1 w-fit text-[9px] font-black uppercase tracking-tight text-app-accent hover:underline"
                    >
                      Row price…
                    </button>
                  </td>
                  {colKeys.map((ck) => {
                    const v = cellMap.get(`${rk}\0${ck}`);
                    if (!v) return <td key={ck} className="border-l border-app-border/50 bg-app-surface-2/50 p-1 text-center text-app-text-muted">—</td>;
                    const oos = v.stock_on_hand <= 0;
                    const low =
                      v.stock_on_hand > 0 &&
                      (v.reorder_point > 0
                        ? v.stock_on_hand <= v.reorder_point
                        : v.stock_on_hand <= 2);
                    return (
                      <td key={ck} className={`relative border-l border-app-border p-1 align-top ${oos ? "bg-app-accent/15 shadow-[inset_0_0_12px_-4px_color-mix(in_srgb,var(--app-accent)_35%,transparent)]" : low ? "bg-amber-50/60" : "bg-app-surface"}`}>
                        <div className="flex flex-col gap-1 rounded-lg p-1">
                          <button
                            type="button"
                            onClick={() => setPriceTarget(v)}
                            className={`text-left text-xs tabular-nums transition-colors hover:opacity-90 ${hasRetailOverride(v) ? "font-bold text-app-accent" : "font-semibold text-app-text-muted"}`}
                          >
                            ${centsToFixed2(parseMoneyToCents(v.effective_retail || "0"))}
                          </button>
                          {priceTarget?.id === v.id && (
                            <div ref={pricePopoverRef} className="absolute left-1/2 top-[calc(100%-4px)] z-20 w-56 -translate-x-1/2 rounded-xl border border-app-border bg-app-surface p-3 shadow-xl">
                              <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Retail override</p>
                              <input
                                type="text"
                                inputMode="decimal"
                                value={priceDraft}
                                onChange={(e) => setPriceDraft(e.target.value)}
                                className="mt-2 w-full rounded-lg border border-app-border px-2 py-1.5 font-mono text-sm"
                                autoFocus
                              />
                              <div className="mt-2 flex flex-col gap-1.5">
                                <button
                                  type="button"
                                  className="rounded-lg bg-app-accent py-2 text-[10px] font-black uppercase tracking-widest text-white hover:opacity-90"
                                  onClick={async () => {
                                    const t = priceDraft.trim();
                                    if (
                                      !t ||
                                      !Number.isFinite(Number.parseFloat(t))
                                    ) {
                                      toast("Invalid price", "error");
                                      return;
                                    }
                                    const n = parseMoneyToCents(t);
                                    if (n < 0) {
                                      toast("Invalid price", "error");
                                      return;
                                    }
                                    await patchRetail(v.id, n);
                                    setPriceTarget(null);
                                  }}
                                >
                                  Set override
                                </button>
                                {hasRetailOverride(v) && (
                                  <button
                                    type="button"
                                    className="rounded-lg border border-app-border py-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                                    onClick={async () => {
                                      await patchRetailClear(v.id);
                                      setPriceTarget(null);
                                    }}
                                  >
                                    Use template
                                  </button>
                                )}
                              </div>
                            </div>
                          )}
                          <span className={`text-lg font-black tabular-nums ${oos ? "text-app-accent" : "text-app-text"}`}>{v.stock_on_hand}</span>
                          <span className="text-[9px] font-bold uppercase tracking-tight text-app-text-muted">
                            Reorder ≤ {v.reorder_point}
                          </span>
                          <input
                            type="text"
                            inputMode="numeric"
                            placeholder="+qty"
                            className="w-full rounded border border-app-border px-1 py-0.5 text-[10px] font-mono"
                            onKeyDown={(e) => {
                              if (e.key !== "Enter") return;
                              const t = (e.target as HTMLInputElement).value.trim();
                              if (!t) return;
                              const n = Number.parseInt(t, 10);
                              if (!Number.isFinite(n) || n === 0) {
                                toast("Enter e.g. +5 or -2", "info");
                                return;
                              }
                              void applyStockDelta(v.id, n);
                              (e.target as HTMLInputElement).value = "";
                            }}
                          />
                          <label
                            className={`mt-1 flex cursor-pointer items-center gap-1.5 text-[9px] font-bold uppercase tracking-tight ${
                              productTrackLowStock
                                ? "text-app-text-muted"
                                : "cursor-not-allowed text-app-text-muted/50"
                            }`}
                            title={
                              productTrackLowStock
                                ? "Include this SKU in admin morning low-stock digest when at or below reorder"
                                : "Turn on template tracking on the General tab first"
                            }
                          >
                            <input
                              type="checkbox"
                              className="h-3 w-3 rounded border-app-border"
                              disabled={!productTrackLowStock}
                              checked={v.track_low_stock}
                              onChange={(e) =>
                                void patchTrackLowStock(v.id, e.target.checked)
                              }
                            />
                            Track low
                          </label>
                          <label className="mt-1 flex cursor-pointer items-center gap-1.5 text-[9px] font-bold uppercase tracking-tight text-app-text-muted">
                            <input
                              type="checkbox"
                              className="h-3 w-3 rounded border-app-border"
                              checked={v.web_published}
                              onChange={(e) =>
                                void patchWebPublished(v.id, e.target.checked)
                              }
                            />
                            Web store
                          </label>
                          <input
                            key={`wpo-${v.id}-${v.web_price_override ?? "none"}`}
                            type="text"
                            inputMode="decimal"
                            placeholder="Web $"
                            title="Web-only price override (blank = use retail / template)"
                            className="mt-1 w-full rounded border border-app-border px-1 py-0.5 text-[9px] font-mono"
                            defaultValue={
                              v.web_price_override != null &&
                              String(v.web_price_override).trim() !== ""
                                ? centsToFixed2(
                                    parseMoneyToCents(
                                      String(v.web_price_override),
                                    ),
                                  )
                                : ""
                            }
                            onBlur={(e) => {
                              const t = e.target.value.trim();
                              const had =
                                v.web_price_override != null &&
                                String(v.web_price_override).trim() !== "";
                              if (!t && !had) return;
                              if (!t && had) {
                                void patchVariantPricingFields(v.id, {
                                  clear_web_price_override: true,
                                });
                                return;
                              }
                              const next = centsToFixed2(
                                parseMoneyToCents(t || "0"),
                              );
                              const cur =
                                v.web_price_override != null &&
                                String(v.web_price_override).trim() !== ""
                                  ? centsToFixed2(
                                      parseMoneyToCents(
                                        String(v.web_price_override),
                                      ),
                                    )
                                  : "";
                              if (next === cur) return;
                              void patchVariantPricingFields(v.id, {
                                web_price_override: next,
                              });
                            }}
                          />
                          <div className="mt-1 flex items-center gap-1">
                            <span className="text-[9px] font-bold uppercase text-app-text-muted">
                              Sort
                            </span>
                            <input
                              key={`wg-${v.id}-${v.web_gallery_order}`}
                              type="number"
                              className="w-11 rounded border border-app-border px-1 py-0.5 text-[9px] font-mono"
                              title="Gallery order on public PDP (lower first)"
                              defaultValue={v.web_gallery_order}
                              onBlur={(e) => {
                                const n = Number.parseInt(e.target.value, 10);
                                if (
                                  !Number.isFinite(n) ||
                                  n === v.web_gallery_order
                                )
                                  return;
                                void patchVariantPricingFields(v.id, {
                                  web_gallery_order: n,
                                });
                              }}
                            />
                          </div>
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="sticky bottom-0 z-[2] flex flex-wrap gap-2 rounded-2xl border border-app-border bg-app-surface/95 p-3 shadow-lg backdrop-blur-md">
        <button
          type="button"
          onClick={() => printAllVisible()}
          className="inline-flex items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-4 py-2.5 text-[10px] font-black uppercase tracking-[0.15em] text-app-text hover:bg-app-surface"
        >
          <Printer size={14} aria-hidden />
          Print (visible)
        </button>
        <button
          type="button"
          onClick={() => setShowBulkSetPrompt(true)}
          className="rounded-xl border border-app-accent/30 bg-app-accent/10 px-4 py-2.5 text-[10px] font-black uppercase tracking-[0.15em] text-app-text hover:bg-app-accent/15"
        >
          Mass price…
        </button>
        <button
          type="button"
          onClick={() => {
            if (selectedRows.size === 0) {
              toast("Select row(s) first", "info");
              return;
            }
            setShowSurchargePrompt(true);
          }}
          className="rounded-xl border border-app-accent bg-app-accent px-4 py-2.5 text-[10px] font-black uppercase tracking-[0.15em] text-white hover:opacity-90"
        >
          Surcharge
        </button>
        <button
          type="button"
          onClick={() => setShowClearConfirm(true)}
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-[10px] font-black uppercase tracking-[0.15em] text-amber-900 hover:bg-amber-100"
        >
          Reset overrides
        </button>
      </div>

      <ConfirmationModal
        isOpen={showClearConfirm}
        onClose={() => setShowClearConfirm(false)}
        onConfirm={executeClearAllRetailOverrides}
        title="Clear All Overrides"
        message="Restore ALL retail prices in this template to their base value? Every SKU will lose its custom override."
        confirmLabel="Reset All"
        variant="danger"
      />

      <PromptModal
        isOpen={showSurchargePrompt}
        onClose={() => setShowSurchargePrompt(false)}
        onSubmit={applySurcharge}
        title="Apply Surcharge"
        message={`Add $ amount to effective retail for ${selectedRows.size} row(s).`}
        placeholder="e.g. 5.00"
        type="numeric"
      />

      <PromptModal
        isOpen={!!rowRetailTarget}
        onClose={() => setRowRetailTarget(null)}
        onSubmit={executeRowRetail}
        title="Override Row Price"
        message={`Set price for all variants in the '${rowRetailTarget}' row.`}
        type="numeric"
      />

      <PromptModal
        isOpen={showBulkSetPrompt}
        onClose={() => setShowBulkSetPrompt(false)}
        onSubmit={executeBulkSetRetail}
        title="Mass Retail Update"
        message={`Set price for all ${filteredVariants.length} visible variants.`}
        type="numeric"
      />
    </div>
  );
}
