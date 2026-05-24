import { useMemo, useState } from "react";
import {
  STAFF_AVATAR_CATALOG,
  staffAvatarGroupLabel,
  staffAvatarUrl,
  type StaffAvatarCatalogEntry,
} from "../../lib/staffAvatars";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";

const baseUrl = getBaseUrl();

export default function StaffAvatarPicker({
  value,
  onChange,
  disabled,
  staffId,
  avatarPhotoUrl,
  onAvatarPhotoGenerated,
}: {
  value: string;
  onChange: (key: string) => void;
  disabled?: boolean;
  staffId?: string;
  avatarPhotoUrl?: string | null;
  onAvatarPhotoGenerated?: (photoUrl: string) => void;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [prompt, setPrompt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { backofficeHeaders } = useBackofficeAuth();

  const groups = useMemo(() => {
    const g = new Set(STAFF_AVATAR_CATALOG.map((e) => e.group));
    return ["all", ...Array.from(g)] as const;
  }, []);

  const filtered: StaffAvatarCatalogEntry[] = useMemo(() => {
    if (filter === "all") return STAFF_AVATAR_CATALOG;
    return STAFF_AVATAR_CATALOG.filter((e) => e.group === filter);
  }, [filter]);

  const handleGenerate = async () => {
    if (!prompt.trim() || !staffId || staffId === "NEW") return;
    setGenerating(true);
    setGenError(null);
    try {
      const headers = {
        "Content-Type": "application/json",
        ...backofficeHeaders(),
      };
      
      const dispatchRes = await fetch(`${baseUrl}/api/ai/visual/dispatch`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model_endpoint: "fal-ai/flux/schnell",
          payload: {
            prompt: prompt.trim(),
            num_inference_steps: 4,
            enable_safety_checker: true,
          },
          job_type: "staff_avatar",
          target_id: staffId,
        }),
      });

      if (!dispatchRes.ok) {
        const errData = await dispatchRes.json();
        throw new Error(errData.error || "Failed to dispatch generation task");
      }

      const { job_id } = await dispatchRes.json();

      let attempts = 0;
      const maxAttempts = 60;
      const interval = setInterval(async () => {
        try {
          attempts += 1;
          if (attempts > maxAttempts) {
            clearInterval(interval);
            setGenerating(false);
            setGenError("Generation timed out after 2 minutes.");
            return;
          }

          const statusRes = await fetch(`${baseUrl}/api/ai/visual/status/${job_id}`, {
            headers,
          });

          if (!statusRes.ok) {
            clearInterval(interval);
            throw new Error("Failed to check generation status");
          }

          const job = await statusRes.json();
          if (job.status === "completed") {
            clearInterval(interval);
            setGenerating(false);
            if (job.local_asset_path && onAvatarPhotoGenerated) {
              onAvatarPhotoGenerated(job.local_asset_path);
            }
          } else if (job.status === "failed") {
            clearInterval(interval);
            setGenerating(false);
            setGenError(job.error_message || "Generation job failed");
          }
        } catch (pollErr) {
          clearInterval(interval);
          setGenerating(false);
          const errorMsg = pollErr instanceof Error ? pollErr.message : "Error polling status";
          setGenError(errorMsg);
        }
      }, 2000);
    } catch (err) {
      setGenerating(false);
      const errorMsg = err instanceof Error ? err.message : "An error occurred";
      setGenError(errorMsg);
    }
  };

  return (
    <div className="space-y-4">
      {staffId && staffId !== "NEW" && (
        <div className="rounded-2xl border border-app-border bg-app-surface-2/20 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-black uppercase tracking-widest text-app-text">AI Avatar Generator</span>
            <span className="text-[10px] font-medium text-app-text-muted">via Fal.ai (Flux)</span>
          </div>
          
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="A professional profile photo, corporate executive portrait..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              disabled={disabled || generating}
              className="flex-1 rounded-xl border border-app-border bg-app-surface-3/30 px-3 py-2 text-xs text-app-text placeholder:text-app-text-muted focus:border-app-accent focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={handleGenerate}
              disabled={disabled || generating || !prompt.trim()}
              className="rounded-xl bg-app-accent px-4 py-2 text-xs font-black text-white hover:bg-app-accent/80 disabled:opacity-50 flex items-center gap-2 transition-all"
            >
              {generating ? (
                <>
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                  Generating...
                </>
              ) : (
                "Generate"
              )}
            </button>
          </div>
          
          {genError && (
            <p className="text-[10px] font-bold text-red-400">{genError}</p>
          )}

          {avatarPhotoUrl && (
            <div className="flex items-center gap-3 rounded-xl border border-app-border bg-app-surface-3/30 p-2">
              <img
                src={staffAvatarUrl(value, avatarPhotoUrl)}
                alt="AI Generated"
                className="h-10 w-10 rounded-lg object-cover"
              />
              <div className="flex-1">
                <p className="text-[10px] font-bold text-app-text">Active Custom Portrait</p>
                <p className="text-[9px] text-app-text-muted">Currently active on this staff member's profile</p>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <span className="text-[11px] font-black uppercase tracking-widest text-app-text-muted block">Or choose a preset</span>
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <button
              key={g}
              type="button"
              disabled={disabled}
              onClick={() => setFilter(g)}
              className={`rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-widest transition-colors ${
                filter === g
                  ? "border-app-accent bg-app-accent/15 text-app-text"
                  : "border-app-border text-app-text-muted hover:border-app-accent/40"
              } disabled:opacity-50`}
            >
              {g === "all" ? "All" : staffAvatarGroupLabel(g as StaffAvatarCatalogEntry["group"])}
            </button>
          ))}
        </div>
        <div className="grid max-h-[280px] grid-cols-6 gap-2 overflow-y-auto rounded-xl border border-app-border bg-app-surface-2/40 p-3 sm:grid-cols-8">
          {filtered.map((e) => {
            const active = e.key === value;
            return (
              <button
                key={e.key}
                type="button"
                disabled={disabled}
                onClick={() => onChange(e.key)}
                title={e.key}
                className={`relative aspect-square overflow-hidden rounded-xl border-2 transition-all ${
                  active
                    ? "border-app-accent ring-2 ring-app-accent/30"
                    : "border-transparent hover:border-app-border"
                } disabled:opacity-50`}
              >
                <img
                  src={staffAvatarUrl(e.key)}
                  alt=""
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
