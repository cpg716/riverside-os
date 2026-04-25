import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, CheckCircle2, History, Info } from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

const baseUrl = getBaseUrl();

type MeilisearchSyncRow = {
  index_name: string;
  last_success_at: string | null;
  last_attempt_at: string;
  is_success: boolean;
  row_count: number;
  error_message: string | null;
};

type MeilisearchStatusResponse = {
  configured: boolean;
  indices: MeilisearchSyncRow[];
  is_indexing: boolean;
};

export default function MeilisearchSettingsPanel() {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const [meiliConfigured, setMeiliConfigured] = useState<boolean | null>(null);
  const [meiliIndices, setMeiliIndices] = useState<MeilisearchSyncRow[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [meiliReindexBusy, setMeiliReindexBusy] = useState(false);
  const [meiliReindexConfirmOpen, setMeiliReindexConfirmOpen] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchStatus = useCallback(async () => {
    if (!hasPermission("settings.admin")) return;
    try {
      const res = await fetch(`${baseUrl}/api/settings/meilisearch/status`, {
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (res.ok) {
        const j = (await res.json()) as MeilisearchStatusResponse;
        setMeiliConfigured(j.configured === true);
        setMeiliIndices(j.indices || []);
        setIsIndexing(j.is_indexing);
      } else {
        setMeiliConfigured(null);
      }
    } catch {
      setMeiliConfigured(null);
      setMeiliIndices([]);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders, hasPermission]);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  // Dynamic polling when indexing is active
  useEffect(() => {
    if (!isIndexing) return;

    const interval = setInterval(() => {
      void fetchStatus();
    }, 3000); // Poll every 3 seconds while indexing

    return () => clearInterval(interval);
  }, [isIndexing, fetchStatus]);

  const runReindex = async () => {
    setMeiliReindexConfirmOpen(false);
    setMeiliReindexBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/settings/meilisearch/reindex`, {
        method: "POST",
        headers: backofficeHeaders() as Record<string, string>,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        toast(j.error || "Reindex failed", "error");
        setMeiliReindexBusy(false);
      } else {
        toast("Meilisearch rebuild completed", "success");
        void fetchStatus();
        setMeiliReindexBusy(false);
      }
    } catch (e) {
      toast(String(e), "error");
      setMeiliReindexBusy(false);
    }
  };

  if (!hasPermission("settings.admin")) {
    return (
      <div className="ui-card p-8 text-center">
        <p className="text-sm font-medium text-app-text-muted">
          Administrator privileges required to manage search infrastructure.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <header className="mb-2">
        <div className="flex flex-wrap items-start gap-4">
          <div className="flex shrink-0 items-center justify-center">
            <IntegrationBrandLogo
              brand="meilisearch"
              kind="wordmark"
              className="inline-flex rounded-2xl border border-app-success/20 bg-app-surface px-5 py-3 shadow-sm"
              imageClassName="h-12 w-auto object-contain"
            />
          </div>
          <div className="min-w-0 flex-1 space-y-2">
            <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">
              Search Infrastructure
            </h2>
            <p className="text-sm font-medium text-app-text-muted leading-relaxed max-w-3xl">
              High-performance fuzzy search engine. Riverside uses Meilisearch
              for inventory, customers, weddings, orders, transactions,
              alterations, and help-center search when configured.
            </p>
          </div>
        </div>
      </header>

      <section className="ui-card ui-tint-success p-8 max-w-5xl">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-app-surface ring-1 ring-app-border">
              <IntegrationBrandLogo
                brand="meilisearch"
                kind="icon"
                className="inline-flex"
                imageClassName="h-7 w-7 object-contain"
              />
            </div>
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Sync Health Dashboard
              </h3>
              <p className="text-xs text-app-text-muted mt-1 max-w-xl leading-relaxed">
                Refresh only reloads this health view. Rebuild re-pushes
                PostgreSQL records; normal writes update their affected search
                documents as staff work.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="ui-pill bg-app-surface-2 text-app-text-muted text-[9px]">
              {loading ? (
                "Checking..."
              ) : isIndexing ? (
                <span className="flex items-center gap-1.5 text-emerald-500 font-bold">
                  <RefreshCw className="h-2 w-2 animate-spin" />
                  Indexing...
                </span>
              ) : meiliConfigured === null ? (
                "Status unknown"
              ) : meiliConfigured ? (
                "Configured on server"
              ) : (
                "Not configured"
              )}
            </span>
            <button
              type="button"
              disabled={loading}
              onClick={() => void fetchStatus()}
              className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest inline-flex items-center gap-2"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
                aria-hidden
              />
              Refresh
            </button>
          </div>
        </div>

        {meiliConfigured === false && (
          <div className="ui-panel ui-tint-warning mb-8 px-4 py-3 text-xs text-app-text-muted leading-relaxed">
            <p className="font-bold text-app-warning uppercase tracking-widest text-[10px] mb-1">
              Server environment required
            </p>
            Meilisearch reindex stays disabled until{" "}
            <code className="font-mono text-[10px] bg-app-surface-2 px-1 rounded">
              RIVERSIDE_MEILISEARCH_URL
            </code>{" "}
            and{" "}
            <code className="font-mono text-[10px] bg-app-surface-2 px-1 rounded">
              RIVERSIDE_MEILISEARCH_KEY
            </code>{" "}
            are set on the API host.
          </div>
        )}

        {meiliConfigured && (
          <div className="mb-8 space-y-8">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="ui-metric-cell ui-tint-neutral p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                  Index Health
                </p>
                <div className="flex items-center gap-2">
                  <div
                    className={`h-2 w-2 rounded-full ${isIndexing ? "bg-app-success animate-pulse" : meiliIndices.every((i) => i.is_success) ? "bg-app-success" : "bg-app-danger"} shadow-[0_0_8px_color-mix(in_srgb,var(--app-success)_60%,transparent)]`}
                  />
                  <span className="text-sm font-black text-app-text">
                    {isIndexing
                      ? "Indexing..."
                      : meiliIndices.every((i) => i.is_success)
                        ? "All Healthy"
                        : "Action Required"}
                  </span>
                </div>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                  Total Indexed
                </p>
                <span className="text-sm font-black text-app-text flex items-center gap-2">
                  {meiliIndices
                    .reduce((acc, i) => acc + i.row_count, 0)
                    .toLocaleString()}{" "}
                  <span className="text-[10px] opacity-60">Rows</span>
                  {isIndexing && (
                    <RefreshCw className="h-3 w-3 animate-spin text-emerald-500/50" />
                  )}
                </span>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                  Stale Warning
                </p>
                <span className="text-sm font-black text-app-text">
                  {
                    meiliIndices.filter(
                      (i) =>
                        i.last_success_at &&
                        new Date().getTime() -
                          new Date(i.last_success_at).getTime() >
                          86400000,
                    ).length
                  }{" "}
                  <span className="text-[10px] opacity-60">Indices</span>
                </span>
              </div>
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-1">
                  Last Contact
                </p>
                <span className="text-xs font-black text-app-text truncate">
                  {meiliIndices.length > 0
                    ? meiliIndices
                        .reduce((prev, curr) =>
                          new Date(curr.last_attempt_at) >
                          new Date(prev.last_attempt_at)
                            ? curr
                            : prev,
                        )
                        .last_attempt_at.split("T")[0]
                    : "Never"}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {[
                "ros_variants",
                "ros_customers",
                "ros_wedding_parties",
                "ros_fulfillment_orders",
                "ros_transactions",
                "ros_staff",
                "ros_vendors",
                "ros_tasks",
                "ros_appointments",
                "ros_alterations",
              ].map((catName) => {
                const idx = meiliIndices.find(
                  (i) => i.index_name === catName,
                ) || {
                  index_name: catName,
                  row_count: 0,
                  is_success: false,
                  last_success_at: null,
                  error_message: "Index not yet created or tracked.",
                };

                const isStale =
                  idx.last_success_at &&
                  new Date().getTime() -
                    new Date(idx.last_success_at).getTime() >
                    86400000;
                const hasRun = idx.last_success_at !== null;
                const isLocalIndexing =
                  isIndexing && (!hasRun || idx.is_success);
                if (isLocalIndexing) {
                  console.debug("Meilisearch is currently indexing locally.");
                }

                // User-friendly display names
                const displayLabel =
                  (
                    {
                      ros_variants: "Inventory",
                      ros_wedding_parties: "Weddings",
                      ros_customers: "Customers",
                      ros_fulfillment_orders: "Orders",
                      ros_transactions: "Transactions",
                      ros_staff: "Staff",
                      ros_vendors: "Vendors",
                      ros_tasks: "Tasks",
                      ros_appointments: "Appointments",
                      ros_alterations: "Alterations",
                    } as Record<string, string>
                  )[idx.index_name] ||
                  idx.index_name.replace("ros_", "").replace("_", " ");

                return (
                  <div
                    key={idx.index_name}
                    className={`ui-metric-cell p-4 ${isIndexing ? "ui-tint-success animate-pulse-subtle" : idx.is_success ? (isStale ? "ui-tint-warning" : "ui-tint-success") : "ui-tint-danger"} transition-all group relative overflow-hidden`}
                  >
                    <div className="flex items-center justify-between gap-3 mb-2">
                      <div className="flex flex-col min-w-0">
                        <span
                          className="text-[10px] font-black uppercase tracking-widest text-app-text truncate"
                          title={idx.index_name}
                        >
                          {displayLabel}
                        </span>
                        {isIndexing ? (
                          <span className="text-[8px] font-black text-app-success uppercase tracking-tighter flex items-center gap-1">
                            <RefreshCw className="h-2 w-2 animate-spin" />
                            Indexing...
                          </span>
                        ) : (
                          !hasRun && (
                            <span className="text-[8px] font-black text-app-danger uppercase tracking-tighter">
                              Sync Required
                            </span>
                          )
                        )}
                      </div>
                      {isIndexing ? (
                        <RefreshCw className="h-4 w-4 text-app-success animate-spin opacity-50" />
                      ) : idx.is_success ? (
                        isStale ? (
                          <History className="h-4 w-4 text-app-warning animate-pulse" />
                        ) : (
                          <CheckCircle2 className="h-4 w-4 text-app-success" />
                        )
                      ) : (
                        <div className="h-4 w-4 flex items-center justify-center rounded-full bg-app-danger/10">
                          <Info className="h-3 w-3 text-app-danger" />
                        </div>
                      )}
                    </div>
                    <div className="flex flex-col gap-1.5 mt-3">
                      <div className="flex justify-between items-center text-[11px]">
                        <span className="text-app-text-muted font-bold">
                          Rows
                        </span>
                        <span className="text-app-text font-black">
                          {idx.row_count.toLocaleString()}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-[9px]">
                        <span className="text-app-text-muted font-bold">
                          Last Sync
                        </span>
                        <span className="text-app-text font-black opacity-80">
                          {idx.last_success_at
                            ? new Date(idx.last_success_at).toLocaleTimeString(
                                [],
                                { hour: "2-digit", minute: "2-digit" },
                              )
                            : isIndexing
                              ? "Pending..."
                              : "Never"}
                        </span>
                      </div>
                      {!isIndexing && !idx.is_success && idx.error_message && (
                        <div className="mt-2 text-[8px] font-bold text-app-danger bg-app-danger/10 p-2 rounded-lg border border-app-danger/10 break-words leading-tight">
                          {idx.error_message}
                        </div>
                      )}
                      {idx.is_success && isStale && (
                        <div className="mt-2 text-[8px] font-black uppercase tracking-[0.05em] text-app-warning bg-app-warning/10 p-2 rounded-lg border border-app-warning/10">
                          Warning: Data stale (24h+)
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-8 pt-6 border-t border-emerald-500/10 flex flex-wrap items-center justify-between gap-4">
          <div className="max-w-md">
            <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text mb-1">
              Full index rebuild
            </h4>
            <p className="text-[10px] text-app-text-muted leading-relaxed">
              If search results feel stale or Meilisearch was recently wiped,
              run a full rebuild. This will re-push all records from SQL to
              Meilisearch. Large catalogs may take minutes; Refresh only checks
              the latest status.
            </p>
          </div>
          <button
            type="button"
            disabled={
              meiliReindexBusy || isIndexing || meiliConfigured !== true
            }
            onClick={() => setMeiliReindexConfirmOpen(true)}
            className="ui-btn-primary px-6 py-2.5 text-[10px] font-black uppercase tracking-widest bg-emerald-600 border-emerald-700 shadow-emerald-900/10 hover:bg-emerald-700 disabled:bg-app-surface-2 disabled:text-app-text-muted disabled:border-app-border"
          >
            {isIndexing
              ? "Indexing..."
              : meiliReindexBusy
                ? "Starting..."
                : "Rebuild all indices"}
          </button>
        </div>
      </section>

      {meiliReindexConfirmOpen && (
        <ConfirmationModal
          isOpen={true}
          title="Rebuild all search indices?"
          message="This reloads Meilisearch from PostgreSQL for all modules (Products, Customers, Orders, Transactions, Staff, Vendors, Tasks, Appointments, and Alterations). It can take several minutes on large catalogs. Staff can keep working during the process."
          confirmLabel="Execute Rebuild"
          onConfirm={() => void runReindex()}
          onClose={() => setMeiliReindexConfirmOpen(false)}
          variant="info"
        />
      )}
    </div>
  );
}
