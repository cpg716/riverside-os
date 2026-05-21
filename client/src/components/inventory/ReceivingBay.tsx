import { getBaseUrl } from "../../lib/apiConfig";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertCircle,
  Barcode,
  Camera,
  CheckCircle,
  CheckSquare,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import CameraScanner from "./CameraScanner";
import { playScanSuccess, playScanError, playScanWarning, warmUpAudio } from "../../lib/scanSounds";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import RosieInsightSummary from "../help/RosieInsightSummary";

const BASE_URL = getBaseUrl();

// ── Types ─────────────────────────────────────────────────────────────────────

interface PurchaseOrderDetail {
  id: string;
  po_number: string;
  status: string;
  vendor_id: string;
  vendor_name: string;
  po_kind?: string;
  lines: ApiLine[];
}

interface ApiLine {
  line_id: string;
  variant_id: string;
  sku: string;
  vendor_upc?: string | null;
  product_name: string;
  variation_label: string | null;
  variation_values: Record<string, unknown>;
  qty_ordered: number;
  qty_previously_received: number;
  unit_cost: string | number;
  prior_effective_cost?: string | number;
}

export interface WorksheetLine {
  line_id: string;
  variant_id: string;
  sku: string;
  vendor_upc: string | null;
  product_name: string;
  subtitle: string;
  qty_ordered: number;
  qty_previously_received: number;
  qty_receiving: number;
  unit_cost: number;
  prior_effective_cost: number;
}

type ScanMode = "laser" | "camera";

interface ScanFeedback {
  type: "success" | "warning" | "error";
  message: string;
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function toNumberCost(v: string | number | undefined): number {
  return parseMoneyToCents(v) / 100;
}

const COST_ALERT_THRESHOLD = 0.05;

function unitCostAlerts(priorEffective: number, invoiceUnit: number): boolean {
  if (!(priorEffective > 0)) return false;
  const dev = Math.abs(invoiceUnit - priorEffective) / priorEffective;
  return dev > COST_ALERT_THRESHOLD;
}

function pickAxis(
  obj: Record<string, unknown> | null | undefined,
  keys: string[],
): string {
  if (!obj || typeof obj !== "object") return "—";
  for (const k of keys) {
    const raw = obj[k];
    if (raw == null) continue;
    const s = String(raw).trim();
    if (s !== "") return s;
  }
  return "—";
}

function mapApiLine(l: ApiLine): WorksheetLine {
  const vals = l.variation_values ?? {};
  const color = pickAxis(vals, ["Color", "color", "COLOUR"]);
  const size = pickAxis(vals, ["Size", "size", "Chest", "chest"]);
  const label = l.variation_label?.trim();
  const dims = [color, size]
    .filter((x) => x && x !== "—")
    .join(" · ");
  const subtitle = label || dims || "—";
  return {
    line_id: l.line_id,
    variant_id: l.variant_id,
    sku: l.sku,
    vendor_upc: l.vendor_upc ?? null,
    product_name: l.product_name,
    subtitle,
    qty_ordered: l.qty_ordered,
    qty_previously_received: l.qty_previously_received,
    qty_receiving: 0,
    unit_cost: toNumberCost(l.unit_cost),
    prior_effective_cost: toNumberCost(l.prior_effective_cost),
  };
}

function mergeWorksheetLines(
  apiLines: ApiLine[],
  existingLines: WorksheetLine[],
): WorksheetLine[] {
  const existingByLineId = new Map(
    existingLines.map((line) => [line.line_id, line]),
  );

  return apiLines.map((apiLine) => {
    const mapped = mapApiLine(apiLine);
    const existing = existingByLineId.get(mapped.line_id);
    if (!existing) return mapped;

    const remainingQty = Math.max(
      0,
      mapped.qty_ordered - mapped.qty_previously_received,
    );

    return {
      ...mapped,
      qty_receiving: Math.min(existing.qty_receiving, remainingQty),
    };
  });
}

type ReceivingWorkflowStep = {
  id: "verify" | "count" | "post";
  label: string;
  hint: string;
};

const RECEIVING_WORKFLOW_STEPS: ReceivingWorkflowStep[] = [
  {
    id: "verify",
    label: "Check paperwork",
    hint: "Confirm this is the right vendor invoice or purchase order.",
  },
  {
    id: "count",
    label: "Count & invoice",
    hint: "Enter received quantities, invoice number, and freight from the paperwork in hand.",
  },
  {
    id: "post",
    label: "Post inventory",
    hint: "Review the staged receipt, then post once this invoice is ready to move inventory.",
  },
];

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  poId: string;
  onComplete: () => void;
  onClose: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReceivingBay({ poId, onComplete, onClose }: Props) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [lines, setLines] = useState<WorksheetLine[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [freight, setFreight] = useState("0.00");
  const [invoiceNum, setInvoiceNum] = useState("");
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [invGlLabel, setInvGlLabel] = useState("INV_ASSET · not mapped");
  const [, setFreightGlLabel] = useState("Freight cost · not mapped");
  const [glanceUnavailable, setGlanceUnavailable] = useState(false);
  const [useVendorUpc, setUseVendorUpc] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>("laser");
  const [feedback, setFeedback] = useState<ScanFeedback | null>(null);
  const [scanCount, setScanCount] = useState(0);
  const [showPostConfirm, setShowPostConfirm] = useState(false);
  const { toast } = useToast();
  const scannerRef = useRef<HTMLInputElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Track timing of chars in the scan input for HID detection
  const lastCharTimeRef = useRef<number>(Date.now());
  const charIntervalsRef = useRef<number[]>([]);

  // ── Feedback flash ─────────────────────────────────────────────────────────

  const showFeedback = useCallback((fb: ScanFeedback) => {
    setFeedback(fb);
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 2000);
  }, []);

