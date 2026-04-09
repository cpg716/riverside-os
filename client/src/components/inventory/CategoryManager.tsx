import { useCallback, useEffect, useMemo, useState } from "react";
import { FolderTree, Clock3, CheckCircle2, ChevronRight, ShieldAlert } from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";

interface CategoryNode {
  id: string;
  name: string;
  is_clothing_footwear: boolean;
  parent_id: string | null;
  matrix_row_axis_key: string | null;
  matrix_col_axis_key: string | null;
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

function CategoryMatrixAxisEditor({
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
  const [row, setRow] = useState(node.matrix_row_axis_key ?? "");
  const [col, setCol] = useState(node.matrix_col_axis_key ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setRow(node.matrix_row_axis_key ?? "");
    setCol(node.matrix_col_axis_key ?? "");
  }, [node.id, node.matrix_row_axis_key, node.matrix_col_axis_key]);

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
          matrix_row_axis_key: row.trim(),
          matrix_col_axis_key: col.trim(),
          changed_by_staff_id: actorStaffId,
          change_note: "Matrix axes (Category Manager)",
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        toast(body.error ?? "Failed to save matrix keys", "error");
        return;
      }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="flex flex-col gap-2 rounded-xl border border-dashed border-app-border bg-app-surface px-4 py-3 sm:flex-row sm:flex-wrap sm:items-end"
      style={{ marginInlineStart: `${depth * 20}px` }}
    >
      <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        Matrix row key
        <input
          value={row}
          onChange={(e) => setRow(e.target.value)}
          placeholder="e.g. Neck"
          className="ui-input font-semibold normal-case tracking-normal"
        />
      </label>
      <label className="flex min-w-[140px] flex-1 flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
        Matrix col key
        <input
          value={col}
          onChange={(e) => setCol(e.target.value)}
          placeholder="e.g. Sleeve"
          className="ui-input font-semibold normal-case tracking-normal"
        />
      </label>
      <button
        type="button"
        disabled={saving}
        onClick={() => void save()}
        className="ui-btn-primary px-4 py-2 disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save axes"}
      </button>
      <p className="w-full text-[10px] text-app-text-muted sm:order-last">
        Must match JSON keys in variant variation values. Leave blank and save to clear.
      </p>
    </div>
  );
}

