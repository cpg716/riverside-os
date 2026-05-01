import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderTree, Clock3, Tag, Settings2, History, Zap } from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import { useMediaQuery } from "../../hooks/useMediaQuery";

interface CategoryNode {
  id: string;
  name: string;
  is_clothing_footwear: boolean;
  parent_id: string | null;
  matrix_row_axis_key: string | null;
  matrix_col_axis_key: string | null;
  variation_axis_presets: string[];
  children: CategoryNode[];
}

interface FlatCategory {
  id: string;
  name: string;
}

interface CategoryAuditEntry {
  id: string;
  category_id: string;
  category_name: string;
  changed_field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: string | null;
  changed_by_name: string | null;
  change_note: string | null;
  created_at: string;
}

function collectFlat(nodes: CategoryNode[], out: FlatCategory[] = []): FlatCategory[] {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name });
    collectFlat(node.children, out);
  }
  return out;
}

function CategoryVariationAxisEditor({
  node,
  depth,
  baseUrl,
  actorStaffId,
  onSaved,
}: {
  node: CategoryNode;
  depth: number;
  baseUrl: string;
  actorStaffId: string | null;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const [axes, setAxes] = useState<string[]>(
    node.variation_axis_presets?.length
      ? node.variation_axis_presets.slice(0, 3)
      : [node.matrix_row_axis_key ?? "", node.matrix_col_axis_key ?? "", ""],
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setAxes(
      node.variation_axis_presets?.length
        ? [...node.variation_axis_presets.slice(0, 3), "", "", ""].slice(0, 3)
        : [node.matrix_row_axis_key ?? "", node.matrix_col_axis_key ?? "", ""],
    );
  }, [node.id, node.matrix_row_axis_key, node.matrix_col_axis_key, node.variation_axis_presets]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(apiUrl(baseUrl, `/api/categories/${node.id}`), {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...mergedPosStaffHeaders(backofficeHeaders),
        },
        body: JSON.stringify({
          variation_axis_presets: axes.map((axis) => axis.trim()).filter(Boolean),
          changed_by_staff_id: actorStaffId,
          change_note: "Variation axes (Category Manager)",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error ?? "We couldn't save the category defaults. Please try again.", "error");
        return;
      }
      onSaved();
      toast("Category option defaults updated", "success");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-4 rounded-3xl border border-dashed border-app-border bg-app-surface px-6 py-4 sm:flex-row sm:items-center group hover:bg-app-accent/5 transition-all"
      style={{ marginInlineStart: `${depth * 28}px` }}
    >
      <div className="flex items-center gap-2 text-app-text-muted">
         <Settings2 size={16} className="opacity-40" />
         <span className="text-[10px] font-black uppercase tracking-widest leading-none">Default Options</span>
      </div>
      <div className="flex flex-1 flex-wrap gap-3">
          {[0, 1, 2].map((idx) => (
            <input
              key={idx}
              value={axes[idx] ?? ""}
              onChange={(e) =>
                setAxes((prev) =>
                  [0, 1, 2].map((axisIdx) =>
                    axisIdx === idx ? e.target.value : (prev[axisIdx] ?? ""),
                  ),
                )
              }
              placeholder={`Option type ${idx + 1}${idx === 0 ? ", e.g. Size" : ""}`}
              className="ui-input h-10 min-w-[150px] flex-1 text-xs font-bold"
            />
          ))}
      </div>
      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="ui-btn-primary h-10 px-6 rounded-xl text-[10px] font-black uppercase tracking-widest disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save Defaults"}
      </button>
    </div>
  );
}

