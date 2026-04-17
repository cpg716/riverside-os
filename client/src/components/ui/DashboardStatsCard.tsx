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
    icon: "bg-blue-500/10 text-blue-500",
    chart: "#3b82f6",
    trendUp: "text-emerald-500",
    trendDown: "text-rose-500",
  },
  green: {
    icon: "bg-emerald-500/10 text-emerald-500",
    chart: "#10b981",
    trendUp: "text-emerald-500",
    trendDown: "text-rose-500",
  },
  orange: {
    icon: "bg-orange-500/10 text-orange-500",
    chart: "#f97316",
    trendUp: "text-emerald-500",
    trendDown: "text-rose-500",
  },
  rose: {
    icon: "bg-rose-500/10 text-rose-500",
    chart: "#f43f5e",
    trendUp: "text-emerald-500",
    trendDown: "text-rose-500",
  },
  purple: {
    icon: "bg-purple-500/10 text-purple-500",
    chart: "#a855f7",
    trendUp: "text-emerald-500",
    trendDown: "text-rose-500",
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
        "relative overflow-hidden rounded-2xl border border-app-border bg-app-surface p-6 shadow-sm transition-all hover:shadow-md",
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
                  <span className="text-[10px] font-medium text-app-text-muted opacity-60">
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
