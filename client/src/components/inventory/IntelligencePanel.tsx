import { getBaseUrl } from "../../lib/apiConfig";
import { useState, useEffect, useCallback } from "react";
import {
  BrainCircuit,
  CheckCircle2,
  ArrowRight,
  ShoppingCart,
  Percent,
} from "lucide-react";
import { apiUrl } from "../../lib/apiUrl";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";
import DashboardStatsCard from "../ui/DashboardStatsCard";

interface Recommendation {
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string;
  current_stock: number;
  available_stock: number;
  daily_velocity: number;
  sale_frequency: number;
  confidence_score: number;
  type: "reorder" | "clearance";
  reason: string;
  suggested_action: string;
}

const IntelligencePanel = () => {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();

  const baseUrl = getBaseUrl();

  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const fetchRecommendations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        apiUrl(baseUrl, "/api/inventory/recommendations"),
        {
          headers: apiAuth(),
        },
      );
      if (res.ok) {
        const data = await res.json();
        setRecommendations(data);
      } else {
        toast("Failed to fetch intelligence data", "error");
      }
    } catch (err) {
      console.error("Stock guidance fetch failed:", err);
      toast("Could not load stock guidance right now.", "error");
    } finally {
      setLoading(false);
    }
  }, [baseUrl, apiAuth, toast]);

  useEffect(() => {
    fetchRecommendations();
  }, [fetchRecommendations]);

  if (loading) {
    return (
      <div className="flex flex-col h-[400px] items-center justify-center p-20 gap-6 opacity-80 animate-pulse">
        <div className="relative">
          <BrainCircuit className="w-16 h-16 text-app-accent" />
          <div className="absolute inset-0 bg-app-accent/20 blur-2xl rounded-full" />
        </div>
        <p className="font-black text-app-text tracking-[0.3em] text-[10px] uppercase">
          Loading stock guidance...
        </p>
      </div>
    );
  }

  const reorders = recommendations.filter((r) => r.type === "reorder");
  const clearances = recommendations.filter((r) => r.type === "clearance");

  return (
    <div className="space-y-10 animate-in fade-in slide-in-from-bottom-6 duration-1000">
      {/* Engine Overview Header */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <DashboardStatsCard
          title="Active Alerts"
          value={recommendations.length}
          icon={BrainCircuit}
          trend={{ value: recommendations.length, label: "Total prompts" }}
        />
        <DashboardStatsCard
          title="Reorder Priority"
          value={reorders.length}
          icon={ShoppingCart}
          trend={{ value: reorders.length, label: "Critical items", isUp: true }}
          color="green"
        />
        <DashboardStatsCard
          title="Clearance Ops"
          value={clearances.length}
          icon={Percent}
          trend={{ value: clearances.length, label: "Capital ops", isUp: false }}
          color="orange"
        />
      </div>

      <div className="flex flex-col lg:flex-row gap-10">
        {/* Reorder Queue */}
        <div className="flex-1 space-y-8">
          <div className="flex items-center justify-between px-4">
            <div className="flex items-center gap-3">
              <div className="w-1.5 h-6 rounded-full bg-emerald-500 shadow-[0_0_12px_rgba(16,185,129,0.4)]" />
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-app-text">
                Replenishment Queue
              </h2>
            </div>
            <span className="px-3 py-1 bg-emerald-500/10 border border-emerald-500/20 rounded-full text-[9px] font-black text-emerald-600 tracking-widest">
              {reorders.length} ENTRIES
            </span>
          </div>
          <div className="space-y-6">
            {reorders.length === 0 ? (
              <EmptyState message="All high-velocity SKUs are sufficiently stocked." />
            ) : (
              reorders.map((rec) => (
                <RecommendationCard key={rec.variant_id} recommendation={rec} />
              ))
            )}
          </div>
        </div>

        {/* Clearance Queue */}
        <div className="flex-1 space-y-8">
          <div className="flex items-center justify-between px-4">
            <div className="flex items-center gap-3">
              <div className="w-1.5 h-6 rounded-full bg-amber-500 shadow-[0_0_12px_rgba(245,158,11,0.4)]" />
              <h2 className="text-sm font-black uppercase tracking-[0.2em] text-app-text">
                Inventory Velocity
              </h2>
            </div>
            <span className="px-3 py-1 bg-amber-500/10 border border-amber-500/20 rounded-full text-[9px] font-black text-amber-600 tracking-widest">
              {clearances.length} ENTRIES
            </span>
          </div>
          <div className="space-y-6">
            {clearances.length === 0 ? (
              <EmptyState message="No clearance candidates detected in this cycle." />
            ) : (
              clearances.map((rec) => (
                <RecommendationCard key={rec.variant_id} recommendation={rec} />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const RecommendationCard = ({
  recommendation: rec,
}: {
  recommendation: Recommendation;
}) => {
  const isReorder = rec.type === "reorder";

  return (
    <div
      className={`group relative overflow-hidden rounded-[2.5rem] border border-app-border/40 bg-app-surface/20 p-8 shadow-xl transition-all hover:bg-app-surface/40 backdrop-blur-md duration-500`}
    >
      <div className="relative z-10">
        <div className="flex justify-between items-start mb-6">
          <div className="space-y-1">
            <h3 className="font-black text-lg text-app-text leading-tight uppercase tracking-tighter group-hover:text-app-accent transition-colors">
              {rec.product_name}
            </h3>
            <div className="flex items-center gap-3">
              <span className="px-3 py-1 bg-app-surface-2/40 rounded-lg text-[9px] font-black text-app-text-muted tracking-[0.2em] border border-app-border/40">
                {rec.sku}
              </span>
              <span className="text-[10px] font-bold text-app-text-muted opacity-60">
                {rec.variation_label}
              </span>
            </div>
          </div>
          <div className="flex flex-col items-end">
            <div className="text-[9px] font-black text-app-text-muted uppercase tracking-widest opacity-40 mb-2">
              Engine Confidence
            </div>
            <div className="flex items-center gap-3">
              <div className="w-24 h-2 bg-app-bg shadow-inner rounded-full overflow-hidden border border-app-border/40">
                <div
                  className={`h-full transition-all duration-1000 ${isReorder ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]"}`}
                  style={{ width: `${rec.confidence_score * 100}%` }}
                />
              </div>
              <span className="text-xs font-black tabular-nums text-app-text">
                {Math.round(rec.confidence_score * 100)}%
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6 mb-8 p-6 bg-app-bg/20 rounded-[2rem] border border-app-border/20 backdrop-blur-sm">
          <Metric label="Stock" value={rec.current_stock} />
          <Metric
            label="Velocity"
            value={`${rec.daily_velocity.toFixed(2)}/d`}
          />
          <Metric label="Events" value={`${rec.sale_frequency}`} />
          <Metric
            label="Available"
            value={rec.available_stock}
            highlight={rec.available_stock < 0}
          />
        </div>

        <div className="space-y-6">
          <div className="flex gap-4 p-4 rounded-2xl bg-app-surface/20 border border-app-border/20">
            <div className="mt-1 flex-shrink-0">
              <div
                className={`w-2.5 h-2.5 rounded-full ${isReorder ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" : "bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.6)]"}`}
              />
            </div>
            <p className="text-[11px] font-bold text-app-text leading-relaxed italic opacity-80">
              "{rec.reason}"
            </p>
          </div>

          <button
            className={`group/btn w-full h-14 rounded-2xl text-[10px] font-black uppercase tracking-[0.3em] flex items-center justify-center gap-3 transition-all shadow-xl active:scale-95 ${isReorder ? "bg-app-accent text-white shadow-app-accent/20 hover:brightness-110" : "bg-amber-600 text-white shadow-amber-600/20 hover:bg-amber-700"}`}
          >
            {rec.suggested_action} 
            <ArrowRight size={16} className="transition-transform group-hover/btn:translate-x-1" />
          </button>
        </div>
      </div>
      
      {/* Background accents */}
      <div className={`absolute -top-12 -right-12 h-32 w-32 rounded-full blur-3xl opacity-10 transition-all group-hover:opacity-20 ${isReorder ? "bg-emerald-500" : "bg-amber-500"}`} />
    </div>
  );
};

const Metric = ({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) => (
  <div className="flex flex-col">
    <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted opacity-50 mb-1">
      {label}
    </span>
    <span
      className={`text-sm font-black tracking-tight ${highlight ? "text-rose-500" : "text-app-text"}`}
    >
      {value}
    </span>
  </div>
);

const EmptyState = ({ message }: { message: string }) => (
  <div className="py-24 border-2 border-dashed border-app-border/40 rounded-[3rem] flex flex-col items-center justify-center text-center px-12 bg-app-surface/5 backdrop-blur-sm">
    <div className="mb-6 p-6 rounded-full bg-app-surface/10 border border-app-border/40">
      <CheckCircle2 className="text-app-accent opacity-40" size={48} />
    </div>
    <p className="text-[10px] font-black text-app-text-muted uppercase tracking-[0.3em] opacity-40 leading-relaxed max-w-[240px]">
      {message}
    </p>
  </div>
);

export default IntelligencePanel;
