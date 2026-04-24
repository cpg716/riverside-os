import { getBaseUrl } from "../../lib/apiConfig";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  Barcode,
  Camera,
  CheckCircle,
  CheckSquare,
  Landmark,
  Save,
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
  const [freightGlLabel, setFreightGlLabel] = useState("COGS_FREIGHT · not mapped");
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
    const h = apiAuth();
    const [accRes, mapRes] = await Promise.all([
      fetch(`${BASE_URL}/api/qbo/accounts-cache`, { headers: h }),
      fetch(`${BASE_URL}/api/qbo/mappings`, { headers: h }),
    ]);
    if (!accRes.ok || !mapRes.ok) return;
    const accounts = (await accRes.json()) as { id: string; name: string }[];
    const mappings = (await mapRes.json()) as { internal_key: string; qbo_account_id: string | null }[];
    const byId = new Map(accounts.map((a) => [a.id, a.name]));
    const invId = mappings.find((m) => m.internal_key === "INV_ASSET")?.qbo_account_id;
    const frId = mappings.find((m) => m.internal_key === "COGS_FREIGHT")?.qbo_account_id;
    if (invId && byId.has(invId)) setInvGlLabel(byId.get(invId)!);
    if (frId && byId.has(frId)) setFreightGlLabel(byId.get(frId)!);
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
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load PO");
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

  const canPost =
    !receivingClosed && lines.some((l) => l.qty_receiving > 0) && !loading;
  const receivingWorkflowCurrentStep: ReceivingWorkflowStep["id"] =
    receivingClosed ? "post" : canPost ? "post" : hasReceiptDraft ? "count" : "verify";
  const receivingWorkflowIndex = RECEIVING_WORKFLOW_STEPS.findIndex(
    (step) => step.id === receivingWorkflowCurrentStep,
  );
  const receivingWorkflowNextStep =
    !receivingClosed && receivingWorkflowIndex < RECEIVING_WORKFLOW_STEPS.length - 1
      ? RECEIVING_WORKFLOW_STEPS[receivingWorkflowIndex + 1]
      : null;

  // ── Render: Error ──────────────────────────────────────────────────────────

  if (loadError) {
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-app-bg font-sans">
        <div className="flex items-center justify-between bg-app-text px-6 py-4 text-white">
          <p className="text-sm font-bold text-red-300">{loadError}</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 hover:bg-white/15"
            aria-label="Close"
          >
            <X size={22} />
          </button>
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 font-sans text-sm font-bold text-white">
        Loading purchase order...
      </div>
    );
  }

  // ── Render: Main ───────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-app-bg font-sans">
      {/* Scan feedback overlay */}
      {feedback && (
        <div
          className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-1.5 transition-colors ${
            feedback.type === "success"
              ? "bg-emerald-400"
              : feedback.type === "error"
                ? "bg-red-500"
                : "bg-amber-400"
          }`}
        />
      )}

      <header className="z-10 flex shrink-0 items-center justify-between bg-app-text p-4 sm:p-6 text-white shadow-xl">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4 sm:gap-6">
          <div className="flex min-w-0 flex-col">
            <div className="flex items-center gap-3">
              <h2 className="text-xl font-black uppercase italic tracking-tighter">
                Receiving Bay
              </h2>
              {useVendorUpc && (
                <span className="rounded-full bg-violet-600/30 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-violet-300">
                  Vendor UPC
                </span>
              )}
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
                aria-label="Close receiving"
              >
                <X size={20} />
              </button>
            </div>
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/55">
              Verify invoice · {detail.po_number} · {detail.vendor_name} ·{" "}
              <span className="text-white/75">{detail.status}</span>
              {detail.po_kind && (
                <>
                  {" "}
                  ·{" "}
                  <span className="text-app-accent">{detail.po_kind}</span>
                </>
              )}
            </p>
          </div>

          {/* Scan mode toggle + input */}
          <div className="flex flex-1 items-center gap-3 max-w-md">
            {/* Mode Toggle */}
            <div className="flex shrink-0 overflow-hidden rounded-xl border border-white/20">
              {(["laser", "camera"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setScanMode(m); warmUpAudio(); }}
                  className={`flex items-center gap-1.5 px-3 py-2 text-[10px] font-black uppercase tracking-widest transition ${
                    scanMode === m
                      ? "bg-white/10 text-white"
                      : "text-white/45 hover:text-white/85"
                  }`}
                >
                  {m === "laser" ? <Barcode size={13} /> : <Camera size={13} />}
                  <span className="hidden sm:inline">{m}</span>
                </button>
              ))}
            </div>

            {/* Hidden laser scan input (always present for HID focus) */}
            {scanMode === "laser" && (
              <form
                onSubmit={(e) => { e.preventDefault(); }}
                className="group relative flex-1"
              >
                <Barcode
                  className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-white/45 transition-colors group-focus-within:text-app-accent-2"
                  size={18}
                />
                <input
                  ref={scannerRef}
                  value={scanInput}
                  onChange={handleScanInputChange}
                  onKeyDown={handleScanInputKeyDown}
                  disabled={receivingClosed}
                  className="w-full rounded-xl border border-white/20 bg-black/30 py-2.5 pl-9 pr-4 font-mono text-sm text-white placeholder:text-white/40 outline-none transition-all focus:ring-2 focus:ring-app-accent-2 disabled:opacity-50"
                  placeholder="Scan UPC or SKU…"
                  autoComplete="off"
                />
              </form>
            )}

            {/* Scan count pill */}
            {scanCount > 0 && (
              <span className="shrink-0 rounded-full bg-emerald-500/20 px-2.5 py-1 text-[10px] font-black text-emerald-400">
                {scanCount} scanned
              </span>
            )}
          </div>
        </div>

        <div className="mt-4 flex shrink-0 flex-wrap items-center gap-6 border-white/20 pl-0 lg:mt-0 lg:border-l lg:pl-10">
          <div className="text-right">
            <p className="text-[10px] font-black uppercase text-white/50">
              Est. invoice grand total
            </p>
            <p className="font-mono text-3xl font-black text-emerald-400">
              ${centsToFixed2(grandTotalCents)}
            </p>
          </div>
          <button
            type="button"
            disabled={receivingClosed}
            onClick={markAllRemaining}
            className="flex items-center gap-2 rounded-xl border border-white/25 bg-black/35 px-4 py-2.5 text-[10px] font-black uppercase tracking-widest text-white shadow-sm transition-all hover:bg-white/10 disabled:opacity-40"
          >
            <CheckSquare size={14} /> Mark all remaining
          </button>
        </div>
      </header>

      {/* Camera scanner overlay */}
      {scanMode === "camera" && !receivingClosed && (
        <CameraScanner
          label="Receiving Bay — Camera Scan"
          onScan={handleCameraScan}
          onClose={() => setScanMode("laser")}
        />
      )}

      {/* Scan feedback banner */}
      {feedback && (
        <div
          className={`flex items-center gap-3 px-6 py-2.5 text-xs font-black transition-all ${
            feedback.type === "success"
              ? "border-b border-emerald-200 bg-emerald-50 text-emerald-800"
              : feedback.type === "error"
                ? "border-b border-red-200 bg-red-50 text-red-800"
                : "border-b border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          {feedback.type === "success" ? (
            <CheckCircle size={15} className="shrink-0" />
          ) : (
            <AlertCircle size={15} className="shrink-0" />
          )}
          {feedback.message}
        </div>
      )}

      {receivingClosed && (
        <div className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-6 py-2 text-xs font-bold text-amber-900">
          <AlertCircle size={16} className="shrink-0" />
          This PO cannot be received (standard drafts must be submitted first,
          or open a direct invoice draft).
        </div>
      )}

      {!receivingClosed && costAlertLines.length > 0 && (
        <div className="border-b border-amber-200 bg-amber-50 px-6 py-3 text-xs text-amber-950">
          <div className="flex items-start gap-2">
            <AlertCircle size={16} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-black uppercase tracking-widest">
                Cost change to review before posting
              </p>
              <p className="mt-1 font-semibold leading-relaxed">
                {costAlertLines.length === 1
                    ? "One line is more than 5% different from its prior cost."
                  : `${costAlertLines.length} lines are more than 5% different from their prior costs.`}{" "}
                Posting will use the invoice cost shown here for receipt valuation and downstream accounting.
              </p>
              <p className="mt-2 font-semibold leading-relaxed">
                Review the highlighted unit cost rows before you finalize this receipt:
                {" "}
                {costAlertLines
                  .slice(0, 3)
                  .map((line) => line.sku)
                  .join(", ")}
                {costAlertLines.length > 3 ? ", …" : ""}
              </p>
            </div>
          </div>
        </div>
      )}

      <div className="border-b border-app-border bg-app-surface px-4 py-4 sm:px-6">
        <div className="mx-auto flex max-w-6xl flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-3">
            {RECEIVING_WORKFLOW_STEPS.map((step, index) => {
              const isCurrent = step.id === receivingWorkflowCurrentStep;
              const isComplete =
                receivingClosed || index < receivingWorkflowIndex;
              return (
                <div
                  key={step.id}
                  className={`min-w-[10rem] rounded-2xl border px-4 py-3 ${
                    isCurrent
                      ? "border-app-accent bg-app-accent/10 text-app-text"
                      : isComplete
                        ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                        : "border-app-border bg-app-surface-2 text-app-text-muted"
                  }`}
                >
                  <p className="text-[10px] font-black uppercase tracking-widest opacity-75">
                    Step {index + 1}
                  </p>
                  <p className="mt-1 text-sm font-black text-current">
                    {step.label}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed opacity-80">
                    {step.hint}
                  </p>
                </div>
              );
            })}
          </div>
          <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 text-sm text-app-text lg:max-w-sm">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Current stage
            </p>
            <p className="mt-1 font-black text-app-text">
              {RECEIVING_WORKFLOW_STEPS[receivingWorkflowIndex]?.label}
            </p>
            <p className="mt-1 text-xs leading-relaxed text-app-text-muted">
              {receivingClosed
                ? "This receipt is already posted. Reopen the PO workflow elsewhere if another action is needed."
                : receivingWorkflowNextStep
                  ? `Next: ${receivingWorkflowNextStep.label}. ${receivingWorkflowNextStep.hint}`
                  : "Next: Post inventory when the staged receipt matches the invoice in hand."}
            </p>
            {!receivingClosed ? (
              <p className="mt-2 text-[11px] font-semibold text-app-text-muted">
                {receivingLineCount > 0
                  ? `${receivingLineCount} line${receivingLineCount === 1 ? "" : "s"} staged for this receipt.`
                  : "No lines staged yet."}
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-8">
        <div className="mx-auto max-w-6xl overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-sm">
          <table className="w-full text-left">
            <thead className="border-b border-app-border bg-app-surface-2">
              <tr>
                <th className="px-6 py-4 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Item description
                </th>
                <th className="px-6 py-4 text-center text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Ordered
                </th>
                <th className="bg-app-accent-2/15 px-6 py-4 text-center text-[10px] font-black uppercase tracking-widest text-app-accent-2">
                  Prev. recv.
                </th>
                <th className="bg-app-accent-2/15 px-6 py-4 text-center text-[10px] font-black uppercase tracking-widest text-app-accent-2">
                  Receiving now
                </th>
                <th className="px-6 py-4 text-right text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Invoice unit
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border">
              {lines.map((line) => (
                <tr
                  key={line.line_id}
                  className="transition-colors hover:bg-app-surface-2/50"
                >
                  <td className="px-6 py-4">
                    <div className="text-sm font-black uppercase tracking-tight text-app-text">
                      {line.product_name}
                    </div>
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-app-text-muted">
                      {line.subtitle}{" "}
                      <span className="ml-2 font-mono">{line.sku}</span>
                      {useVendorUpc && line.vendor_upc && (
                        <span className="ml-2 text-violet-500">[UPC: {line.vendor_upc}]</span>
                      )}
                    </div>
                  </td>
                  <td className="px-6 py-4 text-center font-bold text-app-text-muted">
                    {line.qty_ordered}
                  </td>
                  <td className="bg-app-accent-2/10 px-6 py-4 text-center font-bold text-app-text-muted">
                    {line.qty_previously_received}
                  </td>
                  <td className="bg-app-accent-2/10 px-6 py-4">
                    <input
                      type="number"
                      min={0}
                      max={Math.max(0, line.qty_ordered - line.qty_previously_received)}
                      value={line.qty_receiving || ""}
                      disabled={receivingClosed}
                      onChange={(e) => {
                        const raw = Number.parseInt(e.target.value || "0", 10);
                        const cap = Math.max(0, line.qty_ordered - line.qty_previously_received);
                        const val = Number.isFinite(raw) ? Math.min(Math.max(0, raw), cap) : 0;
                        setLines((prev) =>
                          prev.map((l) =>
                            l.line_id === line.line_id ? { ...l, qty_receiving: val } : l,
                          ),
                        );
                      }}
                      className="mx-auto block w-20 rounded-xl border-2 border-app-border p-2 text-center font-black text-app-accent-2 outline-none transition-all focus:border-app-accent-2 disabled:opacity-50"
                    />
                  </td>
                  <td
                    className={`px-6 py-4 text-right font-mono text-sm ${
                      unitCostAlerts(line.prior_effective_cost, line.unit_cost)
                        ? "bg-app-accent/15 text-app-text shadow-[inset_0_0_0_2px_color-mix(in_srgb,var(--app-accent)_45%,transparent)]"
                        : "text-app-text-muted"
                    }`}
                    title={
                      line.prior_effective_cost > 0
                        ? `Prior effective (WAC path): $${centsToFixed2(parseMoneyToCents(line.prior_effective_cost))}`
                        : undefined
                    }
                  >
                    ${centsToFixed2(parseMoneyToCents(line.unit_cost))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <footer className="shrink-0 border-t-2 border-app-border bg-app-surface p-4 sm:p-8 shadow-2xl">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-8 lg:flex-nowrap">
          <div className="w-full lg:w-1/4">
            <label className="mb-2 flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <Truck size={14} className="text-app-accent-2" /> Inbound freight (invoice)
            </label>
            <div className="relative">
              <span className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 font-black text-app-text-muted">
                $
              </span>
              <input
                type="text"
                inputMode="decimal"
                disabled={receivingClosed}
                value={freight}
                onChange={(e) => setFreight(e.target.value)}
                className="w-full rounded-2xl border border-app-border bg-app-surface-2 py-4 pl-8 pr-4 text-2xl font-black text-app-text outline-none focus:ring-2 focus:ring-app-accent-2 disabled:opacity-50"
              />
            </div>
            <label className="mt-3 mb-1 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Vendor invoice #
            </label>
            <input
              type="text"
              disabled={receivingClosed}
              value={invoiceNum}
              onChange={(e) => setInvoiceNum(e.target.value)}
              className="w-full rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-sm font-bold text-app-text outline-none disabled:opacity-50"
            />
          </div>

          <div className="flex-1 rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <div className="mb-4 flex items-center justify-between">
              <span className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Landmark size={14} /> Routing rules (QBO)
              </span>
              <div className="flex items-center gap-1 rounded bg-app-accent-2/15 px-2 py-0.5 text-[9px] font-bold uppercase text-app-accent-2">
                <ShieldCheck size={10} /> COGS_FREIGHT on receipt
              </div>
            </div>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[9px] font-bold uppercase text-app-text-muted">
                  Inventory (asset / receive)
                </p>
                <p className="text-xs font-black tracking-tight text-app-text">
                  {invGlLabel}
                </p>
              </div>
              <div>
                <p className="mb-1 text-[9px] font-bold uppercase text-app-text-muted">
                  Inbound freight GL
                </p>
                <p className="text-xs font-black tracking-tight text-app-accent-2">
                  {freightGlLabel}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void refreshGlance()}
              className="mt-3 text-[10px] font-bold uppercase tracking-widest text-app-text-muted hover:text-app-accent-2"
            >
              Refresh mapping labels
            </button>
          </div>

          <button
            type="button"
            onClick={() => setShowPostConfirm(true)}
            disabled={!canPost}
            className="flex h-[84px] shrink-0 items-center gap-4 rounded-3xl border-b-8 border-emerald-800 bg-emerald-600 px-12 text-lg font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-900/25 transition-all hover:brightness-110 active:translate-y-0.5 active:border-b-4 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Save size={24} /> {loading ? "Updating…" : "Post inventory"}
          </button>
        </div>
      </footer>

      <ConfirmationModal
        isOpen={showPostConfirm}
        onClose={() => setShowPostConfirm(false)}
        onConfirm={handlePost}
        title="Post Inventory"
        message={`Are you sure you want to post this receipt? This will adjust stock levels for ${lines.filter(l => l.qty_receiving > 0).length} items and finalize the invoice. This action cannot be reversed.`}
        confirmLabel={loading ? "Posting..." : "Confirm & Post"}
        variant="success"
      />
    </div>
  );
}