  // ── GL labels ──────────────────────────────────────────────────────────────

  const refreshGlance = useCallback(async () => {
    try {
      const h = apiAuth();
      const [accRes, mapRes] = await Promise.all([
        fetch(`${BASE_URL}/api/qbo/accounts-cache`, { headers: h }),
        fetch(`${BASE_URL}/api/qbo/mappings`, { headers: h }),
      ]);
      if (!accRes.ok || !mapRes.ok) {
        setGlanceUnavailable(true);
        return;
      }
      const accounts = (await accRes.json()) as { id: string; name: string }[];
      const mappings = (await mapRes.json()) as { internal_key: string; qbo_account_id: string | null }[];
      const byId = new Map(accounts.map((a) => [a.id, a.name]));
      const invId = mappings.find((m) => m.internal_key === "INV_ASSET")?.qbo_account_id;
      const frId = mappings.find((m) => m.internal_key === "COGS_FREIGHT")?.qbo_account_id;
      if (invId && byId.has(invId)) setInvGlLabel(byId.get(invId)!);
      if (frId && byId.has(frId)) setFreightGlLabel(byId.get(frId)!);
      setGlanceUnavailable(false);
    } catch {
      setGlanceUnavailable(true);
    }
  }, [apiAuth]);

  // ── Load PO ─────────────────────────────────────────────────────────────────

