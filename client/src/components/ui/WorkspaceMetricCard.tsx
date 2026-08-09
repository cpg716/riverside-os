import type { LucideIcon } from "lucide-react";

export type WorkspaceMetricTone =
  | "neutral"
  | "info"
  | "success"
  | "warning"
  | "danger"
  | "accent";

interface WorkspaceMetricCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  tone?: WorkspaceMetricTone;
  badge?: string;
  detail?: string;
}

const toneStyles: Record<
  WorkspaceMetricTone,
  { tint: string; icon: string }
> = {
  neutral: {
    tint: "ui-tint-neutral",
    icon: "text-app-text-muted",
  },
  info: {
    tint: "ui-tint-info",
    icon: "text-app-info",
  },
  success: {
    tint: "ui-tint-success",
    icon: "text-app-success",
  },
  warning: {
    tint: "ui-tint-warning",
    icon: "text-app-warning",
  },
  danger: {
    tint: "ui-tint-danger",
    icon: "text-app-danger",
  },
  accent: {
    tint: "ui-tint-accent",
    icon: "text-app-accent",
  },
};

function valueSize(value: string | number): string {
  const length = String(value).length;
  if (length >= 10) return "text-[1.35rem] xl:text-[1.55rem]";
  if (length >= 7) return "text-[1.55rem] xl:text-[1.8rem]";
  return "text-[2rem]";
}

export default function WorkspaceMetricCard({
  title,
  value,
  icon: Icon,
  tone = "neutral",
  badge,
  detail,
}: WorkspaceMetricCardProps) {
  const styles = toneStyles[tone];

  return (
    <div
      className={`ui-card ui-workspace-summary-card ${styles.tint}`}
      data-workspace-metric={tone}
    >
      <Icon
        aria-hidden="true"
        className={`ui-workspace-summary-watermark ${styles.icon}`}
        size={80}
      />
      <div className="ui-workspace-summary-icon">
        <Icon aria-hidden="true" className={styles.icon} size={25} />
      </div>
      <div className="relative z-10 min-w-0 flex-1">
        <div className="flex min-w-0 items-start gap-2">
          <p className="min-w-0 flex-1 text-[11px] font-black uppercase leading-tight tracking-[0.14em] text-app-text-muted">
            {title}
          </p>
          {badge ? (
            <span className="max-w-24 shrink-0 rounded-full bg-app-surface-2 px-2 py-1 text-center text-[9px] font-black leading-tight text-app-text-muted shadow-sm">
              {badge}
            </span>
          ) : null}
        </div>
        <p
          className={`mt-1 max-w-full truncate whitespace-nowrap font-black leading-none tabular-nums tracking-tight text-app-text ${valueSize(value)}`}
          title={String(value)}
        >
          {value}
        </p>
        {detail ? (
          <p className="mt-1 truncate text-[10px] font-bold text-app-text-muted">
            {detail}
          </p>
        ) : null}
      </div>
    </div>
  );
}
