import { useCallback, useEffect, useState } from "react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface EventRow {
  id: string;
  name: string;
  receipt_label: string;
  starts_at: string;
  ends_at: string;
  percent_off: string;
  is_active: boolean;
  scope_type: string;
  scope_category_id: string | null;
  scope_vendor_id: string | null;
}

interface VarRow {
  variant_id: string;
  sku: string;
  product_name: string;
}

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

function ymdLocal(d: Date) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default function DiscountEventsPanel() {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const canView = hasPermission("catalog.view");
  const canEdit = hasPermission("catalog.edit");

  const [rows, setRows] = useState<EventRow[]>([]);
  const [sel, setSel] = useState<string | null>(null);
  const [vars, setVars] = useState<VarRow[]>([]);
  const [skuAdd, setSkuAdd] = useState("");
  const [name, setName] = useState("");
  const [receiptLabel, setReceiptLabel] = useState("");
  const [starts, setStarts] = useState("");
  const [ends, setEnds] = useState("");
  const [pct, setPct] = useState("25");
  const [scopeType, setScopeType] = useState<"variants" | "category" | "vendor">("variants");
  const [scopeCategoryId, setScopeCategoryId] = useState("");
  const [scopeVendorId, setScopeVendorId] = useState("");
  const [categories, setCategories] = useState<{ id: string; name: string }[]>([]);
  const [promoVendors, setPromoVendors] = useState<{ id: string; name: string }[]>([]);
  const [editScopeType, setEditScopeType] = useState<"variants" | "category" | "vendor">("variants");
  const [editCategoryId, setEditCategoryId] = useState("");
  const [editVendorId, setEditVendorId] = useState("");
  const [usageFrom, setUsageFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 89);
    return ymdLocal(d);
  });
  const [usageTo, setUsageTo] = useState(() => ymdLocal(new Date()));
  const [usageRows, setUsageRows] = useState<
    {
      event_id: string;
      event_name: string;
      line_count: number;
      units_sold: number;
      subtotal_sum: string;
    }[]
  >([]);

  const load = useCallback(async () => {
    if (!canView) return;
    const res = await fetch(`${baseUrl}/api/discount-events`, {
      headers: backofficeHeaders(),
    });
    if (!res.ok) {
      setRows([]);
      return;
    }
    setRows((await res.json()) as EventRow[]);
  }, [backofficeHeaders, canView]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!canView) return;
    void (async () => {
      const [cRes, vRes] = await Promise.all([
        fetch(`${baseUrl}/api/categories/`, { headers: backofficeHeaders() }),
        fetch(`${baseUrl}/api/vendors/`, { headers: backofficeHeaders() }),
      ]);
      if (cRes.ok) {
        const j = (await cRes.json()) as { id: string; name: string }[];
        setCategories(Array.isArray(j) ? j : []);
      } else setCategories([]);
      if (vRes.ok) {
        const j = (await vRes.json()) as { id: string; name: string }[];
        setPromoVendors(Array.isArray(j) ? j : []);
      } else setPromoVendors([]);
    })();
  }, [canView, backofficeHeaders]);

  useEffect(() => {
    const r = rows.find((x) => x.id === sel);
    if (!r) return;
    const st = (r.scope_type ?? "variants") as "variants" | "category" | "vendor";
    setEditScopeType(st);
    setEditCategoryId(r.scope_category_id ?? "");
    setEditVendorId(r.scope_vendor_id ?? "");
  }, [sel, rows]);

  const loadUsageReport = useCallback(async () => {
    if (!canView) return;
    const p = new URLSearchParams();
    if (usageFrom.trim()) p.set("from", usageFrom.trim());
    if (usageTo.trim()) p.set("to", usageTo.trim());
    const q = p.toString();
    const res = await fetch(
      `${baseUrl}/api/discount-events/usage-report${q ? `?${q}` : ""}`,
      { headers: backofficeHeaders() },
    );
    if (!res.ok) {
      setUsageRows([]);
      toast("Could not load usage report", "error");
      return;
    }
    setUsageRows((await res.json()) as typeof usageRows);
  }, [backofficeHeaders, canView, usageFrom, usageTo, toast]);

  const loadVars = useCallback(
    async (id: string) => {
      const res = await fetch(`${baseUrl}/api/discount-events/${id}/variants`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        setVars([]);
        return;
      }
      setVars((await res.json()) as VarRow[]);
    },
    [backofficeHeaders],
  );

  useEffect(() => {
    if (!sel) {
      setVars([]);
      return;
    }
    void loadVars(sel);
  }, [sel, loadVars]);

  const createEvent = async () => {
    if (!canEdit) return;
    if (!name.trim() || !receiptLabel.trim() || !starts || !ends) {
      toast("Fill name, receipt label, start and end", "info");
      return;
    }
    const p = Number.parseFloat(pct);
    if (!Number.isFinite(p) || p <= 0 || p > 100) {
      toast("Percent must be greater than 0 and at most 100", "error");
      return;
    }
    const body: Record<string, unknown> = {
      name: name.trim(),
      receipt_label: receiptLabel.trim(),
      starts_at: new Date(starts).toISOString(),
      ends_at: new Date(ends).toISOString(),
      percent_off: p.toFixed(2),
      scope_type: scopeType,
    };
    if (scopeType === "category") {
      if (!scopeCategoryId.trim()) {
        toast("Choose a category for this promotion", "error");
        return;
      }
      body.scope_category_id = scopeCategoryId.trim();
    }
    if (scopeType === "vendor") {
      if (!scopeVendorId.trim()) {
        toast("Choose a vendor for this promotion", "error");
        return;
      }
      body.scope_vendor_id = scopeVendorId.trim();
    }
    const res = await fetch(`${baseUrl}/api/discount-events`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Create failed", "error");
      return;
    }
    toast("Promotion created", "success");
    setName("");
    setReceiptLabel("");
    setScopeType("variants");
    setScopeCategoryId("");
    setScopeVendorId("");
    void load();
  };

  const patchSelectedScope = async () => {
    if (!canEdit || !sel) return;
    const body: Record<string, unknown> = { scope_type: editScopeType };
    if (editScopeType === "category") {
      if (!editCategoryId.trim()) {
        toast("Choose a category", "info");
        return;
      }
      body.scope_category_id = editCategoryId.trim();
    }
    if (editScopeType === "vendor") {
      if (!editVendorId.trim()) {
        toast("Choose a vendor", "info");
        return;
      }
      body.scope_vendor_id = editVendorId.trim();
    }
    const res = await fetch(`${baseUrl}/api/discount-events/${sel}`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Update failed", "error");
      return;
    }
    toast("Promotion scope updated", "success");
    void load();
    void loadVars(sel);
  };

  const addVariantBySku = async () => {
    if (!canEdit || !sel) return;
    const q = skuAdd.trim();
    if (!q) return;
    const scan = await fetch(`${baseUrl}/api/inventory/scan/${encodeURIComponent(q)}`, {
      headers: backofficeHeaders(),
    });
    if (!scan.ok) {
      toast("SKU not found", "error");
      return;
    }
    const s = (await scan.json()) as { variant_id: string };
    const res = await fetch(`${baseUrl}/api/discount-events/${sel}/variants`, {
      method: "POST",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ variant_id: s.variant_id }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Add failed", "error");
      return;
    }
    setSkuAdd("");
    toast("Variant added", "success");
    void loadVars(sel);
  };

  if (!canView) {
    return (
      <p className="text-sm text-app-text-muted">Catalog view permission required.</p>
    );
  }

  return (
    <div className="space-y-8">
      <div className="rounded-xl border border-app-border bg-app-surface-2/80 p-4">
        <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
          Checkout usage by event
        </h3>
        <p className="mt-1 text-xs text-app-text-muted">
          Lines that applied a discount event at checkout (UTC date range).
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-[10px] font-black uppercase text-app-text-muted">
            From
            <input
              type="date"
              className="ui-input mt-1 block font-mono text-sm"
              value={usageFrom}
              onChange={(e) => setUsageFrom(e.target.value)}
            />
          </label>
          <label className="text-[10px] font-black uppercase text-app-text-muted">
            To
            <input
              type="date"
              className="ui-input mt-1 block font-mono text-sm"
              value={usageTo}
              onChange={(e) => setUsageTo(e.target.value)}
            />
          </label>
          <button
            type="button"
            onClick={() => void loadUsageReport()}
            className="ui-btn-secondary px-4 py-2 text-xs font-black uppercase"
          >
            Refresh
          </button>
        </div>
        <div className="mt-3 overflow-x-auto rounded-lg border border-app-border">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead className="border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase text-app-text-muted">
              <tr>
                <th className="px-3 py-2">Event</th>
                <th className="px-3 py-2 text-right">Lines</th>
                <th className="px-3 py-2 text-right">Units</th>
                <th className="px-3 py-2 text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {usageRows.map((u) => (
                <tr key={u.event_id} className="border-b border-app-border/60">
                  <td className="px-3 py-2 font-medium">{u.event_name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{u.line_count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{u.units_sold}</td>
                  <td className="px-3 py-2 text-right font-mono tabular-nums">
                    ${u.subtotal_sum}
                  </td>
                </tr>
              ))}
              {usageRows.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="px-3 py-6 text-center text-xs text-app-text-muted"
                  >
                    No usage in this range. Adjust dates and press Refresh.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
          New promotion / sale
        </h3>
        <p className="mt-1 text-xs text-app-text-muted">
          Sale price = retail minus this percent, for the active dates. Pick products by SKU list, whole category, or
          vendor (primary vendor on the product template).
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <input
            className="ui-input"
            placeholder="Name (internal)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <input
            className="ui-input"
            placeholder="Receipt label (e.g. Holiday Sale)"
            value={receiptLabel}
            onChange={(e) => setReceiptLabel(e.target.value)}
          />
          <input
            className="ui-input"
            type="datetime-local"
            value={starts}
            onChange={(e) => setStarts(e.target.value)}
          />
          <input
            className="ui-input"
            type="datetime-local"
            value={ends}
            onChange={(e) => setEnds(e.target.value)}
          />
          <input
            className="ui-input"
            placeholder="Percent off retail"
            value={pct}
            onChange={(e) => setPct(e.target.value)}
          />
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Applies to
            <select
              className="ui-input text-sm font-semibold normal-case"
              value={scopeType}
              onChange={(e) =>
                setScopeType(e.target.value as "variants" | "category" | "vendor")
              }
            >
              <option value="variants">Selected products (SKUs below after create)</option>
              <option value="category">Whole category</option>
              <option value="vendor">Primary vendor</option>
            </select>
          </label>
          {scopeType === "category" ? (
            <label className="sm:col-span-2 flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Category
              <select
                className="ui-input text-sm font-semibold normal-case"
                value={scopeCategoryId}
                onChange={(e) => setScopeCategoryId(e.target.value)}
              >
                <option value="">Select…</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {scopeType === "vendor" ? (
            <label className="sm:col-span-2 flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Vendor
              <select
                className="ui-input text-sm font-semibold normal-case"
                value={scopeVendorId}
                onChange={(e) => setScopeVendorId(e.target.value)}
              >
                <option value="">Select…</option>
                {promoVendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => void createEvent()}
            className="ui-btn-primary mt-3 px-6 py-2 text-xs font-black uppercase tracking-widest"
          >
            Create promotion
          </button>
        ) : null}
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">Promotions</h3>
          <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto rounded-xl border border-app-border">
            {rows.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSel(r.id)}
                  className={`flex w-full flex-col items-start px-3 py-2 text-left text-sm ${
                    sel === r.id ? "bg-app-accent/10 font-bold" : "hover:bg-app-surface-2"
                  }`}
                >
                  <span>{r.name}</span>
                  <span className="text-xs text-app-text-muted">
                    {r.receipt_label} · {r.percent_off}% · scope: {r.scope_type ?? "variants"} ·{" "}
                    {r.is_active ? "active" : "off"}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {sel && canEdit ? (
            <div className="mt-4 rounded-xl border border-app-border bg-app-surface-2/60 p-3">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Edit scope
              </h4>
              <p className="mt-1 text-[11px] text-app-text-muted">
                Changing scope clears manual SKU lists when switching away from selected products.
              </p>
              <div className="mt-2 flex flex-col gap-2">
                <select
                  className="ui-input text-sm"
                  value={editScopeType}
                  onChange={(e) =>
                    setEditScopeType(e.target.value as "variants" | "category" | "vendor")
                  }
                >
                  <option value="variants">Selected products (SKUs)</option>
                  <option value="category">Whole category</option>
                  <option value="vendor">Primary vendor</option>
                </select>
                {editScopeType === "category" ? (
                  <select
                    className="ui-input text-sm"
                    value={editCategoryId}
                    onChange={(e) => setEditCategoryId(e.target.value)}
                  >
                    <option value="">Select category…</option>
                    {categories.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                {editScopeType === "vendor" ? (
                  <select
                    className="ui-input text-sm"
                    value={editVendorId}
                    onChange={(e) => setEditVendorId(e.target.value)}
                  >
                    <option value="">Select vendor…</option>
                    {promoVendors.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  onClick={() => void patchSelectedScope()}
                  className="ui-btn-secondary py-2 text-[10px] font-black uppercase"
                >
                  Save scope
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            SKUs in promotion
          </h3>
          {sel && rows.find((x) => x.id === sel)?.scope_type === "variants" && canEdit ? (
            <div className="mt-2 flex gap-2">
              <input
                className="ui-input flex-1 font-mono text-sm"
                placeholder="Scan or type SKU"
                value={skuAdd}
                onChange={(e) => setSkuAdd(e.target.value)}
              />
              <button
                type="button"
                onClick={() => void addVariantBySku()}
                className="ui-btn-secondary px-4 text-xs font-black uppercase"
              >
                Add
              </button>
            </div>
          ) : sel && rows.find((x) => x.id === sel)?.scope_type !== "variants" ? (
            <p className="mt-2 text-xs text-app-text-muted">
              This promotion applies by category or vendor. Use POS to apply the promotion to lines that match.
            </p>
          ) : null}
          <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto text-sm">
            {vars.map((v) => (
              <li key={v.variant_id} className="flex justify-between border-b border-app-border py-1">
                <span>
                  {v.sku} — {v.product_name}
                </span>
                {canEdit ? (
                  <button
                    type="button"
                    className="text-xs text-red-600"
                    onClick={async () => {
                      await fetch(
                        `${baseUrl}/api/discount-events/${sel}/variants/${v.variant_id}`,
                        { method: "DELETE", headers: backofficeHeaders() },
                      );
                      void loadVars(sel!);
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
