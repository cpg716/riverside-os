import React from "react";
import { CreditCard, Zap, Shield, Info, ArrowRight } from "lucide-react";

const StripeSettingsPanel: React.FC = () => {
  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-10">
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Stripe Terminal</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Integrated payment processing for high-volume retail environments.</p>
      </header>

      <section className="ui-card p-10 max-w-4xl border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-transparent shadow-xl relative overflow-hidden">
        {/* Decorative background element */}
        <CreditCard size={300} className="absolute -bottom-20 -right-20 text-indigo-500 opacity-[0.03] rotate-12 pointer-events-none" />
        
        <div className="flex flex-wrap items-start justify-between gap-6 mb-12">
           <div className="flex items-center gap-6">
              <div className="w-20 h-20 bg-[#635bff] text-white rounded-3xl flex items-center justify-center shadow-2xl shadow-indigo-600/20 ring-4 ring-indigo-500/10">
                 <CreditCard size={40} />
              </div>
              <div>
                 <h3 className="text-xl font-black italic uppercase tracking-tight text-app-text">Integrated Payments</h3>
                 <p className="text-[10px] font-black uppercase tracking-[0.2em] text-indigo-600 flex items-center gap-2">
                    <Zap size={12} className="fill-indigo-600" />
                    Module Pending
                 </p>
              </div>
           </div>
           
           <div className="ui-pill bg-app-surface-2 text-app-text-muted text-[10px] font-black uppercase tracking-widest px-4 py-2">
              Development Roadmap V0.2.0
           </div>
        </div>

        <div className="space-y-8 relative z-10">
           <div className="grid gap-6 md:grid-cols-3">
              {[
                { title: "EMV Tap & Go", desc: "Native support for S700 and BBPOS WisePad card readers.", icon: Zap },
                { title: "Tokenized Security", desc: "Sensitive data never touches our servers—fully PCI compliant.", icon: Shield },
                { title: "Unified Ledger", desc: "Automated reconciliation with Orders and QuickBooks.", icon: Info },
              ].map(feat => (
                <div key={feat.title} className="p-6 rounded-2xl bg-app-surface-2/40 border border-app-border/40 hover:border-indigo-500/30 transition-all">
                   <feat.icon size={20} className="text-indigo-600 mb-4" />
                   <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text mb-2">{feat.title}</h4>
                   <p className="text-[10px] font-bold text-app-text-muted leading-relaxed uppercase opacity-80">{feat.desc}</p>
                </div>
              ))}
           </div>

           <div className="p-8 rounded-3xl bg-indigo-600 text-white shadow-2xl shadow-indigo-600/20">
              <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                 <div className="space-y-2">
                    <h4 className="text-lg font-black uppercase tracking-tighter italic">Early Adoption Program</h4>
                    <p className="text-xs text-white/80 font-medium">Be the first to test integrated hardware processing in your store.</p>
                 </div>
                 <button className="h-12 px-8 rounded-xl bg-white text-indigo-600 font-black uppercase tracking-widest text-[11px] hover:scale-105 transition-all flex items-center gap-2">
                    Inquire for Beta
                    <ArrowRight size={14} />
                 </button>
              </div>
           </div>

           <div className="pt-8 border-t border-app-border/40">
              <p className="text-xs text-app-text-muted leading-relaxed italic">
                Stripe Terminal integration is currently in active development. Once released, you will be able to provision API keys and register physical card readers directly from this panel.
              </p>
           </div>
        </div>
      </section>
    </div>
  );
};

export default StripeSettingsPanel;
