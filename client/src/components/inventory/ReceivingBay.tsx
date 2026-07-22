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
  Plus,
  ShieldCheck,
  Truck,
  X,
} from "lucide-react";
import CameraScanner from "./CameraScanner";
import QuickProcurementItemModal from "./QuickProcurementItemModal";
import VariantSearchInput, { VariantSearchResult } from "../ui/VariantSearchInput";
import { playScanSuccess, playScanError, playScanWarning, warmUpAudio } from "../../lib/scanSounds";
import { useToast } from "../ui/ToastProviderLogic";
import ConfirmationModal from "../ui/ConfirmationModal";
import ReceivingReport from "./ReceivingReport";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { openExternalUrl } from "../../lib/desktopFileBridge";
import { fetchWithTimeout } from "../../lib/api";
import RosieInsightSummary from "../help/RosieInsightSummary";
import { stageReceivingVariantScan } from "./receivingLineMatcher";

const BASE_URL = getBaseUrl();
const RECEIVING_LOOKUP_TIMEOUT_MS = 8_000;

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
  barcode?: string | null;
  vendor_upc?: string | null;
  product_catalog_handle?: string | null;
  product_name: string;
  variation_label: string | null;
  variation_values: Record<string, unknown>;
  qty_ordered: number;
  qty_previously_received: number;
  unit_cost: string | number;
  prior_effective_cost?: string | number;
}

export type LineReceiveStatus = "received" | "backordered" | "not_shipped" | "";

export interface WorksheetLine {
  line_id: string;
  variant_id: string;
  sku: string;
  barcode: string | null;
  vendor_upc: string | null;
  product_catalog_handle: string | null;
  product_name: string;
  subtitle: string;
  qty_ordered: number;
  qty_previously_received: number;
  qty_receiving: number;
  unit_cost: number;
  prior_effective_cost: number;
  line_status: LineReceiveStatus;
}

type ScanMode = "laser" | "camera";

interface ScanFeedback {
  type: "success" | "warning" | "error";
  message: string;
}

interface ExactVariantScanResult {
  product_id: string;
  variant_id: string;
  sku: string;
  name: string;
  variation_label?: string | null;
  standard_retail_price?: string | number;
  unit_cost?: string | number;
  resolution_kind?:
    | "variant_id"
    | "sku"
    | "barcode"
    | "barcode_alias"
    | "catalog_handle"
    | "vendor_upc"
    | "product_name";
}

type VariantCodeLookup =
  | { kind: "exact"; variant: VariantSearchResult }
  | { kind: "ambiguous" }
  | { kind: "name_only" }
  | { kind: "not_found" }
  | { kind: "unavailable" };

// ── Utilities ─────────────────────────────────────────────────────────────────

function toNumberCost(v: string | number | undefined): number {
  return parseMoneyToCents(v) / 100;
}

function variantMoneyInput(value: string | number | null | undefined): string {
  if (typeof value === "number") {
    return value > 1000 ? (value / 100).toFixed(2) : value.toFixed(2);
  }
  return centsToFixed2(parseMoneyToCents(value ?? "0"));
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
    barcode: l.barcode ?? null,
    vendor_upc: l.vendor_upc ?? null,
    product_catalog_handle: l.product_catalog_handle ?? null,
    product_name: l.product_name,
    subtitle,
    qty_ordered: l.qty_ordered,
    qty_previously_received: l.qty_previously_received,
    qty_receiving: 0,
    unit_cost: toNumberCost(l.unit_cost),
    prior_effective_cost: toNumberCost(l.prior_effective_cost),
    line_status: "",
  };
}

