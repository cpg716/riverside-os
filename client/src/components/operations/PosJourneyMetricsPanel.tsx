import { useEffect, useMemo, useState } from "react";
import { Activity, AlertTriangle } from "lucide-react";
import { getBaseUrl } from "../../lib/apiConfig";

type PhaseMetricSummary = {
  operation: string;
  phase: string;
  sample_count: number;
  failure_count: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
};

type OperationalMetricsResponse = {
  window: string;
  phases: PhaseMetricSummary[];
};

const PHASE_LABELS: Record<string, string> = {
  search_to_result: "Search to results",
  scan_to_line: "Scan to Cart line",
  pay_open: "Open Payment",
  tender_confirmed: "Confirm tender",
  receipt_ready: "Receipt ready",
  close_complete: "Close Register",
};

function durationLabel(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)} s`;
  return `${Math.round(value)} ms`;
}

export default function PosJourneyMetricsPanel({
  headers,
  refreshSignal,
}: {
  headers: Record<string, string>;
  refreshSignal: string | null;
}) {
  const [payload, setPayload] = useState<OperationalMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetch(`${getBaseUrl()}/api/ops/metrics`, {
      headers,
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Metrics request failed (${response.status})`);
        return (await response.json()) as OperationalMetricsResponse;
      })
      .then((body) => setPayload(body))
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setPayload(null);
        setError(
          reason instanceof Error
            ? reason.message
            : "Register performance metrics are unavailable.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [headers, refreshSignal]);

  const rows = useMemo(
    () => {
      const byPhase = new Map(
        (payload?.phases ?? [])
          .filter((row) => row.operation === "pos_journey")
          .map((row) => [row.phase, row]),
      );
      return Object.keys(PHASE_LABELS).map(
        (phase): PhaseMetricSummary =>
          byPhase.get(phase) ?? {
            operation: "pos_journey",
            phase,
            sample_count: 0,
            failure_count: 0,
            p50_ms: Number.NaN,
            p95_ms: Number.NaN,
            max_ms: Number.NaN,
          },
      );
    },
    [payload?.phases],
  );
  const hasSamples = rows.some((row) => row.sample_count > 0);

  return (
    <section className="ui-card rounded-xl border-app-border/60 bg-app-surface/50 p-6 backdrop-blur-md">
      <div className="flex items-start gap-3">
        <Activity className="mt-0.5 h-5 w-5 text-app-accent" />
        <div>
          <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
            Register journey performance
          </h3>
          <p className="mt-1 text-xs text-app-text-muted">
            Privacy-safe timings from real Register workflows. No customer, search,
            receipt, Access PIN, or card content is collected.
          </p>
        </div>
      </div>

      {loading ? (
        <p className="mt-6 text-sm font-semibold text-app-text-muted">
          Loading the last 24 hours…
        </p>
      ) : error ? (
        <div className="mt-6 flex items-start gap-2 rounded-xl border border-app-danger/30 bg-app-danger/10 p-4 text-sm text-app-danger">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      ) : !hasSamples ? (
        <div className="mt-6 rounded-xl border border-dashed border-app-border p-6 text-center">
          <p className="text-sm font-black text-app-text">No Register timing samples yet</p>
          <p className="mt-1 text-xs text-app-text-muted">
            Samples appear after staff use the Register on a build containing journey telemetry.
          </p>
        </div>
      ) : (
        <div className="mt-6 overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-app-border text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <th className="px-3 py-3">Stage</th>
                <th className="px-3 py-3 text-right">Samples</th>
                <th className="px-3 py-3 text-right">Median</th>
                <th className="px-3 py-3 text-right">p95</th>
                <th className="px-3 py-3 text-right">Maximum</th>
                <th className="px-3 py-3 text-right">Failures</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.phase} className="border-b border-app-border/50 last:border-0">
                  <td className="px-3 py-3 font-black text-app-text">
                    {PHASE_LABELS[row.phase] ?? row.phase}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums text-app-text-muted">
                    {row.sample_count.toLocaleString()}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-app-text">
                    {durationLabel(row.p50_ms)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono font-black text-app-text">
                    {durationLabel(row.p95_ms)}
                  </td>
                  <td className="px-3 py-3 text-right font-mono text-app-text-muted">
                    {durationLabel(row.max_ms)}
                  </td>
                  <td
                    className={`px-3 py-3 text-right font-black tabular-nums ${
                      row.failure_count > 0 ? "text-app-danger" : "text-app-success"
                    }`}
                  >
                    {row.failure_count.toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="mt-4 text-[10px] font-semibold text-app-text-muted">
        Window: {payload?.window ?? "24h"}. Set performance targets only after representative
        Main Hub and store-workstation samples have accumulated.
      </p>
    </section>
  );
}
