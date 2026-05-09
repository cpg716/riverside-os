import { useCallback, useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import {
  requestRosieInsightSummary,
  type RosieInsightFacts,
  type RosieInsightSummaryRequest,
  type RosieInsightMode,
  type RosieInsightSurface,
  type RosieInsightSummaryResponse,
} from "../../lib/rosie";

type RosieInsightSummaryProps = {
  surface: RosieInsightSurface;
  title: string;
  facts: RosieInsightFacts;
  mode?: RosieInsightMode;
  allowedActions?: RosieInsightSummaryRequest["allowed_actions"];
  getHeaders?: () => Record<string, string>;
  className?: string;
};

export default function RosieInsightSummary({
  surface,
  title,
  facts,
  mode = "summary",
  allowedActions = [],
  getHeaders,
  className = "",
}: RosieInsightSummaryProps) {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<RosieInsightSummaryResponse | null>(null);
  const factsHash = useMemo(
    () => JSON.stringify({ surface, mode, facts, allowedActions }),
    [allowedActions, facts, mode, surface],
  );
  const hasFacts = useMemo(
    () =>
      Boolean(facts.title.trim()) &&
      Boolean(
        facts.bullets?.some((fact) => fact.label.trim()) ||
          facts.metrics?.some((fact) => fact.label.trim() && fact.value.trim()) ||
          facts.warnings?.some((fact) => fact.trim()),
      ),
    [facts],
  );

  useEffect(() => {
    setResponse(null);
  }, [factsHash]);

  const loadInsight = useCallback(async () => {
    if (!hasFacts || loading) return;
    setLoading(true);
    const result = await requestRosieInsightSummary(
      {
        surface,
        mode,
        facts,
        allowed_actions: allowedActions,
      },
      { headers: getHeaders?.() },
    );
    setResponse(result.status === "available" ? result : null);
    setLoading(false);
  }, [allowedActions, facts, getHeaders, hasFacts, loading, mode, surface]);

  if (!hasFacts) return null;

  const visibleBullets = response?.status === "available" ? response.bullets.slice(0, 3) : [];

  return (
    <div
      className={`mt-3 rounded-xl border border-app-border bg-app-surface px-3 py-2 ${className}`}
      data-testid={`rosie-insight-summary-${surface}`}
    >
      <button
        type="button"
        onClick={() => void loadInsight()}
        disabled={loading}
        className="inline-flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition hover:text-app-accent disabled:opacity-60"
        aria-label={`${title} ROSIE insight`}
      >
        <Sparkles size={13} aria-hidden />
        {loading ? "ROSIE thinking..." : "ROSIE insight"}
      </button>
      {visibleBullets.length > 0 ? (
        <ul className="mt-2 space-y-1.5 text-[12px] font-semibold text-app-text">
          {visibleBullets.map((bullet) => (
            <li key={bullet.text} className="flex gap-2">
              <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-app-accent" />
              <span>{bullet.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