export default function CategoryManager() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";
  const [tree, setTree] = useState<CategoryNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [createName, setCreateName] = useState("");
  const [createParentId, setCreateParentId] = useState("");
  const [createIsClothing, setCreateIsClothing] = useState(false);
  const [createMatrixRow, setCreateMatrixRow] = useState("");
  const [createMatrixCol, setCreateMatrixCol] = useState("");
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
      } else {
        setActorStaffId(null);
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
    return Array.from(map.entries());
  }, [auditRows]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createCategory = async () => {
    if (!createName.trim()) return;
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
        change_note: "Created in Category & Tax Manager",
        ...(createMatrixRow.trim()
          ? { matrix_row_axis_key: createMatrixRow.trim() }
          : {}),
        ...(createMatrixCol.trim()
          ? { matrix_col_axis_key: createMatrixCol.trim() }
          : {}),
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
    setCreateMatrixRow("");
    setCreateMatrixCol("");
    await refresh();
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
        change_note: "Updated in Category & Tax Manager",
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(body.error ?? "Failed to update category", "error");
      return;
    }
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
    return (
      <div className="space-y-2">
        <div
          className="group flex items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 p-4 transition-all hover:border-app-accent-2/50"
          style={{ marginInlineStart: `${depth * 20}px` }}
        >
          <div className="flex items-center gap-3">
            <ChevronRight size={18} className="text-app-text-muted" />
            <span className="font-black uppercase tracking-tight text-app-text">
              {node.name}
            </span>
          </div>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => void toggleTaxRule(node)}
              className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-tighter transition-all ${
                node.is_clothing_footwear
                  ? "border-emerald-200 bg-emerald-50 text-emerald-600"
                  : "border-app-border bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {node.is_clothing_footwear ? (
                <CheckCircle2 size={12} />
              ) : (
                <ShieldAlert size={12} />
              )}
              {node.is_clothing_footwear
                ? "Clothing/Footwear (explicit)"
                : "Standard tax (explicit)"}
            </button>
            <span
              className={`rounded px-2 py-0.5 text-[9px] font-black uppercase ${
                effectiveExempt
                  ? "bg-emerald-50 text-emerald-600"
                  : "bg-app-surface-2 text-app-text-muted"
              }`}
            >
              {effectiveExempt ? "Inherited exemption active" : "No exemption"}
            </span>
          </div>
        </div>

        <CategoryMatrixAxisEditor
          node={node}
          depth={depth}
          baseUrl={baseUrl}
          actorStaffId={actorStaffId}
          onSaved={() => void refresh()}
        />

        {node.children.map((child) => (
          <NodeRow
            key={child.id}
            node={child}
            depth={depth + 1}
            inheritedExempt={effectiveExempt}
          />
        ))}
      </div>
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-sm">
      <div className="flex items-center justify-between border-b border-app-border bg-app-surface-2/50 p-6">
        <div className="flex items-center gap-3">
          <FolderTree className="text-app-accent-2" size={22} />
          <h3 className="text-lg font-black uppercase italic tracking-tighter text-app-text">
            Category Hierarchy
          </h3>
        </div>
      </div>

      <div className="space-y-2 border-b border-app-border bg-app-surface p-4">
        <div className="grid gap-2 md:grid-cols-4">
          <input
            value={createName}
            onChange={(e) => setCreateName(e.target.value)}
            placeholder="New category name"
            className="ui-input"
          />
          <select
            value={createParentId}
            onChange={(e) => setCreateParentId(e.target.value)}
            className="ui-input"
          >
            <option value="">Top-level category</option>
            {flat.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm font-bold text-app-text">
            <input
              type="checkbox"
              checked={createIsClothing}
              onChange={(e) => setCreateIsClothing(e.target.checked)}
            />
            Clothing / footwear exempt
          </label>
          <button
            type="button"
            onClick={() => void createCategory()}
            className="ui-btn-primary shadow-lg shadow-black/20"
          >
            New Category
          </button>
        </div>
        <div className="grid gap-2 md:grid-cols-2">
          <input
            value={createMatrixRow}
            onChange={(e) => setCreateMatrixRow(e.target.value)}
            placeholder="Optional matrix row key (e.g. Neck)"
            className="ui-input"
          />
          <input
            value={createMatrixCol}
            onChange={(e) => setCreateMatrixCol(e.target.value)}
            placeholder="Optional matrix column key (e.g. Sleeve)"
            className="ui-input"
          />
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 p-6 lg:grid-cols-2">
        <div className="min-h-0 space-y-3 overflow-y-auto">
          {loading ? (
            <p className="text-sm font-medium text-app-text-muted">Loading categories...</p>
          ) : tree.length === 0 ? (
            <p className="text-sm font-medium text-app-text-muted">
              No categories yet. Create your first category above.
            </p>
          ) : (
            tree.map((node) => (
              <NodeRow key={node.id} node={node} depth={0} inheritedExempt={false} />
            ))
          )}
        </div>

        <aside className="min-h-0 overflow-hidden rounded-2xl border border-app-border bg-app-surface-2">
          <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Clock3 size={16} className="text-app-text-muted" />
              <h4 className="text-xs font-black uppercase tracking-widest text-app-text-muted">
                Category Audit History
              </h4>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted hover:text-app-accent-2"
            >
              Refresh
            </button>
          </div>
          <div className="min-h-0 space-y-3 overflow-y-auto p-3">
            {groupedAudit.length === 0 ? (
              <p className="p-2 text-xs text-app-text-muted">No category changes logged yet.</p>
            ) : (
              groupedAudit.map(([category, entries]) => (
                <div key={category} className="rounded-xl border border-app-border bg-app-surface p-3">
                  <p className="mb-2 text-xs font-black uppercase tracking-widest text-app-text">
                    {category}
                  </p>
                  <div className="space-y-2">
                    {entries.slice(0, 6).map((entry) => (
                      <div key={entry.id} className="rounded-lg bg-app-surface-2 p-2">
                        <p className="text-[11px] font-bold text-app-text">
                          {entry.changed_field}:{" "}
                          <span className="text-app-text-muted">
                            {entry.old_value ?? "null"} {"->"} {entry.new_value ?? "null"}
                          </span>
                        </p>
                        <p className="text-[10px] uppercase tracking-widest text-app-text-muted">
                          {new Date(entry.created_at).toLocaleString()}{" "}
                          {entry.changed_by_name
                            ? `· ${entry.changed_by_name}`
                            : entry.changed_by
                              ? `· ${entry.changed_by}`
                              : "· system"}
                        </p>
                        {entry.change_note && (
                          <p className="mt-0.5 text-[10px] text-app-text-muted">{entry.change_note}</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
