import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  Package,
  Plus,
  RefreshCw,
  StickyNote,
  Truck,
} from "lucide-react";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import IntegrationBrandLogo from "../ui/IntegrationBrandLogo";
import { CheckCircle2 } from "lucide-react";
import AddressAutocompleteInput from "../ui/AddressAutocompleteInput";

const defaultBase = getBaseUrl();

interface ShipmentListItem {
  id: string;
  source: string;
  direction: string;
  status: string;
  transaction_id: string | null;
  customer_id: string | null;
  customer_first_name: string | null;
  customer_last_name: string | null;
  created_at: string;
  tracking_number: string | null;
  shipping_charged_usd: string | null;
  quoted_amount_usd: string | null;
  carrier: string | null;
  service_name: string | null;
  dest_summary: string | null;
}

interface ShipmentEvent {
  id: string;
  at: string;
  kind: string;
  message: string;
  metadata: Record<string, unknown>;
  staff_id: string | null;
}

interface BatchCandidate {
  id: string;
  direction: string;
  customer_first_name: string | null;
  customer_last_name: string | null;
  carrier: string | null;
  service_name: string | null;
  tracking_number: string | null;
  shippo_transaction_object_id: string;
  shippo_carrier_account_object_id: string;
  created_at: string;
}

interface ShipmentBatch {
  id: string;
  batch_type: string;
  status: string;
  carrier_account: string;
  shipment_date: string | null;
  requested_start_time: string | null;
  requested_end_time: string | null;
  confirmation_code: string | null;
  document_url: string | null;
  shipment_count: number;
  created_at: string;
}

interface ShipmentsHubSectionProps {
  baseUrl?: string;
  /** When set, list is restricted to this customer (hub tab). */
  customerIdFilter?: string | null;
  embedded?: boolean;
  onOpenTransactionInBackoffice?: (orderId: string) => void;
  /** When set (e.g. from hub timeline), load this shipment detail; parent should clear via `onOpenShipmentIdConsumed`. */
  openShipmentId?: string | null;
  onOpenShipmentIdConsumed?: () => void;
}

function fmtAddr(shipTo: unknown): string {
  if (!shipTo || typeof shipTo !== "object") return "—";
  const o = shipTo as Record<string, unknown>;
  const city = String(o.city ?? "").trim();
  const st = String(o.state ?? "").trim();
  const zip = String(o.zip ?? "").trim();
  const bits = [city, st, zip].filter(Boolean);
  return bits.length ? bits.join(", ") : "—";
}

function moneyOrDash(s: string | null | undefined): string {
  if (s == null || String(s).trim() === "") return "—";
  const n = Number.parseFloat(String(s));
  if (!Number.isFinite(n)) return String(s);
  return `$${n.toFixed(2)}`;
}

