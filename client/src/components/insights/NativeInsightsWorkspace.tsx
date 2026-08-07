import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Archive,
  ArchiveRestore,
  BarChart3,
  CalendarRange,
  Download,
  FileClock,
  Heart,
  History,
  Loader2,
  Play,
  Printer,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Trash2,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { downloadTextFile } from "../../lib/desktopFileBridge";
import { openProfessionalTablePrint } from "../pos/zReportPrint";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";

type VisualizationKind = "table" | "bar" | "line" | "area" | "pie";

type CubeReportSpec = {
  title: string;
  explanation: string;
  dataset: string;
  measures: string[];
  dimensions: string[];
  time_dimension?: {
    member: string;
    granularity?: string | null;
    date_range?: string[] | null;
  } | null;
  filters: Array<{ member: string; operator: string; values: string[] }>;
  order: Array<{ member: string; direction: string }>;
  limit: number;
  visualization: {
    kind: VisualizationKind;
    x_member?: string | null;
    y_members: string[];
  };
};

type ReportRunResponse = {
  history_id: string;
  question: string;
  spec: CubeReportSpec;
  rows: Record<string, unknown>[];
  row_count: number;
  member_labels: Record<string, string>;
  member_formats: Record<string, string>;
  generated_at: string;
  engine: string;
};

type SavedFavorite = {
  id: string;
  name: string;
  question: string;
  report_spec: CubeReportSpec;
  created_at: string;
  updated_at: string;
};

type HistoryEntry = {
  id: string;
  question: string;
  title: string;
  report_spec: CubeReportSpec;
  row_count: number;
  created_at: string;
  last_accessed_at: string;
  archived_at?: string | null;
};

type HistoryMode = "recent" | "favorites" | "archive";

const baseUrl = getBaseUrl();
const CHART_COLORS = ["#7c3aed", "#2563eb", "#059669", "#d97706", "#dc2626"];
const STARTERS = [
  "Show booked sales by salesperson this month",
  "What were recognized sales by category for the last 90 days?",
  "Show available inventory by brand, highest first",
  "How many active alterations are overdue?",
  "Compare payment totals by tender this week",
];

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10);
}

function ninetyDaysAgoYmd(): string {
  const date = new Date();
  date.setDate(date.getDate() - 90);
  return date.toISOString().slice(0, 10);
}

function memberBase(key: string): string {
  const parts = key.split(".");
  return parts.length > 2 ? parts.slice(0, 2).join(".") : key;
}

