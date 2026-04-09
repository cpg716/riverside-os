import { useCallback, useEffect, useMemo, useState } from "react";
import { BookOpen, RotateCcw, Save } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContext";
import { useToast } from "../ui/ToastProvider";
import ConfirmationModal from "../ui/ConfirmationModal";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

type DefaultVis = {
  required_permissions: string[];
  allow_register_session: boolean;
};

type AdminManualRow = {
  manual_id: string;
  bundled_relative_path: string;
  default_visibility: DefaultVis;
  hidden: boolean;
  title_override: string | null;
  summary_override: string | null;
  markdown_override: string | null;
  order_override: number | null;
  required_permissions: string[] | null;
  allow_register_session: boolean | null;
  bundled_title: string;
  bundled_summary: string;
  bundled_order: number;
};

type AdminDetail = {
  manual_id: string;
  bundled_relative_path: string;
  bundled_markdown: string;
  bundled_title: string;
  bundled_summary: string;
  bundled_order: number;
  default_visibility: DefaultVis;
  hidden: boolean;
  title_override: string | null;
  summary_override: string | null;
  markdown_override: string | null;
  order_override: number | null;
  required_permissions: string[] | null;
  allow_register_session: boolean | null;
};

export default function HelpCenterSettingsPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const [rows, setRows] = useState<AdminManualRow[]>([]);
  const [permissionCatalog, setPermissionCatalog] = useState<string[]>([]);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [detail, setDetail] = useState<AdminDetail | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  const [hidden, setHidden] = useState(false);
  const [titleOverride, setTitleOverride] = useState("");
  const [summaryOverride, setSummaryOverride] = useState("");
  const [orderOverride, setOrderOverride] = useState<string>("");
  const [editorMarkdown, setEditorMarkdown] = useState("");
  const [useBundledBody, setUseBundledBody] = useState(true);
  const [permInherit, setPermInherit] = useState(true);
  const [permPick, setPermPick] = useState<string[]>([]);
  const [regInherit, setRegInherit] = useState(true);
  const [regAllow, setRegAllow] = useState(false);

  const [revertOpen, setRevertOpen] = useState(false);

  const canManage = hasPermission("help.manage");

  const loadList = useCallback(async () => {
    if (!canManage) return;
    setBusy(true);
    setLoadErr(null);
    try {
      const res = await fetch(`${baseUrl}/api/help/admin/manuals`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as {
        manuals?: AdminManualRow[];
        permission_catalog?: string[];
      };
      setRows(Array.isArray(j.manuals) ? j.manuals : []);
      setPermissionCatalog(Array.isArray(j.permission_catalog) ? j.permission_catalog : []);
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setBusy(false);
    }
  }, [canManage, backofficeHeaders]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (!id || !canManage) return;
      setDetailBusy(true);
      try {
        const res = await fetch(`${baseUrl}/api/help/admin/manuals/${encodeURIComponent(id)}`, {
          headers: backofficeHeaders() as Record<string, string>,
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const d = (await res.json()) as AdminDetail;
        setDetail(d);
        setHidden(d.hidden);
        setTitleOverride(d.title_override ?? "");
        setSummaryOverride(d.summary_override ?? "");
        setOrderOverride(d.order_override != null ? String(d.order_override) : "");
        const hasMd = Boolean(d.markdown_override?.trim());
        setUseBundledBody(!hasMd);
        setEditorMarkdown(hasMd ? (d.markdown_override ?? "") : d.bundled_markdown);
        setPermInherit(d.required_permissions == null);
        setPermPick(d.required_permissions ?? []);
        setRegInherit(d.allow_register_session == null);
        setRegAllow(d.allow_register_session ?? d.default_visibility.allow_register_session);
      } catch (e) {
        toast(e instanceof Error ? e.message : "Could not load manual", "error");
        setDetail(null);
      } finally {
        setDetailBusy(false);
      }
    },
    [canManage, backofficeHeaders, toast],
  );

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.manual_id === selectedId),
    [rows, selectedId],
  );

  const save = async () => {
    if (!selectedId || !canManage) return;
    const orderNum =
      orderOverride.trim() === "" ? null : Number.parseInt(orderOverride.trim(), 10);
    if (orderOverride.trim() !== "" && Number.isNaN(orderNum)) {
      toast("Order must be a number or empty", "error");
      return;
    }
    const body = {
      hidden,
      title_override: titleOverride.trim() || null,
      summary_override: summaryOverride.trim() || null,
      markdown_override: useBundledBody ? null : editorMarkdown,
      order_override: orderNum,
      permissions_inherit: permInherit,
      required_permissions: permPick,
      register_session_inherit: regInherit,
      allow_register_session: regAllow,
    };
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/help/admin/manuals/${encodeURIComponent(selectedId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Save failed");
      }
      toast("Help manual policy saved", "success");
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Save failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const revertPolicy = async () => {
    if (!selectedId || !canManage) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/help/admin/manuals/${encodeURIComponent(selectedId)}`, {
        method: "DELETE",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Revert failed");
      }
      toast("Reverted to bundled defaults", "success");
      setRevertOpen(false);
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      toast(e instanceof Error ? e.message : "Revert failed", "error");
    } finally {
      setBusy(false);
    }
  };

  const togglePerm = (key: string) => {
    setPermPick((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  if (!canManage) {
    return (
      <div className="ui-card border-app-border bg-app-surface p-6 text-sm text-app-text-muted">
        You need the <span className="font-mono text-app-text">help.manage</span> permission (admin
        by default) to edit Help Center manuals.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-2xl font-black uppercase italic tracking-tight text-app-text">
            <BookOpen size={22} aria-hidden />
            Help center
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-app-text-muted">
            Hide manuals, override markdown shown in the Help drawer, or change which permissions (and
            register-only access) are required. Defaults follow each manual&apos;s component area.
          </p>
        </div>
      </div>

      {loadErr ? (
        <p className="text-sm text-red-600 dark:text-red-400">{loadErr}</p>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(200px,260px)_1fr]">
        <div className="flex min-h-0 flex-col gap-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Manual
          </label>
          <select
            className="ui-input text-sm"
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            disabled={busy || rows.length === 0}
          >
            <option value="">Select…</option>
            {rows.map((r) => (
              <option key={r.manual_id} value={r.manual_id}>
                {r.hidden ? "⏸ " : ""}
                {r.manual_id}
                {r.title_override ? ` — ${r.title_override}` : ` — ${r.bundled_title}`}
              </option>
            ))}
          </select>
          {selectedRow ? (
            <p className="text-[10px] text-app-text-muted break-all">{selectedRow.bundled_relative_path}</p>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-app-border bg-app-surface p-4">
          {detailBusy || !detail ? (
            <p className="text-sm text-app-text-muted">{selectedId ? "Loading…" : "Select a manual."}</p>
          ) : (
            <>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                <input
                  type="checkbox"
                  checked={hidden}
                  onChange={(e) => setHidden(e.target.checked)}
                  className="rounded border-app-border"
                />
                Hidden (remove from Help Center for everyone)
              </label>

              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <label className="text-[10px] font-black uppercase text-app-text-muted">
                    Title override
                  </label>
                  <input
                    className="ui-input mt-1 w-full text-sm"
                    value={titleOverride}
                    onChange={(e) => setTitleOverride(e.target.value)}
                    placeholder={detail.bundled_title}
                  />
                </div>
                <div>
                  <label className="text-[10px] font-black uppercase text-app-text-muted">
                    Sort order
                  </label>
                  <input
                    className="ui-input mt-1 w-full text-sm"
                    value={orderOverride}
                    onChange={(e) => setOrderOverride(e.target.value)}
                    placeholder={String(detail.bundled_order)}
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-black uppercase text-app-text-muted">
                  Summary override
                </label>
                <input
                  className="ui-input mt-1 w-full text-sm"
                  value={summaryOverride}
                  onChange={(e) => setSummaryOverride(e.target.value)}
                  placeholder={detail.bundled_summary || "Summary"}
                />
              </div>

              <div>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                  <input
                    type="checkbox"
                    checked={useBundledBody}
                    onChange={(e) => {
                      const bundled = e.target.checked;
                      setUseBundledBody(bundled);
                      if (bundled) setEditorMarkdown(detail.bundled_markdown);
                    }}
                    className="rounded border-app-border"
                  />
                  Use bundled markdown (from repo)
                </label>
                <textarea
                  className="ui-input mt-2 min-h-[220px] w-full font-mono text-xs"
                  value={editorMarkdown}
                  onChange={(e) => setEditorMarkdown(e.target.value)}
                  disabled={useBundledBody}
                  spellCheck={false}
                />
              </div>

              <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Who can see this manual (Back Office staff)
                </p>
                <p className="mt-1 text-xs text-app-text-muted">
                  Default:{" "}
                  <span className="font-mono text-app-text">
                    {detail.default_visibility.required_permissions.join(", ") || "(none)"}
                  </span>{" "}
                  — register session only:{" "}
                  {detail.default_visibility.allow_register_session ? "yes" : "no"}
                </p>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={permInherit}
                    onChange={(e) => setPermInherit(e.target.checked)}
                    className="rounded border-app-border"
                  />
                  Use default permissions
                </label>
                {!permInherit ? (
                  <div className="mt-2 max-h-40 overflow-y-auto rounded border border-app-border bg-app-bg p-2">
                    {permissionCatalog.map((k) => (
                      <label
                        key={k}
                        className="flex cursor-pointer items-center gap-2 py-0.5 text-xs font-mono"
                      >
                        <input
                          type="checkbox"
                          checked={permPick.includes(k)}
                          onChange={() => togglePerm(k)}
                          className="rounded border-app-border"
                        />
                        {k}
                      </label>
                    ))}
                  </div>
                ) : null}
                <p className="mt-2 text-[10px] text-app-text-muted">
                  Staff must have all selected keys. Empty custom list means any signed-in Back Office
                  user.
                </p>
              </div>

              <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Register session (no staff code)
                </p>
                <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={regInherit}
                    onChange={(e) => setRegInherit(e.target.checked)}
                    className="rounded border-app-border"
                  />
                  Use default
                </label>
                {!regInherit ? (
                  <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={regAllow}
                      onChange={(e) => setRegAllow(e.target.checked)}
                      className="rounded border-app-border"
                    />
                    Allow viewing from an open register without Back Office sign-in
                  </label>
                ) : null}
              </div>

              <div className="flex flex-wrap gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={busy}
                  className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm font-bold"
                >
                  <Save size={16} aria-hidden />
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setRevertOpen(true)}
                  disabled={busy}
                  className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-sm font-bold"
                >
                  <RotateCcw size={16} aria-hidden />
                  Revert overrides
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <ConfirmationModal
        isOpen={revertOpen}
        title="Revert manual policy?"
        message="This removes all database overrides for this manual and restores bundled markdown and default visibility rules."
        confirmLabel="Revert"
        variant="danger"
        onConfirm={() => void revertPolicy()}
        onClose={() => setRevertOpen(false)}
      />
    </div>
  );
}