export default function ShipmentsHubSection({
  baseUrl = defaultBase,
  customerIdFilter = null,
  embedded = false,
  onOpenTransactionInBackoffice,
  openShipmentId = null,
  onOpenShipmentIdConsumed,
}: ShipmentsHubSectionProps) {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission, permissionsLoaded } =
    useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const canView = hasPermission("shipments.view");
  const canManage = hasPermission("shipments.manage");
  const isCompactList = useMediaQuery("(max-width: 1023px)");

  const [openOnly, setOpenOnly] = useState(true);
  const [items, setItems] = useState<ShipmentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    shipment: Record<string, unknown>;
    events: ShipmentEvent[];
  } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const [rates, setRates] = useState<
    {
      rate_quote_id: string;
      amount_usd: unknown;
      carrier: string;
      service_name: string;
    }[]
  >([]);
  const [ratesBusy, setRatesBusy] = useState(false);
  const [labelPurchaseBusy, setLabelPurchaseBusy] = useState(false);
  const [labelRefundBusy, setLabelRefundBusy] = useState(false);
  const [labelFileType, setLabelFileType] = useState("PDF_4X6");
  const [returnBusy, setReturnBusy] = useState(false);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchCandidates, setBatchCandidates] = useState<BatchCandidate[]>([]);
  const [batches, setBatches] = useState<ShipmentBatch[]>([]);
  const [selectedBatchIds, setSelectedBatchIds] = useState<string[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [pickupDraft, setPickupDraft] = useState({
    requested_start_time: "",
    requested_end_time: "",
    building_location_type: "Front Door",
    building_type: "",
    instructions: "",
  });
  const [noteDraft, setNoteDraft] = useState("");
  const [statusDraft, setStatusDraft] = useState("");
  const [trackDraft, setTrackDraft] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [newCustomerId, setNewCustomerId] = useState("");
  const [newForm, setNewForm] = useState({
    name: "",
    company: "",
    street1: "",
    street2: "",
    city: "",
    state: "",
    zip: "",
    country: "US",
    phone: "",
    email: "",
    is_residential: false,
  });
  const { dialogRef, titleId } = useDialogAccessibility(newOpen, {
    onEscape: () => setNewOpen(false),
  });

  useEffect(() => {
    if (!newOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [newOpen]);

  const fetchShipmentList = useCallback(
    async (useOpenOnlyFilter: boolean) => {
      if (!canView) return;
      setLoading(true);
      try {
        const q = new URLSearchParams();
        if (customerIdFilter) q.set("customer_id", customerIdFilter);
        if (useOpenOnlyFilter) q.set("open_only", "true");
        q.set("limit", "100");
        const res = await fetch(`${baseUrl}/api/shipments?${q}`, {
          headers: apiAuth(),
        });
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          items?: ShipmentListItem[];
        };
        if (!res.ok) {
          toast(j.error ?? "Could not load shipments", "error");
          setItems([]);
          return;
        }
        setItems(j.items ?? []);
      } catch {
        toast("Network error loading shipments", "error");
        setItems([]);
      } finally {
        setLoading(false);
      }
    },
    [apiAuth, baseUrl, canView, customerIdFilter, toast],
  );

  const loadList = useCallback(async () => {
    await fetchShipmentList(openOnly);
  }, [fetchShipmentList, openOnly]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  const openDetail = useCallback(
    async (id: string) => {
      setDetailId(id);
      setDetailBusy(true);
      setRates([]);
      setNoteDraft("");
      try {
        const res = await fetch(
          `${baseUrl}/api/shipments/${encodeURIComponent(id)}`,
          { headers: apiAuth() },
        );
        const j = (await res.json().catch(() => ({}))) as {
          error?: string;
          shipment?: Record<string, unknown>;
          events?: ShipmentEvent[];
        };
        if (!res.ok) {
          toast(j.error ?? "Load failed", "error");
          setDetail(null);
          return;
        }
        setDetail({
          shipment: j.shipment ?? {},
          events: j.events ?? [],
        });
        const st = String(j.shipment?.status ?? "");
        setStatusDraft(st);
        setTrackDraft(String(j.shipment?.tracking_number ?? ""));
      } catch {
        toast("Network error", "error");
        setDetail(null);
      } finally {
        setDetailBusy(false);
      }
    },
    [apiAuth, baseUrl, toast],
  );

  useEffect(() => {
    const id = openShipmentId?.trim();
    if (!id || !canView) return;
    let cancelled = false;
    void (async () => {
      setOpenOnly(false);
      await fetchShipmentList(false);
      if (cancelled) return;
      await openDetail(id);
      if (!cancelled) onOpenShipmentIdConsumed?.();
    })();
    return () => {
      cancelled = true;
    };
  }, [
    openShipmentId,
    canView,
    fetchShipmentList,
    openDetail,
    onOpenShipmentIdConsumed,
  ]);

  const refreshRates = useCallback(async () => {
    if (!detailId || !canManage) return;
    setRatesBusy(true);
    setRates([]);
    try {
      const res = await fetch(
        `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}/rates?force_stub=false`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({}),
        },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        rates?: typeof rates;
        stub?: boolean;
      };
      if (!res.ok) {
        toast(j.error ?? "Rates failed", "error");
        return;
      }
      setRates(j.rates ?? []);
      if (j.stub)
        toast("Using demo rates (configure Shippo for live pricing).", "info");
      else toast("Rates updated", "success");
      void openDetail(detailId);
    } catch {
      toast("Network error", "error");
    } finally {
      setRatesBusy(false);
    }
  }, [apiAuth, baseUrl, canManage, detailId, openDetail, toast]);

  const applyRate = useCallback(
    async (rateQuoteId: string) => {
      if (!detailId || !canManage) return;
      try {
        const res = await fetch(
          `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}/apply-quote`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...apiAuth() },
            body: JSON.stringify({ rate_quote_id: rateQuoteId }),
          },
        );
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          toast(j.error ?? "Apply failed", "error");
          return;
        }
        toast("Rate applied to shipment", "success");
        setRates([]);
        void openDetail(detailId);
        void loadList();
      } catch {
        toast("Network error", "error");
      }
    },
    [apiAuth, baseUrl, canManage, detailId, loadList, openDetail, toast],
  );

  const purchaseShippoLabel = useCallback(async () => {
    if (!detailId || !canManage) return;
    setLabelPurchaseBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}/purchase-label`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ label_file_type: labelFileType }),
        },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        tracking_number?: string;
        shipping_label_url?: string;
      };
      if (!res.ok) {
        toast(j.error ?? "Label purchase failed", "error");
        return;
      }
      toast(
        j.tracking_number
          ? `Label purchased — tracking ${j.tracking_number}`
          : "Label purchased",
        "success",
      );
      void openDetail(detailId);
      void loadList();
    } catch {
      toast("Network error", "error");
    } finally {
      setLabelPurchaseBusy(false);
    }
  }, [apiAuth, baseUrl, canManage, detailId, labelFileType, loadList, openDetail, toast]);

  const refundShippoLabel = useCallback(async () => {
    if (!detailId || !canManage) return;
    setLabelRefundBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}/refund-label`,
        { method: "POST", headers: { ...apiAuth() } },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        status?: string | null;
      };
      if (!res.ok) {
        toast(j.error ?? "Label refund request failed", "error");
        return;
      }
      toast(
        j.status
          ? `Unused label refund requested: ${j.status}`
          : "Unused label refund requested",
        "success",
      );
      void openDetail(detailId);
    } catch {
      toast("Network error", "error");
    } finally {
      setLabelRefundBusy(false);
    }
  }, [apiAuth, baseUrl, canManage, detailId, openDetail, toast]);

  const createReturnShipment = useCallback(async () => {
    if (!detailId || !canManage) return;
    setReturnBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}/return-shipment`,
        { method: "POST", headers: { ...apiAuth() } },
      );
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        shipment_id?: string;
      };
      if (!res.ok) {
        toast(j.error ?? "Could not create return shipment", "error");
        return;
      }
      toast("Return label workflow created", "success");
      void loadList();
      if (j.shipment_id) void openDetail(j.shipment_id);
    } catch {
      toast("Network error", "error");
    } finally {
      setReturnBusy(false);
    }
  }, [apiAuth, baseUrl, canManage, detailId, loadList, openDetail, toast]);

  const loadBatches = useCallback(async () => {
    if (!canManage) return;
    setBatchBusy(true);
    try {
      const [candidateRes, batchRes] = await Promise.all([
        fetch(`${baseUrl}/api/shipments/batch-candidates`, {
          headers: apiAuth(),
        }),
        fetch(`${baseUrl}/api/shipments/batches`, {
          headers: apiAuth(),
        }),
      ]);
      const candidates = (await candidateRes.json().catch(() => ({}))) as {
        error?: string;
        items?: BatchCandidate[];
      };
      const batchList = (await batchRes.json().catch(() => ({}))) as {
        error?: string;
        items?: ShipmentBatch[];
      };
      if (!candidateRes.ok) {
        toast(candidates.error ?? "Could not load label candidates", "error");
      } else {
        setBatchCandidates(candidates.items ?? []);
      }
      if (!batchRes.ok) {
        toast(batchList.error ?? "Could not load carrier batches", "error");
      } else {
        setBatches(batchList.items ?? []);
      }
    } catch {
      toast("Network error loading carrier handoff", "error");
    } finally {
      setBatchBusy(false);
    }
  }, [apiAuth, baseUrl, canManage, toast]);

  const toggleBatchId = useCallback((id: string) => {
    setSelectedBatchIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  }, []);

  const createManifest = useCallback(async () => {
    if (!canManage || selectedBatchIds.length === 0) {
      toast("Select labels for the manifest", "error");
      return;
    }
    setBatchBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/shipments/batches/manifest`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          shipment_ids: selectedBatchIds,
          shipment_date: new Date().toISOString(),
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(j.error ?? "Could not create manifest", "error");
        return;
      }
      toast("Manifest created", "success");
      setSelectedBatchIds([]);
      void loadBatches();
      void loadList();
    } catch {
      toast("Network error creating manifest", "error");
    } finally {
      setBatchBusy(false);
    }
  }, [apiAuth, baseUrl, canManage, loadBatches, loadList, selectedBatchIds, toast]);

  const createPickup = useCallback(async () => {
    if (!canManage || selectedBatchIds.length === 0) {
      toast("Select labels for pickup", "error");
      return;
    }
    if (!pickupDraft.requested_start_time || !pickupDraft.requested_end_time) {
      toast("Pickup start and end times are required", "error");
      return;
    }
    setBatchBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/shipments/batches/pickup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          shipment_ids: selectedBatchIds,
          requested_start_time: new Date(
            pickupDraft.requested_start_time,
          ).toISOString(),
          requested_end_time: new Date(
            pickupDraft.requested_end_time,
          ).toISOString(),
          building_location_type: pickupDraft.building_location_type,
          building_type: pickupDraft.building_type.trim() || undefined,
          instructions: pickupDraft.instructions.trim() || undefined,
        }),
      });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        toast(j.error ?? "Could not schedule pickup", "error");
        return;
      }
      toast("Pickup requested", "success");
      setSelectedBatchIds([]);
      void loadBatches();
      void loadList();
    } catch {
      toast("Network error scheduling pickup", "error");
    } finally {
      setBatchBusy(false);
    }
  }, [
    apiAuth,
    baseUrl,
    canManage,
    loadBatches,
    loadList,
    pickupDraft,
    selectedBatchIds,
    toast,
  ]);

  const saveNote = useCallback(async () => {
    if (!detailId || !canManage || !noteDraft.trim()) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}/notes`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({ message: noteDraft.trim() }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Note failed", "error");
        return;
      }
      setNoteDraft("");
      toast("Note added", "success");
      void openDetail(detailId);
    } catch {
      toast("Network error", "error");
    }
  }, [apiAuth, baseUrl, canManage, detailId, noteDraft, openDetail, toast]);

  const savePatch = useCallback(async () => {
    if (!detailId || !canManage) return;
    try {
      const res = await fetch(
        `${baseUrl}/api/shipments/${encodeURIComponent(detailId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...apiAuth() },
          body: JSON.stringify({
            status: statusDraft.trim() || undefined,
            tracking_number: trackDraft.trim() || undefined,
          }),
        },
      );
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Update failed", "error");
        return;
      }
      toast("Shipment updated", "success");
      void openDetail(detailId);
      void loadList();
    } catch {
      toast("Network error", "error");
    }
  }, [
    apiAuth,
    baseUrl,
    canManage,
    detailId,
    loadList,
    openDetail,
    statusDraft,
    trackDraft,
    toast,
  ]);

  const createManual = useCallback(async () => {
    if (!canManage) return;
    if (
      !newForm.street1.trim() ||
      !newForm.city.trim() ||
      !newForm.state.trim() ||
      !newForm.zip.trim()
    ) {
      toast("Street, city, state, and ZIP are required", "error");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/shipments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify({
          customer_id: newCustomerId.trim() || null,
          ship_to: {
            name: newForm.name.trim(),
            company: newForm.company.trim() || undefined,
            street1: newForm.street1.trim(),
            street2: newForm.street2.trim() || undefined,
            city: newForm.city.trim(),
            state: newForm.state.trim(),
            zip: newForm.zip.trim(),
            country: newForm.country.trim() || "US",
            phone: newForm.phone.trim() || undefined,
            email: newForm.email.trim() || undefined,
            is_residential: newForm.is_residential,
          },
        }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        error?: string;
        shipment_id?: string;
      };
      if (!res.ok) {
        toast(j.error ?? "Create failed", "error");
        return;
      }
      toast("Shipment created", "success");
      setNewOpen(false);
      setNewCustomerId("");
      setNewForm({
        name: "",
        company: "",
        street1: "",
        street2: "",
        city: "",
        state: "",
        zip: "",
        country: "US",
        phone: "",
        email: "",
        is_residential: false,
      });
      void loadList();
      if (j.shipment_id) void openDetail(j.shipment_id);
    } catch {
      toast("Network error", "error");
    }
  }, [
    apiAuth,
    baseUrl,
    canManage,
    loadList,
    newCustomerId,
    newForm,
    openDetail,
    toast,
  ]);

  const sourceLabel = useMemo(
    () =>
      ({
        pos_order: "POS",
        web_order: "Online",
        manual_hub: "Manual",
      }) as Record<string, string>,
    [],
  );
  const selectedBatchCandidates = useMemo(
    () => batchCandidates.filter((row) => selectedBatchIds.includes(row.id)),
    [batchCandidates, selectedBatchIds],
  );
  const selectedCarrierAccount =
    selectedBatchCandidates[0]?.shippo_carrier_account_object_id ?? "";
  const hasMixedCarrierAccounts = selectedBatchCandidates.some(
    (row) => row.shippo_carrier_account_object_id !== selectedCarrierAccount,
  );

  if (!permissionsLoaded) {
    return (
      <div className="p-6 text-sm text-app-text-muted">
        Loading permissions…
      </div>
    );
  }
  if (!canView) {
    return (
      <div className="p-6 text-sm text-app-text-muted">
        You do not have access to shipments (shipments.view).
      </div>
    );
  }

  const overlayRoot = document.getElementById("drawer-root") || document.body;

  return (
    <div
      className={`flex min-h-0 flex-1 flex-col gap-4 ${embedded ? "" : "ui-page p-4"}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="mb-3 flex items-center">
            <IntegrationBrandLogo
              brand="shippo"
              kind="wordmark"
              className="inline-flex rounded-2xl border border-lime-500/20 bg-app-surface px-4 py-2 shadow-sm"
              imageClassName="h-10 w-auto object-contain"
            />
          </div>
          <h2 className="text-xl font-black tracking-tight text-app-text">
            {customerIdFilter ? "Customer shipments" : "All shipments"}
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-app-text-muted">
            POS and online store orders with shipping create rows here. Manual
            entries are for shipments without a sale. Timeline shows history and
            staff notes.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => setOpenOnly(e.target.checked)}
              className="rounded border-app-border"
            />
            Open only
          </label>
          <button
            type="button"
            onClick={() => void loadList()}
            className="ui-btn-secondary flex items-center gap-1.5 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          {canManage ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setBatchOpen((current) => !current);
                  if (!batchOpen) void loadBatches();
                }}
                className="ui-btn-secondary flex items-center gap-1.5 px-3 py-2 text-[10px] font-black uppercase tracking-widest"
              >
                <Truck size={14} />
                Carrier handoff
              </button>
              <button
                type="button"
                onClick={() => setNewOpen(true)}
                className="flex items-center gap-1.5 rounded-xl border-b-8 border-emerald-800 bg-emerald-600 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg"
              >
                <Plus size={14} />
                New shipment
              </button>
            </>
          ) : null}
        </div>
      </div>

      {batchOpen && canManage ? (
        <div className="rounded-2xl border border-app-border bg-app-surface p-4 shadow-sm">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
                Carrier handoff
              </h3>
              <p className="mt-1 max-w-3xl text-xs text-app-text-muted">
                Select purchased labels for the same carrier account, then create
                a manifest or schedule pickup. Return labels appear here after
                they are purchased.
              </p>
            </div>
            <button
              type="button"
              disabled={batchBusy}
              onClick={() => void loadBatches()}
              className="ui-btn-secondary px-3 py-2 text-[10px] font-black uppercase tracking-widest"
            >
              {batchBusy ? "Loading..." : "Refresh handoff"}
            </button>
          </div>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_420px]">
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Ready labels
                </p>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  {selectedBatchIds.length} selected
                </p>
              </div>
              {batchCandidates.length === 0 ? (
                <p className="rounded-lg border border-app-border bg-app-surface p-3 text-xs text-app-text-muted">
                  No purchased labels with carrier accounts are ready for a
                  manifest or pickup request.
                </p>
              ) : (
                <div className="grid gap-2 md:grid-cols-2">
                  {batchCandidates.map((row) => {
                    const name =
                      row.customer_first_name || row.customer_last_name
                        ? `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim()
                        : "No customer linked";
                    return (
                      <label
                        key={row.id}
                        className="flex cursor-pointer gap-3 rounded-lg border border-app-border bg-app-surface p-3 text-xs hover:bg-app-surface-2"
                      >
                        <input
                          type="checkbox"
                          checked={selectedBatchIds.includes(row.id)}
                          onChange={() => toggleBatchId(row.id)}
                          className="mt-1 rounded border-app-border"
                        />
                        <span className="min-w-0">
                          <span className="block truncate font-black text-app-text">
                            {name}
                          </span>
                          <span className="mt-1 block truncate text-app-text-muted">
                            {row.direction === "return" ? "Return" : "Outbound"} ·{" "}
                            {row.carrier ?? "Carrier"} {row.service_name ?? ""}
                          </span>
                          <span className="mt-1 block truncate font-mono text-[10px] text-app-text-muted">
                            {row.tracking_number ?? row.shippo_transaction_object_id}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              )}
              {hasMixedCarrierAccounts ? (
                <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs font-semibold text-amber-700">
                  Selected labels use different carrier accounts. Create one
                  handoff per carrier account.
                </p>
              ) : null}
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Manifest / SCAN form
                </p>
                <p className="mt-1 text-xs text-app-text-muted">
                  Creates the carrier document for the selected purchased labels.
                </p>
                <button
                  type="button"
                  disabled={
                    batchBusy ||
                    selectedBatchIds.length === 0 ||
                    hasMixedCarrierAccounts
                  }
                  onClick={() => void createManifest()}
                  className="mt-3 w-full rounded-xl border-b-8 border-app-accent/70 bg-app-accent px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow disabled:opacity-50"
                >
                  Create manifest
                </button>
              </div>

              <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Pickup request
                </p>
                <div className="mt-2 grid gap-2">
                  <label className="text-[10px] font-bold uppercase text-app-text-muted">
                    Ready after
                    <input
                      type="datetime-local"
                      className="ui-input mt-1 w-full text-xs"
                      value={pickupDraft.requested_start_time}
                      onChange={(e) =>
                        setPickupDraft((draft) => ({
                          ...draft,
                          requested_start_time: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="text-[10px] font-bold uppercase text-app-text-muted">
                    Available until
                    <input
                      type="datetime-local"
                      className="ui-input mt-1 w-full text-xs"
                      value={pickupDraft.requested_end_time}
                      onChange={(e) =>
                        setPickupDraft((draft) => ({
                          ...draft,
                          requested_end_time: e.target.value,
                        }))
                      }
                    />
                  </label>
                  <label className="text-[10px] font-bold uppercase text-app-text-muted">
                    Pickup location
                    <select
                      className="ui-input mt-1 w-full text-xs"
                      value={pickupDraft.building_location_type}
                      onChange={(e) =>
                        setPickupDraft((draft) => ({
                          ...draft,
                          building_location_type: e.target.value,
                        }))
                      }
                    >
                      <option>Front Door</option>
                      <option>Back Door</option>
                      <option>Side Door</option>
                      <option>Knock on Door/Ring Bell</option>
                      <option>Mail Room</option>
                      <option>Office</option>
                      <option>Reception</option>
                      <option>In/At Mailbox</option>
                      <option>Security Deck</option>
                      <option>Shipping Dock</option>
                      <option>Other</option>
                    </select>
                  </label>
                  <label className="text-[10px] font-bold uppercase text-app-text-muted">
                    Building detail
                    <select
                      className="ui-input mt-1 w-full text-xs"
                      value={pickupDraft.building_type}
                      onChange={(e) =>
                        setPickupDraft((draft) => ({
                          ...draft,
                          building_type: e.target.value,
                        }))
                      }
                    >
                      <option value="">None</option>
                      <option value="apartment">Apartment</option>
                      <option value="building">Building</option>
                      <option value="department">Department</option>
                      <option value="floor">Floor</option>
                      <option value="room">Room</option>
                      <option value="suite">Suite</option>
                    </select>
                  </label>
                  <label className="text-[10px] font-bold uppercase text-app-text-muted">
                    Instructions
                    <textarea
                      className="ui-input mt-1 min-h-20 w-full text-xs"
                      value={pickupDraft.instructions}
                      onChange={(e) =>
                        setPickupDraft((draft) => ({
                          ...draft,
                          instructions: e.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <button
                  type="button"
                  disabled={
                    batchBusy ||
                    selectedBatchIds.length === 0 ||
                    hasMixedCarrierAccounts
                  }
                  onClick={() => void createPickup()}
                  className="mt-3 w-full rounded-xl border-b-8 border-emerald-800 bg-emerald-600 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow disabled:opacity-50"
                >
                  Schedule pickup
                </button>
              </div>
            </div>
          </div>
          {batches.length > 0 ? (
            <div className="mt-4 rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Recent handoffs
              </p>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {batches.slice(0, 6).map((batch) => (
                  <div
                    key={batch.id}
                    className="rounded-lg border border-app-border bg-app-surface p-3 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-black uppercase tracking-widest text-app-text">
                        {batch.batch_type}
                      </p>
                      <span className="rounded-full border border-app-border px-2 py-0.5 text-[9px] font-black uppercase text-app-text-muted">
                        {batch.status}
                      </span>
                    </div>
                    <p className="mt-1 text-app-text-muted">
                      {batch.shipment_count} labels ·{" "}
                      {new Date(batch.created_at).toLocaleString()}
                    </p>
                    {batch.confirmation_code ? (
                      <p className="mt-1 font-mono text-app-text">
                        {batch.confirmation_code}
                      </p>
                    ) : null}
                    {batch.document_url ? (
                      <a
                        href={batch.document_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex text-sky-600 underline"
                      >
                        Open document
                      </a>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1fr_minmax(300px,400px)]">
        <div className="min-h-0 overflow-auto rounded-2xl border border-app-border bg-app-surface">
          {loading ? (
            <p className="p-6 text-sm text-app-text-muted">Loading…</p>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-8 text-center text-app-text-muted">
              <Package size={40} className="mb-3 opacity-70" />
              <p className="text-sm font-black uppercase tracking-widest italic">No shipments found</p>
              <p className="mt-2 max-w-sm text-sm font-medium normal-case tracking-normal text-app-text-muted">
                Shippo labels and handoff activity will appear here once a shipment is created or synced.
              </p>
            </div>
          ) : (
            isCompactList ? (
              <div className="space-y-2 p-2">
                {items.map((row) => (
                  <button
                    key={row.id}
                    type="button"
                    className={`w-full rounded-xl border px-3 py-3 text-left transition-colors ${
                      detailId === row.id
                        ? "border-app-accent bg-app-accent/10"
                        : "border-app-border bg-app-surface hover:bg-app-surface-2"
                    }`}
                    onClick={() => void openDetail(row.id)}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-black uppercase tracking-widest text-app-text">
                          {sourceLabel[row.source] ?? row.source}
                        </p>
                        <p className="mt-1 text-xs text-app-text-muted">
                          {new Date(row.created_at).toLocaleString()}
                        </p>
                      </div>
                      <span className="rounded-full border border-app-border bg-app-surface-2 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        {row.status}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <p className="min-w-0 truncate text-app-text">
                        <span className="font-black text-app-text-muted">Customer:</span>{" "}
                        {row.customer_first_name || row.customer_last_name
                          ? `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim()
                          : "—"}
                      </p>
                      <p className="min-w-0 truncate text-app-text">
                        <span className="font-black text-app-text-muted">Tracking:</span>{" "}
                        {row.tracking_number ?? "—"}
                      </p>
                      <p className="min-w-0 truncate text-app-text">
                        <span className="font-black text-app-text-muted">Ship to:</span>{" "}
                        {row.dest_summary?.trim() || "—"}
                      </p>
                      <p className="text-right font-black tabular-nums text-app-text">
                        {moneyOrDash(row.shipping_charged_usd ?? row.quoted_amount_usd)}
                      </p>
                    </div>
                    {row.transaction_id ? (
                      <p className="mt-2 text-[11px] text-app-text-muted">
                        <span className="font-black uppercase tracking-widest">
                          {row.direction === "return" ? "Return" : "Transaction"}
                        </span>{" "}
                        <span className="font-mono">
                          {row.transaction_id.slice(0, 8)}
                        </span>
                      </p>
                    ) : null}
                  </button>
                ))}
              </div>
            ) : (
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="sticky top-0 border-b border-app-border bg-app-surface-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  <tr>
                    <th className="px-3 py-2">Created</th>
                    <th className="px-3 py-2">Source</th>
                    <th className="px-3 py-2">Type</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Customer</th>
                    <th className="px-3 py-2">Ship to</th>
                    <th className="px-3 py-2">Transaction</th>
                    <th className="px-3 py-2">Tracking</th>
                    <th className="px-3 py-2 text-right">Ship $</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-app-border/60">
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className={`cursor-pointer hover:bg-app-surface-2/60 ${
                        detailId === row.id ? "bg-app-accent/10" : ""
                      }`}
                      onClick={() => void openDetail(row.id)}
                    >
                      <td className="px-3 py-2 text-xs text-app-text-muted">
                        {new Date(row.created_at).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-xs font-semibold">
                        {sourceLabel[row.source] ?? row.source}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {row.direction === "return" ? "Return" : "Outbound"}
                      </td>
                      <td className="px-3 py-2 text-xs">{row.status}</td>
                      <td className="px-3 py-2 text-xs">
                        {row.customer_first_name || row.customer_last_name
                          ? `${row.customer_first_name ?? ""} ${row.customer_last_name ?? ""}`.trim()
                          : "—"}
                      </td>
                      <td className="max-w-[160px] truncate px-3 py-2 text-xs text-app-text-muted">
                        {row.dest_summary?.trim() || "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-xs">
                        {row.transaction_id ? row.transaction_id.slice(0, 8) : "—"}
                      </td>
                      <td className="max-w-[120px] truncate px-3 py-2 text-xs">
                        {row.tracking_number ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-xs tabular-nums">
                        {moneyOrDash(
                          row.shipping_charged_usd ?? row.quoted_amount_usd,
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
        </div>

        <div className="flex min-h-0 flex-col gap-3 overflow-visible rounded-2xl border border-app-border bg-app-surface p-4 lg:overflow-hidden">
          <div className="flex items-center gap-2 border-b border-app-border pb-2">
            <Truck size={18} className="text-sky-600" />
            <h3 className="text-sm font-black uppercase tracking-widest text-app-text">
              Detail &amp; log
            </h3>
          </div>
          {!detailId || detailBusy ? (
            <p className="text-sm text-app-text-muted">
              {detailBusy ? "Loading…" : "Select a shipment."}
            </p>
          ) : detail ? (
            <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
              <div className="space-y-1 text-xs">
                <p>
                  <span className="font-black text-app-text-muted">ID</span>{" "}
                  <span className="font-mono">
                    {String(detail.shipment.id)}
                  </span>
                </p>
                <p>
                  <span className="font-black text-app-text-muted">Source</span>{" "}
                  {sourceLabel[String(detail.shipment.source)] ??
                    String(detail.shipment.source)}
                </p>
                <p>
                  <span className="font-black text-app-text-muted">Type</span>{" "}
                  {String(detail.shipment.direction) === "return"
                    ? "Return label"
                    : "Outbound shipment"}
                </p>
                <p>
                  <span className="font-black text-app-text-muted">
                    Destination
                  </span>{" "}
                  {fmtAddr(detail.shipment.ship_to)}
                </p>
                {detail.shipment.transaction_id ? (
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-black text-app-text-muted">
                      Transaction
                    </span>
                    <span className="font-mono">
                      {String(detail.shipment.transaction_id).slice(0, 8)}…
                    </span>
                    {onOpenTransactionInBackoffice ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenTransactionInBackoffice(
                            String(detail.shipment.transaction_id),
                          )
                        }
                        className="rounded-lg border border-app-accent/40 bg-app-accent/10 px-2 py-0.5 text-[10px] font-black uppercase text-app-accent"
                      >
                        Open transaction
                      </button>
                    ) : null}
                  </p>
                ) : null}
              </div>

              {canManage ? (
                <div className="space-y-2 rounded-xl border border-app-border bg-app-surface-2 p-3">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Update
                  </p>
                  <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                    Status
                    <select
                      className="ui-input mt-1 block w-full text-xs"
                      value={statusDraft}
                      onChange={(e) => setStatusDraft(e.target.value)}
                    >
                      <option value="draft">draft</option>
                      <option value="quoted">quoted</option>
                      <option value="label_purchased">label_purchased</option>
                      <option value="in_transit">in_transit</option>
                      <option value="delivered">delivered</option>
                      <option value="cancelled">cancelled</option>
                      <option value="exception">exception</option>
                    </select>
                  </label>
                  <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                    Tracking #
                    <input
                      className="ui-input mt-1 block w-full text-xs"
                      value={trackDraft}
                      onChange={(e) => setTrackDraft(e.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void savePatch()}
                    className="ui-btn-secondary w-full py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    Save status / tracking
                  </button>
                  <button
                    type="button"
                    disabled={ratesBusy}
                    onClick={() => void refreshRates()}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-app-border py-2 text-[10px] font-black uppercase tracking-widest"
                  >
                    <IntegrationBrandLogo
                      brand="shippo"
                      kind="icon"
                      className="inline-flex"
                      imageClassName="h-4 w-4 object-contain"
                    />
                    {ratesBusy ? "Fetching…" : "Get shipping rates"}
                  </button>
                  {rates.length > 0 ? (
                    <ul className="space-y-1">
                      {rates.map((r) => (
                        <li key={r.rate_quote_id}>
                          <button
                            type="button"
                            onClick={() => void applyRate(r.rate_quote_id)}
                            className="flex w-full items-center justify-between rounded-lg border border-app-border px-2 py-1.5 text-left text-xs hover:bg-app-surface"
                          >
                            <span>
                              {r.carrier} — {r.service_name}
                            </span>
                            <span className="tabular-nums">
                              {moneyOrDash(String(r.amount_usd))}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {(() => {
                    const sh = detail.shipment;
                    const rateRef =
                      typeof sh.shippo_rate_object_id === "string" &&
                      sh.shippo_rate_object_id.trim().length > 0;
                    const txId = String(
                      sh.shippo_transaction_object_id ?? "",
                    ).trim();
                    const labelUrl = String(sh.shipping_label_url ?? "").trim();
                    const isReturn = String(sh.direction) === "return";
                    const refundRequested = detail.events.some(
                      (ev) => ev.kind === "label_refund_requested",
                    );
                    if (!rateRef && !labelUrl && !txId) return null;
                    return (
                      <div className="space-y-2 rounded-lg border border-sky-500/30 bg-sky-500/5 p-2">
                        <div className="flex items-center gap-2">
                          <IntegrationBrandLogo
                            brand="shippo"
                            kind="icon"
                            className="inline-flex rounded-lg bg-app-surface p-1 ring-1 ring-black/5"
                            imageClassName="h-4 w-4 object-contain"
                          />
                          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            {isReturn ? "Return label" : "Label purchase"}
                          </p>
                        </div>
                        {labelUrl ? (
                          <a
                            href={labelUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="block truncate text-xs text-sky-600 underline"
                          >
                            Open label
                          </a>
                        ) : null}
                        {rateRef && !txId ? (
                          <div className="space-y-2">
                            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                              Label style
                              <select
                                value={labelFileType}
                                onChange={(event) => setLabelFileType(event.target.value)}
                                className="ui-input mt-1 h-9 w-full rounded-lg px-2 text-xs font-bold normal-case tracking-normal"
                              >
                                <option value="PDF_4X6">4x6 PDF label</option>
                                <option value="PDF">Letter PDF</option>
                                <option value="PNG">PNG image</option>
                                <option value="ZPLII">Thermal ZPLII</option>
                              </select>
                            </label>
                            <button
                              type="button"
                              disabled={labelPurchaseBusy}
                              onClick={() => void purchaseShippoLabel()}
                              className="w-full rounded-xl border-b-8 border-emerald-800 bg-emerald-600 py-2 text-[10px] font-black uppercase tracking-widest text-white shadow-lg disabled:opacity-50"
                            >
                              {labelPurchaseBusy
                                ? "Purchasing…"
                                : "Buy label"}
                            </button>
                          </div>
                        ) : null}
                        {txId ? (
                          <div className="space-y-1.5 rounded-lg border border-amber-500/20 bg-amber-500/5 p-2">
                            <p className="text-[10px] leading-relaxed text-app-text-muted">
                              {refundRequested
                                ? "A refund request is already logged for this label."
                                : "Use refund only for an unused label. Shippo decides whether the carrier accepts the refund."}
                            </p>
                            <button
                              type="button"
                              disabled={labelRefundBusy || refundRequested}
                              onClick={() => void refundShippoLabel()}
                              className="w-full rounded-xl border border-amber-500/40 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-amber-700 hover:bg-amber-500/10 disabled:opacity-50"
                            >
                              {refundRequested
                                ? "Refund request logged"
                                : labelRefundBusy
                                  ? "Requesting..."
                                  : "Request unused-label refund"}
                            </button>
                          </div>
                        ) : null}
                        {txId && !isReturn ? (
                          <div className="space-y-1.5 rounded-lg border border-sky-500/20 bg-sky-500/5 p-2">
                            <p className="text-[10px] leading-relaxed text-app-text-muted">
                              Create a return-label workflow when the customer
                              needs to ship merchandise back to the store.
                            </p>
                            <button
                              type="button"
                              disabled={returnBusy}
                              onClick={() => void createReturnShipment()}
                              className="w-full rounded-xl border border-sky-500/40 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-sky-700 hover:bg-sky-500/10 disabled:opacity-50"
                            >
                              {returnBusy
                                ? "Creating..."
                                : "Create return label"}
                            </button>
                          </div>
                        ) : null}
                        {!rateRef && !txId ? (
                          <p className="text-[10px] text-app-text-muted">
                            Apply a live rate (not demo) before buying a label.
                          </p>
                        ) : null}
                      </div>
                    );
                  })()}
                  <div className="flex gap-2">
                    <input
                      className="ui-input min-w-0 flex-1 text-xs"
                      placeholder="Staff note…"
                      value={noteDraft}
                      onChange={(e) => setNoteDraft(e.target.value)}
                    />
                    <button
                      type="button"
                      onClick={() => void saveNote()}
                      className="shrink-0 rounded-xl border border-app-border p-2 text-app-text-muted hover:bg-app-surface"
                      aria-label="Add note"
                    >
                      <StickyNote size={16} />
                    </button>
                  </div>
                </div>
              ) : null}

              <div>
                <p className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  History &amp; logs
                </p>
                <ul className="space-y-2">
                  {detail.events.length === 0 ? (
                    <li className="text-xs text-app-text-muted">
                      No events yet.
                    </li>
                  ) : (
                    detail.events.map((ev) => (
                      <li
                        key={ev.id}
                        className="rounded-lg border border-app-border/80 bg-app-surface-2/80 px-3 py-2 text-xs"
                      >
                        <div className="flex justify-between gap-2 text-[10px] font-bold uppercase text-app-text-muted">
                          <span>{ev.kind}</span>
                          <span>{new Date(ev.at).toLocaleString()}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap text-app-text">
                          {ev.message}
                        </p>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </div>
          ) : (
            <p className="text-sm text-app-text-muted">
              Could not load detail.
            </p>
          )}
        </div>
      </div>

      {newOpen
        ? createPortal(
        <div
          className="ui-overlay-backdrop !z-[200]"
          onClick={() => setNewOpen(false)}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="ui-modal relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center gap-2">
              <Package className="text-app-accent" size={20} />
              <h2
                id={titleId}
                className="text-sm font-black uppercase tracking-widest text-app-text"
              >
                New manual shipment
              </h2>
            </div>
            <div className="mb-4 space-y-2">
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                Link Customer (optional)
                <CustomerSearchInput
                  className="mt-1"
                  onSelect={(c) => {
                    setNewCustomerId(c.id);
                    setNewForm((f) => {
                      const cAddr = c as unknown as {
                        company?: string | null;
                        street1?: string | null;
                        street2?: string | null;
                        address_line1?: string | null;
                        address_line2?: string | null;
                        city?: string | null;
                        state?: string | null;
                        zip?: string | null;
                        postal_code?: string | null;
                        phone?: string | null;
                        email?: string | null;
                      };
                      return {
                        ...f,
                        name: f.name || `${c.first_name} ${c.last_name}`.trim(),
                        company: f.company || cAddr.company || "",
                        street1:
                          f.street1 ||
                          cAddr.street1 ||
                          cAddr.address_line1 ||
                          "",
                        street2:
                          f.street2 ||
                          cAddr.street2 ||
                          cAddr.address_line2 ||
                          "",
                        city: f.city || cAddr.city || "",
                        state: f.state || cAddr.state || "",
                        zip: f.zip || cAddr.zip || cAddr.postal_code || "",
                        phone: f.phone || cAddr.phone || "",
                        email: f.email || cAddr.email || "",
                      };
                    });
                  }}
                  placeholder="Search by name or phone…"
                />
              </label>
              {newCustomerId && (
                <div className="flex items-center gap-2 rounded-lg bg-emerald-500/5 border border-emerald-500/10 px-2 py-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                  <CheckCircle2 size={12} className="text-emerald-600" />
                  <span className="text-[10px] font-black uppercase text-emerald-700">
                    Linked to CRM Profile
                  </span>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="col-span-2 block text-[10px] font-bold uppercase text-app-text-muted">
                Name
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.name}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, name: e.target.value }))
                  }
                />
              </label>
              <label className="col-span-2 block text-[10px] font-bold uppercase text-app-text-muted">
                Company
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.company}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, company: e.target.value }))
                  }
                />
              </label>
              <AddressAutocompleteInput
                className="col-span-2"
                label="Street 1"
                value={newForm.street1}
                inputClassName="ui-input mt-1 w-full text-xs"
                validationContext={{
                  name: newForm.name,
                  company: newForm.company,
                  address_line2: newForm.street2,
                  country: newForm.country,
                  phone: newForm.phone,
                  email: newForm.email,
                  is_residential: newForm.is_residential,
                }}
                onChange={(value) =>
                  setNewForm((f) => ({ ...f, street1: value }))
                }
                onSelectAddress={(suggestion) =>
                  setNewForm((f) => ({
                    ...f,
                    street1: suggestion.address_line1,
                    city: suggestion.city,
                    state: suggestion.state,
                    zip: suggestion.postal_code,
                    country: suggestion.country || f.country || "US",
                  }))
                }
              />
              <label className="col-span-2 block text-[10px] font-bold uppercase text-app-text-muted">
                Street 2
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.street2}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, street2: e.target.value }))
                  }
                />
              </label>
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                City
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.city}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, city: e.target.value }))
                  }
                />
              </label>
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                State
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.state}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, state: e.target.value }))
                  }
                />
              </label>
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                ZIP
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.zip}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, zip: e.target.value }))
                  }
                />
              </label>
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                Country
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.country}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, country: e.target.value }))
                  }
                />
              </label>
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                Phone
                <input
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.phone}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, phone: e.target.value }))
                  }
                />
              </label>
              <label className="block text-[10px] font-bold uppercase text-app-text-muted">
                Email
                <input
                  type="email"
                  className="ui-input mt-1 w-full text-xs"
                  value={newForm.email}
                  onChange={(e) =>
                    setNewForm((f) => ({ ...f, email: e.target.value }))
                  }
                />
              </label>
              <label className="col-span-2 flex items-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-bold uppercase text-app-text-muted">
                <input
                  type="checkbox"
                  className="rounded border-app-border"
                  checked={newForm.is_residential}
                  onChange={(e) =>
                    setNewForm((f) => ({
                      ...f,
                      is_residential: e.target.checked,
                    }))
                  }
                />
                Residential destination
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setNewOpen(false)}
                className="ui-btn-secondary px-4 py-2 text-[10px] font-black uppercase"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void createManual()}
                className="rounded-xl border-b-8 border-emerald-800 bg-emerald-600 px-4 py-2 text-[10px] font-black uppercase text-white"
              >
                Create
              </button>
            </div>
          </div>
        </div>,
        overlayRoot,
      )
        : null}
    </div>
  );
}
