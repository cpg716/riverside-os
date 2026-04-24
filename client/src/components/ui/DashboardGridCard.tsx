import React from "react";
import { type LucideIcon } from "lucide-react";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

interface DashboardGridCardProps {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  actionLabel?: string;
  onAction?: () => void;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
}

export default function DashboardGridCard({
  title,
  subtitle,
  icon: Icon,
  actionLabel,
  onAction,
  children,
  className,
  contentClassName,
}: DashboardGridCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-2xl border border-app-border bg-[color-mix(in_srgb,var(--app-surface)_92%,var(--app-surface-2))] shadow-[0_12px_26px_-20px_rgba(15,23,42,0.24)] transition-all",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-app-border bg-[color-mix(in_srgb,var(--app-surface-2)_88%,var(--app-surface))] px-6 py-4">
        <div className="flex items-center gap-3">
          {Icon && (
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-app-accent/10 text-app-accent">
              <Icon size={18} />
            </div>
          )}
          <div>
            <h3 className="text-sm font-bold tracking-tight text-app-text">{title}</h3>
            {subtitle && <p className="text-[10px] font-medium text-app-text-muted">{subtitle}</p>}
          </div>
        </div>

        {actionLabel && (
          <button
            onClick={onAction}
            className="text-[10px] font-bold uppercase tracking-widest text-app-accent transition-opacity hover:opacity-85"
          >
            {actionLabel}
          </button>
        )}
      </div>

      <div className={cn("flex-1 p-6", contentClassName)}>{children}</div>
    </div>
  );
}