export default function CategoryManager() {
  const isCompactLayout = useMediaQuery("(max-width: 1023px)");
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = getBaseUrl();
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  
  const [createName, setCreateName] = useState("");
  const [createParentId, setCreateParentId] = useState("");
  const [createIsClothing, setCreateIsClothing] = useState(false);
  const [createAxes, setCreateAxes] = useState(["", "", ""]);
  
  const [auditRows, setAuditRows] = useState<CategoryAuditEntry[]>([]);
  const [actorStaffId, setActorStaffId] = useState<string | null>(null);

  const flat = useMemo(() => collectFlat(tree), [tree]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/categories/tree"), {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("Failed to load category tree");
      setTree((await res.json()) as CategoryNode[]);
      
      const sessionRes = await fetch(apiUrl(baseUrl, "/api/sessions/current"), {
        headers: apiAuth(),
      });
      if (sessionRes.ok) {
        const session = (await sessionRes.json()) as {
          register_primary_staff_id?: string;
        };
        setActorStaffId(session.register_primary_staff_id ?? null);
      }
      
      const auditRes = await fetch(
        apiUrl(baseUrl, "/api/categories/audit?limit=150"),
        { headers: apiAuth() },
      );
      if (auditRes.ok) {
        setAuditRows((await auditRes.json()) as CategoryAuditEntry[]);
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Failed to load categories", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, apiAuth, toast]);

  const groupedAudit = useMemo(() => {
    const map = new Map<string, CategoryAuditEntry[]>();
    for (const row of auditRows) {
      const key = row.category_name;
      const bucket = map.get(key) ?? [];
      bucket.push(row);
      map.set(key, bucket);
    }
    return Array.from(map.entries()) as [string, CategoryAuditEntry[]][];
  }, [auditRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createCategory = async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(apiUrl(baseUrl, "/api/categories"), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          name: createName.trim(),
          parent_id: createParentId || null,
          is_clothing_footwear: createIsClothing,
          changed_by_staff_id: actorStaffId,
          change_note: "Created in Category Manager Hub",
          variation_axis_presets: createAxes.map((axis) => axis.trim()).filter(Boolean),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error ?? "Failed to create category", "error");
        return;
      }
      setCreateName("");
      setCreateParentId("");
      setCreateIsClothing(false);
      setCreateAxes(["", "", ""]);
      toast("Category added", "success");
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const toggleTaxRule = async (node: CategoryNode) => {
    const res = await fetch(apiUrl(baseUrl, `/api/categories/${node.id}`), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        ...apiAuth(),
      },
      body: JSON.stringify({
        is_clothing_footwear: !node.is_clothing_footwear,
        changed_by_staff_id: actorStaffId,
        change_note: "Tax status manual toggle",
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Failed to update category", "error");
      return;
    }
    toast(`${node.name} tax classification updated`, "success");
    await refresh();
  };

  const NodeRow = ({
    node,
    depth,
    inheritedExempt,
  }: {
    node: CategoryNode;
    depth: number;
    inheritedExempt: boolean;
  }) => {
    const effectiveExempt = inheritedExempt || node.is_clothing_footwear;
    const depthIndent = Math.min(depth * (isCompactLayout ? 16 : 28), isCompactLayout ? 56 : 280);
    return (
      <div className="space-y-4">
        <div
          className="group relative flex flex-wrap items-center justify-between gap-4 rounded-[2rem] border border-app-border bg-app-surface px-4 py-4 shadow-sm transition-all hover:border-app-accent/20 hover:bg-app-accent/5 sm:px-6 sm:py-5"
          style={{ marginInlineStart: `${depthIndent}px` }}
        >
           {/* Visual connection line if depth > 0 */}
           {depth > 0 && (
               <div className="absolute left-[-20px] top-1/2 h-px w-5 bg-app-border" />
           )}
           
          <div className="flex items-center gap-4">
             <div className={`flex h-10 w-10 items-center justify-center rounded-2xl border ${node.is_clothing_footwear ? 'border-emerald-200 bg-emerald-50 text-emerald-600' : 'border-app-border bg-app-surface-2 text-app-text-muted'}`}>
                <Tag size={18} />
             </div>
             <div>
               <h4 className="text-sm font-black uppercase tracking-tight text-app-text italic">
                 {node.name}
               </h4>
               <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest opacity-60">
                  {node.children.length} subcategor{node.children.length === 1 ? "y" : "ies"}
               </p>
             </div>
          </div>

          <div className="flex w-full items-center justify-end gap-4 sm:w-auto sm:gap-6">
            <div className="text-right hidden sm:block">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted leading-tight">Tax Implication</p>
                <select
                    value={node.is_clothing_footwear ? "clothing_footwear" : "standard"}
                    onChange={() => void toggleTaxRule(node)}
                    className={`mt-1 rounded-full border px-3 py-1 text-[9px] font-black uppercase tracking-widest transition-all ${
                      node.is_clothing_footwear
                        ? "border-app-success/20 bg-app-success/10 text-app-success shadow-sm"
                        : "border-app-border bg-app-surface-2 text-app-text-muted"
                    }`}
                >
                    <option value="standard">Standard taxable</option>
                    <option value="clothing_footwear">Clothing / footwear</option>
                </select>
            </div>

            <div className="hidden h-10 w-px bg-app-border/40 sm:block" />

            <div className="hidden xl:flex flex-col items-end">
                <span className={`text-[9px] font-black uppercase tracking-widest leading-tight ${effectiveExempt ? 'text-app-success' : 'text-app-text-muted opacity-40'}`}>
                    Status
                </span>
                <span className={`text-[10px] font-black uppercase italic ${effectiveExempt ? 'text-app-success' : 'text-app-text-muted'}`}>
                    {effectiveExempt ? 'Tax-Protected' : 'Global Rate'}
                </span>
            </div>
          </div>
        </div>

        <CategoryVariationAxisEditor
          node={node}
          depth={depth}
          baseUrl={baseUrl}
          actorStaffId={actorStaffId}
          onSaved={() => void refresh()}
        />

        <div className="space-y-4">
            {node.children.map((child) => (
            <NodeRow
                key={child.id}
                node={child}
                depth={depth + 1}
                inheritedExempt={effectiveExempt}
            />
            ))}
        </div>
      </div>
    );
  };

  return (
    <div className="animate-in fade-in slide-in-from-bottom-8 flex min-h-0 flex-1 flex-col gap-6 duration-700 sm:gap-8">
      <div className="flex items-center justify-between px-1 sm:px-2">
        <div>
          <h3 className="text-[11px] font-black uppercase tracking-[0.3em] text-app-text-muted opacity-40 mb-1">Item Groups</h3>
          <h2 className="text-2xl font-black tracking-tight text-app-text">Categories</h2>
        </div>
        <button 
           onClick={() => void refresh()}
           className="h-10 w-10 flex items-center justify-center rounded-xl bg-app-surface border border-app-border text-app-text-muted hover:text-app-accent hover:border-app-accent transition-all shadow-sm active:scale-95"
        >
           <Zap size={18} />
        </button>
      </div>

      {/* Modernized Quick Create Registry Bar */}
      <section className="rounded-[2rem] border border-app-border bg-app-surface p-4 shadow-[0_16px_36px_rgba(15,23,42,0.06),0_4px_10px_rgba(15,23,42,0.04)] sm:rounded-[2.5rem] sm:p-8">
         <div className="grid gap-4 sm:gap-6 md:grid-cols-[1fr_240px_180px_180px_160px]">
            <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-2">Category Name</label>
                <input
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="e.g. Formal Footwear"
                    className="w-full h-12 bg-app-surface border border-app-border rounded-2xl px-5 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 transition-all"
                />
            </div>
            <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-2">Parent Category</label>
                <select
                    value={createParentId}
                    onChange={(e) => setCreateParentId(e.target.value)}
                    className="w-full h-12 bg-app-surface border border-app-border rounded-2xl px-5 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 transition-all"
                >
                    <option value="">Top-Level Category</option>
                    {flat.map((c) => (
                    <option key={c.id} value={c.id}>
                        {c.name}
                    </option>
                    ))}
                </select>
            </div>
	            {[0, 1, 2].map((idx) => (
	              <div key={idx} className="space-y-2">
	                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted px-2">
	                  Option Type {idx + 1}
	                </label>
	                <input
	                  value={createAxes[idx] ?? ""}
	                  onChange={(e) =>
	                    setCreateAxes((prev) =>
	                      [0, 1, 2].map((axisIdx) =>
	                        axisIdx === idx ? e.target.value : (prev[axisIdx] ?? ""),
	                      ),
	                    )
	                  }
	                  placeholder={idx === 0 ? "e.g. Size" : idx === 1 ? "e.g. Color" : "e.g. Fit"}
	                  className="w-full h-12 bg-app-surface border border-app-border rounded-2xl px-5 text-sm font-bold focus:ring-2 focus:ring-app-accent/20 transition-all"
	                />
	              </div>
	            ))}
            <div className="flex flex-col justify-end gap-3">
                 <label className="space-y-1 px-1">
                    <span className="text-[10px] font-black uppercase tracking-tight text-app-text-muted">Tax Category</span>
                    <select
                        value={createIsClothing ? "clothing_footwear" : "standard"}
                        onChange={(e) => setCreateIsClothing(e.target.value === "clothing_footwear")}
                        className="h-10 w-full rounded-xl border border-app-border bg-app-surface px-3 text-[10px] font-black uppercase tracking-tight text-app-text"
                    >
                        <option value="standard">Standard taxable</option>
                        <option value="clothing_footwear">Clothing / footwear</option>
                    </select>
                 </label>
                 <button
                    type="button"
                    disabled={creating || !createName.trim()}
                    onClick={() => void createCategory()}
                    className="h-12 rounded-2xl bg-app-accent text-[10px] font-black uppercase tracking-widest text-white shadow-xl shadow-app-accent/20 disabled:opacity-20 transition-all active:scale-95"
                >
                    {creating ? "Saving..." : "Add Category"}
                </button>
            </div>
         </div>
      </section>

      <div className="grid min-h-0 flex-1 gap-6 sm:gap-8 lg:grid-cols-[1fr_360px]">
        {/* TREE VIEW */}
        <div className="min-h-0 space-y-6 overflow-visible pb-8 sm:pb-20 lg:overflow-y-auto lg:pr-4 no-scrollbar">
          {loading ? (
             <div className="flex flex-col items-center py-20 opacity-20">
                <FolderTree size={64} className="animate-pulse" />
                <p className="mt-4 text-[10px] font-black uppercase tracking-[0.3em]">Loading categories...</p>
             </div>
          ) : tree.length === 0 ? (
            <div className="flex flex-col items-center py-20 opacity-20">
               <FolderTree size={64} />
               <p className="mt-4 text-[10px] font-black uppercase tracking-[0.3em]">No categories yet</p>
            </div>
          ) : (
            tree.map((node) => (
              <NodeRow key={node.id} node={node} depth={0} inheritedExempt={false} />
            ))
          )}
        </div>

        {/* AUDIT ASIDE */}
        <aside className="flex min-h-0 flex-col overflow-visible rounded-[2rem] border border-app-border bg-app-surface shadow-[0_16px_36px_rgba(15,23,42,0.06),0_4px_10px_rgba(15,23,42,0.04)] sm:rounded-[2.5rem] lg:overflow-hidden">
          <div className="flex items-center justify-between border-b border-app-border px-8 py-6 bg-app-surface-2">
            <div className="flex items-center gap-3 text-app-text-muted">
              <History size={18} className="text-app-accent" />
              <h4 className="text-[11px] font-black uppercase tracking-[0.2em]">Recent Changes</h4>
            </div>
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-visible p-4 sm:p-6 lg:overflow-y-auto no-scrollbar">
            {groupedAudit.length === 0 ? (
              <div className="flex flex-col items-center py-20 opacity-20">
                <Clock3 size={32} />
                <p className="mt-3 text-[10px] font-black uppercase tracking-widest text-center">No recent changes</p>
              </div>
            ) : (
              groupedAudit.map(([category, entries]) => (
                <div key={category} className="rounded-[2.5rem] border border-app-border bg-app-surface-2 p-6 shadow-sm">
                  <h5 className="mb-4 text-[11px] font-black uppercase tracking-widest text-app-text italic">
                    {category}
                  </h5>
                  <div className="space-y-3">
                    {entries.slice(0, 8).map((entry) => (
                      <div key={entry.id} className="group relative pl-4 border-l-2 border-app-border hover:border-app-accent-2 transition-all">
                        <p className="text-[11px] font-black text-app-text uppercase tracking-tight">
                          {entry.changed_field}
                        </p>
                        <p className="text-[10px] font-bold text-app-text-muted leading-tight mt-0.5">
                           {entry.old_value || "—"} → <span className="text-app-text">{entry.new_value || "—"}</span>
                        </p>
                        <div className="mt-2 flex items-center gap-2 text-[8px] font-black uppercase tracking-widest text-app-text-muted opacity-40">
                          {new Date(entry.created_at).toLocaleDateString()} · {entry.changed_by_name || "System"}
                        </div>
                        {entry.change_note && (
                          <div className="mt-1.5 rounded-lg bg-app-surface-2 p-2 text-[9px] font-bold text-app-text-muted leading-relaxed">
                            {entry.change_note}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="bg-app-surface p-6 border-t border-app-border/40 text-center">
             <p className="text-[9px] font-black uppercase tracking-tighter text-app-text-muted opacity-40">Showing the last 150 changes</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
