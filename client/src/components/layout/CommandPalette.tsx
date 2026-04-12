import { useState, useEffect, useRef, useMemo } from "react";
import { 
  Search, 
  ShoppingCart, 
  Users, 
  Package, 
  LayoutDashboard, 
  Zap,
  Heart,
  UserPlus
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import type { Customer } from "../../components/pos/CustomerSelector";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigateTab: (tab: "home" | "customers" | "inventory" | "orders" | "weddings" | "settings" | "staff" | "register" | "appointments" | "insights") => void;
  onNavigateSubSection: (tab: string, section: string) => void;
  onOpenCustomer: (customer: Customer) => void;
  onOpenProduct: (product: { sku: string; name: string; variant_id?: string }) => void;
}

interface SearchResult {
  id: string;
  kind: "action" | "customer" | "product" | "tab";
  label: string;
  subtitle?: string;
  icon: React.ReactNode;
  handler: () => void;
}

export default function CommandPalette({ 
  isOpen, 
  onClose, 
  onNavigateTab, 
  onNavigateSubSection,
  onOpenCustomer,
  onOpenProduct
}: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const { backofficeHeaders } = useBackofficeAuth();
  const inputRef = useRef<HTMLInputElement>(null);
  const onOpenCustomerRef = useRef(onOpenCustomer);
  const onOpenProductRef = useRef(onOpenProduct);
  const onNavigateTabRef = useRef(onNavigateTab);
  const onNavigateSubSectionRef = useRef(onNavigateSubSection);
  const onCloseRef = useRef(onClose);

  onOpenCustomerRef.current = onOpenCustomer;
  onOpenProductRef.current = onOpenProduct;
  onNavigateTabRef.current = onNavigateTab;
  onNavigateSubSectionRef.current = onNavigateSubSection;
  onCloseRef.current = onClose;

  const staticActions = useMemo<SearchResult[]>(() => [
    { id: "goto-register", kind: "tab", label: "Go to Register", subtitle: "Switch to POS mode", icon: <ShoppingCart />, handler: () => onNavigateTabRef.current("register") },
    { id: "goto-weddings", kind: "tab", label: "Go to Weddings", subtitle: "Wedding Manager", icon: <Heart />, handler: () => onNavigateTabRef.current("weddings") },
    { id: "goto-dashboard", kind: "tab", label: "Go to Dashboard", subtitle: "Operational performance", icon: <LayoutDashboard />, handler: () => { onNavigateTabRef.current("home"); onNavigateSubSectionRef.current("home", "dashboard"); } },
    { id: "new-customer", kind: "action", label: "New Customer", subtitle: "Create an account", icon: <UserPlus />, handler: () => { onNavigateTabRef.current("customers"); onNavigateSubSectionRef.current("customers", "add"); } },
    { id: "sync-inventory", kind: "action", label: "Sync Counterpoint", subtitle: "Inventory bridge", icon: <Zap />, handler: () => { onNavigateTabRef.current("settings"); onNavigateSubSectionRef.current("settings", "counterpoint"); } },
  ], []);

  useEffect(() => {
    const timer = setTimeout(async () => {
      const q = query;
      if (q.length < 2) {
        setResults(staticActions);
        return;
      }

      try {
        const headers = mergedPosStaffHeaders(backofficeHeaders);
        
        const [custRes, prodRes] = await Promise.all([
          fetch(`${baseUrl}/api/customers/browse?q=${encodeURIComponent(q)}&limit=5`, { headers }),
          fetch(`${baseUrl}/api/products/control-board?search=${encodeURIComponent(q)}&limit=5`, { headers }),
        ]);

        const customers = custRes.ok ? await custRes.json() : [];
        const products = prodRes.ok ? await prodRes.json() : { rows: [] };

        const customerResults: SearchResult[] = (customers.items || customers).slice(0, 5).map((c: Customer) => ({
          id: `cust-${c.id}`,
          kind: "customer",
          label: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim(),
          subtitle: c.email || c.phone || "Customer",
          icon: <Users />,
          handler: () => onOpenCustomerRef.current(c)
        }));

        const productResults: SearchResult[] = (products.rows || []).slice(0, 5).map((p: { sku: string; product_name: string; variant_id?: string; brand?: string }) => ({
          id: `prod-${p.variant_id}`,
          kind: "product",
          label: p.product_name,
          subtitle: `${p.sku} · ${p.brand || "ROS Catalog"}`,
          icon: <Package />,
          handler: () => onOpenProductRef.current({ sku: p.sku, name: p.product_name, variant_id: p.variant_id })
        }));

        setResults([
          ...staticActions.filter(a => a.label.toLowerCase().includes(q.toLowerCase())),
          ...customerResults,
          ...productResults
        ]);
      } catch (e) {
        console.error("Palette search failed", e);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query, backofficeHeaders, staticActions]);

  useEffect(() => {
    if (isOpen) {
      setActiveIndex(0);
      setQuery("");
      setResults(staticActions);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex(i => (i + 1) % Math.max(1, results.length));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex(i => (i - 1 + results.length) % Math.max(1, results.length));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (results[activeIndex]) {
          results[activeIndex].handler();
          onCloseRef.current();
        }
      } else if (e.key === "Escape") {
        onCloseRef.current();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, results, activeIndex]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4 pointer-events-none">
      <div 
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px] pointer-events-auto" 
        onClick={onClose}
      />
      
      <div className="relative w-full max-w-2xl overflow-hidden rounded-[28px] border border-app-border bg-app-surface shadow-2xl pointer-events-auto animate-palette-in">
        <div className="flex items-center gap-4 border-b border-app-border px-6 py-5">
          <Search className="text-app-text-muted" size={24} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search anything (Customers, Products, Tabs)..."
            className="flex-1 bg-transparent text-xl font-bold text-app-text outline-none placeholder:text-app-text-muted/40"
          />
          <div className="flex items-center gap-1 rounded-lg bg-app-surface-2 px-2 py-1 text-[10px] font-black text-app-text-muted">
            <kbd className="font-sans">ESC</kbd> to close
          </div>
        </div>

        <div className="max-h-[60vh] overflow-auto p-2">
          {results.length === 0 ? (
            <div className="py-20 text-center opacity-40">
              <Zap className="mx-auto mb-2" size={32} />
              <p className="text-sm font-bold uppercase tracking-widest">No matching results</p>
            </div>
          ) : (
            <div className="space-y-1">
              {results.map((res, index) => (
                <button
                  key={res.id}
                  type="button"
                  onClick={() => { res.handler(); onClose(); }}
                  onMouseEnter={() => setActiveIndex(index)}
                  className={`flex w-full items-center gap-4 rounded-[20px] px-4 py-3 text-left transition-all ${
                    index === activeIndex 
                      ? "bg-app-accent text-white shadow-lg shadow-app-accent/20" 
                      : "hover:bg-app-surface-2 text-app-text"
                  }`}
                >
                  <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                    index === activeIndex ? "bg-white/20" : "bg-app-surface-2"
                  }`}>
                    {res.icon}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className={`font-black uppercase tracking-tight ${
                      index === activeIndex ? "text-white" : "text-app-text"
                    }`}>
                      {res.label}
                    </p>
                    {res.subtitle && (
                      <p className={`truncate text-xs font-bold leading-tight ${
                        index === activeIndex ? "text-white/70" : "text-app-text-muted"
                      }`}>
                        {res.subtitle}
                      </p>
                    )}
                  </div>
                  {index === activeIndex && (
                    <div className="flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-white/60">
                      Enter <ArrowRight size={12} />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
        
        <div className="flex items-center justify-between border-t border-app-border bg-app-surface-2/30 px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
          <div className="flex gap-4">
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-app-border bg-app-surface px-1">↑↓</kbd> Navigate
            </span>
            <span className="flex items-center gap-1">
              <kbd className="rounded border border-app-border bg-app-surface px-1">↵</kbd> Select
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Heart size={10} className="text-pink-500" /> Riverside OS v0.1.9
          </div>
        </div>
      </div>
    </div>
  );
}

function ArrowRight({ size, className }: { size: number; className?: string }) {
  return (
    <svg 
      width={size} 
      height={size} 
      viewBox="0 0 24 24" 
      fill="none" 
      stroke="currentColor" 
      strokeWidth={3} 
      strokeLinecap="round" 
      strokeLinejoin="round" 
      className={className}
    >
      <path d="M5 12h14" />
      <path d="m12 5 7 7-7 7" />
    </svg>
  );
}
