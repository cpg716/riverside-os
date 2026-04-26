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
  onClick?: () => void;
  ariaLabel?: string;
}

const colorMap = {
  blue: {
    card: "ui-tint-info",
    icon: "bg-app-info/10 text-app-info ring-1 ring-app-info/16",
    chart: "#2f7dd1",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  green: {
    card: "ui-tint-success",
    icon: "bg-app-success/10 text-app-success ring-1 ring-app-success/16",
    chart: "#16956a",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  orange: {
    card: "ui-tint-warning",
    icon: "bg-app-warning/10 text-app-warning ring-1 ring-app-warning/16",
    chart: "#b7791f",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  rose: {
    card: "ui-tint-danger",
    icon: "bg-app-danger/10 text-app-danger ring-1 ring-app-danger/16",
    chart: "#cf5b5b",
    trendUp: "text-app-success",
    trendDown: "text-app-danger",
  },
  purple: {
    card: "ui-tint-accent",
    icon: "bg-app-accent/10 text-app-accent ring-1 ring-app-accent/16",
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
  onClick,
  ariaLabel,
}: DashboardStatsCardProps) {
  const styles = colorMap[color];
  const Root = onClick ? "button" : "div";

  return (
    <Root
      type={onClick ? "button" : undefined}
      onClick={onClick}
      aria-label={ariaLabel ?? (onClick ? `Open ${title}` : undefined)}
      className={cn(
        "ui-card relative min-w-0 overflow-hidden p-6 text-left transition-all hover:-translate-y-0.5",
        onClick && "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-app-accent/30",
        styles.card,
        className,
      )}
    >
      <div className="relative z-10 min-w-0 space-y-4">
        <div className="flex min-w-0 items-center gap-3">
            <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", styles.icon)}>
              <Icon size={20} />
            </div>
            <span className="min-w-0 text-sm font-semibold leading-tight text-app-text-muted">{title}</span>
        </div>

        <div className="min-w-0 space-y-1">
            <h3 className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-[clamp(1.75rem,2vw,2.25rem)] font-bold leading-tight tracking-tight text-app-text">
              {value}
            </h3>
            {trend && (
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    "shrink-0 text-xs font-bold",
                    trend.isUp ? styles.trendUp : styles.trendDown,
                  )}
                >
                  {trend.isUp ? "▲" : "▼"} {trend.value}
                </span>
                {trend.label && (
                  <span className="min-w-0 truncate text-[10px] font-medium text-app-text-muted">
                    {trend.label}
                  </span>
                )}
              </div>
            )}
        </div>
      </div>

        {sparklineData && sparklineData.length > 0 && (
          <div className="pointer-events-none absolute bottom-3 right-3 h-12 w-20 opacity-75" aria-hidden>
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

      {/* Subtle glassmorphic background reflection effect */}
      <div className="absolute -right-4 -top-4 size-24 rounded-full bg-app-accent/2 blur-3xl" />
    </Root>
  );
}
