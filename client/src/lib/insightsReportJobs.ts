import { dispatchAppToast } from "../components/ui/ToastProviderLogic";

export type InsightsVisualizationKind = "table" | "bar" | "line" | "area" | "pie";

export type InsightsReportSpec = {
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
    kind: InsightsVisualizationKind;
    x_member?: string | null;
    y_members: string[];
  };
};

export type InsightsReportRunResponse = {
  history_id: string;
  question: string;
  spec: InsightsReportSpec;
  rows: Record<string, unknown>[];
  row_count: number;
  member_labels: Record<string, string>;
  member_formats: Record<string, string>;
  generated_at: string;
  engine: string;
};

export type InsightsReportJob = {
  id: string;
  label: string;
  kind: "build" | "update" | "rerun";
  status: "running" | "complete" | "error";
  startedAt: string;
  completedAt?: string;
  viewed: boolean;
  result?: InsightsReportRunResponse;
  error?: string;
};

type JobListener = (jobs: InsightsReportJob[]) => void;

export const MAX_CONCURRENT_INSIGHTS_JOBS = 2;
const MAX_RETAINED_JOBS = 10;
let jobs: InsightsReportJob[] = [];
const listeners = new Set<JobListener>();

function snapshot(): InsightsReportJob[] {
  return jobs.map((job) => ({ ...job }));
}

function emit() {
  const next = snapshot();
  listeners.forEach((listener) => listener(next));
}

function jobId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `insights-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function getInsightsReportJobs(): InsightsReportJob[] {
  return snapshot();
}

export function subscribeInsightsReportJobs(listener: JobListener): () => void {
  listeners.add(listener);
  listener(snapshot());
  return () => listeners.delete(listener);
}

export function startInsightsReportJob(options: {
  label: string;
  kind: InsightsReportJob["kind"];
  run: () => Promise<InsightsReportRunResponse>;
}): InsightsReportJob {
  const running = jobs.filter((job) => job.status === "running").length;
  if (running >= MAX_CONCURRENT_INSIGHTS_JOBS) {
    throw new Error("Two reports are already generating. Wait for one to finish before starting another.");
  }

  const job: InsightsReportJob = {
    id: jobId(),
    label: options.label,
    kind: options.kind,
    status: "running",
    startedAt: new Date().toISOString(),
    viewed: false,
  };
  jobs = [job, ...jobs].slice(0, MAX_RETAINED_JOBS);
  emit();

  void options.run().then(
    (result) => {
      jobs = jobs.map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              status: "complete",
              completedAt: new Date().toISOString(),
              result,
            }
          : candidate,
      );
      emit();
      dispatchAppToast(`Report ready: ${result.spec.title}`, "success");
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "Report generation failed";
      jobs = jobs.map((candidate) =>
        candidate.id === job.id
          ? {
              ...candidate,
              status: "error",
              completedAt: new Date().toISOString(),
              error: message,
            }
          : candidate,
      );
      emit();
      dispatchAppToast(message, "error");
    },
  );

  return job;
}

export function markInsightsReportJobViewed(id: string) {
  markInsightsReportJobsViewed([id]);
}

export function markInsightsReportJobsViewed(ids: string[]) {
  const viewedIds = new Set(ids);
  jobs = jobs.map((job) =>
    viewedIds.has(job.id) ? { ...job, viewed: true } : job,
  );
  emit();
}

export function dismissInsightsReportJob(id: string) {
  jobs = jobs.filter((job) => job.id !== id || job.status === "running");
  emit();
}
