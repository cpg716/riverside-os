import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  RotateCcw,
  Save,
  Wand2,
  Search,
  RefreshCw,
  Library,
  FilePenLine,
  TerminalSquare,
  Sparkles,
  Bot,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
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

type OpsStatus = {
  meilisearch_configured: boolean;
  meilisearch_indexing: boolean;
  node_available: boolean;
  script_exists: boolean;
  help_docs_dir_exists: boolean;
};

type OpsResult = {
  ok: boolean;
  exit_code: number | null;
  stdout: string;
  stderr: string;
};

type OpsLog = {
  at: string;
  action: string;
  ok: boolean;
  message: string;
};

type ManagerTab =
  | "library"
  | "editor"
  | "automation"
  | "search-index"
  | "rosie-readiness";

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

  const [tab, setTab] = useState<ManagerTab>("library");
  const [opsStatus, setOpsStatus] = useState<OpsStatus | null>(null);
  const [opsBusy, setOpsBusy] = useState(false);
  const [opsDryRun, setOpsDryRun] = useState(true);
  const [opsIncludeShadcn, setOpsIncludeShadcn] = useState(false);
  const [opsRescanComponents, setOpsRescanComponents] = useState(false);
  const [opsCleanupOrphans, setOpsCleanupOrphans] = useState(false);
  const [opsFullReindexFallback, setOpsFullReindexFallback] = useState(true);
  const [opsLastResult, setOpsLastResult] = useState<OpsResult | null>(null);
  const [opsLogs, setOpsLogs] = useState<OpsLog[]>([]);
  const [fullSyncBusy, setFullSyncBusy] = useState(false);
  const [fullSyncConfirmOpen, setFullSyncConfirmOpen] = useState(false);
  const [fullSyncStage, setFullSyncStage] = useState<
    "idle" | "manifest" | "reindex" | "done" | "error"
  >("idle");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryFilter, setLibraryFilter] = useState<
    "all" | "hidden" | "overridden" | "markdown-overrides"
  >("all");
  const [compactMode, setCompactMode] = useState(false);
  const [librarySort, setLibrarySort] = useState<
    | "manual_id_asc"
    | "manual_id_desc"
    | "title_asc"
    | "title_desc"
    | "order_asc"
    | "order_desc"
  >("manual_id_asc");

  const canManage = hasPermission("help.manage");

  const pushLog = useCallback(
    (action: string, ok: boolean, message: string) => {
      setOpsLogs((prev) =>
        [
          {
            at: new Date().toISOString(),
            action,
            ok,
            message,
          },
          ...prev,
        ].slice(0, 250),
      );
    },
    [],
  );

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
      setPermissionCatalog(
        Array.isArray(j.permission_catalog) ? j.permission_catalog : [],
      );
    } catch (e) {
      setLoadErr(e instanceof Error ? e.message : "Load failed");
    } finally {
      setBusy(false);
    }
  }, [canManage, backofficeHeaders]);

  const loadDetail = useCallback(
    async (id: string) => {
      if (!id || !canManage) return;
      setDetailBusy(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/help/admin/manuals/${encodeURIComponent(id)}`,
          {
            headers: backofficeHeaders() as Record<string, string>,
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const d = (await res.json()) as AdminDetail;
        setDetail(d);
        setHidden(d.hidden);
        setTitleOverride(d.title_override ?? "");
        setSummaryOverride(d.summary_override ?? "");
        setOrderOverride(
          d.order_override != null ? String(d.order_override) : "",
        );
        const hasMd = Boolean(d.markdown_override?.trim());
        setUseBundledBody(!hasMd);
        setEditorMarkdown(
          hasMd ? (d.markdown_override ?? "") : d.bundled_markdown,
        );
        setPermInherit(d.required_permissions == null);
        setPermPick(d.required_permissions ?? []);
        setRegInherit(d.allow_register_session == null);
        setRegAllow(
          d.allow_register_session ??
            d.default_visibility.allow_register_session,
        );
      } catch (e) {
        toast(
          e instanceof Error ? e.message : "Could not load manual",
          "error",
        );
        setDetail(null);
      } finally {
        setDetailBusy(false);
      }
    },
    [canManage, backofficeHeaders, toast],
  );

  const loadOpsStatus = useCallback(async () => {
    if (!canManage) return;
    try {
      const res = await fetch(`${baseUrl}/api/help/admin/ops/status`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as OpsStatus;
      setOpsStatus(j);
    } catch (e) {
      pushLog(
        "status",
        false,
        e instanceof Error ? e.message : "Status load failed",
      );
    }
  }, [canManage, backofficeHeaders, pushLog]);

  useEffect(() => {
    void loadList();
    void loadOpsStatus();
  }, [loadList, loadOpsStatus]);

  useEffect(() => {
    if (selectedId) void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  const selectedRow = useMemo(
    () => rows.find((r) => r.manual_id === selectedId),
    [rows, selectedId],
  );

  const kpi = useMemo(() => {
    const total = rows.length;
    const hiddenCount = rows.filter((r) => r.hidden).length;
    const overriddenCount = rows.filter(
      (r) =>
        r.title_override != null ||
        r.summary_override != null ||
        r.markdown_override != null ||
        r.order_override != null ||
        r.required_permissions != null ||
        r.allow_register_session != null ||
        r.hidden,
    ).length;
    const markdownOverrideCount = rows.filter((r) =>
      Boolean(r.markdown_override?.trim()),
    ).length;
    const rosieTaggedCount = rows.filter((r) =>
      (r.markdown_override ?? "").toLowerCase().includes("rosie"),
    ).length;
    return {
      total,
      hiddenCount,
      overriddenCount,
      markdownOverrideCount,
      rosieTaggedCount,
    };
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = libraryQuery.trim().toLowerCase();
    const base = rows.filter((r) => {
      const hay = [
        r.manual_id,
        r.title_override ?? "",
        r.bundled_title ?? "",
        r.summary_override ?? "",
        r.bundled_summary ?? "",
        r.bundled_relative_path ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return q ? hay.includes(q) : true;
    });

    const filtered = base.filter((r) => {
      const overridden =
        r.hidden ||
        r.title_override != null ||
        r.summary_override != null ||
        r.markdown_override != null ||
        r.order_override != null ||
        r.required_permissions != null ||
        r.allow_register_session != null;

      if (libraryFilter === "hidden") return r.hidden;
      if (libraryFilter === "overridden") return overridden;
      if (libraryFilter === "markdown-overrides")
        return Boolean(r.markdown_override?.trim());
      return true;
    });

    const valueTitle = (r: AdminManualRow) =>
      (
        r.title_override?.trim() ||
        r.bundled_title ||
        r.manual_id
      ).toLowerCase();
    const valueOrder = (r: AdminManualRow) =>
      r.order_override != null ? r.order_override : r.bundled_order;

    filtered.sort((a, b) => {
      if (librarySort === "manual_id_asc")
        return a.manual_id.localeCompare(b.manual_id);
      if (librarySort === "manual_id_desc")
        return b.manual_id.localeCompare(a.manual_id);
      if (librarySort === "title_asc")
        return valueTitle(a).localeCompare(valueTitle(b));
      if (librarySort === "title_desc")
        return valueTitle(b).localeCompare(valueTitle(a));
      if (librarySort === "order_asc") return valueOrder(a) - valueOrder(b);
      return valueOrder(b) - valueOrder(a);
    });

    return filtered;
  }, [rows, libraryQuery, libraryFilter, librarySort]);

  const markdownDiffPreview = useMemo(() => {
    if (!detail) return [];
    const bundled = detail.bundled_markdown ?? "";
    const overridden = editorMarkdown ?? "";
    if (useBundledBody || !overridden.trim()) return [];
    const a = bundled.split("\n");
    const b = overridden.split("\n");
    const max = Math.max(a.length, b.length);
    const out: { type: "same" | "add" | "del"; text: string }[] = [];
    for (let i = 0; i < max; i += 1) {
      const left = a[i];
      const right = b[i];
      if (left === right) {
        out.push({ type: "same", text: right ?? "" });
      } else {
        if (left !== undefined) out.push({ type: "del", text: left });
        if (right !== undefined) out.push({ type: "add", text: right });
      }
      if (out.length > 500) break;
    }
    return out;
  }, [detail, editorMarkdown, useBundledBody]);

  const exportOpsLogs = async () => {
    const body = {
      exported_at: new Date().toISOString(),
      total_logs: opsLogs.length,
      logs: opsLogs,
    };
    const text = JSON.stringify(body, null, 2);

    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        toast("Operation logs copied to clipboard", "success");
        pushLog("ops.logs.export", true, "Copied logs to clipboard");
        return;
      }
    } catch {
      // fall through to file download
    }

    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `help-center-manager-ops-logs-${new Date()
      .toISOString()
      .replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast("Operation logs exported as JSON", "success");
    pushLog("ops.logs.export", true, "Downloaded logs JSON");
  };

  const save = async () => {
    if (!selectedId || !canManage) return;
    const orderNum =
      orderOverride.trim() === ""
        ? null
        : Number.parseInt(orderOverride.trim(), 10);
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
      const res = await fetch(
        `${baseUrl}/api/help/admin/manuals/${encodeURIComponent(selectedId)}`,
        {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Save failed");
      }
      toast("Help manual policy saved", "success");
      pushLog("manual.save", true, `Saved overrides for '${selectedId}'`);
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Save failed";
      toast(msg, "error");
      pushLog("manual.save", false, msg);
    } finally {
      setBusy(false);
    }
  };

  const revertPolicy = async () => {
    if (!selectedId || !canManage) return;
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/help/admin/manuals/${encodeURIComponent(selectedId)}`,
        {
          method: "DELETE",
          headers: backofficeHeaders() as Record<string, string>,
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? "Revert failed");
      }
      toast("Reverted to bundled defaults", "success");
      pushLog(
        "manual.revert",
        true,
        `Reverted '${selectedId}' to bundled defaults`,
      );
      setRevertOpen(false);
      await loadList();
      await loadDetail(selectedId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Revert failed";
      toast(msg, "error");
      pushLog("manual.revert", false, msg);
    } finally {
      setBusy(false);
    }
  };

  const runGenerateManifest = async () => {
    if (!canManage) return;
    if (opsCleanupOrphans && !opsRescanComponents) {
      toast("Cleanup orphans requires Rescan components enabled", "error");
      return;
    }
    if (!opsDryRun && opsCleanupOrphans) {
      toast(
        "Guardrail: run cleanup in Dry run first, then disable Dry run if results look correct.",
        "error",
      );
      pushLog(
        "ops.generate-manifest.guardrail",
        false,
        "Blocked non-dry-run orphan cleanup",
      );
      return;
    }
    setOpsBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/help/admin/ops/generate-manifest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({
            dry_run: opsDryRun,
            include_shadcn: opsIncludeShadcn,
            rescan_components: opsRescanComponents,
            cleanup_orphans: opsCleanupOrphans,
          }),
        },
      );
      const j = (await res.json().catch(() => ({}))) as {
        status?: string;
        result?: OpsResult;
        error?: string;
      };
      if (!res.ok) {
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const result = j.result ?? {
        ok: false,
        exit_code: null,
        stdout: "",
        stderr: "",
      };
      setOpsLastResult(result);
      pushLog(
        "ops.generate-manifest",
        result.ok,
        result.ok
          ? `Completed with exit code ${result.exit_code ?? "unknown"}`
          : `Failed with exit code ${result.exit_code ?? "unknown"}`,
      );
      toast(
        result.ok
          ? "Help manifest workflow completed"
          : "Help manifest workflow reported errors",
        result.ok ? "success" : "error",
      );
      await loadList();
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Generate manifest failed";
      toast(msg, "error");
      pushLog("ops.generate-manifest", false, msg);
    } finally {
      setOpsBusy(false);
      void loadOpsStatus();
    }
  };

  const runHelpReindex = async () => {
    if (!canManage) return;
    setOpsBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/help/admin/ops/reindex-search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(backofficeHeaders() as Record<string, string>),
        },
        body: JSON.stringify({ full_reindex_fallback: opsFullReindexFallback }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        status?: string;
        mode?: string;
        error?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `HTTP ${res.status}`);
      const mode = j.mode ?? "help_only";
      pushLog("ops.reindex-search", true, `Reindex completed (${mode})`);
      toast(`Help search reindex completed (${mode})`, "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Reindex failed";
      pushLog("ops.reindex-search", false, msg);
      toast(msg, "error");
    } finally {
      setOpsBusy(false);
      void loadOpsStatus();
    }
  };

  const runFullSync = async () => {
    if (!canManage || fullSyncBusy) return;
    setFullSyncConfirmOpen(false);
    setFullSyncBusy(true);
    setOpsBusy(true);
    setFullSyncStage("manifest");
    try {
      const genRes = await fetch(
        `${baseUrl}/api/help/admin/ops/generate-manifest`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({
            dry_run: false,
            include_shadcn: opsIncludeShadcn,
            rescan_components: true,
            cleanup_orphans: false,
          }),
        },
      );
      const genJson = (await genRes.json().catch(() => ({}))) as {
        status?: string;
        result?: OpsResult;
        error?: string;
      };
      if (!genRes.ok || !genJson.result?.ok) {
        setFullSyncStage("error");
        throw new Error(
          genJson.error ??
            `Generate manifest failed (exit ${genJson.result?.exit_code ?? "?"})`,
        );
      }
      setOpsLastResult(genJson.result);
      pushLog("ops.full-sync.generate", true, "Manifest generation completed");

      setFullSyncStage("reindex");
      const reindexRes = await fetch(
        `${baseUrl}/api/help/admin/ops/reindex-search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(backofficeHeaders() as Record<string, string>),
          },
          body: JSON.stringify({ full_reindex_fallback: true }),
        },
      );
      const reindexJson = (await reindexRes.json().catch(() => ({}))) as {
        status?: string;
        mode?: string;
        error?: string;
      };
      if (!reindexRes.ok) {
        setFullSyncStage("error");
        throw new Error(reindexJson.error ?? "Reindex failed");
      }
      pushLog(
        "ops.full-sync.reindex",
        true,
        `Reindex completed (${reindexJson.mode ?? "help_only"})`,
      );

      await loadList();
      await loadOpsStatus();
      setFullSyncStage("done");
      toast("Full sync completed: manifest + search index", "success");
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Full sync failed";
      setFullSyncStage("error");
      pushLog("ops.full-sync", false, msg);
      toast(msg, "error");
    } finally {
      setOpsBusy(false);
      setFullSyncBusy(false);
      setTimeout(() => {
        setFullSyncStage((prev) => (prev === "done" ? "idle" : prev));
      }, 2200);
    }
  };

  const togglePerm = (key: string) => {
    setPermPick((prev) =>
      prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key],
    );
  };

  if (!canManage) {
    return (
      <div className="ui-card border-app-border bg-app-surface p-6 text-sm text-app-text-muted">
        You need the{" "}
        <span className="font-mono text-app-text">help.manage</span> permission
        (admin by default) to use the Help Center Manager.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
      <div className="rounded-xl border border-app-border bg-app-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-2xl font-black uppercase italic tracking-tight text-app-text">
              <BookOpen size={22} aria-hidden />
              Help Center Manager
            </h2>
            <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
              Manage in-app manuals, policy overrides, automation workflows, and
              Help search indexing from one control surface.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg border border-app-border bg-app-surface-2/40 px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                Manuals
              </p>
              <p className="text-lg font-black text-app-text">{kpi.total}</p>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-2/40 px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                Hidden
              </p>
              <p className="text-lg font-black text-app-text">
                {kpi.hiddenCount}
              </p>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-2/40 px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                Overrides
              </p>
              <p className="text-lg font-black text-app-text">
                {kpi.overriddenCount}
              </p>
            </div>
            <div className="rounded-lg border border-app-border bg-app-surface-2/40 px-3 py-2 text-center">
              <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                MD Overrides
              </p>
              <p className="text-lg font-black text-app-text">
                {kpi.markdownOverrideCount}
              </p>
            </div>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setTab("library")}
            className={`ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider ${
              tab === "library" ? "ring-2 ring-app-accent" : ""
            }`}
          >
            <Library size={14} /> Library
          </button>
          <button
            type="button"
            onClick={() => setTab("editor")}
            className={`ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider ${
              tab === "editor" ? "ring-2 ring-app-accent" : ""
            }`}
          >
            <FilePenLine size={14} /> Editor
          </button>
          <button
            type="button"
            onClick={() => setTab("automation")}
            className={`ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider ${
              tab === "automation" ? "ring-2 ring-app-accent" : ""
            }`}
          >
            <Wand2 size={14} /> Automation
          </button>
          <button
            type="button"
            onClick={() => setTab("search-index")}
            className={`ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider ${
              tab === "search-index" ? "ring-2 ring-app-accent" : ""
            }`}
          >
            <Search size={14} /> Search & Index
          </button>
          <button
            type="button"
            onClick={() => setTab("rosie-readiness")}
            className={`ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider ${
              tab === "rosie-readiness" ? "ring-2 ring-app-accent" : ""
            }`}
          >
            <Bot size={14} /> ROSIE readiness
          </button>
        </div>
      </div>

      {loadErr ? (
        <p className="text-sm text-red-600 dark:text-red-400">{loadErr}</p>
      ) : null}

      {(tab === "library" || tab === "editor") && (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(260px,320px)_1fr]">
          <div className="flex min-h-0 flex-col gap-2 rounded-xl border border-app-border bg-app-surface p-3">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Manual
              </label>
              <button
                type="button"
                onClick={() => void loadList()}
                className="ui-btn-secondary inline-flex items-center gap-1 px-2 py-1 text-[10px] font-black uppercase tracking-wider"
                disabled={busy}
              >
                <RefreshCw size={12} /> Refresh
              </button>
            </div>
            <input
              className="ui-input text-sm"
              value={libraryQuery}
              onChange={(e) => setLibraryQuery(e.target.value)}
              placeholder="Search manuals, title, summary, path…"
            />
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              <select
                className="ui-input text-xs"
                value={librarySort}
                onChange={(e) =>
                  setLibrarySort(
                    e.target.value as
                      | "manual_id_asc"
                      | "manual_id_desc"
                      | "title_asc"
                      | "title_desc"
                      | "order_asc"
                      | "order_desc",
                  )
                }
              >
                <option value="manual_id_asc">Sort: Manual ID (A→Z)</option>
                <option value="manual_id_desc">Sort: Manual ID (Z→A)</option>
                <option value="title_asc">Sort: Title (A→Z)</option>
                <option value="title_desc">Sort: Title (Z→A)</option>
                <option value="order_asc">Sort: Order (Low→High)</option>
                <option value="order_desc">Sort: Order (High→Low)</option>
              </select>
              <label className="flex cursor-pointer items-center gap-2 rounded border border-app-border bg-app-surface-2/40 px-2 py-1 text-[10px] font-black uppercase tracking-wider text-app-text">
                <input
                  type="checkbox"
                  checked={compactMode}
                  onChange={(e) => setCompactMode(e.target.checked)}
                  className="rounded border-app-border"
                />
                Compact mode
              </label>
            </div>
            <div className="flex flex-wrap gap-1">
              <button
                type="button"
                onClick={() => setLibraryFilter("all")}
                className={`ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider ${
                  libraryFilter === "all" ? "ring-2 ring-app-accent" : ""
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setLibraryFilter("hidden")}
                className={`ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider ${
                  libraryFilter === "hidden" ? "ring-2 ring-app-accent" : ""
                }`}
              >
                Hidden
              </button>
              <button
                type="button"
                onClick={() => setLibraryFilter("overridden")}
                className={`ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider ${
                  libraryFilter === "overridden" ? "ring-2 ring-app-accent" : ""
                }`}
              >
                Overridden
              </button>
              <button
                type="button"
                onClick={() => setLibraryFilter("markdown-overrides")}
                className={`ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider ${
                  libraryFilter === "markdown-overrides"
                    ? "ring-2 ring-app-accent"
                    : ""
                }`}
              >
                MD Overrides
              </button>
            </div>
            <select
              className="ui-input text-sm"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={busy || filteredRows.length === 0}
            >
              <option value="">Select…</option>
              {filteredRows.map((r) => (
                <option key={r.manual_id} value={r.manual_id}>
                  {r.hidden ? "⏸ " : ""}
                  {r.manual_id}
                  {r.title_override
                    ? ` — ${r.title_override}`
                    : ` — ${r.bundled_title}`}
                </option>
              ))}
            </select>

            {selectedRow ? (
              <div className="space-y-1 rounded-lg border border-app-border bg-app-surface-2/40 p-2">
                <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                  Bundled path
                </p>
                <p className="text-[10px] break-all text-app-text">
                  {selectedRow.bundled_relative_path}
                </p>
              </div>
            ) : null}

            {tab === "library" ? (
              <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-app-border bg-app-bg/40 p-2">
                <p className="mb-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  Catalog
                </p>
                <ul className="space-y-1">
                  {filteredRows.map((r) => {
                    const overridden =
                      r.hidden ||
                      r.title_override != null ||
                      r.summary_override != null ||
                      r.markdown_override != null ||
                      r.order_override != null ||
                      r.required_permissions != null ||
                      r.allow_register_session != null;
                    return (
                      <li key={`cat-${r.manual_id}`}>
                        <button
                          type="button"
                          onClick={() => setSelectedId(r.manual_id)}
                          className={`w-full rounded text-left text-xs transition ${
                            compactMode ? "px-2 py-0.5" : "px-2 py-1"
                          } ${
                            selectedId === r.manual_id
                              ? "bg-app-accent/20 text-app-text"
                              : "hover:bg-app-surface text-app-text-muted"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono">{r.manual_id}</span>
                            <div className="flex items-center gap-1">
                              {r.hidden ? (
                                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-700 dark:text-amber-300">
                                  hidden
                                </span>
                              ) : null}
                              {overridden ? (
                                <span className="rounded bg-indigo-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-indigo-700 dark:text-indigo-300">
                                  override
                                </span>
                              ) : null}
                              {r.markdown_override?.trim() ? (
                                <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-700 dark:text-emerald-300">
                                  md
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ) : null}
          </div>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-xl border border-app-border bg-app-surface p-4">
            {detailBusy || !detail ? (
              <p className="text-sm text-app-text-muted">
                {selectedId ? "Loading…" : "Select a manual."}
              </p>
            ) : tab === "editor" ? (
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
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[10px] font-black uppercase text-app-text-muted">
                        Title override
                      </label>
                      <button
                        type="button"
                        onClick={() => setTitleOverride("")}
                        className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider"
                      >
                        Reset
                      </button>
                    </div>
                    <input
                      className="ui-input mt-1 w-full text-sm"
                      value={titleOverride}
                      onChange={(e) => setTitleOverride(e.target.value)}
                      placeholder={detail.bundled_title}
                    />
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <label className="text-[10px] font-black uppercase text-app-text-muted">
                        Sort order
                      </label>
                      <button
                        type="button"
                        onClick={() => setOrderOverride("")}
                        className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider"
                      >
                        Reset
                      </button>
                    </div>
                    <input
                      className="ui-input mt-1 w-full text-sm"
                      value={orderOverride}
                      onChange={(e) => setOrderOverride(e.target.value)}
                      placeholder={String(detail.bundled_order)}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="text-[10px] font-black uppercase text-app-text-muted">
                      Summary override
                    </label>
                    <button
                      type="button"
                      onClick={() => setSummaryOverride("")}
                      className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider"
                    >
                      Reset
                    </button>
                  </div>
                  <input
                    className="ui-input mt-1 w-full text-sm"
                    value={summaryOverride}
                    onChange={(e) => setSummaryOverride(e.target.value)}
                    placeholder={detail.bundled_summary || "Summary"}
                  />
                </div>

                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Health badges
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wider">
                    <span className="rounded bg-app-surface px-2 py-1 text-app-text">
                      {hidden ? "visibility: hidden" : "visibility: visible"}
                    </span>
                    <span className="rounded bg-app-surface px-2 py-1 text-app-text">
                      {useBundledBody
                        ? "body: bundled"
                        : "body: markdown override"}
                    </span>
                    <span className="rounded bg-app-surface px-2 py-1 text-app-text">
                      permissions: {permInherit ? "default" : "custom"}
                    </span>
                    <span className="rounded bg-app-surface px-2 py-1 text-app-text">
                      register:{" "}
                      {regInherit
                        ? "default"
                        : regAllow
                          ? "allowed"
                          : "blocked"}
                    </span>
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2">
                    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
                      <input
                        type="checkbox"
                        checked={useBundledBody}
                        onChange={(e) => {
                          const bundled = e.target.checked;
                          setUseBundledBody(bundled);
                          if (bundled)
                            setEditorMarkdown(detail.bundled_markdown);
                        }}
                        className="rounded border-app-border"
                      />
                      Use bundled markdown (from repo)
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setUseBundledBody(true);
                        setEditorMarkdown(detail.bundled_markdown);
                      }}
                      className="ui-btn-secondary px-2 py-1 text-[10px] font-black uppercase tracking-wider"
                    >
                      Reset body
                    </button>
                  </div>
                  <textarea
                    className="ui-input mt-2 min-h-[240px] w-full font-mono text-xs"
                    value={editorMarkdown}
                    onChange={(e) => setEditorMarkdown(e.target.value)}
                    disabled={useBundledBody}
                    spellCheck={false}
                  />
                  {!useBundledBody ? (
                    <div className="mt-3 rounded-lg border border-app-border bg-app-bg p-2">
                      <p className="mb-2 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                        Diff preview (bundled vs override)
                      </p>
                      <div className="max-h-52 overflow-y-auto font-mono text-[11px]">
                        {markdownDiffPreview.length === 0 ? (
                          <p className="text-xs text-app-text-muted">
                            No differences detected.
                          </p>
                        ) : (
                          markdownDiffPreview.map((d, idx) => (
                            <div
                              key={`diff-${idx}`}
                              className={
                                d.type === "add"
                                  ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  : d.type === "del"
                                    ? "bg-rose-500/10 text-rose-700 dark:text-rose-300"
                                    : "text-app-text-muted"
                              }
                            >
                              {d.type === "add"
                                ? "+ "
                                : d.type === "del"
                                  ? "- "
                                  : "  "}
                              {d.text}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  ) : null}
                </div>

                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Who can see this manual (Back Office staff)
                  </p>
                  <p className="mt-1 text-xs text-app-text-muted">
                    Default:{" "}
                    <span className="font-mono text-app-text">
                      {detail.default_visibility.required_permissions.join(
                        ", ",
                      ) || "(none)"}
                    </span>{" "}
                    — register session only:{" "}
                    {detail.default_visibility.allow_register_session
                      ? "yes"
                      : "no"}
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
                    Staff must have all selected keys. Empty custom list means
                    any signed-in Back Office user.
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
                      Allow viewing from an open register without Back Office
                      sign-in
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
            ) : (
              <div className="space-y-3">
                <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                  Manual detail
                </h3>
                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                    Manual ID
                  </p>
                  <p className="font-mono text-sm text-app-text">
                    {detail.manual_id}
                  </p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                    Bundled title
                  </p>
                  <p className="text-sm text-app-text">
                    {detail.bundled_title}
                  </p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                    Bundled summary
                  </p>
                  <p className="text-sm text-app-text">
                    {detail.bundled_summary || "—"}
                  </p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                    Bundled order
                  </p>
                  <p className="text-sm text-app-text">
                    {detail.bundled_order}
                  </p>
                </div>
                <div className="rounded-lg border border-app-border bg-app-surface-2/50 p-3">
                  <p className="text-[10px] uppercase tracking-wider text-app-text-muted">
                    Policy defaults
                  </p>
                  <p className="text-xs text-app-text">
                    Permissions:{" "}
                    <span className="font-mono">
                      {detail.default_visibility.required_permissions.join(
                        ", ",
                      ) || "(none)"}
                    </span>
                  </p>
                  <p className="text-xs text-app-text">
                    Register session allowed:{" "}
                    <span className="font-semibold">
                      {detail.default_visibility.allow_register_session
                        ? "yes"
                        : "no"}
                    </span>
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {tab === "automation" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-app-text">
              <TerminalSquare size={16} /> Automation controls
            </h3>
            <p className="mt-1 text-xs text-app-text-muted">
              Run MANUAL_CREATION workflows directly from Settings.
            </p>

            <div className="mt-4 space-y-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={opsDryRun}
                  onChange={(e) => setOpsDryRun(e.target.checked)}
                  className="rounded border-app-border"
                />
                Dry run
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={opsIncludeShadcn}
                  onChange={(e) => setOpsIncludeShadcn(e.target.checked)}
                  className="rounded border-app-border"
                />
                Include `ui-shadcn` components
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={opsRescanComponents}
                  onChange={(e) => setOpsRescanComponents(e.target.checked)}
                  className="rounded border-app-border"
                />
                Rescan components (vs bulk scaffold)
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={opsCleanupOrphans}
                  onChange={(e) => setOpsCleanupOrphans(e.target.checked)}
                  disabled={!opsRescanComponents}
                  className="rounded border-app-border"
                />
                Cleanup orphaned auto-scaffold manuals (requires rescan)
              </label>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runGenerateManifest()}
                disabled={opsBusy}
                className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm font-bold"
              >
                <Wand2 size={16} /> Run help manifest workflow
              </button>
              <button
                type="button"
                onClick={() => setFullSyncConfirmOpen(true)}
                disabled={opsBusy || fullSyncBusy}
                className="ui-btn-secondary inline-flex items-center gap-2 px-4 py-2 text-sm font-bold"
              >
                <Sparkles size={16} /> One-click full sync
              </button>
              <button
                type="button"
                onClick={() => void loadOpsStatus()}
                disabled={opsBusy}
                className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider"
              >
                <RefreshCw size={14} /> Refresh status
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Latest command output
            </h3>
            <div className="mt-2 rounded border border-app-border bg-app-surface-2/40 px-2 py-1 text-xs">
              Full sync state:{" "}
              <span className="font-bold">
                {fullSyncStage === "idle" && "idle"}
                {fullSyncStage === "manifest" && "running manifest"}
                {fullSyncStage === "reindex" && "reindexing search"}
                {fullSyncStage === "done" && "completed"}
                {fullSyncStage === "error" && "error"}
              </span>
            </div>
            <div className="mt-2 grid gap-2 sm:grid-cols-3">
              <div className="rounded border border-app-border bg-app-surface-2/40 px-2 py-1 text-xs">
                Status:{" "}
                <span
                  className={`font-bold ${opsLastResult?.ok ? "text-emerald-600" : "text-rose-600"}`}
                >
                  {opsLastResult
                    ? opsLastResult.ok
                      ? "success"
                      : "error"
                    : "n/a"}
                </span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 px-2 py-1 text-xs">
                Exit:{" "}
                <span className="font-mono">
                  {opsLastResult?.exit_code ?? "n/a"}
                </span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 px-2 py-1 text-xs">
                Busy:{" "}
                <span className="font-semibold">{opsBusy ? "yes" : "no"}</span>
              </div>
            </div>

            <div className="mt-3 grid gap-3 lg:grid-cols-2">
              <div>
                <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  stdout
                </p>
                <pre className="max-h-72 overflow-y-auto rounded border border-app-border bg-app-bg p-2 text-[11px] text-app-text whitespace-pre-wrap">
                  {opsLastResult?.stdout?.trim() || "(empty)"}
                </pre>
              </div>
              <div>
                <p className="mb-1 text-[10px] font-black uppercase tracking-wider text-app-text-muted">
                  stderr
                </p>
                <pre className="max-h-72 overflow-y-auto rounded border border-app-border bg-app-bg p-2 text-[11px] text-app-text whitespace-pre-wrap">
                  {opsLastResult?.stderr?.trim() || "(empty)"}
                </pre>
              </div>
            </div>
          </section>
        </div>
      )}

      {tab === "search-index" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-app-text">
              <Search size={16} /> Search health
            </h3>
            <p className="mt-1 text-xs text-app-text-muted">
              Status and maintenance controls for Help search corpus indexing.
            </p>

            <div className="mt-4 space-y-2 text-sm">
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Meilisearch configured:{" "}
                <span className="font-bold">
                  {opsStatus
                    ? opsStatus.meilisearch_configured
                      ? "yes"
                      : "no"
                    : "…"}
                </span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Indexing active:{" "}
                <span className="font-bold">
                  {opsStatus
                    ? opsStatus.meilisearch_indexing
                      ? "yes"
                      : "no"
                    : "…"}
                </span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Node available:{" "}
                <span className="font-bold">
                  {opsStatus ? (opsStatus.node_available ? "yes" : "no") : "…"}
                </span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Manifest script found:{" "}
                <span className="font-bold">
                  {opsStatus ? (opsStatus.script_exists ? "yes" : "no") : "…"}
                </span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Help docs directory found:{" "}
                <span className="font-bold">
                  {opsStatus
                    ? opsStatus.help_docs_dir_exists
                      ? "yes"
                      : "no"
                    : "…"}
                </span>
              </div>
            </div>

            <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={opsFullReindexFallback}
                onChange={(e) => setOpsFullReindexFallback(e.target.checked)}
                className="rounded border-app-border"
              />
              Allow full reindex fallback if help-only reindex fails
            </label>

            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => void runHelpReindex()}
                disabled={opsBusy}
                className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-sm font-bold"
              >
                <Search size={16} /> Reindex Help search
              </button>
              <button
                type="button"
                onClick={() => void loadOpsStatus()}
                disabled={opsBusy}
                className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider"
              >
                <RefreshCw size={14} /> Refresh status
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Operation logs
              </h3>
              <button
                type="button"
                onClick={() => void exportOpsLogs()}
                disabled={opsLogs.length === 0}
                className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs font-black uppercase tracking-wider"
              >
                Export logs
              </button>
            </div>
            <div className="mt-2 max-h-[420px] overflow-y-auto rounded border border-app-border bg-app-bg p-2">
              {opsLogs.length === 0 ? (
                <p className="text-xs text-app-text-muted">
                  No operations yet.
                </p>
              ) : (
                <ul className="space-y-1">
                  {opsLogs.map((l, i) => (
                    <li
                      key={`${l.at}-${i}`}
                      className={`rounded px-2 py-1 text-xs ${l.ok ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "bg-rose-500/10 text-rose-700 dark:text-rose-300"}`}
                    >
                      <span className="font-mono">{l.at}</span> ·{" "}
                      <span className="font-semibold uppercase">
                        {l.action}
                      </span>{" "}
                      · <span>{l.message}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}

      {tab === "rosie-readiness" && (
        <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <h3 className="flex items-center gap-2 text-sm font-black uppercase tracking-widest text-app-text">
              <Bot size={16} /> ROSIE readiness
            </h3>
            <p className="mt-1 text-xs text-app-text-muted">
              Early quality gates for future local-LLM Help integration.
            </p>
            <div className="mt-4 space-y-2 text-sm">
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Manuals available:{" "}
                <span className="font-bold">{kpi.total}</span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Manuals with markdown overrides:{" "}
                <span className="font-bold">{kpi.markdownOverrideCount}</span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Hidden manuals (excluded from viewer):{" "}
                <span className="font-bold">{kpi.hiddenCount}</span>
              </div>
              <div className="rounded border border-app-border bg-app-surface-2/40 p-2">
                Mentions of “ROSIE” in overrides:{" "}
                <span className="font-bold">{kpi.rosieTaggedCount}</span>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-app-border bg-app-surface p-4">
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Recommended next steps
            </h3>
            <ul className="mt-2 list-disc space-y-2 pl-5 text-sm text-app-text">
              <li>
                Keep summaries and headings clear so chunked search results are
                easier for staff and future ROSIE grounding.
              </li>
              <li>
                Run <strong>One-click full sync</strong> after structural manual
                changes to keep manifest and search aligned.
              </li>
              <li>
                Minimize hidden manuals unless intentionally archived for policy
                reasons.
              </li>
              <li>
                Use manual tags/order consistently to improve prioritization in
                the Help picker and future AI context routing.
              </li>
            </ul>
          </section>
        </div>
      )}

      <ConfirmationModal
        isOpen={revertOpen}
        title="Revert manual policy?"
        message="This removes all database overrides for this manual and restores bundled markdown and default visibility rules."
        confirmLabel="Revert"
        variant="danger"
        onConfirm={() => void revertPolicy()}
        onClose={() => setRevertOpen(false)}
      />
      <ConfirmationModal
        isOpen={fullSyncConfirmOpen}
        title="Run one-click full sync?"
        message="This will run manifest generation (non-dry-run, rescan enabled) and then reindex Help search. Use this after structural Help manual changes."
        confirmLabel={fullSyncBusy ? "Running…" : "Run full sync"}
        onConfirm={() => void runFullSync()}
        onClose={() => {
          if (!fullSyncBusy) setFullSyncConfirmOpen(false);
        }}
      />
    </div>
  );
}
