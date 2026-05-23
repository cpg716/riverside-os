import { useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";

const baseUrl = getBaseUrl();

interface ProductImageGeneratorProps {
  productId?: string;
  onGenerated: (url: string) => void;
  disabled?: boolean;
  jobType?: "product_image" | "promo_image";
  title?: string;
  placeholder?: string;
}

export default function ProductImageGenerator({
  productId = "00000000-0000-0000-0000-000000000000",
  onGenerated,
  disabled = false,
  jobType = "product_image",
  title = "AI Product Image Generator",
  placeholder = "A studio lighting photo of a wedding gown, white satin, high-end bridal catalog style, solid grey backdrop...",
}: ProductImageGeneratorProps) {
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("fal-ai/flux/schnell");
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const { backofficeHeaders } = useBackofficeAuth();

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
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
          model_endpoint: model,
          payload: {
            prompt: prompt.trim(),
            num_inference_steps: model.includes("schnell") ? 4 : 28,
            enable_safety_checker: true,
          },
          job_type: jobType,
          target_id: productId,
        }),
      });

      if (!dispatchRes.ok) {
        const errData = await dispatchRes.json();
        throw new Error(errData.error || "Failed to dispatch generation task");
      }

      const { job_id } = await dispatchRes.json();

      let attempts = 0;
      const maxAttempts = 90; // 3 minutes max (Flux Dev can take longer)
      const interval = setInterval(async () => {
        try {
          attempts += 1;
          if (attempts > maxAttempts) {
            clearInterval(interval);
            setGenerating(false);
            setGenError("Generation timed out.");
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
            if (job.local_asset_path) {
              onGenerated(job.local_asset_path);
              setPrompt("");
            }
          } else if (job.status === "failed") {
            clearInterval(interval);
            setGenerating(false);
            setGenError(job.error_message || "Generation job failed");
          }
        } catch (pollErr: any) {
          clearInterval(interval);
          setGenerating(false);
          setGenError(pollErr.message || "Error polling status");
        }
      }, 2000);
    } catch (err: any) {
      setGenerating(false);
      setGenError(err.message || "An error occurred");
    }
  };

  return (
    <div className="rounded-2xl border border-app-border bg-app-surface-2/20 p-4 space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-black uppercase tracking-widest text-app-text">{title}</span>
        <span className="text-[10px] font-medium text-app-text-muted">via Fal.ai</span>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Model Type:</label>
          <div className="flex gap-2">
            {[
              { label: "Flux Schnell (Fast)", value: "fal-ai/flux/schnell" },
              { label: "Flux Dev (High Quality)", value: "fal-ai/flux/dev" },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                disabled={generating || disabled}
                onClick={() => setModel(opt.value)}
                className={`rounded-full border px-2.5 py-0.5 text-[9px] font-black uppercase tracking-widest transition-colors ${
                  model === opt.value
                    ? "border-app-accent bg-app-accent/15 text-app-text"
                    : "border-app-border text-app-text-muted hover:border-app-accent/40"
                } disabled:opacity-50`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <textarea
            rows={2}
            placeholder={placeholder}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={disabled || generating}
            className="flex-1 rounded-xl border border-app-border bg-app-surface-3/30 px-3 py-2 text-xs text-app-text placeholder:text-app-text-muted focus:border-app-accent focus:outline-none disabled:opacity-50 resize-none"
          />
          <button
            type="button"
            onClick={handleGenerate}
            disabled={disabled || generating || !prompt.trim()}
            className="rounded-xl bg-app-accent px-5 py-2 text-xs font-black text-white hover:bg-app-accent/80 disabled:opacity-50 flex items-center justify-center gap-2 transition-all self-stretch min-w-[100px]"
          >
            {generating ? (
              <div className="flex flex-col items-center gap-1">
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                <span className="text-[9px]">Generating</span>
              </div>
            ) : (
              "Generate"
            )}
          </button>
        </div>

        {genError && (
          <p className="text-[10px] font-bold text-red-400">{genError}</p>
        )}
      </div>
    </div>
  );
}
