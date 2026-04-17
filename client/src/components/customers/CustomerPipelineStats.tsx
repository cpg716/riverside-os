import { Users, Gem, Wallet, Heart } from "lucide-react";
import { CustomerPipelineStats as StatsType } from "./CustomerWorkspaceTypes";

export default function CustomerPipelineStats({ stats }: { stats: StatsType | null }) {
  const statConfig = [
    {
      label: "Total CRM",
      count: stats?.total_customers,
      icon: Users,
      color: "text-blue-500",
      bg: "bg-blue-500/10",
      border: "border-blue-500/20",
    },
    {
      label: "VIP Premium",
      count: stats?.vip_customers,
      icon: Gem,
      color: "text-amber-500",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
    },
    {
      label: "Balance Recovery",
      count: stats?.with_balance,
      icon: Wallet,
      color: "text-rose-500",
      bg: "bg-rose-500/10",
      border: "border-rose-500/20",
    },
    {
      label: "Occasions (30d)",
      count: stats?.upcoming_weddings,
      icon: Heart,
      color: "text-pink-500",
      bg: "bg-pink-500/10",
      border: "border-pink-500/20",
    },
  ];

  return (
    <div className="flex shrink-0 items-stretch gap-4 overflow-x-auto p-4 sm:p-6 sm:pb-2 no-scrollbar">
      {statConfig.map((stat, i) => (
        <div
          key={i}
          className={`flex min-w-[200px] flex-1 items-center gap-4 rounded-[20px] border ${stat.border} ${stat.bg} p-4 shadow-sm backdrop-blur-md`}
        >
          <div
            className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/50 shadow-sm dark:bg-black/20`}
          >
            <stat.icon size={24} className={stat.color} />
          </div>
          <div className="min-w-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-70">
              {stat.label}
            </p>
            <p className="text-2xl font-black tabular-nums text-app-text">
              {stat.count ?? "—"}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
