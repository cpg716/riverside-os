import type { ReactNode } from "react";

interface SmartButtonProps {
  icon: ReactNode;
  label: string;
  value: string | number;
  onClick: () => void;
  color?: "blue" | "accent" | "emerald";
}

export default function SmartButton({
  icon,
  label,
  value,
  onClick,
  color = "blue",
}: SmartButtonProps) {
  const themes = {
    blue: "text-app-accent-2 bg-app-accent-2/15 border-app-accent-2/25 hover:bg-app-accent-2 hover:text-white",
    accent:
      "text-app-accent bg-app-accent/10 border-app-accent/25 hover:bg-app-accent hover:text-white",
    emerald:
      "text-emerald-600 bg-emerald-50 border-emerald-100 hover:bg-emerald-600 hover:text-white",
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group flex h-16 min-w-[100px] shrink-0 flex-col items-center justify-center rounded-2xl border p-2 transition-all ${themes[color]}`}
    >
      <div className="mb-1 flex min-w-0 max-w-full items-center gap-1.5">
        <span className="shrink-0 opacity-60 group-hover:opacity-100">
          {icon}
        </span>
        <span className="min-w-0 max-w-[5.5rem] truncate text-lg font-black tracking-tighter">
          {value}
        </span>
      </div>
      <span className="text-[9px] font-black uppercase tracking-[0.1em] opacity-60 group-hover:opacity-100">
        {label}
      </span>
    </button>
  );
}