  const loadPo = useCallback(async () => {
    setLoadError(null);
    try {
      const h = apiAuth();
      const res = await fetch(`${BASE_URL}/api/purchase-orders/${poId}`, {
        headers: h,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Failed to load PO");
      }
      const data = (await res.json()) as PurchaseOrderDetail;
      setDetail(data);
      setLines((prev) => mergeWorksheetLines(data.lines, prev));

      // Load vendor's use_vendor_upc setting
      if (data.vendor_id) {
        const vRes = await fetch(`${BASE_URL}/api/vendors/${data.vendor_id}/hub`, {
          headers: h,
        });
        if (vRes.ok) {
          const hub = (await vRes.json()) as { use_vendor_upc?: boolean };
          setUseVendorUpc(hub.use_vendor_upc ?? false);
        }
      }
    } catch {
      setLoadError("Purchase order details could not load right now.");
    }
  }, [poId, apiAuth]);

  useEffect(() => {
    void loadPo();
    void refreshGlance();
    warmUpAudio();
  }, [loadPo, refreshGlance]);

  useEffect(() => {
    if (scanMode === "laser") {
      scannerRef.current?.focus();
    }
  }, [lines.length, detail?.id, scanMode]);

  // ── Scan matching ──────────────────────────────────────────────────────────

  const matchLine = useCallback(
    (code: string): number => {
      const c = code.toLowerCase().trim();
      // If vendor uses vendor UPC, check that field first
      if (useVendorUpc) {
        const vuIdx = lines.findIndex(
          (l) => l.vendor_upc && l.vendor_upc.toLowerCase() === c,
        );
        if (vuIdx >= 0) return vuIdx;
      }
      // Fall back to SKU
      return lines.findIndex((l) => l.sku.toLowerCase() === c);
    },
    [lines, useVendorUpc],
  );

  const processScan = useCallback(
    (code: string) => {
      const sku = code.trim();
      if (!sku) return;

      const idx = matchLine(sku);
      if (idx === -1) {
        playScanError();
        showFeedback({ type: "error", message: `Not on this purchase order: ${sku}` });
        return;
      }

      const line = lines[idx];
      const remain = Math.max(0, line.qty_ordered - line.qty_previously_received);

      if (line.qty_receiving >= remain) {
        playScanWarning();
        showFeedback({ type: "warning", message: `${line.product_name} already at max qty` });
        return;
      }

      setLines((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], qty_receiving: next[idx].qty_receiving + 1 };
        return next;
      });
      setScanCount((c) => c + 1);
      playScanSuccess();
      showFeedback({ type: "success", message: `${line.product_name} · ${line.qty_receiving + 1} received` });
    },
    [lines, matchLine, showFeedback],
  );

  // ── HID scanner detection in the dedicated scan input ─────────────────────

  const handleScanInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const code = scanInput.trim();
      if (!code) return;

      processScan(code);
      setScanInput("");
      charIntervalsRef.current = [];
      scannerRef.current?.focus();
    }
  };

  const handleScanInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const now = Date.now();
    const elapsed = now - lastCharTimeRef.current;
    lastCharTimeRef.current = now;
    charIntervalsRef.current.push(elapsed);
    if (charIntervalsRef.current.length > 12) charIntervalsRef.current.shift();
    setScanInput(e.target.value);
  };

  // ── Camera scan handler ────────────────────────────────────────────────────

  const handleCameraScan = useCallback(
    (code: string) => processScan(code),
    [processScan],
  );

  // ── Submit all received ────────────────────────────────────────────────────

  const receivingClosed =
    detail?.status === "closed" ||
    detail?.status === "cancelled" ||
    (detail?.status === "draft" && detail?.po_kind !== "direct_invoice");

  const itemsTotalCents = useMemo(
    () =>
      lines.reduce(
        (acc, l) => acc + l.qty_receiving * parseMoneyToCents(l.unit_cost),
        0,
      ),
    [lines],
  );

  const freightCents = parseMoneyToCents(freight || "0");
  const grandTotalCents = itemsTotalCents + freightCents;
  const receivingLineCount = useMemo(
    () => lines.filter((line) => line.qty_receiving > 0).length,
    [lines],
  );
  const costAlertLines = useMemo(
    () =>
      lines.filter((line) =>
        unitCostAlerts(line.prior_effective_cost, line.unit_cost),
      ),
    [lines],
  );
  const invoiceMissing = invoiceNum.trim() === "";
  const receivingInsightFacts = useMemo(() => {
    const totalOrdered = lines.reduce((sum, line) => sum + line.qty_ordered, 0);
    const totalPreviouslyReceived = lines.reduce(
      (sum, line) => sum + line.qty_previously_received,
      0,
    );
    const totalReceivingNow = lines.reduce(
      (sum, line) => sum + line.qty_receiving,
      0,
    );
    const remainingBeforeReceipt = Math.max(0, totalOrdered - totalPreviouslyReceived);
    const facts: { id: string; label: string; severity?: string }[] = [];

    if (detail) {
      facts.push({
        id: "receiving-context",
        label: `Receiving ${detail.po_number} for ${detail.vendor_name} (${detail.status}).`,
        severity: "info",
      });
    }
    facts.push({
      id: "receiving-units",
      label: `${totalReceivingNow} of ${remainingBeforeReceipt} remaining units are staged across ${receivingLineCount} receipt lines.`,
      severity: totalReceivingNow > 0 ? "info" : "warning",
    });
    facts.push({
      id: "receiving-history",
      label: `${totalPreviouslyReceived} of ${totalOrdered} ordered units were already received before this receipt.`,
      severity: "info",
    });
    if (receivingClosed) {
      facts.push({
        id: "receiving-closed",
        label: "This document cannot receive stock from the current state.",
        severity: "warning",
      });
    }
    if (costAlertLines.length > 0) {
      facts.push({
        id: "cost-variance",
        label: `${costAlertLines.length} receipt lines are more than 5% different from prior cost.`,
        severity: "warning",
      });
    }
    if (feedback?.type === "error" || feedback?.type === "warning") {
      facts.push({
        id: "scan-warning",
        label:
          feedback.type === "error"
            ? "Current scan warning: scanned code did not match this purchase order."
            : "Current scan warning: scanned line is already at its receiving limit.",
        severity: feedback.type === "error" ? "warning" : "info",
      });
    }
    if (invoiceMissing && totalReceivingNow > 0) {
      facts.push({
        id: "invoice-missing",
        label: "Receipt is staged without an invoice number.",
        severity: "warning",
      });
    }
    facts.push({
      id: "scan-mode",
      label: useVendorUpc
        ? "Scan matching checks vendor UPC before SKU for this vendor."
        : "Scan matching uses SKU for this vendor.",
      severity: "info",
    });

    return {
      title: "Receiving Review",
      bullets: facts,
      disclaimers: [
        "Explain visible receiving checks only. ROSIE cannot approve receiving, change quantities, or post inventory.",
      ],
    };
  }, [
    costAlertLines.length,
    detail,
    feedback,
    invoiceMissing,
    lines,
    receivingClosed,
    receivingLineCount,
    useVendorUpc,
  ]);
  const hasReceiptDraft =
    receivingLineCount > 0 ||
    scanCount > 0 ||
    freightCents > 0 ||
    invoiceNum.trim() !== "";

  const markAllRemaining = () => {
    setLines((prev) =>
      prev.map((l) => ({
        ...l,
        qty_receiving: Math.max(0, l.qty_ordered - l.qty_previously_received),
      })),
    );
  };

  const handlePost = async () => {
    if (receivingClosed || !detail) return;
    setLoading(true);
    try {
      const payloadLines = lines
        .filter((l) => l.qty_receiving > 0)
        .map((l) => ({
          po_line_id: l.line_id,
          quantity_received_now: l.qty_receiving,
        }));
      const res = await fetch(`${BASE_URL}/api/purchase-orders/${poId}/receive`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          freight_total: centsToFixed2(freightCents),
          invoice_number: invoiceNum.trim() || null,
          lines: payloadLines,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "Receive failed");
      }
      onComplete();
    } catch (err) {
      toast(
        err instanceof Error
          ? err.message
          : "We couldn't apply this receipt to inventory. Please try again.",
        "error",
      );
    } finally {
      setLoading(false);
      setShowPostConfirm(false);
    }
  };

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const canPost =
    !receivingClosed && lines.some((l) => l.qty_receiving > 0) && !loading;
  const receivingWorkflowCurrentStep: ReceivingWorkflowStep["id"] =
    receivingClosed ? "post" : canPost ? "post" : hasReceiptDraft ? "count" : "verify";
  const receivingWorkflowIndex = RECEIVING_WORKFLOW_STEPS.findIndex(
    (step) => step.id === receivingWorkflowCurrentStep,
  );

  // ── Render: Error ──────────────────────────────────────────────────────────

  if (loadError) {
    return createPortal(
      <div className="fixed inset-0 z-[100] flex flex-col bg-app-bg font-sans">
        <div className="flex items-center justify-between bg-app-text px-6 py-4 text-white">
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-2 hover:bg-white/15"
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </div>
        <div className="flex flex-1 items-center justify-center p-6">
          <div className="w-full max-w-lg rounded-3xl border border-amber-500/30 bg-app-surface p-6 text-center shadow-xl">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600">
              <AlertCircle size={26} aria-hidden />
            </div>
            <h3 className="mt-4 text-lg font-black text-app-text">
              Vendor paperwork could not open
            </h3>
            <p className="mt-2 text-sm font-semibold text-app-text-muted">
              {loadError}
            </p>
            <p className="mt-3 text-sm font-semibold text-app-text">
              Receiving has not posted any inventory from this window.
            </p>
            <p className="mt-1 text-xs leading-relaxed text-app-text-muted">
              Try again, or close this screen and reopen the vendor paperwork
              from Receive Stock.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-3">
              <button
                type="button"
                onClick={() => void loadPo()}
                className="rounded-2xl bg-app-accent px-5 py-3 text-[10px] font-black uppercase tracking-widest text-white shadow-lg shadow-app-accent/20 transition hover:brightness-110 active:scale-95"
              >
                Try again
              </button>
              <button
                type="button"
                onClick={onClose}
                className="rounded-2xl border border-app-border bg-app-surface px-5 py-3 text-[10px] font-black uppercase tracking-widest text-app-text transition hover:border-app-accent hover:text-app-accent"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </div>,
      root
    );
  }

  if (!detail) {
    return createPortal(
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 font-sans text-sm font-bold text-white">
        Loading purchase order...
      </div>,
      root
    );
  }

  // ── Render: Main ───────────────────────────────────────────────────────────

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-app-bg font-sans">
      {/* Scan feedback color bar */}
      {feedback && (
        <div
          className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-1 transition-colors ${
            feedback.type === "success" ? "bg-emerald-400" : feedback.type === "error" ? "bg-red-500" : "bg-amber-400"
          }`}
        />
      )}

      {/* ── Header ── */}
      <header className="z-10 shrink-0 bg-app-text text-white shadow-xl">
        <div className="flex items-center gap-4 px-5 py-3">
          {/* Left: Identity */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Truck size={18} className="text-emerald-400 shrink-0" />
              <h2 className="text-base font-bold truncate">Receive Stock</h2>
              <span className="text-xs font-mono text-white/60">{detail.po_number}</span>
              {useVendorUpc && (
                <span className="rounded-full bg-violet-600/30 px-2 py-0.5 text-[9px] font-bold text-violet-300">UPC Mode</span>
              )}
            </div>
            <p className="text-[10px] text-white/50 mt-0.5">
              {detail.vendor_name} · {detail.status}{detail.po_kind ? ` · ${detail.po_kind}` : ""}
            </p>
          </div>

          {/* Center: Scanner */}
          <div className="flex items-center gap-2 max-w-md flex-1">
            <div className="flex shrink-0 overflow-hidden rounded-lg border border-white/20">
              {(["laser", "camera"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setScanMode(m); warmUpAudio(); }}
                  className={`flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold uppercase transition ${
                    scanMode === m ? "bg-white/15 text-white" : "text-white/40 hover:text-white/70"
                  }`}
                >
                  {m === "laser" ? <Barcode size={12} /> : <Camera size={12} />}
                  <span className="hidden sm:inline">{m}</span>
                </button>
              ))}
            </div>
            {scanMode === "laser" && (
              <form onSubmit={(e) => e.preventDefault()} className="group relative flex-1">
                <Barcode className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-white/40 group-focus-within:text-emerald-400" size={16} />
                <input
                  ref={scannerRef}
                  value={scanInput}
                  onChange={handleScanInputChange}
                  onKeyDown={handleScanInputKeyDown}
                  disabled={receivingClosed}
                  className="w-full rounded-lg border border-white/20 bg-black/30 py-2 pl-9 pr-3 font-mono text-sm text-white placeholder:text-white/35 outline-none focus:ring-2 focus:ring-emerald-400/50 disabled:opacity-40"
                  placeholder="Scan UPC or SKU..."
                  autoComplete="off"
                />
              </form>
            )}
            {scanCount > 0 && (
              <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-bold text-emerald-400">{scanCount}</span>
            )}
          </div>

          {/* Right: Total + actions */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right">
              <p className="text-[9px] font-bold uppercase text-white/40">Total</p>
              <p className="font-mono text-2xl font-bold text-emerald-400">${centsToFixed2(grandTotalCents)}</p>
            </div>
            <button
              type="button"
              disabled={receivingClosed}
              onClick={markAllRemaining}
              className="flex items-center gap-1.5 rounded-lg border border-white/20 bg-black/30 px-3 py-2 text-[9px] font-bold uppercase text-white/70 hover:bg-white/10 disabled:opacity-30 transition-all"
            >
              <CheckSquare size={13} /> Fill All
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-white/40 hover:bg-white/10 hover:text-white transition-colors"
              aria-label="Close"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      </header>

      {/* ── Status + Workflow bar ── */}
      <div className="shrink-0 border-b border-app-border bg-app-surface px-5 py-2">
        <div className="mx-auto flex max-w-6xl items-center gap-3 text-xs">
          {/* Step indicators (compact) */}
          <div className="flex items-center gap-1">
            {RECEIVING_WORKFLOW_STEPS.map((step, index) => {
              const isCurrent = step.id === receivingWorkflowCurrentStep;
              const isComplete = receivingClosed || index < receivingWorkflowIndex;
              return (
                <div key={step.id} className="flex items-center gap-1">
                  {index > 0 && <div className="h-px w-4 bg-app-border" />}
                  <span className={`flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[9px] font-bold ${
                    isCurrent ? "bg-app-accent/10 text-app-accent border border-app-accent/20" :
                    isComplete ? "bg-emerald-50 text-emerald-700 border border-emerald-200" :
                    "bg-app-surface-2 text-app-text-muted border border-app-border"
                  }`}>
                    {isComplete && <CheckCircle size={10} />}
                    {step.label}
                  </span>
                </div>
              );
            })}
          </div>
          <div className="h-4 w-px bg-app-border" />
          <span className={`rounded-lg px-2 py-0.5 text-[9px] font-bold ${
            canPost ? "bg-emerald-50 text-emerald-700 border border-emerald-200" : "bg-app-surface-2 text-app-text-muted border border-app-border"
          }`}>
            {receivingLineCount} line{receivingLineCount === 1 ? "" : "s"} staged
          </span>
          <RosieInsightSummary
            surface="receiving_review"
            title="Receiving Review"
            mode="explain"
            getHeaders={apiAuth}
            facts={receivingInsightFacts}
            className="mt-0 ml-auto"
          />
        </div>
      </div>

      {/* Camera scanner overlay */}
      {scanMode === "camera" && !receivingClosed && (
        <CameraScanner label="Receive Stock - Camera Scan" onScan={handleCameraScan} onClose={() => setScanMode("laser")} />
      )}

      {/* Feedback banner */}
      {feedback && (
        <div className={`flex items-center gap-2 px-5 py-2 text-xs font-bold ${
          feedback.type === "success" ? "border-b border-emerald-200 bg-emerald-50 text-emerald-800" :
          feedback.type === "error" ? "border-b border-red-200 bg-red-50 text-red-800" :
          "border-b border-amber-200 bg-amber-50 text-amber-800"
        }`}>
          {feedback.type === "success" ? <CheckCircle size={14} className="shrink-0" /> : <AlertCircle size={14} className="shrink-0" />}
          {feedback.message}
        </div>
      )}

      {/* Closed warning */}
      {receivingClosed && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-bold text-amber-900">
          <AlertCircle size={14} className="shrink-0" />
          This PO cannot be received — standard drafts must be submitted first, or use a direct invoice.
        </div>
      )}

      {/* Cost alert */}
      {!receivingClosed && costAlertLines.length > 0 && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs font-bold text-amber-900">
          <AlertCircle size={14} className="shrink-0" />
          {costAlertLines.length} line{costAlertLines.length === 1 ? " has" : "s have"} cost variance &gt;5%: {costAlertLines.slice(0, 3).map((l) => l.sku).join(", ")}{costAlertLines.length > 3 ? ", …" : ""}
        </div>
      )}

      {/* ── Line Table ── */}
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:px-6">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-2xl border border-app-border bg-app-surface shadow-sm">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-app-border bg-app-surface-2/60">
              <tr>
                <th className="px-5 py-3 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Item</th>
                <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Ordered</th>
                <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-app-text-muted bg-app-accent-2/10">Prior Rcvd</th>
                <th className="px-4 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-app-accent-2 bg-app-accent-2/10">Receiving</th>
                <th className="px-4 py-3 text-right text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Unit Cost</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/40">
              {lines.map((line) => {
                const remaining = Math.max(0, line.qty_ordered - line.qty_previously_received);
                const hasCostAlert = unitCostAlerts(line.prior_effective_cost, line.unit_cost);
                return (
                  <tr key={line.line_id} className="transition-colors hover:bg-app-surface-2/30">
                    <td className="px-5 py-3">
                      <p className="text-xs font-bold text-app-text">{line.product_name}</p>
                      <p className="text-[10px] text-app-text-muted">
                        {line.subtitle} · <span className="font-mono">{line.sku}</span>
                        {useVendorUpc && line.vendor_upc && <span className="ml-1 text-violet-500">UPC: {line.vendor_upc}</span>}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-app-text-muted">{line.qty_ordered}</td>
                    <td className="px-4 py-3 text-center font-bold text-app-text-muted bg-app-accent-2/5">{line.qty_previously_received}</td>
                    <td className="px-4 py-3 bg-app-accent-2/5">
                      <input
                        type="number"
                        min={0}
                        max={remaining}
                        value={line.qty_receiving || ""}
                        disabled={receivingClosed}
                        onChange={(e) => {
                          const raw = Number.parseInt(e.target.value || "0", 10);
                          const val = Number.isFinite(raw) ? Math.min(Math.max(0, raw), remaining) : 0;
                          setLines((prev) => prev.map((l) => l.line_id === line.line_id ? { ...l, qty_receiving: val } : l));
                        }}
                        className="mx-auto block w-16 rounded-lg border-2 border-app-border p-1.5 text-center text-sm font-bold text-app-accent-2 outline-none focus:border-app-accent-2 disabled:opacity-40"
                      />
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className={`text-sm font-bold tabular-nums ${hasCostAlert ? "text-amber-600" : "text-app-text"}`}>
                        ${line.unit_cost.toFixed(2)}
                      </span>
                      {line.prior_effective_cost > 0 && (
                        <p className="text-[9px] text-app-text-muted">was ${line.prior_effective_cost.toFixed(2)}</p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Footer ── */}
      <footer className="shrink-0 border-t border-app-border bg-app-surface px-5 py-4 shadow-[0_-8px_24px_rgba(0,0,0,0.06)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-4">
          {/* Invoice & freight inputs */}
          <div className="flex flex-wrap gap-3 flex-1">
            <div className="min-w-[180px] space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Invoice #</label>
              <input
                type="text"
                value={invoiceNum}
                disabled={receivingClosed}
                onChange={(e) => setInvoiceNum(e.target.value)}
                className="ui-input h-10 w-full text-sm font-bold"
                placeholder="From paperwork..."
              />
            </div>
            <div className="w-[130px] space-y-1">
              <label className="text-[10px] font-bold uppercase tracking-wider text-app-text-muted ml-1">Freight ($)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted/40">$</span>
                <input
                  type="text"
                  value={freight}
                  disabled={receivingClosed}
                  onChange={(e) => setFreight(e.target.value)}
                  className="ui-input h-10 w-full pl-7 font-mono text-sm font-bold"
                />
              </div>
            </div>
            {/* QBO status (compact) */}
            <div className="flex items-end gap-2 text-[9px] font-bold text-app-text-muted pb-2">
              <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0 mb-0.5" />
              <span>{invGlLabel}</span>
              {glanceUnavailable && <AlertCircle size={10} className="text-amber-500" />}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-10 rounded-xl border border-app-border bg-app-surface-2 px-5 text-xs font-bold text-app-text-muted hover:text-app-text transition-all"
            >
              Close
            </button>
            <button
              type="button"
              disabled={!canPost}
              onClick={() => setShowPostConfirm(true)}
              className="flex items-center gap-2 h-10 rounded-xl bg-emerald-600 px-6 text-xs font-bold text-white shadow-lg shadow-emerald-500/20 hover:brightness-110 active:scale-95 disabled:opacity-30 transition-all"
            >
              {loading ? (
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              ) : (
                <ShieldCheck size={16} />
              )}
              Post Receipt
            </button>
          </div>
        </div>
      </footer>

      {showPostConfirm && (
        <ConfirmationModal
          isOpen={true}
          title={invoiceMissing ? "Post Without Invoice Number?" : "Finalize Inventory Receipt?"}
          message={
            invoiceMissing
              ? `No invoice number entered. This will add stock and post $${centsToFixed2(grandTotalCents)} to QBO.`
              : `This will add stock and post $${centsToFixed2(grandTotalCents)} to QBO. This action is audit-tracked.`
          }
          confirmLabel={invoiceMissing ? "Post Without Invoice" : "Confirm & Post"}
          onConfirm={() => void handlePost()}
          onClose={() => setShowPostConfirm(false)}
        />
      )}
    </div>,
    root
  );
}