function effectiveCatalogNumber(line: {
  vendor_upc?: string | null;
  product_catalog_handle?: string | null;
}): string | null {
  return line.vendor_upc?.trim() || line.product_catalog_handle?.trim() || null;
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
  onOpenAddItem?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ReceivingBay({ poId, onComplete, onClose, onOpenAddItem }: Props) {
  const { backofficeHeaders } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [detail, setDetail] = useState<PurchaseOrderDetail | null>(null);
  const [lines, setLines] = useState<WorksheetLine[]>([]);
  const [scanInput, setScanInput] = useState("");
  const [selectedVariant, setSelectedVariant] = useState<VariantSearchResult | null>(null);
  const [entryQty, setEntryQty] = useState(1);
  const [entryCost, setEntryCost] = useState("0.00");
  const [entryRetail, setEntryRetail] = useState("0.00");
  const [lineBusy, setLineBusy] = useState(false);
  const [quickItemOpen, setQuickItemOpen] = useState(false);
  const [quickItemSeedSku, setQuickItemSeedSku] = useState("");
  const [lineSaveBusy, setLineSaveBusy] = useState<string | null>(null);
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
  const [postedReceivingEventId, setPostedReceivingEventId] = useState<string | null>(null);
  const { toast } = useToast();
  const scannerRef = useRef<HTMLInputElement>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoReceiveAfterLoadRef = useRef<{ lineId: string; qty: number } | null>(null);
  const linesRef = useRef<WorksheetLine[]>([]);
  const activePoIdRef = useRef(poId);
  const scanQueueRef = useRef<Promise<void>>(Promise.resolve());
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
      setLines((prev) => {
        const merged = mergeWorksheetLines(data.lines, prev);
        const autoReceive = autoReceiveAfterLoadRef.current;
        if (!autoReceive) {
          linesRef.current = merged;
          return merged;
        }
        autoReceiveAfterLoadRef.current = null;
        const next = merged.map((line) => {
          if (line.line_id !== autoReceive.lineId) return line;
          const remaining = Math.max(0, line.qty_ordered - line.qty_previously_received);
          return {
            ...line,
            qty_receiving: Math.min(Math.max(autoReceive.qty, 0), remaining),
            line_status: "received" as const,
          };
        });
        linesRef.current = next;
        return next;
      });

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
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    activePoIdRef.current = poId;
    scanQueueRef.current = Promise.resolve();
  }, [poId]);

  useEffect(() => {
    if (scanMode === "laser") {
      scannerRef.current?.focus();
    }
  }, [lines.length, detail?.id, scanMode]);

  // ── Scan matching ──────────────────────────────────────────────────────────

  const canAddInvoiceLines =
    !!detail &&
    detail.status !== "closed" &&
    detail.status !== "cancelled" &&
    (detail.po_kind === "direct_invoice" || detail.status !== "draft");

  const selectEntryVariant = useCallback((variant: VariantSearchResult) => {
    setSelectedVariant(variant);
    setEntryCost(variantMoneyInput(variant.cost_price));
    setEntryRetail(variantMoneyInput(variant.retail_price));
  }, []);

  const updateUnpostedLine = useCallback(
    async (line: WorksheetLine, updates: { quantityOrdered?: number; unitCost?: number }) => {
      const quantityOrdered = updates.quantityOrdered ?? line.qty_ordered;
      const unitCost = updates.unitCost ?? line.unit_cost;
      if (quantityOrdered < line.qty_previously_received || quantityOrdered <= 0) {
        toast("Ordered quantity must stay above received quantity.", "error");
        return;
      }
      if (unitCost < 0) {
        toast("Unit cost must be zero or higher.", "error");
        return;
      }
      setLineSaveBusy(line.line_id);
      try {
        const body: { quantity_ordered?: number; unit_cost?: string } = {};
        if (updates.quantityOrdered !== undefined) body.quantity_ordered = quantityOrdered;
        if (updates.unitCost !== undefined) body.unit_cost = centsToFixed2(Math.round(unitCost * 100));
        const res = await fetch(`${BASE_URL}/api/purchase-orders/${poId}/lines/${line.line_id}`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...apiAuth(),
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "Line could not be updated.");
        }
        setLines((prev) =>
          prev.map((row) =>
            row.line_id === line.line_id
              ? {
                  ...row,
                  qty_ordered: updates.quantityOrdered ?? row.qty_ordered,
                  qty_receiving: Math.min(
                    row.qty_receiving,
                    Math.max(0, (updates.quantityOrdered ?? row.qty_ordered) - row.qty_previously_received),
                  ),
                  unit_cost: updates.unitCost ?? row.unit_cost,
                }
              : row,
          ),
        );
      } catch (error) {
        toast(error instanceof Error ? error.message : "Line could not be updated.", "error");
      } finally {
        setLineSaveBusy(null);
      }
    },
    [apiAuth, poId, toast],
  );

  const lookupVariantByCode = useCallback(
    async (code: string): Promise<VariantCodeLookup> => {
      const trimmed = code.trim();
      if (trimmed.length < 2) return { kind: "not_found" };
      try {
        const headers = apiAuth();
        if (!detail?.vendor_id) return { kind: "unavailable" };
        const params = new URLSearchParams({
          code: trimmed,
          vendor_id: detail.vendor_id,
          purchase_order_id: poId,
        });
        const scanRes = await fetchWithTimeout(
          `${BASE_URL}/api/inventory/receiving-scan-resolve?${params}`,
          { headers },
          RECEIVING_LOOKUP_TIMEOUT_MS,
        );
        if (scanRes.ok) {
          const exact = (await scanRes.json()) as ExactVariantScanResult;
          const exactIdentifierMatch =
            exact.resolution_kind != null
              ? exact.resolution_kind !== "product_name"
              : exact.sku.toLowerCase() === trimmed.toLowerCase();
          if (!exactIdentifierMatch) return { kind: "name_only" };
          return {
            kind: "exact",
            variant: {
              product_id: exact.product_id,
              variant_id: exact.variant_id,
              sku: exact.sku,
              product_name: exact.name,
              variation_label: exact.variation_label,
              retail_price: exact.standard_retail_price,
              cost_price: exact.unit_cost,
            },
          };
        }
        if (scanRes.status === 400) return { kind: "ambiguous" };
        if (scanRes.status !== 404) return { kind: "unavailable" };

        // The server exact resolver is the only authority for automatic selection.
        // A fuzzy result may guide staff to the picker, but never proves uniqueness.
        const res = await fetchWithTimeout(
          `${BASE_URL}/api/products/control-board?search=${encodeURIComponent(trimmed)}&limit=8`,
          { headers },
          RECEIVING_LOOKUP_TIMEOUT_MS,
        );
        if (!res.ok) return { kind: "unavailable" };
        const data = (await res.json()) as { rows?: VariantSearchResult[] };
        const rows = Array.isArray(data.rows) ? data.rows : [];
        return { kind: rows.length > 0 ? "name_only" : "not_found" };
      } catch {
        return { kind: "unavailable" };
      }
    },
    [apiAuth, detail?.vendor_id, poId],
  );

  const processScan = useCallback(
    async (code: string) => {
      const sku = code.trim();
      if (!sku) return;

      const lookup = await lookupVariantByCode(sku);
      if (activePoIdRef.current !== poId) return;
      if (lookup.kind === "unavailable") {
        playScanError();
        showFeedback({
          type: "error",
          message: "Item lookup is unavailable. Nothing was selected or changed.",
        });
        return;
      }
      if (lookup.kind === "ambiguous") {
        playScanError();
        showFeedback({
          type: "error",
          message: "That identifier matches multiple variations. Use the item picker; nothing was selected.",
        });
        return;
      }
      if (lookup.kind === "name_only") {
        playScanWarning();
        showFeedback({
          type: "warning",
          message: "Similar items were found, but the code is not one unique exact identifier. Use the item picker.",
        });
        return;
      }
      if (lookup.kind === "not_found") {
        if (canAddInvoiceLines) {
          setQuickItemSeedSku(sku);
        }
        playScanError();
        showFeedback({ type: "error", message: canAddInvoiceLines ? `SKU not found. Use Quick Add Item to create ${sku}.` : `Not on this purchase order: ${sku}` });
        return;
      }

      const staged = stageReceivingVariantScan(linesRef.current, lookup.variant.variant_id);
      if (staged.status === "ambiguous") {
        playScanError();
        showFeedback({
          type: "error",
          message: "That variation appears on more than one purchase-order line. Choose the intended line manually; nothing changed.",
        });
        return;
      }
      if (staged.status === "not_found") {
        if (canAddInvoiceLines) {
          selectEntryVariant(lookup.variant);
          playScanWarning();
          showFeedback({ type: "warning", message: `${lookup.variant.product_name} found. Confirm qty, cost, and retail, then Add Line.` });
        } else {
          playScanError();
          showFeedback({ type: "error", message: `Not on this purchase order: ${sku}` });
        }
        return;
      }
      if (staged.status === "at_limit") {
        playScanWarning();
        showFeedback({
          type: "warning",
          message: `${staged.line?.product_name ?? lookup.variant.product_name} already at max qty`,
        });
        return;
      }

      const line = staged.line;
      if (!line) return;
      linesRef.current = staged.lines;
      setLines(staged.lines);
      setScanCount((c) => c + 1);
      playScanSuccess();
      showFeedback({ type: "success", message: `${line.product_name} · ${line.qty_receiving} received` });
    },
    [canAddInvoiceLines, lookupVariantByCode, poId, selectEntryVariant, showFeedback],
  );

  const enqueueScan = useCallback(
    (code: string) => {
      const run = () => processScan(code);
      const queued = scanQueueRef.current.then(run, run);
      scanQueueRef.current = queued.catch(() => undefined);
    },
    [processScan],
  );

  // ── HID scanner detection in the dedicated scan input ─────────────────────

  const handleScanInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const code = scanInput.trim();
      if (!code) return;

      enqueueScan(code);
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
    (code: string) => enqueueScan(code),
    [enqueueScan],
  );

  const addInvoiceLine = useCallback(async () => {
    if (!selectedVariant || !canAddInvoiceLines) return;
    if (entryQty <= 0) {
      toast("Quantity must be greater than zero.", "error");
      return;
    }
    const costCents = parseMoneyToCents(entryCost);
    const retailCents = parseMoneyToCents(entryRetail);
    if (costCents < 0 || retailCents < 0) {
      toast("Cost and retail must be non-negative.", "error");
      return;
    }
    setLineBusy(true);
    try {
      const currentRetailCents = parseMoneyToCents(variantMoneyInput(selectedVariant.retail_price));
      const retailNeedsUpdate = currentRetailCents !== retailCents;
      const res = await fetch(`${BASE_URL}/api/purchase-orders/${poId}/lines`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          variant_id: selectedVariant.variant_id,
          quantity_ordered: entryQty,
          unit_cost: centsToFixed2(costCents),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not add invoice line.");
      }
      const addedLine = (await res.json()) as { line_id?: string };
      if (!addedLine.line_id) {
        await loadPo();
        throw new Error("Invoice line was added, but its exact line could not be staged automatically.");
      }

      let retailUpdateWarning: string | null = null;
      if (retailNeedsUpdate) {
        const priceRes = await fetch(`${BASE_URL}/api/products/variants/${selectedVariant.variant_id}/pricing`, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/json",
            ...apiAuth(),
          },
          body: JSON.stringify({
            retail_price_override: centsToFixed2(retailCents),
          }),
        });
        if (!priceRes.ok) {
          const body = (await priceRes.json().catch(() => ({}))) as { error?: string };
          retailUpdateWarning = body.error ?? "Retail price could not be updated.";
        }
      }
      autoReceiveAfterLoadRef.current = {
        lineId: addedLine.line_id,
        qty: entryQty,
      };
      await loadPo();
      setSelectedVariant(null);
      setEntryQty(1);
      setEntryCost("0.00");
      setEntryRetail("0.00");
      if (retailUpdateWarning) {
        toast(
          `Invoice line added and staged, but retail was not changed: ${retailUpdateWarning}`,
          "info",
        );
      } else {
        toast("Invoice line added and staged for receiving.", "success");
      }
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not add invoice line.", "error");
    } finally {
      setLineBusy(false);
      scannerRef.current?.focus();
    }
  }, [
    apiAuth,
    canAddInvoiceLines,
    entryCost,
    entryQty,
    entryRetail,
    loadPo,
    poId,
    selectedVariant,
    toast,
  ]);

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
      const result = (await res.json().catch(() => ({}))) as {
        receiving_event_id?: string;
      };
      if (result.receiving_event_id) {
        setPostedReceivingEventId(result.receiving_event_id);
      } else {
        onComplete();
      }
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
        <div className="flex items-center justify-between border-b border-app-border bg-app-surface px-6 py-4 text-app-text">
          <button
            type="button"
            onClick={onClose}
            className="ml-auto rounded-lg p-2 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
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
      {quickItemOpen && detail && (
        <QuickProcurementItemModal
          vendorId={detail.vendor_id}
          vendorName={detail.vendor_name}
          initialSku={quickItemSeedSku}
          defaultCost={entryCost}
          defaultRetail={entryRetail}
          onCreated={selectEntryVariant}
          onClose={() => {
            setQuickItemOpen(false);
            setQuickItemSeedSku("");
          }}
        />
      )}
      {/* Scan feedback color bar */}
      {feedback && (
        <div
          className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-1 transition-colors ${
            feedback.type === "success" ? "bg-emerald-400" : feedback.type === "error" ? "bg-red-500" : "bg-amber-400"
          }`}
        />
      )}

      {/* ── Header ── */}
      <header className="z-10 shrink-0 border-b border-app-border bg-app-surface text-app-text shadow-xl">
        <div className="flex items-center gap-4 px-5 py-3">
          {/* Left: Identity */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Truck size={18} className="text-emerald-500 shrink-0" />
              <h2 className="text-base font-bold truncate">Receive Stock</h2>
              <span className="text-xs font-mono text-app-text-muted">{detail.po_number}</span>
              {useVendorUpc && (
                <span className="rounded-full bg-violet-600/30 px-2 py-0.5 text-[9px] font-bold text-violet-300">UPC Mode</span>
              )}
            </div>
            <p className="text-[10px] text-app-text-muted mt-0.5">
              {detail.vendor_name} · {detail.status}{detail.po_kind ? ` · ${detail.po_kind}` : ""}
            </p>
          </div>

          {/* Center: Scanner */}
          <div className="flex items-center gap-2 max-w-md flex-1">
            <div className="flex shrink-0 overflow-hidden rounded-lg border border-app-border">
              {(["laser", "camera"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { setScanMode(m); warmUpAudio(); }}
                  className={`flex items-center gap-1 px-2.5 py-1.5 text-[9px] font-bold uppercase transition ${
                    scanMode === m ? "bg-app-accent/10 text-app-accent" : "text-app-text-muted hover:text-app-text"
                  }`}
                >
                  {m === "laser" ? <Barcode size={12} /> : <Camera size={12} />}
                  <span className="hidden sm:inline">{m}</span>
                </button>
              ))}
            </div>
            {scanMode === "laser" && (
              <form onSubmit={(e) => e.preventDefault()} className="group relative flex-1">
                <Barcode className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-app-text-muted group-focus-within:text-emerald-500" size={16} />
                <input
                  ref={scannerRef}
                  value={scanInput}
                  onChange={handleScanInputChange}
                  onKeyDown={handleScanInputKeyDown}
                  disabled={receivingClosed}
                  className="w-full rounded-lg border border-app-border bg-app-bg py-2 pl-9 pr-3 font-mono text-sm text-app-text placeholder:text-app-text-muted/70 outline-none focus:ring-2 focus:ring-emerald-400/50 disabled:opacity-40"
                  placeholder="Scan UPC or SKU..."
                  autoComplete="off"
                />
              </form>
            )}
            {scanCount > 0 && (
              <span className="shrink-0 rounded-full bg-emerald-500/15 px-2 py-0.5 text-[10px] font-bold text-emerald-600">{scanCount}</span>
            )}
          </div>

          {/* Right: Total + actions */}
          <div className="flex items-center gap-4 shrink-0">
            <div className="text-right">
              <p className="text-[9px] font-bold uppercase text-app-text-muted">Total</p>
              <p className="font-mono text-2xl font-bold text-emerald-400">${centsToFixed2(grandTotalCents)}</p>
            </div>
            <button
              type="button"
              disabled={receivingClosed}
              onClick={markAllRemaining}
              className="flex items-center gap-1.5 rounded-lg border border-app-border bg-app-surface-2 px-3 py-2 text-[9px] font-bold uppercase text-app-text-muted hover:text-app-text disabled:opacity-30 transition-all"
            >
              <CheckSquare size={13} /> Fill All
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg p-1.5 text-app-text-muted hover:bg-app-surface-2 hover:text-app-text transition-colors"
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
                    <span>Step {index + 1}</span>
                    <span className="opacity-40 font-normal">|</span>
                    <span>{step.label}</span>
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
          {!receivingClosed && (
            <span className="text-[9px] font-bold text-app-text-muted">
              Next: {receivingWorkflowIndex < RECEIVING_WORKFLOW_STEPS.length - 1
                ? RECEIVING_WORKFLOW_STEPS[receivingWorkflowIndex + 1].label
                : "Post inventory"}
            </span>
          )}
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

      {canAddInvoiceLines && (
        <div className="shrink-0 border-b border-app-border bg-app-surface px-5 py-3">
          <div className="mx-auto flex max-w-6xl flex-wrap items-end gap-3 rounded-2xl border border-app-border bg-app-surface-2 p-3">
            <div className="min-w-[280px] flex-1 space-y-1">
              <label className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">
                Search or scan item
              </label>
              <VariantSearchInput
                onSelect={selectEntryVariant}
                placeholder="Search SKU, UPC, or product name..."
              />
              {selectedVariant && (
                <p className="text-[10px] font-bold text-app-text-muted">
                  {selectedVariant.sku}
                  {selectedVariant.variation_label ? ` · ${selectedVariant.variation_label}` : ""}
                  {" · "}current cost ${variantMoneyInput(selectedVariant.cost_price)}
                  {" · "}current retail ${variantMoneyInput(selectedVariant.retail_price)}
                </p>
              )}
            </div>
            <div className="w-[92px] space-y-1">
              <label className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Qty</label>
              <input
                type="number"
                min={1}
                value={entryQty}
                onChange={(e) => setEntryQty(Number.parseInt(e.target.value || "1", 10))}
                className="ui-input h-10 w-full text-center text-sm font-bold"
              />
            </div>
            <div className="w-[132px] space-y-1">
              <label className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Unit Cost</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted/50">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={entryCost}
                  onChange={(e) => setEntryCost(e.target.value)}
                  className="ui-input h-10 w-full pl-7 text-sm font-bold"
                />
              </div>
            </div>
            <div className="w-[132px] space-y-1">
              <label className="ml-1 text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Retail</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted/50">$</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={entryRetail}
                  onChange={(e) => setEntryRetail(e.target.value)}
                  className="ui-input h-10 w-full pl-7 text-sm font-bold"
                />
              </div>
            </div>
            <button
              type="button"
              disabled={!selectedVariant || lineBusy}
              onClick={() => void addInvoiceLine()}
              className="h-10 rounded-xl bg-app-accent px-4 text-xs font-bold text-white shadow-md shadow-app-accent/20 transition-all hover:brightness-110 active:scale-95 disabled:opacity-30"
            >
              {lineBusy ? "Adding..." : "Add Line"}
            </button>
            <button
              type="button"
              onClick={() => setQuickItemOpen(true)}
              className="h-10 rounded-xl border border-app-border bg-app-surface px-4 text-xs font-bold text-app-text-muted transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
            >
              <Plus size={13} className="inline mr-1" /> Quick Add Item
            </button>
            {onOpenAddItem && (
              <button
                type="button"
                onClick={() => {
                  onClose();
                  onOpenAddItem();
                }}
                className="h-10 rounded-xl border border-app-border/70 bg-app-surface/70 px-4 text-xs font-bold text-app-text-muted transition-all hover:border-app-accent hover:text-app-accent active:scale-95"
              >
                Full Catalog
              </button>
            )}
          </div>
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
                <th className="px-3 py-3 text-center text-[10px] font-bold uppercase tracking-wider text-app-text-muted">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-app-border/40">
              {lines.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-5 py-12 text-center">
                    <p className="text-sm font-black text-app-text">
                      {canAddInvoiceLines ? "Add invoice lines above." : "No receivable lines on this paperwork."}
                    </p>
                    <p className="mx-auto mt-2 max-w-xl text-xs font-semibold leading-relaxed text-app-text-muted">
                      {canAddInvoiceLines
                        ? "Search or scan products, confirm quantity, cost, and retail, then add the line before posting inventory."
                        : "Close this screen and open the correct PO or direct invoice from Receive Stock."}
                    </p>
                  </td>
                </tr>
              ) : lines.map((line) => {
                const remaining = Math.max(0, line.qty_ordered - line.qty_previously_received);
                const hasCostAlert = unitCostAlerts(line.prior_effective_cost, line.unit_cost);
                const canEditUnpostedLine = !receivingClosed && line.qty_previously_received === 0;
                const rowSaving = lineSaveBusy === line.line_id;
                return (
                  <tr key={line.line_id} className="transition-colors hover:bg-app-surface-2/30">
                    <td className="px-5 py-3">
                      <p className="text-xs font-bold text-app-text">{line.product_name}</p>
                      <p className="text-[10px] text-app-text-muted">
                        {line.subtitle} · <span className="font-mono">{line.sku}</span>
                        {effectiveCatalogNumber(line) && (
                          <span className="ml-1 text-violet-500">
                            Catalog #: {effectiveCatalogNumber(line)}
                          </span>
                        )}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-center">
                      {canEditUnpostedLine ? (
                        <input
                          aria-label={`Ordered quantity for ${line.sku}`}
                          type="number"
                          min={1}
                          value={line.qty_ordered}
                          disabled={rowSaving}
                          onChange={(e) => {
                            const raw = Number.parseInt(e.target.value || "1", 10);
                            const val = Number.isFinite(raw) ? Math.max(1, raw) : 1;
                            setLines((prev) =>
                              prev.map((l) =>
                                l.line_id === line.line_id
                                  ? {
                                      ...l,
                                      qty_ordered: val,
                                      qty_receiving: Math.min(l.qty_receiving, Math.max(0, val - l.qty_previously_received)),
                                    }
                                  : l,
                              ),
                            );
                          }}
                          onBlur={(e) => {
                            const raw = Number.parseInt(e.target.value || "1", 10);
                            const val = Number.isFinite(raw) ? Math.max(1, raw) : 1;
                            void updateUnpostedLine(line, { quantityOrdered: val });
                          }}
                          className="mx-auto block w-16 rounded-lg border border-app-border bg-app-surface p-1.5 text-center text-sm font-bold text-app-text outline-none focus:border-app-accent disabled:opacity-40"
                        />
                      ) : (
                        <span className="font-bold text-app-text-muted">{line.qty_ordered}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center font-bold text-app-text-muted bg-app-accent-2/5">{line.qty_previously_received}</td>
                    <td className="px-4 py-3 bg-app-accent-2/5">
                      <input
                        aria-label={`Receiving quantity for ${line.sku}`}
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
                      {canEditUnpostedLine ? (
                        <div className="ml-auto w-24">
                          <div className="relative">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs font-bold text-app-text-muted/50">$</span>
                            <input
                              aria-label={`Unit cost for ${line.sku}`}
                              type="text"
                              inputMode="decimal"
                              value={line.unit_cost.toFixed(2)}
                              disabled={rowSaving}
                              onChange={(e) => {
                                const raw = Number.parseFloat(e.target.value || "0");
                                const val = Number.isFinite(raw) ? Math.max(0, raw) : 0;
                                setLines((prev) => prev.map((l) => l.line_id === line.line_id ? { ...l, unit_cost: val } : l));
                              }}
                              onBlur={(e) => {
                                const raw = Number.parseFloat(e.target.value || "0");
                                const val = Number.isFinite(raw) ? Math.max(0, raw) : 0;
                                void updateUnpostedLine(line, { unitCost: val });
                              }}
                              className={`w-full rounded-lg border bg-app-surface py-1.5 pl-5 pr-2 text-right text-sm font-bold tabular-nums outline-none focus:border-app-accent disabled:opacity-40 ${
                                hasCostAlert ? "border-amber-300 text-amber-600" : "border-app-border text-app-text"
                              }`}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className={`text-sm font-bold tabular-nums ${hasCostAlert ? "text-amber-600" : "text-app-text"}`}>
                          ${line.unit_cost.toFixed(2)}
                        </span>
                      )}
                      {line.prior_effective_cost > 0 && (
                        <p className="text-[9px] text-app-text-muted">was ${line.prior_effective_cost.toFixed(2)}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 text-center">
                      {remaining > 0 ? (
                        <select
                          value={line.line_status || (line.qty_receiving >= remaining ? "received" : line.qty_receiving > 0 ? "received" : "")}
                          disabled={receivingClosed}
                          onChange={(e) => {
                            const val = e.target.value as LineReceiveStatus;
                            setLines((prev) => prev.map((l) => l.line_id === line.line_id ? { ...l, line_status: val } : l));
                          }}
                          className={`w-full max-w-[110px] rounded-lg border border-app-border px-1.5 py-1 text-[9px] font-bold outline-none transition-colors disabled:opacity-40 ${
                            (line.line_status || (line.qty_receiving >= remaining ? "received" : "")) === "received" ? "bg-emerald-50 text-emerald-700 border-emerald-200" :
                            (line.line_status) === "backordered" ? "bg-amber-50 text-amber-700 border-amber-200" :
                            (line.line_status) === "not_shipped" ? "bg-red-50 text-red-700 border-red-200" :
                            "bg-app-surface text-app-text-muted"
                          }`}
                        >
                          <option value="">—</option>
                          <option value="received">Received</option>
                          <option value="backordered">Backordered</option>
                          <option value="not_shipped">Not Shipped</option>
                        </select>
                      ) : (
                        <span className="text-[9px] font-bold text-emerald-600">Complete</span>
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

      {postedReceivingEventId && (
        <ReceivingReport
          receivingEventId={postedReceivingEventId}
          showTagPrompt={true}
          onPrintTags={(eventId) => {
            void openExternalUrl(
              `${BASE_URL}/api/purchase-orders/receiving-events/${eventId}`,
              "_blank",
            );
            toast("Tag printing initiated. Use label printer for received items.", "success");
          }}
          onClose={() => {
            setPostedReceivingEventId(null);
            onComplete();
          }}
        />
      )}
    </div>,
    root
  );
}
