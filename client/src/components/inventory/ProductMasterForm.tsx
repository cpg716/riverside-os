import { useCallback, useEffect, useMemo, useState } from "react";
import MatrixBuilder, { type GeneratedMatrixRow } from "./MatrixBuilder";
import { apiUrl } from "../../lib/apiUrl";
import { useToast } from "../ui/ToastProvider";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";

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

export default function ProductMasterForm({ onCreated }: ProductMasterFormProps) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const [categories, setCategories] = useState<Category[]>([]);
  const [name, setName] = useState("");
  const [brand, setBrand] = useState("");
  const [description, setDescription] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [baseRetail, setBaseRetail] = useState("0.00");
  const [baseCost, setBaseCost] = useState("0.00");
  const [imagesRaw, setImagesRaw] = useState("");
  const [rows, setRows] = useState<GeneratedMatrixRow[]>([]);
  const [axes, setAxes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [trackLowStockTemplate, setTrackLowStockTemplate] = useState(false);
  const [publishVariantsToWeb, setPublishVariantsToWeb] = useState(false);
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

  const submitProduct = async () => {
    if (!name.trim() || rows.length === 0) return;
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
          base_retail_price: centsToFixed2(parseMoneyToCents(baseRetail || "0")),
          base_cost: centsToFixed2(parseMoneyToCents(baseCost || "0")),
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
      setName("");
      setBrand("");
      setDescription("");
      setBaseRetail("0.00");
      setBaseCost("0.00");
      setRows([]);
      setTrackLowStockTemplate(false);
      setPublishVariantsToWeb(false);
      onCreated?.();
      toast("Product and matrix variants created.", "success");
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to create product", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-app-border bg-app-surface p-4">
        <h2 className="mb-3 text-sm font-black uppercase tracking-wider text-app-text">
          Product Master
        </h2>
        <div className="grid gap-3 md:grid-cols-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Product name"
            className="ui-input"
          />
          <input
            value={brand}
            onChange={(e) => setBrand(e.target.value)}
            placeholder="Brand"
            className="ui-input"
          />
          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="ui-input"
          >
            <option value="">Select category</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <div className="rounded border border-app-border px-3 py-2 text-xs text-app-text-muted">
            Tax badge:{" "}
            {categoryBadge ? (
              categoryBadge.is_clothing_footwear ? (
                <span className="font-bold text-emerald-700">
                  Clothing/Footwear Approved
                </span>
              ) : (
                <span className="font-bold text-app-text-muted">General Merchandise</span>
              )
            ) : (
              "Select category"
            )}
          </div>
          <input
            value={baseRetail}
            onChange={(e) => setBaseRetail(e.target.value)}
            placeholder="Base retail"
            type="number"
            step="0.01"
            className="ui-input"
          />
          <input
            value={baseCost}
            onChange={(e) => setBaseCost(e.target.value)}
            placeholder="Base cost"
            type="number"
            step="0.01"
            className="ui-input"
          />
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Description"
            className="ui-input md:col-span-2"
          />
          <input
            value={imagesRaw}
            onChange={(e) => setImagesRaw(e.target.value)}
            placeholder="Image URLs (comma separated, max 5)"
            className="ui-input md:col-span-2"
          />
          <label className="flex cursor-pointer items-start gap-3 md:col-span-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-app-border"
              checked={trackLowStockTemplate}
              onChange={(e) => setTrackLowStockTemplate(e.target.checked)}
            />
            <span className="text-sm text-app-text">
              <span className="font-bold">Track low stock</span>
              <span className="mt-0.5 block text-xs text-app-text-muted">
                Off by default. When on, you can opt in individual SKUs in the product hub Matrix tab
                for admin morning low-stock alerts.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 md:col-span-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 rounded border-app-border"
              checked={publishVariantsToWeb}
              onChange={(e) => setPublishVariantsToWeb(e.target.checked)}
            />
            <span className="text-sm text-app-text">
              <span className="font-bold">Publish new variants to web store</span>
              <span className="mt-0.5 block text-xs text-app-text-muted">
                Sets web visibility on every SKU created here. The product still needs a catalog
                handle and published template before it appears on the public shop.
              </span>
            </span>
          </label>
        </div>
      </section>

      <MatrixBuilder
        onGenerated={(generated, axisNames) => {
          setRows(generated);
          setAxes(axisNames);
        }}
      />

      {rows.length > 0 && (
        <section className="rounded-xl border border-app-border bg-app-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-black uppercase tracking-wider text-app-text">
              Generated Variants ({rows.length})
            </h3>
            <button
              type="button"
              onClick={submitProduct}
              disabled={busy}
              className="ui-btn-primary text-sm normal-case tracking-normal disabled:opacity-50"
            >
              {busy ? "Saving..." : "Save Product + Variants"}
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto rounded border border-app-border">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-app-surface-2">
                <tr>
                  <th className="px-2 py-2">SKU</th>
                  <th className="px-2 py-2">Variation</th>
                  <th className="px-2 py-2 text-right">Stock</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={`${r.sku}-${i}`} className="border-t border-app-border">
                    <td className="px-2 py-2 font-mono">{r.sku}</td>
                    <td className="px-2 py-2">{r.variation_label}</td>
                    <td className="px-2 py-2 text-right">{r.stock_on_hand}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
