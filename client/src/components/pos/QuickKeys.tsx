import { PlusCircle } from "lucide-react";
import { getAppIcon } from "../../lib/icons";

interface QuickKeysProps {
  disabled?: boolean;
  onAction: (actionId: string) => void;
}

const ACTIONS = [
  {
    id: "gift-card",
    label: "Gift Card",
    icon: getAppIcon("giftCards"),
    color: "text-purple-600 bg-[color-mix(in_srgb,var(--app-accent-secondary)_8%,var(--app-surface))] border-purple-200/20",
  },
  {
    id: "misc",
    label: "Misc Fee",
    icon: PlusCircle,
    color: "text-amber-600 bg-[color-mix(in_srgb,orange_8%,var(--app-surface))] border-amber-200/20",
  },
] as const;

export default function QuickKeys({ disabled, onAction }: QuickKeysProps) {
  return (
    <div className="flex flex-wrap gap-3 border-b border-app-border bg-app-surface-2 p-4">
      {ACTIONS.map((action) => {
        const Icon = action.icon;
        return (
          <button
            key={action.id}
            type="button"
            disabled={disabled}
            onClick={() => onAction(action.id)}
            className={`flex min-h-[80px] min-w-[120px] flex-1 flex-col items-center justify-center gap-2 rounded-2xl border p-3 font-bold transition-all active:scale-95 hover:translate-y-[-2px] hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 ${action.color}`}
          >
            <Icon size={28} />
            <span className="text-[10px] uppercase font-black tracking-widest">{action.label}</span>
          </button>
        );
      })}
    </div>
  );
}
