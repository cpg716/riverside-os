import { useState, useEffect } from "react";
import { 
  CreditCard, 
  Wifi, 
  CheckCircle2, 
  Loader2, 
  Smartphone,
  ShieldCheck
} from "lucide-react";
import { centsToFixed2 } from "../../lib/money";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

export type ReaderStatus = "connecting" | "idle" | "insert_card" | "processing" | "success" | "error";

/** POS mock terminal — display only; tender amount is integer cents (same path as Nexo / Stripe intent). */
interface StripeReaderSimulationProps {
  amountCents: number;
  moto?: boolean;
  onSuccess: (metadata?: { brand?: string; last4?: string }) => void;
  onCancel: () => void;
}

export default function StripeReaderSimulation({
  amountCents,
  moto,
  onSuccess,
  onCancel
}: StripeReaderSimulationProps) {
  const [status, setStatus] = useState<ReaderStatus>(moto ? "insert_card" : "connecting");
  const [dots, setDots] = useState("");

  // Simulated Connection Handshake
  useEffect(() => {
    if (moto) {
        setStatus("insert_card");
        return;
    }
    const timer = setTimeout(() => setStatus("insert_card"), 2000);
    return () => clearTimeout(timer);
  }, [moto]);

  // Pulsing Dots for "Connecting" or "Processing"
  useEffect(() => {
    if (status === "connecting" || status === "processing") {
      const interval = setInterval(() => {
        setDots(prev => (prev.length >= 3 ? "" : prev + "."));
      }, 400);
      return () => clearInterval(interval);
    }
  }, [status]);

  const [cardNumber, setCardNumber] = useState("");
  const [cardExpiry, setCardExpiry] = useState("");
  const [cardCvc, setCardCvc] = useState("");

  const simulatePayment = () => {
    setStatus("processing");
    setTimeout(() => {
      setStatus("success");
      setTimeout(() => {
        const last4 = cardNumber.slice(-4) || "4242";
        const brand = cardNumber.startsWith("4") ? "visa" : "mastercard";
        onSuccess({ brand, last4 });
      }, 1500);
    }, 2500);
  };

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col items-center justify-center rounded-[40px] border-4 border-white/10 bg-app-text p-8 shadow-2xl animate-in zoom-in-95 duration-500">
      {/* Handheld Terminal Header (LEDs) */}
      <div className="flex gap-2 mb-8">
        {[0, 1, 2, 3].map((i) => (
          <div 
            key={i} 
            className={`h-2 w-8 rounded-full transition-all duration-300 ${
              status === "success" ? "bg-emerald-500 shadow-[0_0_10px_#10b981]" : 
              status === "processing" ? (dots.length > i ? "bg-blue-500 shadow-[0_0_10px_#3b82f6]" : "bg-white/15") :
              status === "insert_card" ? "animate-pulse bg-white/25" : "bg-white/15"
            }`} 
          />
        ))}
      </div>

      {/* Terminal Screen Container */}
      <div className="relative flex aspect-[4/3] w-full flex-col items-center justify-between overflow-hidden rounded-2xl border-2 border-white/10 bg-[#1a1a1a] p-6 shadow-inner">
        {/* Screen Glare */}
        <div className="absolute inset-x-0 top-0 h-1/2 bg-gradient-to-b from-white/5 to-transparent pointer-events-none" />
        
        <div className="w-full flex justify-between items-center opacity-40">
           <Wifi size={14} className="text-white/40" />
           <div className="h-1.5 w-6 rounded-full bg-white/35" />
        </div>

        <div className="flex flex-col items-center text-center space-y-4 py-4">
          {status === "connecting" && (
            <>
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
                 <Loader2 className="animate-spin text-white/45" size={24} />
              </div>
              <p className="text-sm font-black uppercase tracking-widest text-white/45">Connecting{dots}</p>
            </>
          )}

          {status === "insert_card" && (
            <>
              {moto ? (
                <div className="w-full space-y-3">
                    <p className="text-xl font-black text-emerald-400 italic tracking-tighter mb-2">TEL MOTO ORDER</p>
                    <div className="space-y-2">
                        <input 
                            placeholder="CARD NUMBER" 
                            value={cardNumber} 
                            autoFocus
                            onChange={e => setCardNumber(e.target.value.replace(/\D/g, '').slice(0, 16))}
                            className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-white font-mono text-xs placeholder:text-white/20 focus:border-blue-500 outline-none" 
                        />
                        <div className="grid grid-cols-2 gap-2">
                            <input 
                                placeholder="MM/YY" 
                                value={cardExpiry}
                                onChange={e => setCardExpiry(e.target.value.slice(0, 5))}
                                className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-white font-mono text-xs placeholder:text-white/20 focus:border-blue-500 outline-none" 
                            />
                            <input 
                                placeholder="CVC" 
                                value={cardCvc}
                                onChange={e => setCardCvc(e.target.value.replace(/\D/g, '').slice(0, 4))}
                                className="w-full bg-white/5 border border-white/10 rounded-lg p-2 text-white font-mono text-xs placeholder:text-white/20 focus:border-blue-500 outline-none" 
                            />
                        </div>
                    </div>
                </div>
              ) : (
                <>
                <div className="h-16 w-16 rounded-full bg-blue-500/10 flex items-center justify-center text-blue-500 animate-pulse">
                    <CreditCard size={32} />
                </div>
                <div>
                    <p className="text-2xl font-black text-white italic tracking-tighter">${centsToFixed2(Math.abs(amountCents))}</p>
                    <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.2em] text-white/45">{amountCents < 0 ? "TAP TO RECEIVE CREDIT" : "Insert / Tap Card"}</p>
                </div>
                </>
              )}
            </>
          )}

          {status === "processing" && (
            <>
              <div className="h-12 w-12 rounded-full border-2 border-blue-500/30 flex items-center justify-center">
                 <Loader2 className="text-blue-500 animate-spin" size={24} />
              </div>
              <p className="text-lg font-black tabular-nums text-white/90">
                ${centsToFixed2(Math.abs(amountCents))}
              </p>
              <p className="text-sm font-black uppercase tracking-widest text-blue-400">{amountCents < 0 ? "Crediting" : "Authorizing"}{dots}</p>
            </>
          )}

          {status === "success" && (
            <>
              <div className="h-16 w-16 rounded-full bg-emerald-500 flex items-center justify-center text-white shadow-[0_0_20px_rgba(16,185,129,0.4)] animate-bounce">
                 <CheckCircle2 size={32} strokeWidth={3} />
              </div>
              <p className="text-xl font-black uppercase italic tracking-tighter text-emerald-400">Approved</p>
            </>
          )}
        </div>

        <div className="w-full text-center">
           <div className="flex items-center justify-center gap-2">
             <IntegrationBrandLogo
               brand="stripe"
               kind="icon"
               theme="dark"
               className="inline-flex"
               imageClassName="h-4 w-4 object-contain opacity-75"
             />
             <span className="text-[9px] font-bold uppercase tracking-widest text-white/35">Powered by</span>
             <span className="text-[9px] font-bold uppercase tracking-widest text-white/35">Stripe</span>
           </div>
        </div>
      </div>

      {/* Manual Hardware Triggers (Mocking physical actions) */}
      {status === "insert_card" && (
        <div className="mt-8 grid grid-cols-2 gap-3 w-full">
          {!moto ? (
            <>
            <button 
                onClick={simulatePayment}
                className="group flex h-20 flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/40 transition-all hover:bg-white/10 active:scale-95 text-white"
            >
                <Smartphone size={20} className="transition-colors group-hover:text-blue-400" />
                <span className="text-[10px] font-black uppercase tracking-widest leading-none">Simulate Tap</span>
            </button>
            <button 
                onClick={simulatePayment}
                className="group flex h-20 flex-col items-center justify-center gap-2 rounded-2xl border border-white/10 bg-black/40 transition-all hover:bg-white/10 active:scale-95 text-white"
            >
                <CreditCard size={20} className="transition-colors group-hover:text-blue-400" />
                <span className="text-[10px] font-black uppercase tracking-widest leading-none">Simulate Dip</span>
            </button>
            </>
          ) : (
            <button 
                onClick={simulatePayment}
                disabled={cardNumber.length < 15}
                className="col-span-2 h-14 rounded-2xl bg-blue-600 text-white font-black uppercase tracking-widest text-xs hover:bg-blue-500 disabled:opacity-30 transition-all flex items-center justify-center gap-2"
            >
                {amountCents < 0 ? "Process Credit" : "Process Charge"} — ${centsToFixed2(Math.abs(amountCents))}
                <CheckCircle2 size={16} />
            </button>
          )}
        </div>
      )}

      {/* Security Footer */}
      <div className="mt-8 flex items-center gap-2 opacity-30 group hover:opacity-100 transition-opacity">
         <ShieldCheck size={12} className="text-white/40" />
         <p className="text-[9px] font-bold uppercase tracking-widest text-white/40">Secure E2E Encryption</p>
      </div>

      {/* Cancel Action */}
      {(status === "insert_card" || status === "error") && (
        <button 
          onClick={onCancel}
          className="mt-6 text-[10px] font-black uppercase tracking-widest text-white/45 transition-colors hover:text-red-400"
        >
          Cancel Transaction
        </button>
      )}
    </div>
  );
}
