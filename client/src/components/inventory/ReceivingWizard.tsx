import { useState, useEffect, useCallback } from "react";
import {
  Truck,
  Search,
  ArrowRight,
  ChevronRight,
  FileText,
  Scan,
  CheckCircle2,
  X,
  Plus,
  Loader2,
  Building2,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useScanner } from "../../hooks/useScanner";

interface PurchaseOrderSummary {
  id: string;
  po_number: string;
  status: string;
  vendor_name: string;
  po_kind: string;
}

interface Vendor {
  id: string;
  name: string;
  vendor_code?: string;
}

interface PurchaseOrderLine {
  line_id: string;
  variant_id: string;
  sku: string;
  product_name: string;
  variation_label: string | null;
  qty_ordered: number;
  qty_previously_received: number;
  unit_cost: string;
  // Local state for receiving
  receivedNow: number;
}

interface PurchaseOrderDetail {
  id: string;
  po_number: string;
  status: string;
  vendor_name: string;
  po_kind: string;
  lines: PurchaseOrderLine[];
}

type ReceivingStep = "select_vendor" | "select_po" | "scan_verification" | "post_to_stock" | "success";

export default function ReceivingWizard() {
  const { toast } = useToast();
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(() => mergedPosStaffHeaders(backofficeHeaders() as Record<string, string>), [backofficeHeaders]);
  const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

  const [step, setStep] = useState<ReceivingStep>("select_vendor");
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // Select Vendor State
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [selectedVendorId, setSelectedVendorId] = useState<string | null>(null);

  // Select PO State
  const [poSearch, setPoSearch] = useState("");
  const [availablePos, setAvailablePos] = useState<PurchaseOrderSummary[]>([]);
  const [selectedPo, setSelectedPo] = useState<PurchaseOrderDetail | null>(null);

  // Invoice State
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [freightTotal, setFreightTotal] = useState("0.00");

  const loadVendors = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/vendors`, {
        headers: apiAuth(),
      });
      if (res.ok) {
        setVendors(await res.json());
      }
    } finally {
      setLoading(false);
    }
  }, [baseUrl, apiAuth]);

  const loadOpenPos = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/purchase-orders`, {
        headers: apiAuth(),
      });
      if (res.ok) {
        const data = await res.json() as PurchaseOrderSummary[];
        setAvailablePos(data.filter(p => ["submitted", "partially_received", "draft"].includes(p.status)));
      }
    } finally {
      setLoading(false);
    }
  }, [baseUrl, apiAuth]);

  useEffect(() => {
    if (step === "select_vendor") {
      void loadVendors();
    }
    if (step === "select_po") {
      void loadOpenPos();
    }
  }, [step, loadVendors, loadOpenPos]);

  const selectPo = async (id: string) => {
    setLoading(true);
    try {
      const res = await fetch(`${baseUrl}/api/purchase-orders/${id}`, {
        headers: apiAuth(),
      });
      if (res.ok) {
        const data = await res.json() as PurchaseOrderDetail;
        setSelectedPo({
          ...data,
          lines: data.lines.map(l => ({ ...l, receivedNow: 0 }))
        });
        setStep("scan_verification");
      }
    } finally {
      setLoading(false);
    }
  };

  const handleScan = (sku: string) => {
    if (step !== "scan_verification" || !selectedPo) return;

    const idx = selectedPo.lines.findIndex(l => l.sku.toLowerCase() === sku.toLowerCase());
    if (idx !== -1) {
      const line = selectedPo.lines[idx]!;
      const maxRemaining = line.qty_ordered - line.qty_previously_received;
      
      if (line.receivedNow >= maxRemaining) {
        toast(`SKU ${sku} already fully received`, "info");
        return;
      }

      const nextLines = [...selectedPo.lines];
      nextLines[idx] = { ...line, receivedNow: line.receivedNow + 1 };
      setSelectedPo({ ...selectedPo, lines: nextLines });
      toast(`+1 ${line.product_name} (${line.variation_label || "Standard"})`, "success");
    } else {
      toast(`SKU ${sku} not found on this PO`, "error");
    }
  };

  useScanner({
    onScan: handleScan,
    enabled: step === "scan_verification" && !!selectedPo,
  });

  const submitReceiving = async () => {
    if (!selectedPo) return;
    const linesToReceive = selectedPo.lines
      .filter(l => l.receivedNow > 0)
      .map(l => ({
        po_line_id: l.line_id,
        quantity_received_now: l.receivedNow,
      }));

    if (linesToReceive.length === 0) {
      toast("No items scanned for receiving", "error");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${baseUrl}/api/purchase-orders/${selectedPo.id}/receive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          invoice_number: invoiceNumber || null,
          freight_total: freightTotal,
          lines: linesToReceive,
        }),
      });

      if (res.ok) {
        setStep("success");
        toast("Inventory successfully materialized", "success");
      } else {
        const data = await res.json();
        throw new Error(data.error || "Receiving failed");
      }
    } catch (e) {
      toast(e instanceof Error ? e.message : "Network error during commit", "error");
    } finally {
      setSubmitting(false);
    }
  };

  const filteredPos = availablePos.filter(p => {
    const matchesSearch = p.po_number.toLowerCase().includes(poSearch.toLowerCase()) || 
                         p.vendor_name.toLowerCase().includes(poSearch.toLowerCase());
    // In step select_po, we can filter by selectedVendorId if the API doesn't do it
    return matchesSearch;
  });

  const selectedVendor = vendors.find(v => v.id === selectedVendorId);

  return (
    <div className="flex flex-col gap-8 max-w-6xl mx-auto pb-24">
      {/* Header & Progress */}
      <div className="flex flex-col gap-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-4xl font-black italic tracking-tighter text-app-text uppercase flex items-center gap-4">
              <Truck size={40} className="text-app-accent" />
              Receiving Bay
            </h1>
            <p className="text-[10px] font-black uppercase tracking-[0.4em] text-app-text-muted mt-2 opacity-60">
              Supply Chain Integration Protocol
            </p>
          </div>
          
          <div className="flex items-center gap-3">
            {[
              { id: "select_vendor", label: "Vendor" },
              { id: "select_po", label: "Order" },
              { id: "scan_verification", label: "Scan" },
              { id: "post_to_stock", label: "Post" },
            ].map((s, idx) => (
              <div key={s.id} className="flex items-center gap-3">
                <div className={`
                  h-2 w-12 rounded-full transition-all duration-500
                  ${step === s.id ? "bg-app-accent w-16" : "bg-app-border"}
                `} />
                {idx < 3 && <ChevronRight size={10} className="text-app-border" />}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-8">
        {step === "select_vendor" && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
             <div className="rounded-[32px] border border-app-border bg-app-surface/40 backdrop-blur-xl p-8 shadow-xl">
                <div className="mb-8">
                  <h2 className="text-xl font-black italic text-app-text uppercase tracking-tight">Step 1: Select Vendor</h2>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">Choose your supplier</p>
                </div>

                <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4">
                  {loading ? (
                     <div className="col-span-full py-12 flex justify-center"><Loader2 className="animate-spin text-app-accent" /></div>
                  ) : (
                    vendors.map(v => (
                      <button
                        key={v.id}
                        onClick={() => {
                          setSelectedVendorId(v.id);
                          setStep("select_po");
                        }}
                        className="flex flex-col items-center justify-center p-6 rounded-2xl border border-app-border bg-app-surface hover:border-app-accent hover:bg-app-accent/5 transition-all text-center group"
                      >
                        <div className="h-12 w-12 bg-app-surface-2 rounded-xl flex items-center justify-center text-app-text-muted mb-4 group-hover:text-app-accent transition-colors">
                          <Building2 size={24} />
                        </div>
                        <span className="text-xs font-black uppercase tracking-tight line-clamp-2">{v.name}</span>
                        {v.vendor_code && <span className="text-[9px] font-bold text-app-text-muted mt-1">{v.vendor_code}</span>}
                      </button>
                    ))
                  )}
                </div>
             </div>
          </div>
        )}

        {step === "select_po" && (
          <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="rounded-[32px] border border-app-border bg-app-surface/40 backdrop-blur-xl p-8 shadow-xl">
              <div className="mb-8 flex items-center justify-between">
                <div>
                  <h2 className="text-xl font-black italic text-app-text uppercase tracking-tight">Step 2: Select PO</h2>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-60">
                    Open orders for {selectedVendor?.name}
                  </p>
                </div>
                <button 
                  onClick={() => setStep("select_vendor")}
                  className="text-[10px] font-black uppercase tracking-widest text-app-text-muted hover:text-app-text"
                >
                  Change Vendor
                </button>
              </div>

              <div className="relative mb-8">
                <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" size={18} />
                <input 
                  value={poSearch}
                  onChange={(e) => setPoSearch(e.target.value)}
                  placeholder="PO Number..."
                  className="ui-input h-14 pl-12 pr-6 text-sm font-bold bg-app-surface rounded-2xl border-app-border focus:border-app-accent transition-all"
                />
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                {loading ? (
                  <div className="col-span-2 py-12 flex justify-center"><Loader2 className="animate-spin text-app-accent" /></div>
                ) : filteredPos.length === 0 ? (
                  <div className="col-span-2 py-12 text-center border border-dashed border-app-border rounded-2xl">
                    <p className="text-app-text-muted text-[10px] font-black uppercase tracking-widest">No Documents Found</p>
                  </div>
                ) : (
                  filteredPos.map(po => (
                    <button
                      key={po.id}
                      onClick={() => selectPo(po.id)}
                      className="flex items-center justify-between p-5 rounded-2xl border border-app-border bg-app-surface hover:border-app-accent hover:bg-app-accent/5 transition-all text-left group"
                    >
                      <div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-app-accent">{po.status}</span>
                        <h4 className="text-lg font-black text-app-text mt-1">{po.po_number}</h4>
                        <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-tighter">{po.po_kind}</p>
                      </div>
                      <ArrowRight size={18} className="text-app-border group-hover:text-app-accent transition-colors" />
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {step === "scan_verification" && selectedPo && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-500 space-y-6">
            <div className="flex items-center justify-between bg-app-surface/60 backdrop-blur-md p-6 rounded-[24px] border border-app-border">
              <div className="flex items-center gap-4">
                 <div className="h-12 w-12 bg-app-accent rounded-xl flex items-center justify-center text-white shadow-lg shadow-app-accent/20">
                    <Scan size={24} />
                 </div>
                 <div>
                    <h3 className="text-lg font-black uppercase italic text-app-text">{selectedPo.vendor_name}</h3>
                    <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">Document: {selectedPo.po_number}</p>
                 </div>
              </div>
              <button 
                onClick={() => setStep("select_po")}
                className="text-[10px] font-black uppercase tracking-widest text-app-border hover:text-app-text transition-colors"
              >
                Change Document
              </button>
            </div>

            <div className="rounded-[24px] border border-app-border bg-app-surface overflow-hidden shadow-sm">
              <table className="w-full text-left border-separate border-spacing-0">
                <thead>
                  <tr className="bg-app-surface-2 border-b border-app-border">
                    <th className="px-6 py-4 text-[9px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">Product Name</th>
                    <th className="px-6 py-4 text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">Ordered</th>
                    <th className="px-6 py-4 text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">Prev Rcvd</th>
                    <th className="px-6 py-4 text-center text-[9px] font-black uppercase tracking-widest text-app-text-muted border-b border-app-border">Rcvd Now</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/10">
                  {selectedPo.lines.map((line, idx) => {
                    const remaining = line.qty_ordered - line.qty_previously_received;
                    const isFullySourced = line.receivedNow >= remaining;

                    return (
                      <tr key={line.line_id} className={`group hover:bg-app-accent/5 transition-colors ${isFullySourced ? "bg-emerald-500/5" : ""}`}>
                        <td className="px-6 py-3">
                          <div className="flex flex-col">
                            <span className="text-[11px] font-black text-app-text uppercase">{line.product_name}</span>
                            <span className="text-[9px] font-bold text-app-text-muted opacity-50 uppercase tracking-tighter">{line.variation_label || "Standard"} · {line.sku}</span>
                          </div>
                        </td>
                        <td className="px-6 py-3 text-center text-xs font-black text-app-text">{line.qty_ordered}</td>
                        <td className="px-6 py-3 text-center text-xs font-bold text-app-text-muted opacity-30">{line.qty_previously_received}</td>
                        <td className="px-6 py-3">
                          <div className="flex items-center justify-center gap-2">
                            <button 
                              onClick={() => {
                                const next = [...selectedPo.lines];
                                next[idx] = { ...line, receivedNow: Math.max(0, line.receivedNow - 1) };
                                setSelectedPo({ ...selectedPo, lines: next });
                              }}
                              className="h-8 w-8 rounded-lg border border-app-border hover:bg-app-surface-2 flex items-center justify-center text-app-text-muted transition-all"
                            >
                              <X size={12} />
                            </button>
                            <input 
                              type="number"
                              value={line.receivedNow}
                              onChange={(e) => {
                                const val = parseInt(e.target.value || "0");
                                const next = [...selectedPo.lines];
                                next[idx] = { ...line, receivedNow: Math.max(0, Math.min(val, remaining)) };
                                setSelectedPo({ ...selectedPo, lines: next });
                              }}
                              className="w-14 h-8 bg-app-surface-2 border border-app-border rounded-lg text-center text-sm font-black text-app-text focus:ring-1 focus:ring-app-accent/20 outline-none"
                            />
                            <button 
                              onClick={() => {
                                if (line.receivedNow >= remaining) return;
                                const next = [...selectedPo.lines];
                                next[idx] = { ...line, receivedNow: line.receivedNow + 1 };
                                setSelectedPo({ ...selectedPo, lines: next });
                              }}
                              className={`h-8 w-8 rounded-lg bg-app-accent flex items-center justify-center text-white shadow-sm active:scale-95 transition-all ${isFullySourced ? "opacity-20 pointer-events-none" : ""}`}
                            >
                              <Plus size={12} strokeWidth={3} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center bg-app-surface/20 backdrop-blur-sm p-6 rounded-[24px] border border-app-border">
              <div className="flex items-center gap-4">
                 <div className="h-10 w-10 rounded-xl bg-app-surface border border-app-border flex items-center justify-center text-app-text-muted">
                    <Scan size={20} />
                 </div>
                 <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted italic">
                    Scanner active. Point at SKU to increment.
                 </p>
              </div>
              
              <button 
                onClick={() => setStep("post_to_stock")}
                className="h-12 px-8 bg-app-accent rounded-xl text-white text-[10px] font-black uppercase tracking-widest shadow-lg shadow-app-accent/10 hover:brightness-110 active:scale-95 transition-all flex items-center gap-3 group"
              >
                Continue <ArrowRight size={14} className="group-hover:translate-x-1 transition-transform" />
              </button>
            </div>
          </div>
        )}

        {step === "post_to_stock" && selectedPo && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-500 flex flex-col items-center">
            <div className="max-w-xl w-full rounded-[32px] border border-app-border bg-app-surface p-8 shadow-2xl space-y-8">
               <div className="text-center space-y-2">
                  <div className="h-16 w-16 bg-app-accent/10 text-app-accent rounded-2xl flex items-center justify-center mx-auto mb-4">
                    <FileText size={32} />
                  </div>
                  <h2 className="text-xl font-black italic uppercase tracking-tight text-app-text leading-none">Step 4: Add to Stock</h2>
                  <p className="text-[9px] font-black uppercase tracking-[0.2em] text-app-text-muted opacity-60">Final Review</p>
               </div>

               <div className="space-y-6">
                  <div className="space-y-2">
                     <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted flex items-center gap-2">
                        Vendor Invoice #
                     </label>
                     <input 
                        value={invoiceNumber}
                        onChange={(e) => setInvoiceNumber(e.target.value)}
                        placeholder="INV-XXXXX"
                        className="ui-input h-14 px-6 text-lg font-black italic tracking-tight rounded-2xl bg-app-surface-2"
                     />
                  </div>

                  <div className="space-y-2">
                     <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted flex items-center gap-2">
                        Freight Total (USD)
                     </label>
                     <div className="relative">
                        <span className="absolute left-6 top-1/2 -translate-y-1/2 text-lg font-black text-app-text-muted opacity-40">$</span>
                        <input 
                           type="number"
                           step="0.01"
                           value={freightTotal}
                           onChange={(e) => setFreightTotal(e.target.value)}
                           className="ui-input h-14 pl-12 pr-6 text-lg font-black tabular-nums tracking-tighter rounded-2xl bg-app-surface-2"
                        />
                     </div>
                  </div>
               </div>

               <div className="flex gap-3">
                  <button 
                    onClick={() => setStep("scan_verification")}
                    className="flex-1 h-16 rounded-2xl bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-3 transition-all"
                  >
                    Adjust Scans
                  </button>
                  <button 
                    onClick={submitReceiving}
                    disabled={submitting}
                    className="flex-[2] h-16 bg-emerald-600 rounded-2xl text-white text-[10px] font-black uppercase tracking-widest shadow-xl shadow-emerald-500/20 hover:brightness-110 active:scale-95 transition-all flex items-center justify-center gap-3 group"
                  >
                    {submitting ? (
                        <>Adding items...</>
                    ) : (
                        <>Finish Receiving <CheckCircle2 size={18} className="group-hover:scale-110 transition-transform" /></>
                    )}
                  </button>
               </div>
            </div>
          </div>
        )}

        {step === "success" && (
          <div className="animate-in zoom-in-95 duration-700 flex flex-col items-center py-10">
            <div className="h-24 w-24 bg-emerald-100 text-emerald-600 rounded-full flex items-center justify-center shadow-xl shadow-emerald-500/10 mb-6">
               <CheckCircle2 size={48} strokeWidth={3} />
            </div>
            <h2 className="text-3xl font-black italic tracking-tighter text-app-text uppercase text-center leading-none">Items Added to Stock</h2>
            <p className="text-sm font-bold text-app-text-muted mt-4 text-center max-w-sm uppercase tracking-widest leading-relaxed opacity-60">
               Inventory counts have been updated.
            </p>
            
            <button 
              onClick={() => {
                  setStep("select_vendor");
                  setSelectedVendorId(null);
                  setSelectedPo(null);
                  setInvoiceNumber("");
                  setFreightTotal("0.00");
              }}
              className="mt-12 h-16 px-12 bg-app-surface border border-app-border rounded-2xl text-[10px] font-black uppercase tracking-widest text-app-text hover:border-app-accent transition-all shadow-sm"
            >
              Start New Protocol
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
