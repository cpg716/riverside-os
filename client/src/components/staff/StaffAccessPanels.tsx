import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { STAFF_PERMISSION_CATALOG } from "../../lib/staffPermissions";

const baseUrl = getBaseUrl();

type StaffRole = "admin" | "salesperson" | "sales_support";

interface RolePermRow {
  role: StaffRole;
  permission_key: string;
  allowed: boolean;
}

const ROLES: StaffRole[] = ["admin", "salesperson", "sales_support"];

export function StaffRoleAccessPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const [rows, setRows] = useState<RolePermRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/role-permissions`, {
        headers: backofficeHeaders(),
      });
      if (!res.ok) throw new Error("Could not load role permissions");
      setRows((await res.json()) as RolePermRow[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    void load();
  }, [load]);

  const allowedMap = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of rows) {
      m.set(`${r.role}:${r.permission_key}`, r.allowed);
    }
    return m;
  }, [rows]);

  const setCell = (role: StaffRole, key: string, allowed: boolean) => {
    setRows((prev) => {
      const next = prev.filter(
        (x) => !(x.role === role && x.permission_key === key),
      );
      next.push({ role, permission_key: key, allowed });
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await fetch(`${baseUrl}/api/staff/admin/role-permissions`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ permissions: rows }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Save failed");
      }
      setOk("Role defaults saved.");
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  if (!hasPermission("staff.manage_access")) {
    return (
      <p className="text-sm text-app-text-muted">
        You need the staff.manage_access permission to edit role defaults.
      </p>
    );
  }

  const byGroup = STAFF_PERMISSION_CATALOG.reduce<
    Record<string, typeof STAFF_PERMISSION_CATALOG>
  >((acc, p) => {
    acc[p.group] = acc[p.group] ?? [];
    acc[p.group].push(p);
    return acc;
  }, {});

  return (
    <section className="ui-card min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <div className="rounded-xl border border-app-accent/20 bg-app-accent/5 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-accent text-white">
            <svg
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2.5}
                d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-sm font-black uppercase tracking-tight text-app-text">
              Global Register Policy
            </h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
              Core transaction guardrails
            </p>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex items-start gap-3 rounded-lg border border-app-border bg-app-surface p-3">
            <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
              <span className="text-[10px] font-black">60</span>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-tight text-app-text">
                Return/Exchange Window
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-app-text-muted">
                Staff can process returns for any transaction within 60 days
                without secondary approval. Beyond 60 days, a Manager PIN is
                required.
              </p>
            </div>
          </div>
          <div className="flex items-start gap-3 rounded-lg border border-app-border bg-app-surface p-3">
            <div className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-blue-500/10 text-blue-600">
              <svg className="h-3 w-3" fill="currentColor" viewBox="0 0 20 20">
                <path d="M4 4a2 2 0 00-2 2v1h16V6a2 2 0 00-2-2H4z" />
                <path
                  fillRule="evenodd"
                  d="M18 9H2v5a2 2 0 002 2h12a2 2 0 002-2V9zM4 13a1 1 0 011-1h1a1 1 0 110 2H5a1 1 0 01-1-1zm5-1a1 1 0 100 2h1a1 1 0 100-2H9z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div>
              <p className="text-xs font-black uppercase tracking-tight text-app-text">
                Register Session Limit
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-app-text-muted">
                Active cashiers are restricted to their assigned register station
                until the session is reconciled or handed off.
              </p>
            </div>
          </div>
        </div>
      </div>

      <details className="rounded-xl border border-app-border bg-app-surface-2/50 px-3 py-2 text-xs text-app-text-muted">
        <summary className="cursor-pointer select-none font-bold text-app-text">
          Role planning (how retail POS systems frame access)
        </summary>
        <ul className="mt-2 list-disc space-y-1.5 pl-4 leading-relaxed">
          <li>
            <span className="font-semibold text-app-text">Sales floor</span> —
            keep <span className="font-mono">salesperson</span> defaults tight
            (POS/customers only), then add keys only where needed (for example
            physical inventory or insights).
          </li>
          <li>
            <span className="font-semibold text-app-text">Back office</span> —
            use <span className="font-mono">sales_support</span> (or expanded
            salesperson defaults) for catalog, vendors, reporting, and QBO
            read-only, mirroring a &quot;manager&quot; style template.
          </li>
          <li>
            <span className="font-semibold text-app-text">Admin</span> always
            has the full permission set in software; this matrix documents
            intent for non-admin roles.
          </li>
          <li>
            <span className="font-semibold text-app-text">View unit cost</span>{" "}
            is sensitive like Lightspeed&apos;s &quot;Show product costs&quot;
            — grant <span className="font-mono">inventory.view_cost</span>{" "}
            only for roles that should see margin data.
          </li>
          <li>
            <span className="font-semibold text-app-text">Not in ROS yet</span>{" "}
            (possible future work): per-role discount caps, POS void/refund
            keys, per-user outlet scoping. See{" "}
            <span className="font-mono">docs/STAFF_PERMISSIONS.md</span>{" "}
            (Lightspeed comparison section).
          </li>
        </ul>
      </details>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-app-text-muted">
          Defaults for each role. Admin still receives full access in software;
          these rows affect non-admin roles and documentation of intent.
        </p>
        <button
          type="button"
          disabled={busy || loading}
          onClick={() => void load()}
          className="ui-btn-secondary text-xs"
        >
          Reload
        </button>
      </div>
      {err ? (
        <p className="text-sm font-semibold text-red-600">{err}</p>
      ) : null}
      {ok ? (
        <p className="text-sm font-semibold text-emerald-700">{ok}</p>
      ) : null}
      {loading ? (
        <p className="text-app-text-muted">Loading…</p>
      ) : (
        <div className="space-y-6">
          {Object.entries(byGroup).map(([group, perms]) => (
            <div key={group}>
              <h3 className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {group}
              </h3>
              <div className="overflow-x-auto rounded-xl border border-app-border">
                <table className="w-full min-w-[480px] text-left text-xs">
                  <thead className="bg-app-surface-2 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                    <tr>
                      <th className="px-3 py-2">Permission</th>
                      {ROLES.map((r) => (
                        <th key={r} className="px-2 py-2 text-center">
                          {r.replace("_", " ")}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-app-border">
                    {perms.map((p) => (
                      <tr key={p.key} className="hover:bg-app-surface-2/60">
                        <td className="px-3 py-2 font-medium text-app-text">
                          {p.label}
                          <span className="ml-1 font-mono text-[10px] text-app-text-muted">
                            {p.key}
                          </span>
                        </td>
                        {ROLES.map((role) => (
                          <td key={role} className="px-2 py-2 text-center">
                            <input
                              type="checkbox"
                              checked={
                                allowedMap.get(`${role}:${p.key}`) ?? false
                              }
                              onChange={(e) =>
                                setCell(role, p.key, e.target.checked)
                              }
                              className="h-4 w-4 rounded border-app-border"
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        type="button"
        disabled={busy || loading}
        onClick={() => void save()}
        className="ui-btn-primary w-full max-w-xs py-3 text-sm disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save role defaults"}
      </button>
    </section>
  );
}

interface HubLite {
  id: string;
  full_name: string;
  cashier_code: string;
}

interface OverrideRow {
  permission_key: string;
  effect: string;
}

export function StaffUserOverridesPanel({ roster }: { roster: HubLite[] }) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const [staffId, setStaffId] = useState("");
  const [overrides, setOverrides] = useState<OverrideRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const loadOverrides = useCallback(async () => {
    if (!staffId) {
      setOverrides([]);
      return;
    }
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}/permission-overrides`,
        { headers: backofficeHeaders() },
      );
      if (!res.ok) throw new Error("Could not load overrides");
      setOverrides((await res.json()) as OverrideRow[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Load failed");
      setOverrides([]);
    } finally {
      setLoading(false);
    }
  }, [staffId, backofficeHeaders]);

  useEffect(() => {
    void loadOverrides();
  }, [loadOverrides]);

  const effectFor = (key: string): "" | "allow" | "deny" => {
    const o = overrides.find((x) => x.permission_key === key);
    if (!o) return "";
    return o.effect === "deny" ? "deny" : "allow";
  };

  const setEffectFor = (key: string, effect: "" | "allow" | "deny") => {
    setOverrides((prev) => {
      const rest = prev.filter((x) => x.permission_key !== key);
      if (!effect) return rest;
      return [...rest, { permission_key: key, effect }];
    });
  };

  const save = async () => {
    if (!staffId) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const res = await fetch(
        `${baseUrl}/api/staff/admin/${encodeURIComponent(staffId)}/permission-overrides`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ overrides }),
        },
      );
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Save failed");
      }
      setOk("Overrides saved.");
      await loadOverrides();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  };

  if (!hasPermission("staff.manage_access")) {
    return (
      <p className="text-sm text-app-text-muted">
        You need the staff.manage_access permission to edit per-user overrides.
      </p>
    );
  }

  return (
    <section className="ui-card min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
      <p className="text-sm text-app-text-muted">
        Allow adds a permission beyond role defaults; deny removes one the role
        would otherwise have.
      </p>
      <label className="block text-[10px] font-black uppercase text-app-text-muted">
        Staff member
        <select
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          className="ui-input mt-1 w-full max-w-md"
        >
          <option value="">Select…</option>
          {roster.map((r) => (
            <option key={r.id} value={r.id}>
              {r.full_name} ({r.cashier_code})
            </option>
          ))}
        </select>
      </label>
      {err ? (
        <p className="text-sm font-semibold text-red-600">{err}</p>
      ) : null}
      {ok ? (
        <p className="text-sm font-semibold text-emerald-700">{ok}</p>
      ) : null}
      {loading && staffId ? (
        <p className="text-app-text-muted">Loading overrides…</p>
      ) : null}
      {staffId ? (
        <div className="max-h-[50vh] space-y-2 overflow-y-auto rounded-xl border border-app-border p-3">
          {STAFF_PERMISSION_CATALOG.map((p) => (
            <div
              key={p.key}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-app-border/60 py-2 last:border-0"
            >
              <div>
                <span className="text-sm font-semibold text-app-text">
                  {p.label}
                </span>
                <span className="ml-2 font-mono text-[10px] text-app-text-muted">
                  {p.key}
                </span>
              </div>
              <select
                value={effectFor(p.key)}
                onChange={(e) =>
                  setEffectFor(
                    p.key,
                    e.target.value as "" | "allow" | "deny",
                  )
                }
                className="ui-input text-xs"
              >
                <option value="">Inherit (no override)</option>
                <option value="allow">Allow</option>
                <option value="deny">Deny</option>
              </select>
            </div>
          ))}
        </div>
      ) : null}
      <button
        type="button"
        disabled={busy || !staffId}
        onClick={() => void save()}
        className="ui-btn-primary max-w-xs py-3 text-sm disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save overrides"}
      </button>
    </section>
  );
}
