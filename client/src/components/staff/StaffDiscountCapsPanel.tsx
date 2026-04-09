import { useCallback, useEffect, useState } from "react";
import { useToast } from "../ui/ToastProvider";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type StaffRole = "admin" | "salesperson" | "sales_support";

interface Row {
  role: StaffRole;
  max_discount_percent: string;
}

function jsonHeaders(base: () => HeadersInit): HeadersInit {
  const h = new Headers(base());
  h.set("Content-Type", "application/json");
  return h;
}

export default function StaffDiscountCapsPanel() {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const canManage = hasPermission("staff.manage_access");

  const [rows, setRows] = useState<Row[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!canManage) return;
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/pricing-limits`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) {
        toast("Could not load discount caps", "error");
        return;
      }
      const data = (await res.json()) as Row[];
      setRows(data);
      const d: Record<string, string> = {};
      for (const r of data) {
        d[r.role] = String(r.max_discount_percent);
      }
      setDraft(d);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, canManage, toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const limits = rows.map((r) => {
      const raw = (draft[r.role] ?? "").trim();
      const n = Number.parseFloat(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        toast(`Invalid percent for ${r.role}`, "error");
        throw new Error("invalid");
      }
      return { role: r.role, max_discount_percent: n.toFixed(2) };
    });
    const res = await fetch(`${baseUrl}/api/staff/admin/pricing-limits`, {
      method: "PATCH",
      headers: jsonHeaders(backofficeHeaders),
      body: JSON.stringify({ limits }),
    });
    if (!res.ok) {
      const b = (await res.json().catch(() => ({}))) as { error?: string };
      toast(b.error ?? "Save failed", "error");
      return;
    }
    toast("Discount caps updated", "success");
    void load();
  };

  if (!canManage) {
    return (
      <p className="text-sm text-app-text-muted">
        You need staff access management permission to edit role discount caps.
      </p>
    );
  }

  return (
    <div className="ui-card space-y-4 border border-app-border p-4">
      <div>
        <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
          Role discount caps
        </h3>
        <p className="mt-1 text-xs text-app-text-muted">
          Maximum percent off standard retail allowed on a line when a price override reason is
          present. Enforced at checkout for the register operator.
        </p>
      </div>
      {loading ? (
        <p className="text-sm text-app-text-muted">Loading…</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div
              key={r.role}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border pb-3 last:border-0"
            >
              <span className="text-xs font-black uppercase tracking-wider text-app-text-muted">
                {r.role.replace("_", " ")}
              </span>
              <div className="flex items-center gap-2">
                <input
                  className="ui-input w-24 text-right font-mono text-sm"
                  value={draft[r.role] ?? ""}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, [r.role]: e.target.value }))
                  }
                />
                <span className="text-xs font-bold text-app-text-muted">%</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={loading}
        onClick={() => void save().catch(() => {})}
        className="ui-btn-primary w-full py-2 text-xs font-black uppercase tracking-widest"
      >
        Save caps
      </button>
    </div>
  );
}
