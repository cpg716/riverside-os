import { type LucideIcon } from "lucide-react";
import { LineChart, Line } from "recharts";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface DashboardStatsCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: string | number;
    isUp?: boolean;
    label?: string;
  };
  sparklineData?: { value: number }[];
  color?: "blue" | "green" | "orange" | "rose" | "purple";
  className?: string;
}

const colorMap = {
  blue: {
    icon: "bg-app-info/12 text-app-info ring-1 ring-app-info/20",
    chart: "#2f7dd1",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  green: {
    icon: "bg-app-success/12 text-app-success ring-1 ring-app-success/20",
    chart: "#16956a",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  orange: {
    icon: "bg-app-warning/12 text-app-warning ring-1 ring-app-warning/20",
    chart: "#b7791f",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  rose: {
    icon: "bg-app-danger/12 text-app-danger ring-1 ring-app-danger/20",
    chart: "#cf5b5b",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  purple: {
    icon: "bg-app-accent/10 text-app-accent ring-1 ring-app-accent/20",
    chart: "#a855f7",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
};

export default function DashboardStatsCard({
  title,
  value,
  icon: Icon,
  trend,
  sparklineData,
  color = "blue",
  className,
}: DashboardStatsCardProps) {
  const styles = colorMap[color];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-app-border bg-[color-mix(in_srgb,var(--app-surface)_90%,var(--app-surface-2))] p-6 shadow-[0_12px_26px_-20px_rgba(15,23,42,0.24)] transition-all hover:border-app-accent/15 hover:shadow-[0_16px_32px_-22px_rgba(15,23,42,0.3)]",
        className,
      )}
    >
      <div className="flex items-start justify-between">
        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", styles.icon)}>
              <Icon size={20} />
            </div>
            <span className="text-sm font-semibold text-app-text-muted">{title}</span>
          </div>

          <div className="space-y-1">
            <h3 className="text-3xl font-bold tracking-tight text-app-text">{value}</h3>
            {trend && (
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-xs font-bold",
                    trend.isUp ? styles.trendUp : styles.trendDown,
                  )}
                >
                  {trend.isUp ? "▲" : "▼"} {trend.value}
                </span>
                {trend.label && (
                  <span className="text-[10px] font-medium text-app-text-muted">
                    {trend.label}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>

        {sparklineData && sparklineData.length > 0 && (
          <div className="h-16 w-24 translate-y-2 relative" style={{ minWidth: "96px", minHeight: "64px" }}>
            <LineChart width={96} height={64} data={sparklineData}>
              <Line
                type="monotone"
                dataKey="value"
                stroke={styles.chart}
                strokeWidth={2}
                dot={false}
                isAnimationActive={false}
              />
            </LineChart>
          </div>
        )}
      </div>

      {/* Subtle glassmorphic background reflection effect */}
      <div className="absolute -right-4 -top-4 size-24 rounded-full bg-app-accent/5 blur-3xl" />
    </div>
  );
}
