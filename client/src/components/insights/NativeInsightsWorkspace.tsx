import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  CheckCircle2,
  Download,
  FileClock,
  Heart,
  History,
  Loader2,
  Plus,
  Play,
  Printer,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { getBaseUrl } from "../../lib/apiConfig";
import { downloadTextFile } from "../../lib/desktopFileBridge";
import {
  dismissInsightsReportJob,
  getInsightsReportJobs,
  markInsightsReportJobViewed,
  markInsightsReportJobsViewed,
  MAX_CONCURRENT_INSIGHTS_JOBS,
  startInsightsReportJob,
  subscribeInsightsReportJobs,
  type InsightsReportJob,
  type InsightsReportRunResponse,
  type InsightsReportSpec,
  type InsightsVisualizationKind,
} from "../../lib/insightsReportJobs";
import { openProfessionalTablePrint } from "../pos/zReportPrint";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { useToast } from "../ui/ToastProviderLogic";

type SavedFavorite = {
  id: string;
  name: string;
  question: string;
  report_spec: InsightsReportSpec;
  created_at: string;
  updated_at: string;
};

type HistoryEntry = {
  id: string;
  question: string;
  title: string;
  report_spec: InsightsReportSpec;
  row_count: number;
  created_at: string;
  last_accessed_at: string;
  archived_at?: string | null;
};

type HistoryMode = "recent" | "favorites" | "archive";
type ReportingHealth = {
  status: "connected" | "degraded" | "unreachable" | "needs_configuration";
  message: string;
  cube_ready: boolean;
  planner_ready: boolean;
};

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

function isReportSpec(value: unknown): value is InsightsReportSpec {
  if (!value || typeof value !== "object") return false;
  const spec = value as Partial<InsightsReportSpec>;
  return (
    typeof spec.title === "string" &&
    typeof spec.dataset === "string" &&
    Array.isArray(spec.measures) &&
    Array.isArray(spec.dimensions) &&
    typeof spec.visualization === "object"
  );
}

async function readReportResponse(
  response: Response,
  fallback: string,
): Promise<InsightsReportRunResponse> {
  const payload = (await response.json().catch(() => ({}))) as unknown;
  if (!response.ok) throw new Error(getErrorMessage(payload, fallback));
  return payload as InsightsReportRunResponse;
}

