import React, { useState } from "react";
import { X, Loader2, Check } from "lucide-react";

interface VariantGeneratorModalProps {
  productId: string;
  productName: string;
  onClose: () => void;
  onGenerated: () => void;
  baseUrl: string;
  apiAuth: () => HeadersInit;
}

export const VariantGeneratorModal: React.FC<VariantGeneratorModalProps> = ({
  productId,
  productName,
  onClose,
  onGenerated,
  baseUrl,
  apiAuth,
}) => {
  const [colors, setColors] = useState("");
  const [sizes, setSizes] = useState("");
  const [fits, setFits] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [step, setStep] = useState<"input" | "preview">("input");

  const [previewItems, setPreviewItems] = useState<{ color: string; size: string; fit: string }[]>([]);

  const handlePreview = () => {
    const colorList = colors.split(",").map(s => s.trim()).filter(Boolean);
    const sizeList = sizes.split(",").map(s => s.trim()).filter(Boolean);
    const fitList = fits.split(",").map(s => s.trim()).filter(Boolean);

    if (colorList.length === 0 && sizeList.length === 0) return;

    const items: { color: string; size: string; fit: string }[] = [];
    
    // Handle the cross-product
    const colorsArr = colorList.length > 0 ? colorList : [""];
    const sizesArr = sizeList.length > 0 ? sizeList : [""];
    const fitsArr = fitList.length > 0 ? fitList : [""];

    for (const c of colorsArr) {
      for (const s of sizesArr) {
        for (const f of fitsArr) {
          items.push({ color: c, size: s, fit: f });
        }
      }
    }
    setPreviewItems(items);
    setStep("preview");
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const res = await fetch(`${baseUrl}/api/products/${productId}/variants/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          variants: previewItems.map(item => ({
             variation_values: {
               ...(item.color ? { "Color": item.color } : {}),
               ...(item.size ? { "Size": item.size } : {}),
               ...(item.fit ? { "Fit": item.fit } : {}),
             }
          }))
        })
      });

      if (!res.ok) throw new Error("Batch creation failed");
      
      onGenerated();
      onClose();
    } catch (e) {
      console.error("Batch creation failed", e);
      // Removed alert() per project rules. Failure logged to console.
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[24px] border border-app-border bg-app-surface shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="p-6 border-b border-app-border flex items-center justify-between bg-app-surface/50">
          <div>
            <h3 className="text-lg font-black tracking-tight text-app-text">Variant Generator</h3>
            <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">{productName}</p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-app-surface-2 rounded-xl text-app-text-muted">
            <X size={20} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-8 space-y-6">
          {step === "input" ? (
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Colors (Comma separated)</label>
                <input 
                  autoFocus
                  value={colors}
                  onChange={e => setColors(e.target.value)}
                  placeholder="Navy, Charcoal, Black..." 
                  className="ui-input w-full h-12 px-4 bg-app-bg/50 border-app-border"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Sizes (Comma separated)</label>
                <input 
                  value={sizes}
                  onChange={e => setSizes(e.target.value)}
                  placeholder="38R, 40R, 42R..." 
                  className="ui-input w-full h-12 px-4 bg-app-bg/50 border-app-border"
                />
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-app-text-muted ml-1">Fits (Optional)</label>
                <input 
                  value={fits}
                  onChange={e => setFits(e.target.value)}
                  placeholder="Slim, Modern, Classic..." 
                  className="ui-input w-full h-12 px-4 bg-app-bg/50 border-app-border"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-xs font-medium text-app-text-muted">Reviewing <span className="text-app-text font-bold">{previewItems.length}</span> proposed variations. System will assign sequential <span className="font-mono bg-app-surface-2 px-1 py-0.5 rounded text-app-accent">B-XXXXX</span> codes.</p>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                {previewItems.map((item, i) => (
                  <div key={i} className="p-2 rounded-lg border border-app-border bg-app-surface/40 text-[10px] font-bold">
                    {item.color && <span className="text-app-accent">{item.color}</span>}
                    {item.size && <span className="text-app-text"> / {item.size}</span>}
                    {item.fit && <span className="text-app-text-muted"> / {item.fit}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-app-border bg-app-surface/50 flex gap-3">
          {step === "input" ? (
            <>
              <button 
                onClick={onClose}
                className="flex-1 h-12 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted border border-app-border hover:bg-app-surface-2"
              >
                Cancel
              </button>
              <button 
                onClick={handlePreview}
                disabled={!colors && !sizes}
                className="flex-1 h-12 bg-app-accent text-white rounded-xl text-[10px] font-black uppercase tracking-widest shadow-lg shadow-app-accent/20 hover:brightness-110 active:scale-95 disabled:opacity-50 transition-all"
              >
                Preview Variants
              </button>
            </>
          ) : (
            <>
              <button 
                onClick={() => setStep("input")}
                disabled={isGenerating}
                className="flex-1 h-12 rounded-xl text-[10px] font-black uppercase tracking-widest text-app-text-muted border border-app-border hover:bg-app-surface-2"
              >
                Back to Edit
              </button>
              <button 
                onClick={handleGenerate}
                disabled={isGenerating}
                className="flex-1 h-12 bg-app-success text-white rounded-xl flex items-center justify-center gap-2 text-[10px] font-black uppercase tracking-widest shadow-lg shadow-app-success/20 hover:brightness-110 active:scale-95 transition-all"
              >
                {isGenerating ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />}
                <span>Create All SKUs</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