function fallbackLabel(key: string): string {
  const raw = key.split(".").slice(-2, -1)[0] ?? key.split(".").at(-1) ?? key;
  return raw
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function rowValue(row: Record<string, unknown>, member: string): unknown {
  if (member in row) return row[member];
  const key = Object.keys(row).find((candidate) => candidate.startsWith(`${member}.`));
  return key ? row[key] : undefined;
}

function numberValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function displayValue(value: unknown, format: string): string {
  if (value === null || value === undefined || value === "") return "—";
  if (format === "money") {
    return numberValue(value).toLocaleString(undefined, {
      style: "currency",
      currency: "USD",
    });
  }
  if (format === "number" || format === "points") {
    return numberValue(value).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
  }
  if (format === "date" && typeof value === "string") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toLocaleDateString();
  }
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function safeFilename(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${slug || "riverside-report"}-${todayYmd()}.csv`;
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload && typeof payload === "object" && "error" in payload) {
    const error = (payload as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function isReportSpec(value: unknown): value is CubeReportSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<CubeReportSpec>;
  return (
    typeof spec.title === "string" &&
    typeof spec.dataset === "string" &&
    Array.isArray(spec.measures) &&
    Array.isArray(spec.dimensions) &&
    typeof spec.visualization === "object"
  );
}

export default function NativeInsightsWorkspace() {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ReportRunResponse | null>(null);
  const [favorites, setFavorites] = useState<SavedFavorite[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [archive, setArchive] = useState<HistoryEntry[]>([]);
  const [historyMode, setHistoryMode] = useState<HistoryMode>("recent");
  const [listsLoading, setListsLoading] = useState(true);
  const [favoriteName, setFavoriteName] = useState("");
  const [showFavoriteForm, setShowFavoriteForm] = useState(false);
  const [favoriteToDelete, setFavoriteToDelete] = useState<SavedFavorite | null>(null);
  const [fromDate, setFromDate] = useState(ninetyDaysAgoYmd());
  const [toDate, setToDate] = useState(todayYmd());
  const [health, setHealth] = useState<"connected" | "needs_update" | null>(null);
  const [staffGuidance, setStaffGuidance] = useState("");

  const headers = useCallback(
    () => backofficeHeaders() as Record<string, string>,
    [backofficeHeaders],
  );

  const loadLists = useCallback(async () => {
    setListsLoading(true);
    try {
      const requestHeaders = headers();
      const [favoritesResponse, historyResponse, archiveResponse, healthResponse] =
        await Promise.all([
          fetch(`${baseUrl}/api/insights/reports/favorites`, { headers: requestHeaders }),
          fetch(`${baseUrl}/api/insights/reports/history`, { headers: requestHeaders }),
          fetch(`${baseUrl}/api/insights/reports/history?archived=true`, {
            headers: requestHeaders,
          }),
          fetch(`${baseUrl}/api/insights/health`, { headers: requestHeaders }),
        ]);
      if (favoritesResponse.ok) {
        const rows = (await favoritesResponse.json()) as SavedFavorite[];
        setFavorites(rows.filter((row) => isReportSpec(row.report_spec)));
      }
      if (historyResponse.ok) {
        const rows = (await historyResponse.json()) as HistoryEntry[];
        setHistory(rows.filter((row) => isReportSpec(row.report_spec)));
      }
      if (archiveResponse.ok) {
        const rows = (await archiveResponse.json()) as HistoryEntry[];
        setArchive(rows.filter((row) => isReportSpec(row.report_spec)));
      }
      if (healthResponse.ok) {
        const data = (await healthResponse.json()) as {
          status?: typeof health;
          staff_guidance?: string;
        };
        setHealth(data.status ?? null);
        setStaffGuidance(data.staff_guidance?.trim() ?? "");
      }
    } catch {
      toast("Could not refresh report history", "error");
    } finally {
      setListsLoading(false);
    }
  }, [headers, toast]);

  useEffect(() => {
    void loadLists();
  }, [loadLists]);

  const applyResult = useCallback((next: ReportRunResponse) => {
    setResult(next);
    const range = next.spec.time_dimension?.date_range;
    if (Array.isArray(range) && range.length === 2) {
      setFromDate(range[0]);
      setToDate(range[1]);
    }
  }, []);

  const ask = async (requestedQuestion?: string) => {
    const text = (requestedQuestion ?? question).trim();
    if (!text) return;
    setBusy(true);
    try {
      const response = await fetch(`${baseUrl}/api/insights/reports/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({
          question: text,
          previous_spec: result?.spec ?? null,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        toast(getErrorMessage(payload, "Report could not be generated"), "error");
        return;
      }
      applyResult(payload as ReportRunResponse);
      setQuestion("");
      setShowFavoriteForm(false);
      void loadLists();
    } catch {
      toast("Report could not be generated", "error");
    } finally {
      setBusy(false);
    }
  };

  const runSpec = async (
    spec: CubeReportSpec,
    options?: { historyId?: string; question?: string; useSelectedPeriod?: boolean },
  ) => {
    setBusy(true);
    try {
      const response = await fetch(`${baseUrl}/api/insights/reports/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({
          spec,
          question: options?.question ?? "",
          history_id: options?.historyId ?? null,
          date_range:
            options?.useSelectedPeriod && spec.time_dimension
              ? [fromDate, toDate]
              : null,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as unknown;
      if (!response.ok) {
        toast(getErrorMessage(payload, "Report could not be rerun"), "error");
        return;
      }
      applyResult(payload as ReportRunResponse);
      setShowFavoriteForm(false);
      void loadLists();
    } catch {
      toast("Report could not be rerun", "error");
    } finally {
      setBusy(false);
    }
  };

  const saveFavorite = async () => {
    if (!result || !favoriteName.trim()) return;
    try {
      const response = await fetch(`${baseUrl}/api/insights/reports/favorites`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers() },
        body: JSON.stringify({
          name: favoriteName.trim(),
          question: result.question,
          spec: result.spec,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        toast(getErrorMessage(payload, "Favorite could not be saved"), "error");
        return;
      }
      toast("Report saved to favorites", "success");
      setFavoriteName("");
      setShowFavoriteForm(false);
      void loadLists();
    } catch {
      toast("Favorite could not be saved", "error");
    }
  };

  const deleteFavorite = async () => {
    if (!favoriteToDelete) return;
    try {
      const response = await fetch(
        `${baseUrl}/api/insights/reports/favorites/${favoriteToDelete.id}`,
        { method: "DELETE", headers: headers() },
      );
      if (!response.ok) {
        toast("Favorite could not be removed", "error");
        return;
      }
      toast("Favorite removed", "success");
      setFavoriteToDelete(null);
      void loadLists();
    } catch {
      toast("Favorite could not be removed", "error");
    }
  };

  const setArchived = async (entry: HistoryEntry, archived: boolean) => {
    try {
      const action = archived ? "archive" : "restore";
      const response = await fetch(
        `${baseUrl}/api/insights/reports/history/${entry.id}/${action}`,
        { method: "POST", headers: headers() },
      );
      if (!response.ok) {
        toast(`Report could not be ${archived ? "archived" : "restored"}`, "error");
        return;
      }
      toast(archived ? "Report moved to archive" : "Report restored", "success");
      void loadLists();
    } catch {
      toast("Report history could not be updated", "error");
    }
  };

  const columns = useMemo(() => {
    if (!result) return [];
    if (result.rows.length > 0) return Object.keys(result.rows[0]);
    return Array.from(
      new Set([
        ...(result.spec.time_dimension ? [result.spec.time_dimension.member] : []),
        ...result.spec.dimensions,
        ...result.spec.measures,
      ]),
    );
  }, [result]);

  const labelFor = useCallback(
    (key: string) => {
      if (!result) return fallbackLabel(key);
      return (
        result.member_labels[key] ??
        result.member_labels[memberBase(key)] ??
        fallbackLabel(key)
      );
    },
    [result],
  );

  const formatFor = useCallback(
    (key: string) => {
      if (!result) return "text";
      return result.member_formats[key] ?? result.member_formats[memberBase(key)] ?? "text";
    },
    [result],
  );

  const printRows = useMemo(() => {
    if (!result) return [];
    return result.rows.map((row) =>
      Object.fromEntries(
        columns.map((column) => [
          labelFor(column),
          displayValue(row[column], formatFor(column)),
        ]),
      ),
    );
  }, [columns, formatFor, labelFor, result]);

  const exportCsv = async () => {
    if (!result) return;
    const header = columns.map((column) => csvCell(labelFor(column))).join(",");
    const lines = result.rows.map((row) =>
      columns
        .map((column) => csvCell(displayValue(row[column], formatFor(column))))
        .join(","),
    );
    const saved = await downloadTextFile(
      safeFilename(result.spec.title),
      [header, ...lines].join("\n"),
      "text/csv;charset=utf-8",
      [{ name: "CSV report", extensions: ["csv"] }],
    );
    if (saved) toast("Report exported", "success");
  };

  const printReport = async () => {
    if (!result) return;
    const range = result.spec.time_dimension?.date_range;
    const period =
      Array.isArray(range) && range.length === 2
        ? `${range[0]} through ${range[1]}`
        : null;
    await openProfessionalTablePrint({
      title: result.spec.title,
      subtitle: [
        result.spec.explanation,
        period,
        `${result.row_count.toLocaleString()} rows`,
        `Generated ${new Date(result.generated_at).toLocaleString()}`,
      ]
        .filter(Boolean)
        .join(" · "),
      columns: columns.map(labelFor),
      rows: printRows,
      action: "preview",
    });
  };

  const chart = useMemo(() => {
    if (!result || result.spec.visualization.kind === "table") return null;
    const xMember = result.spec.visualization.x_member;
    const yMembers = result.spec.visualization.y_members;
    if (!xMember || yMembers.length === 0) return null;
    return result.rows.map((row) => ({
      label: displayValue(
        rowValue(row, xMember),
        result.member_formats[xMember] ?? "text",
      ),
      ...Object.fromEntries(
        yMembers.map((member, index) => [`value_${index}`, numberValue(rowValue(row, member))]),
      ),
    }));
  }, [result]);

  const renderChart = () => {
    if (!result || !chart) return null;
    const kind = result.spec.visualization.kind;
    const yMembers = result.spec.visualization.y_members;
    const tooltipFormatter = (value: unknown, name: unknown): [string, string] => {
      const label = String(name ?? "Value");
      const member =
        yMembers.find(
          (candidate) =>
            (result.member_labels[candidate] ?? fallbackLabel(candidate)) === label,
        ) ?? yMembers[0];
      return [
        displayValue(value, result.member_formats[member] ?? "number"),
        label,
      ];
    };
    if (kind === "pie") {
      return (
        <ResponsiveContainer width="100%" height={330}>
          <PieChart>
            <Pie data={chart} dataKey="value_0" nameKey="label" outerRadius={120} label>
              {chart.map((_, index) => (
                <Cell key={index} fill={CHART_COLORS[index % CHART_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={tooltipFormatter} />
            <Legend />
          </PieChart>
        </ResponsiveContainer>
      );
    }
    const common = (
      <>
        <CartesianGrid strokeDasharray="3 3" opacity={0.2} />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 10 }} />
        <Tooltip formatter={tooltipFormatter} />
        <Legend />
      </>
    );
    if (kind === "line") {
      return (
        <ResponsiveContainer width="100%" height={330}>
          <LineChart data={chart}>
            {common}
            {yMembers.map((member, index) => (
              <Line
                key={member}
                type="monotone"
                dataKey={`value_${index}`}
                name={result.member_labels[member] ?? fallbackLabel(member)}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                strokeWidth={3}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      );
    }
    if (kind === "area") {
      return (
        <ResponsiveContainer width="100%" height={330}>
          <AreaChart data={chart}>
            {common}
            {yMembers.map((member, index) => (
              <Area
                key={member}
                type="monotone"
                dataKey={`value_${index}`}
                name={result.member_labels[member] ?? fallbackLabel(member)}
                stroke={CHART_COLORS[index % CHART_COLORS.length]}
                fill={CHART_COLORS[index % CHART_COLORS.length]}
                fillOpacity={0.18}
              />
            ))}
          </AreaChart>
        </ResponsiveContainer>
      );
    }
    return (
      <ResponsiveContainer width="100%" height={330}>
        <BarChart data={chart}>
          {common}
          {yMembers.map((member, index) => (
            <Bar
              key={member}
              dataKey={`value_${index}`}
              name={result.member_labels[member] ?? fallbackLabel(member)}
              fill={CHART_COLORS[index % CHART_COLORS.length]}
              radius={[5, 5, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    );
  };

  const visibleEntries = historyMode === "archive" ? archive : history;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-app-bg px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="ui-card overflow-hidden p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-violet-500/10 p-3 text-violet-600 ring-1 ring-violet-500/20">
                <Sparkles className="h-7 w-7" aria-hidden />
              </div>
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-violet-600">
                  Riverside Insights
                </p>
                <h1 className="mt-1 text-3xl font-black tracking-tight text-app-text">
                  Ask Riverside anything reportable
                </h1>
                <p className="mt-2 max-w-3xl text-sm font-medium leading-relaxed text-app-text-muted">
                  Ask in plain language. Gemma creates a checked report plan, and Riverside reads
                  only approved report data before presenting the chart, table, printout, and export.
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <span
                className={`h-2.5 w-2.5 rounded-full ${
                  health === "connected"
                    ? "bg-emerald-500"
                    : "bg-amber-500"
                }`}
              />
              {health === "connected" ? "Reporting ready" : "Main Hub update needed"}
            </div>
          </div>

          {staffGuidance ? (
            <div className="mt-5 rounded-2xl border border-violet-500/20 bg-violet-500/[0.05] px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-violet-600">
                Store reporting guidance
              </p>
              <p className="mt-1 whitespace-pre-wrap text-xs font-semibold leading-relaxed text-app-text-muted">
                {staffGuidance}
              </p>
            </div>
          ) : null}

          <form
            className="mt-6 flex flex-col gap-3 rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] p-4 lg:flex-row"
            onSubmit={(event) => {
              event.preventDefault();
              void ask();
            }}
          >
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={2}
              className="ui-input min-h-16 flex-1 resize-y px-4 py-3 text-sm font-semibold"
              placeholder={
                result
                  ? "Change this report—for example: group monthly, switch to recognized sales, or add units..."
                  : "Ask for a report in plain language..."
              }
              disabled={busy}
            />
            <button
              type="submit"
              disabled={busy || !question.trim()}
              className="ui-btn-primary inline-flex min-h-12 items-center justify-center gap-2 px-6 text-xs font-black uppercase tracking-widest"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {result ? "Update report" : "Build report"}
            </button>
          </form>

          {!result ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => void ask(starter)}
                  disabled={busy}
                  className="rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-[11px] font-bold text-app-text transition-colors hover:border-violet-500/40 hover:text-violet-600"
                >
                  {starter}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        <div className="grid gap-5 xl:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="ui-card self-start overflow-hidden xl:sticky xl:top-20">
            <div className="grid grid-cols-3 border-b border-app-border">
              {([
                ["recent", History, "History"],
                ["favorites", Heart, "Favorites"],
                ["archive", Archive, "Archive"],
              ] as const).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setHistoryMode(mode)}
                  className={`flex flex-col items-center gap-1 px-2 py-3 text-[9px] font-black uppercase tracking-wider transition-colors ${
                    historyMode === mode
                      ? "bg-violet-500/10 text-violet-600"
                      : "text-app-text-muted hover:bg-app-surface-2"
                  }`}
                >
                  <Icon className="h-4 w-4" />
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between border-b border-app-border px-4 py-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                {historyMode === "favorites"
                  ? `${favorites.length} pinned`
                  : `${visibleEntries.length} reports`}
              </p>
              <button
                type="button"
                onClick={() => void loadLists()}
                className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
                aria-label="Refresh report lists"
              >
                <RefreshCw className={`h-4 w-4 ${listsLoading ? "animate-spin" : ""}`} />
              </button>
            </div>
            <div className="max-h-[66vh] overflow-y-auto p-2">
              {historyMode === "favorites"
                ? favorites.map((favorite) => (
                    <div key={favorite.id} className="group rounded-xl border border-transparent p-2 hover:border-app-border hover:bg-app-surface-2">
                      <button
                        type="button"
                        onClick={() =>
                          void runSpec(favorite.report_spec, { question: favorite.question })
                        }
                        disabled={busy}
                        className="w-full text-left"
                      >
                        <p className="line-clamp-2 text-xs font-black text-app-text">{favorite.name}</p>
                        <p className="mt-1 text-[10px] font-medium text-app-text-muted">
                          {favorite.report_spec.dataset.replaceAll("_", " ")}
                        </p>
                      </button>
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => setFavoriteToDelete(favorite)}
                          className="rounded-lg p-1.5 text-app-text-muted opacity-60 hover:bg-rose-500/10 hover:text-rose-600 group-hover:opacity-100"
                          aria-label={`Remove ${favorite.name} from favorites`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))
                : visibleEntries.map((entry) => (
                    <div key={entry.id} className="group rounded-xl border border-transparent p-2 hover:border-app-border hover:bg-app-surface-2">
                      <button
                        type="button"
                        onClick={() =>
                          void runSpec(entry.report_spec, {
                            historyId: entry.id,
                            question: entry.question,
                          })
                        }
                        disabled={busy}
                        className="w-full text-left"
                      >
                        <p className="line-clamp-2 text-xs font-black text-app-text">{entry.title}</p>
                        <p className="mt-1 text-[10px] font-medium text-app-text-muted">
                          {new Date(entry.last_accessed_at).toLocaleDateString()} · {entry.row_count.toLocaleString()} rows
                        </p>
                      </button>
                      <div className="mt-2 flex justify-end">
                        <button
                          type="button"
                          onClick={() => void setArchived(entry, historyMode !== "archive")}
                          className="rounded-lg p-1.5 text-app-text-muted opacity-60 hover:bg-violet-500/10 hover:text-violet-600 group-hover:opacity-100"
                          aria-label={historyMode === "archive" ? "Restore report" : "Archive report"}
                        >
                          {historyMode === "archive" ? (
                            <ArchiveRestore className="h-3.5 w-3.5" />
                          ) : (
                            <Archive className="h-3.5 w-3.5" />
                          )}
                        </button>
                      </div>
                    </div>
                  ))}
              {!listsLoading &&
              ((historyMode === "favorites" && favorites.length === 0) ||
                (historyMode !== "favorites" && visibleEntries.length === 0)) ? (
                <div className="px-4 py-10 text-center">
                  <FileClock className="mx-auto h-7 w-7 text-app-text-muted opacity-40" />
                  <p className="mt-3 text-xs font-bold text-app-text-muted">Nothing here yet.</p>
                </div>
              ) : null}
            </div>
          </aside>

          <main className="min-w-0 space-y-5">
            {result ? (
              <>
                <section className="ui-card p-5 sm:p-6">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full bg-violet-500/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-violet-600">
                          {result.spec.dataset.replaceAll("_", " ")}
                        </span>
                        <span className="text-[10px] font-bold text-app-text-muted">
                          {result.row_count.toLocaleString()} rows · {result.engine}
                        </span>
                      </div>
                      <h2 className="mt-3 text-2xl font-black tracking-tight text-app-text">
                        {result.spec.title}
                      </h2>
                      <p className="mt-2 max-w-4xl text-sm font-medium leading-relaxed text-app-text-muted">
                        {result.spec.explanation}
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setShowFavoriteForm((visible) => !visible)}
                        className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        <Star className="h-4 w-4" /> Favorite
                      </button>
                      <button
                        type="button"
                        onClick={() => void exportCsv()}
                        className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        <Download className="h-4 w-4" /> Export CSV
                      </button>
                      <button
                        type="button"
                        onClick={() => void printReport()}
                        className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        <Printer className="h-4 w-4" /> Print
                      </button>
                    </div>
                  </div>

                  {showFavoriteForm ? (
                    <div className="mt-5 flex flex-col gap-2 rounded-xl border border-violet-500/20 bg-violet-500/[0.04] p-3 sm:flex-row">
                      <input
                        value={favoriteName}
                        onChange={(event) => setFavoriteName(event.target.value)}
                        className="ui-input flex-1 px-3 py-2 text-sm font-semibold"
                        placeholder="Favorite name"
                        maxLength={120}
                      />
                      <button
                        type="button"
                        onClick={() => void saveFavorite()}
                        disabled={!favoriteName.trim()}
                        className="ui-btn-primary px-4 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        Save favorite
                      </button>
                    </div>
                  ) : null}

                  {result.spec.time_dimension ? (
                    <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
                      <CalendarRange className="mb-2 h-5 w-5 text-violet-600" />
                      <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        From
                        <input
                          type="date"
                          value={fromDate}
                          onChange={(event) => setFromDate(event.target.value)}
                          className="ui-input mt-1 block px-3 py-2 text-xs font-bold"
                        />
                      </label>
                      <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        To
                        <input
                          type="date"
                          value={toDate}
                          onChange={(event) => setToDate(event.target.value)}
                          className="ui-input mt-1 block px-3 py-2 text-xs font-bold"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() =>
                          void runSpec(result.spec, {
                            historyId: result.history_id,
                            question: result.question,
                            useSelectedPeriod: true,
                          })
                        }
                        disabled={busy || !fromDate || !toDate}
                        className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        <Play className="h-3.5 w-3.5" /> Run this period
                      </button>
                    </div>
                  ) : null}
                </section>

                {chart ? (
                  <section className="ui-card p-5 sm:p-6">
                    <div className="mb-4 flex items-center gap-2">
                      <BarChart3 className="h-5 w-5 text-violet-600" />
                      <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                        Visual summary
                      </h3>
                    </div>
                    {renderChart()}
                  </section>
                ) : null}

                <section className="ui-card overflow-hidden">
                  <div className="flex items-center justify-between border-b border-app-border px-5 py-4">
                    <div>
                      <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                        Report detail
                      </h3>
                      <p className="mt-1 text-[10px] font-medium text-app-text-muted">
                        Generated {new Date(result.generated_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full text-left text-xs">
                      <thead className="bg-app-surface-2 text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                        <tr>
                          {columns.map((column) => (
                            <th key={column} className="whitespace-nowrap px-4 py-3">
                              {labelFor(column)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-app-border">
                        {result.rows.map((row, index) => (
                          <tr key={index} className="hover:bg-app-surface-2/60">
                            {columns.map((column) => (
                              <td key={column} className="max-w-md px-4 py-3 font-semibold text-app-text">
                                {displayValue(row[column], formatFor(column))}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {result.rows.length === 0 ? (
                      <div className="px-6 py-16 text-center text-sm font-bold text-app-text-muted">
                        No matching rows for this report period and filter set.
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : (
              <section className="ui-card flex min-h-[520px] items-center justify-center p-8 text-center">
                <div className="max-w-lg">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-violet-500/10 text-violet-600">
                    <Sparkles className="h-8 w-8" />
                  </div>
                  <h2 className="mt-5 text-2xl font-black text-app-text">Your report will appear here</h2>
                  <p className="mt-2 text-sm font-medium leading-relaxed text-app-text-muted">
                    Ask a question above, or reopen any report from history. Every successful report is
                    saved automatically; unused history moves to the archive after the configured period.
                  </p>
                </div>
              </section>
            )}
          </main>
        </div>
      </div>

      <ConfirmationModal
        isOpen={favoriteToDelete !== null}
        onClose={() => setFavoriteToDelete(null)}
        onConfirm={() => void deleteFavorite()}
        title="Remove favorite?"
        message={
          favoriteToDelete
            ? `${favoriteToDelete.name} will be removed from Favorites. Its generated runs remain in report history.`
            : ""
        }
        confirmLabel="Remove favorite"
        variant="danger"
      />
    </div>
  );
}