export default function NativeInsightsWorkspace() {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<InsightsReportRunResponse | null>(null);
  const [jobs, setJobs] = useState<InsightsReportJob[]>(getInsightsReportJobs);
  const [generationModalJobId, setGenerationModalJobId] = useState<string | null>(null);
  const [visualizationKind, setVisualizationKind] =
    useState<InsightsVisualizationKind>("table");
  const [showVisual, setShowVisual] = useState(true);
  const [showData, setShowData] = useState(true);
  const [showPrintOptions, setShowPrintOptions] = useState(false);
  const [includeVisualInPrint, setIncludeVisualInPrint] = useState(true);
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
  const [health, setHealth] = useState<ReportingHealth | null>(null);
  const chartRef = useRef<HTMLDivElement | null>(null);

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
        setHealth((await healthResponse.json()) as ReportingHealth);
      } else {
        setHealth({
          status: "unreachable",
          message: "Reporting readiness could not be verified.",
          cube_ready: false,
          planner_ready: false,
        });
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

  const applyResult = useCallback((next: InsightsReportRunResponse) => {
    setResult(next);
    setVisualizationKind(next.spec.visualization.kind);
    setShowVisual(next.spec.visualization.kind !== "table");
    setShowData(true);
    const range = next.spec.time_dimension?.date_range;
    if (Array.isArray(range) && range.length === 2) {
      setFromDate(range[0]);
      setToDate(range[1]);
    }
  }, []);

  useEffect(() => subscribeInsightsReportJobs(setJobs), []);

  useEffect(() => {
    const completedJobs = jobs.filter(
      (job) => job.status === "complete" && job.result && !job.viewed,
    );
    const completed = completedJobs[0];
    if (!completed?.result) return;
    applyResult(completed.result);
    setShowFavoriteForm(false);
    markInsightsReportJobsViewed(completedJobs.map((job) => job.id));
    void loadLists();
  }, [applyResult, jobs, loadLists]);

  const runningJobs = useMemo(
    () => jobs.filter((job) => job.status === "running"),
    [jobs],
  );

  const startJob = useCallback(
    (options: {
      label: string;
      kind: InsightsReportJob["kind"];
      run: () => Promise<InsightsReportRunResponse>;
    }) => {
      try {
        const job = startInsightsReportJob(options);
        setGenerationModalJobId(job.id);
        return job;
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "Report could not be started",
          "warning",
        );
        return null;
      }
    },
    [toast],
  );

  const ask = async (requestedQuestion?: string) => {
    const text = (requestedQuestion ?? question).trim();
    if (!text) return;
    const previousSpec = result?.spec ?? null;
    const job = startJob({
      label: text,
      kind: previousSpec ? "update" : "build",
      run: async () => {
        const response = await fetch(`${baseUrl}/api/insights/reports/ask`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers() },
          body: JSON.stringify({ question: text, previous_spec: previousSpec }),
        });
        return readReportResponse(response, "Report could not be generated");
      },
    });
    if (job) {
      setQuestion("");
    }
  };

  const runSpec = async (
    spec: InsightsReportSpec,
    options?: { historyId?: string; question?: string; useSelectedPeriod?: boolean },
  ) => {
    startJob({
      label: spec.title,
      kind: "rerun",
      run: async () => {
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
        return readReportResponse(response, "Report could not be rerun");
      },
    });
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

  const printReport = async (includeVisual: boolean) => {
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
      visualHtml:
        includeVisual && chartRef.current
          ? chartRef.current.querySelector("svg")?.outerHTML
          : undefined,
      action: "preview",
    });
    setShowPrintOptions(false);
  };

  const chart = useMemo(() => {
    if (!result) return null;
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
    const kind = visualizationKind;
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
  const generationModalJob = jobs.find((job) => job.id === generationModalJobId);
  const { dialogRef: generationDialogRef, titleId: generationDialogTitleId } =
    useDialogAccessibility(generationModalJob !== undefined, {
      onEscape: () => setGenerationModalJobId(null),
    });
  const { dialogRef: printDialogRef, titleId: printDialogTitleId } =
    useDialogAccessibility(showPrintOptions && result !== null, {
      onEscape: () => setShowPrintOptions(false),
    });
  useShellBackdropLayer(generationModalJob !== undefined || showPrintOptions);
  const overlayRoot =
    typeof document === "undefined"
      ? null
      : document.getElementById("drawer-root") ?? document.body;
  const beginNewReport = () => {
    setResult(null);
    setQuestion("");
    setShowFavoriteForm(false);
    setVisualizationKind("table");
    setShowVisual(true);
    setShowData(true);
  };
  const openCompletedJob = (job: InsightsReportJob) => {
    if (!job.result) return;
    applyResult(job.result);
    markInsightsReportJobViewed(job.id);
  };

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-app-bg px-4 py-5 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-[1800px] space-y-5">
        <header className="ui-card overflow-hidden p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex items-start gap-4">
              <div className="rounded-2xl bg-violet-500/10 p-3 text-violet-600 ring-1 ring-violet-500/20">
                <Sparkles className="h-7 w-7" aria-hidden />
              </div>
              <div>
                <h1 className="text-3xl font-black tracking-tight text-app-text">Insights</h1>
                <p className="mt-2 text-sm font-medium text-app-text-muted">
                  Ask, shape, visualize, and deliver governed Riverside reports from one workspace.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-end gap-2">
              {result ? (
                <button
                  type="button"
                  onClick={beginNewReport}
                  className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-wider"
                >
                  <Plus className="h-4 w-4" /> New report
                </button>
              ) : null}
              <div
                className="flex items-center gap-2 rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                title={
                  health?.status === "connected"
                    ? "Cube and the ROSIE report planner are ready."
                    : health?.message ?? "Checking reporting readiness."
                }
              >
                <span
                  className={`h-2.5 w-2.5 rounded-full ${
                    health?.status === "connected"
                      ? "bg-emerald-500"
                      : health?.status === "degraded" || health?.status === "needs_configuration" || health === null
                        ? "bg-amber-500"
                        : "bg-rose-500"
                  }`}
                />
                {health?.status === "connected"
                  ? "Reporting ready"
                  : health === null
                    ? "Checking reporting"
                    : health.status === "needs_configuration"
                      ? "Reporting setup needed"
                      : "Reporting unavailable"}
              </div>
            </div>
          </div>

          <div className="mt-5 grid gap-2 sm:grid-cols-3">
            {[
              ["1", "Ask", "Describe the decision or comparison you need."],
              ["2", "Explore", "Switch visuals, dates, and detail without losing the result."],
              ["3", "Deliver", "Favorite, export, or print with the chart included."],
            ].map(([step, title, copy]) => (
              <div key={step} className="flex gap-3 rounded-xl border border-app-border bg-app-surface-2/70 p-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-[10px] font-black text-violet-600">
                  {step}
                </span>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text">{title}</p>
                  <p className="mt-1 text-[11px] font-medium leading-snug text-app-text-muted">{copy}</p>
                </div>
              </div>
            ))}
          </div>

          <form
            className="mt-5 flex flex-col gap-3 rounded-2xl border border-violet-500/20 bg-violet-500/[0.04] p-4 lg:flex-row"
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
            />
            <button
              type="submit"
              disabled={
                runningJobs.length >= MAX_CONCURRENT_INSIGHTS_JOBS || !question.trim()
              }
              className="ui-btn-primary inline-flex min-h-12 items-center justify-center gap-2 px-6 text-xs font-black uppercase tracking-widest"
            >
              <Send className="h-4 w-4" />
              {result ? "Update report" : "Build report"}
            </button>
          </form>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold text-app-text-muted">
            <span>
              {runningJobs.length > 0
                ? `${runningJobs.length} of ${MAX_CONCURRENT_INSIGHTS_JOBS} report slots active · you may leave this section`
                : "Reports continue generating if you move to another Riverside workspace."}
            </span>
            {result ? (
              <button
                type="button"
                onClick={beginNewReport}
                className="inline-flex items-center gap-1.5 text-violet-600 hover:underline"
              >
                <Plus className="h-3.5 w-3.5" /> Start a separate report
              </button>
            ) : null}
          </div>

          {!result ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {STARTERS.map((starter) => (
                <button
                  key={starter}
                  type="button"
                  onClick={() => void ask(starter)}
                  disabled={runningJobs.length >= MAX_CONCURRENT_INSIGHTS_JOBS}
                  className="rounded-full border border-app-border bg-app-surface-2 px-3 py-2 text-[11px] font-bold text-app-text transition-colors hover:border-violet-500/40 hover:text-violet-600"
                >
                  {starter}
                </button>
              ))}
            </div>
          ) : null}
        </header>

        {jobs.length > 0 ? (
          <section className="ui-card p-4" aria-label="Report generation activity">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Generation activity</p>
                <p className="mt-1 text-sm font-bold text-app-text">
                  {runningJobs.length > 0
                    ? "ROSIE is building your report in the background"
                    : "Recent report jobs"}
                </p>
              </div>
              <span className="rounded-full bg-violet-500/10 px-3 py-1.5 text-[9px] font-black uppercase tracking-widest text-violet-600">
                {runningJobs.length}/{MAX_CONCURRENT_INSIGHTS_JOBS} active
              </span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {jobs.slice(0, 4).map((job) => (
                <div key={job.id} className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
                  {job.status === "running" ? (
                    <Loader2 className="h-5 w-5 shrink-0 animate-spin text-violet-600" />
                  ) : job.status === "complete" ? (
                    <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
                  ) : (
                    <X className="h-5 w-5 shrink-0 text-rose-600" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-black text-app-text">{job.label}</p>
                    <p className="mt-0.5 text-[10px] font-medium text-app-text-muted">
                      {job.status === "running"
                        ? `Generating since ${new Date(job.startedAt).toLocaleTimeString()}`
                        : job.status === "complete"
                          ? `Ready · ${job.result?.row_count.toLocaleString() ?? 0} rows`
                          : job.error ?? "Generation failed"}
                    </p>
                  </div>
                  {job.status === "complete" ? (
                    <button type="button" onClick={() => openCompletedJob(job)} className="ui-btn-secondary px-3 py-2 text-[9px] font-black uppercase tracking-wider">
                      Open
                    </button>
                  ) : job.status === "error" ? (
                    <button type="button" onClick={() => dismissInsightsReportJob(job.id)} className="rounded-lg p-2 text-app-text-muted hover:bg-app-surface hover:text-app-text" aria-label="Dismiss failed report">
                      <X className="h-4 w-4" />
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ) : null}

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
                        disabled={runningJobs.length >= MAX_CONCURRENT_INSIGHTS_JOBS}
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
                        disabled={runningJobs.length >= MAX_CONCURRENT_INSIGHTS_JOBS}
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
                          {result.row_count.toLocaleString()} rows
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
                        onClick={() => {
                          setIncludeVisualInPrint(Boolean(chart && showVisual));
                          setShowPrintOptions(true);
                        }}
                        className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        <Printer className="h-4 w-4" /> Print / PDF
                      </button>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                    {[
                      ["Dataset", result.spec.dataset.replaceAll("_", " ")],
                      ["Rows", result.row_count.toLocaleString()],
                      ["Engine", result.engine],
                      ["Generated", new Date(result.generated_at).toLocaleTimeString()],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">{label}</p>
                        <p className="mt-1 truncate text-sm font-black capitalize text-app-text">{value}</p>
                      </div>
                    ))}
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
                        disabled={
                          runningJobs.length >= MAX_CONCURRENT_INSIGHTS_JOBS ||
                          !fromDate ||
                          !toDate
                        }
                        className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-wider"
                      >
                        <Play className="h-3.5 w-3.5" /> Run this period
                      </button>
                    </div>
                  ) : null}

                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-app-border bg-app-surface-2 p-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Presentation</p>
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {(["table", "bar", "line", "area", "pie"] as InsightsVisualizationKind[]).map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            disabled={kind !== "table" && !chart}
                            onClick={() => {
                              setVisualizationKind(kind);
                              if (kind === "table") {
                                setShowData(true);
                              } else {
                                setShowVisual(true);
                              }
                            }}
                            className={`rounded-lg border px-3 py-2 text-[9px] font-black uppercase tracking-wider transition-colors ${
                              visualizationKind === kind
                                ? "border-violet-500 bg-violet-500/10 text-violet-600"
                                : "border-app-border bg-app-surface text-app-text-muted hover:text-app-text"
                            } disabled:cursor-not-allowed disabled:opacity-40`}
                          >
                            {kind}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={!chart || visualizationKind === "table"}
                        onClick={() => {
                          if (showVisual && !showData) setShowData(true);
                          setShowVisual((visible) => !visible);
                        }}
                        className={`rounded-full border px-3 py-2 text-[9px] font-black uppercase tracking-wider ${showVisual ? "border-violet-500/40 bg-violet-500/10 text-violet-600" : "border-app-border text-app-text-muted"} disabled:opacity-40`}
                      >
                        Visual {showVisual ? "on" : "off"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          if (showData && !showVisual) setShowVisual(Boolean(chart));
                          setShowData((visible) => !visible);
                        }}
                        className={`rounded-full border px-3 py-2 text-[9px] font-black uppercase tracking-wider ${showData ? "border-violet-500/40 bg-violet-500/10 text-violet-600" : "border-app-border text-app-text-muted"}`}
                      >
                        Data {showData ? "on" : "off"}
                      </button>
                    </div>
                  </div>
                </section>

                {showVisual && chart && visualizationKind !== "table" ? (
                  <section className="ui-card p-5 sm:p-6">
                    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <BarChart3 className="h-5 w-5 text-violet-600" />
                        <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                          Visual summary
                        </h3>
                      </div>
                      <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {visualizationKind} view · included in print by default
                      </span>
                    </div>
                    <div ref={chartRef}>{renderChart()}</div>
                  </section>
                ) : null}

                {showData ? <section className="ui-card overflow-hidden">
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
                </section> : null}
              </>
            ) : (
              <section className="ui-card flex min-h-[520px] items-center justify-center p-8 text-center">
                <div className="max-w-lg">
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-violet-500/10 text-violet-600">
                    <Sparkles className="h-8 w-8" />
                  </div>
                  <h2 className="mt-5 text-2xl font-black text-app-text">Your report will appear here</h2>
                  <p className="mt-2 text-sm font-medium text-app-text-muted">
                    Enter a request above or open a saved report from History.
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

      {generationModalJob && overlayRoot
        ? createPortal(
            <div className="ui-overlay-backdrop fixed inset-0 z-[200] flex items-center justify-center p-4">
              <section ref={generationDialogRef} className="ui-card w-full max-w-lg p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby={generationDialogTitleId}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div className="rounded-2xl bg-violet-500/10 p-3 text-violet-600">
                      {generationModalJob.status === "running" ? (
                        <Loader2 className="h-6 w-6 animate-spin" />
                      ) : generationModalJob.status === "complete" ? (
                        <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                      ) : (
                        <X className="h-6 w-6 text-rose-600" />
                      )}
                    </div>
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-violet-600">ROSIE reporting</p>
                      <h2 id={generationDialogTitleId} className="mt-1 text-xl font-black text-app-text">
                        {generationModalJob.status === "running"
                          ? "Your report is generating"
                          : generationModalJob.status === "complete"
                            ? "Your report is ready"
                            : "Report generation stopped"}
                      </h2>
                    </div>
                  </div>
                  <button type="button" onClick={() => setGenerationModalJobId(null)} className="rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text" aria-label="Close report generation status">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <p className="mt-4 rounded-xl border border-app-border bg-app-surface-2 p-3 text-sm font-semibold text-app-text">
                  {generationModalJob.label}
                </p>
                <p className="mt-4 text-sm font-medium leading-relaxed text-app-text-muted">
                  {generationModalJob.status === "running"
                    ? "You can keep working here or leave Insights. Riverside will keep this report running and notify you when it is ready."
                    : generationModalJob.status === "complete"
                      ? "The result is saved in report history and is ready to explore, customize, print, or export."
                      : generationModalJob.error ?? "The report could not be generated."}
                </p>
                <div className="mt-6 flex flex-wrap justify-end gap-2">
                  <button type="button" onClick={() => setGenerationModalJobId(null)} className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-wider">
                    {generationModalJob.status === "running" ? "Keep working" : "Close"}
                  </button>
                  {generationModalJob.status === "complete" ? (
                    <button type="button" onClick={() => { openCompletedJob(generationModalJob); setGenerationModalJobId(null); }} className="ui-btn-primary px-4 py-2 text-[10px] font-black uppercase tracking-wider">
                      Open report
                    </button>
                  ) : null}
                </div>
              </section>
            </div>,
            overlayRoot,
          )
        : null}

      {showPrintOptions && result && overlayRoot
        ? createPortal(
            <div className="ui-overlay-backdrop fixed inset-0 z-[200] flex items-center justify-center p-4">
              <section ref={printDialogRef} className="ui-card w-full max-w-md p-6 shadow-2xl" role="dialog" aria-modal="true" aria-labelledby={printDialogTitleId}>
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[9px] font-black uppercase tracking-widest text-violet-600">Report delivery</p>
                    <h2 id={printDialogTitleId} className="mt-1 text-xl font-black text-app-text">Print / PDF options</h2>
                  </div>
                  <button type="button" onClick={() => setShowPrintOptions(false)} className="rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text" aria-label="Close print options">
                    <X className="h-5 w-5" />
                  </button>
                </div>
                <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 p-4">
                  <input
                    type="checkbox"
                    checked={includeVisualInPrint}
                    disabled={!chart || !showVisual || visualizationKind === "table"}
                    onChange={(event) => setIncludeVisualInPrint(event.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-violet-600"
                  />
                  <span>
                    <span className="block text-sm font-black text-app-text">Include visual chart</span>
                    <span className="mt-1 block text-xs font-medium text-app-text-muted">
                      On by default when a chart is visible. Turn it off for a data-only report.
                    </span>
                  </span>
                </label>
                <p className="mt-3 text-xs font-medium text-app-text-muted">
                  The title, business explanation, period, generation time, and result table are always included.
                </p>
                <div className="mt-6 flex justify-end gap-2">
                  <button type="button" onClick={() => setShowPrintOptions(false)} className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase tracking-wider">Cancel</button>
                  <button type="button" onClick={() => void printReport(includeVisualInPrint)} className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2 text-[10px] font-black uppercase tracking-wider">
                    <Printer className="h-4 w-4" /> Open preview
                  </button>
                </div>
              </section>
            </div>,
            overlayRoot,
          )
        : null}
    </div>
  );
}
