import React from "react";
import { CheckCircle2, Info, ArrowUpRight } from "lucide-react";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";

interface QuickBooksSettingsPanelProps {
  onOpenQbo: () => void;
}

const QuickBooksSettingsPanel: React.FC<QuickBooksSettingsPanelProps> = ({ onOpenQbo }) => {
  return (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <header className="mb-10">
        <div className="mb-4 flex items-center">
          <IntegrationBrandLogo
            brand="qbo"
            kind="wordmark"
            className="inline-flex rounded-2xl border border-emerald-500/20 bg-white px-4 py-2 shadow-sm"
            imageClassName="h-10 w-auto object-contain"
          />
        </div>
        <h2 className="text-3xl font-black italic tracking-tighter uppercase text-app-text">Accounting Bridge</h2>
        <p className="text-sm text-app-text-muted mt-2 font-medium">Synchronize financial data, daily sales, and item mappings between Riverside and your QBO ledger.</p>
      </header>

      <section className="ui-card p-10 max-w-4xl border-emerald-500/20 bg-gradient-to-br from-emerald-500/5 to-transparent shadow-xl">
        <div className="flex flex-wrap items-start justify-between gap-6 mb-10 pb-10 border-b border-app-border/40">
           <div className="flex items-center gap-6">
              <div className="flex h-20 w-20 items-center justify-center rounded-[2.5rem] bg-white shadow-2xl shadow-[#2ca01c]/20 ring-4 ring-emerald-500/10">
                 <IntegrationBrandLogo
                   brand="qbo"
                   kind="icon"
                   className="inline-flex"
                   imageClassName="h-14 w-14 object-contain"
                 />
              </div>
              <div>
                 <h3 className="text-xl font-black italic uppercase tracking-tight text-app-text">Intuit Data Bridge</h3>
                 <p className="text-[10px] font-black uppercase tracking-widest text-[#2ca01c] flex items-center gap-2">
                    <CheckCircle2 size={12} />
                    Live Ledger Ready
                 </p>
              </div>
           </div>
           
           <button 
             onClick={onOpenQbo}
             className="flex items-center gap-2 h-14 px-10 rounded-2xl bg-[#2ca01c] text-white font-black uppercase tracking-[0.2em] shadow-xl shadow-[#2ca01c]/20 hover:scale-[1.05] transition-all group"
           >
              Launch Remote Bridge
              <ArrowUpRight size={18} className="group-hover:translate-x-1 group-hover:-translate-y-1 transition-transform" />
           </button>
        </div>

        <div className="grid gap-8 md:grid-cols-2">
           <div className="space-y-4">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Status & Continuity</h4>
              <div className="p-5 rounded-2xl bg-app-surface-2/60 border border-app-border/40 space-y-4">
                 <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-app-text">Last Sync Attempt</span>
                    <span className="text-[10px] font-mono text-app-text-muted">Today, 04:12 AM</span>
                 </div>
                 <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-app-text">Mapping Health</span>
                    <span className="text-[10px] font-black uppercase text-emerald-600">Healthy</span>
                 </div>
                 <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-app-text">Daily Close Export</span>
                    <span className="text-[10px] font-black uppercase text-app-accent">Automatic</span>
                 </div>
              </div>
           </div>

           <div className="space-y-4">
              <h4 className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Integration Scope</h4>
              <ul className="space-y-3">
                 {[
                   "Invoices & Payments (Daily Sales)",
                   "Inventory Level Adjustments",
                   "Vendor & Purchase Order Sync",
                   "Sales Tax Liability Reporting"
                 ].map(item => (
                   <li key={item} className="flex items-center gap-3 text-xs font-medium text-app-text">
                      <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                      {item}
                   </li>
                 ))}
              </ul>
           </div>
        </div>

        <div className="mt-12 p-6 rounded-2xl bg-amber-500/5 border border-amber-500/20 flex gap-4">
           <Info className="flex-shrink-0 text-amber-600" size={24} />
           <div className="space-y-2">
              <h5 className="text-[10px] font-black uppercase tracking-widest text-amber-700">Accounting Note</h5>
              <p className="text-xs text-app-text-muted leading-relaxed">
                The QuickBooks integration uses a secure JWT-based handshake. If transactions aren't appearing in your bank feed, ensure the Riverside bridge is correctly mapped to your <strong>Sales Clearing</strong> and <strong>Tax Payable</strong> accounts in the Bridge settings.
              </p>
           </div>
        </div>
      </section>
    </div>
  );
};

export default QuickBooksSettingsPanel;
