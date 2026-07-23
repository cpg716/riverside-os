import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isTauri } from "@tauri-apps/api/core";
import { transform } from "receiptline";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Gift,
  Mail,
  MessageSquare,
  Printer,
  RefreshCw,
  X,
  ArrowRight,
  Save,
} from "lucide-react";
import {
  checkReceiptPrinterConnection,
  describePrinterTarget,
  resolvePrinterTarget,
} from "../../lib/printerBridge";
import {
  prepareReceiptPayload,
  printReceiptBase64,
} from "../../lib/receiptPrint";
import { receiptHtmlToPngBase64 } from "../../lib/receiptHtmlToPng";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { enqueueFailedPrint } from "../../lib/printRetryQueue";
import { openPrintableHtml } from "../../lib/browserPrint";
import type { OrderPaymentCartLine } from "./types";

export type RefundProcessResult = {
  status: string;
  transaction_id: string;
  payment_transaction_id: string;
  refund_event_id: string;
  refund_amount: string;
  tender_amount: string;
  payment_method: string;
  payment_provider: string | null;
  provider_status: string | null;
  provider_refund_id: string | null;
  original_provider_transaction_id: string | null;
  card_brand: string | null;
  card_last4: string | null;
  message: string;
};

export interface ReceiptSummaryModalProps {
  transactionId: string | null;
  onClose: () => void;
  baseUrl: string;
  /** When set, order read/receipt use register-session authorization (no BO headers). */
  registerSessionId?: string | null;
  /** Required: POS + staff merged headers for `/api/transactions/*`. */
  getAuthHeaders: () => Record<string, string>;
  orderPaymentLines?: OrderPaymentCartLine[];
  cashChangeDueCents?: number;
  receiptTransactionLineIds?: string[];
  /** When set, append returned lines from this original transaction to an exchange receipt. */
  exchangeReturnTransactionId?: string | null;
  /** Server-issued identifier that scopes receipt content to one return/refund event. */
  refundEventId?: string | null;
  /** Original transaction used only for event-scoped receipt generation and delivery. */
  receiptEventTransactionId?: string | null;
  /** Exact confirmation returned by the just-completed refund request. */
  refundResult?: RefundProcessResult | null;
  /** A linked-card refund is still outstanding; no final receipt may be issued. */
  pendingRefundAmountCents?: number | null;
  /** Only the just-completed sale flow may auto-print. Historical receipt views stay manual. */
  autoPrintOnOpen?: boolean;
}

type OrderCustomer = {
  id: string;
  first_name: string;
  last_name: string;
  phone?: string | null;
  email?: string | null;
};

type OrderLineRow = {
  transaction_line_id: string;
  product_name: string;
  sku: string;
  quantity: number;
  is_fulfilled?: boolean;
  is_internal?: boolean;
  gift_card_load_code?: string | null;
  quantity_returned?: number;
  returned_total?: string;
};

function maskGiftCardCode(code: string | null | undefined): string | null {
  const trimmed = (code ?? "").trim();
  if (!trimmed) return null;
  const last4 = trimmed.slice(-4);
  if (!last4) return null;
  return trimmed.length <= 4 ? last4 : `••••${last4}`;
}

type OrderDetail = {
  transaction_id?: string;
  transaction_display_id?: string;
  status?: string;
  total_price?: string;
  amount_paid?: string;
  balance_due?: string;
  payment_methods_summary?: string;
  refund_payment_methods_summary?: string;
  refund_total?: string;
  payment_applications?: Array<{
    target_transaction_id: string;
    target_display_id: string;
    amount: string;
    remaining_balance: string;
  }>;
  pickup_applications?: Array<{
    target_transaction_id: string;
    target_display_id: string;
    items: Array<{
      product_name: string;
      sku: string;
      quantity: number;
    }>;
  }>;
  customer?: OrderCustomer | null;
  items?: OrderLineRow[];
  receipt_studio_layout_available?: boolean;
  receipt_thermal_mode?: string;
  store_review_invites_enabled?: boolean;
  store_send_review_invite_by_default?: boolean;
  review_invite_sent_at?: string | null;
  review_invite_suppressed_at?: string | null;
  customer_review_requests_opt_out?: boolean;
};

type ReviewInviteChoiceResult = {
  ok?: boolean;
  status?: string;
  message?: string;
  provider_id?: string | null;
  review_url?: string | null;
};

const EMPTY_ORDER_PAYMENT_LINES: OrderPaymentCartLine[] = [];
const EMPTY_RECEIPT_TRANSACTION_LINE_IDS: string[] = [];

function transactionDisplayFallback(transactionId: unknown): string {
  const normalized =
    typeof transactionId === "string" || typeof transactionId === "number"
      ? String(transactionId).trim()
      : "";
  return normalized ? normalized.slice(0, 8).toUpperCase() : "";
}

export default function ReceiptSummaryModal({
  transactionId,
  onClose,
  baseUrl,
  registerSessionId,
  getAuthHeaders,
  orderPaymentLines = EMPTY_ORDER_PAYMENT_LINES,
  cashChangeDueCents = 0,
  receiptTransactionLineIds = EMPTY_RECEIPT_TRANSACTION_LINE_IDS,
  exchangeReturnTransactionId = null,
  refundEventId = null,
  receiptEventTransactionId = null,
  refundResult = null,
  pendingRefundAmountCents = null,
  autoPrintOnOpen = false,
}: ReceiptSummaryModalProps) {
  const { toast } = useToast();
  const [printing, setPrinting] = useState(false);
  const [sendingEmail, setSendingEmail] = useState(false);
  const [sendingSms, setSendingSms] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [printingFailure, setPrintingFailure] = useState<string | null>(null);
  const [printingFailureTitle, setPrintingFailureTitle] = useState<string | null>(
    null,
  );
  const [printingFailureDetail, setPrintingFailureDetail] = useState<string | null>(null);
  const [lastPrintAttemptLabel, setLastPrintAttemptLabel] = useState<string | null>(
    null,
  );
  const [lastPrintRequest, setLastPrintRequest] = useState<
    { gift?: boolean; transactionLineIds?: string[] } | undefined
  >(undefined);
  const [printingSuccessMessage, setPrintingSuccessMessage] = useState<
    string | null
  >(null);
  const [cashDrawerKicked, setCashDrawerKicked] = useState(false);
  const [checkingPrinter, setCheckingPrinter] = useState(false);
  const [printerCheckMessage, setPrinterCheckMessage] = useState<string | null>(
    null,
  );
  const [transactionDetail, setTransactionDetail] = useState<OrderDetail | null>(null);
  const [phoneDraft, setPhoneDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [savingContact, setSavingContact] = useState(false);
  const [skipReviewInvite, setSkipReviewInvite] = useState(false);
  const [reviewInviteSaving, setReviewInviteSaving] = useState(false);
  const [giftDialogOpen, setGiftDialogOpen] = useState(false);
  const [receiptPreviewOpen, setReceiptPreviewOpen] = useState(false);
  const [receiptPreviewHtml, setReceiptPreviewHtml] = useState<string | null>(null);
  const [receiptPreviewLoading, setReceiptPreviewLoading] = useState(false);
  const [receiptPreviewError, setReceiptPreviewError] = useState<string | null>(null);
  /** Per line; only lines checked here are included on the next gift receipt. */
  const [giftLinePick, setGiftLinePick] = useState<Record<string, boolean>>({});
  const autoPrintAttemptedTransactionRef = useRef<string | null>(null);
  const receiptDeliveryTransactionId =
    receiptEventTransactionId?.trim() || transactionId;

  const buildReceiptQuery = useCallback(
    (
      extra?: { gift?: boolean; transactionLineIds?: string[] },
      includeRefundEvent = true,
    ) => {
      const sp = new URLSearchParams();
      if (registerSessionId) {
        sp.set("register_session_id", registerSessionId);
      }
      if (extra?.gift) {
        sp.set("gift", "1");
      }
      if (includeRefundEvent && refundEventId) {
        sp.set("refund_event_id", refundEventId);
        const eventQuery = sp.toString();
        return eventQuery ? `?${eventQuery}` : "";
      }
      const ids = extra?.transactionLineIds?.length
        ? extra.transactionLineIds
        : receiptTransactionLineIds;
      const refundRequest =
        ids.length > 0 &&
        ids.every((id) => {
          const item = transactionDetail?.items?.find(
            (row) => row.transaction_line_id === id,
          );
          return (
            (item?.quantity_returned ?? 0) > 0 &&
            parseMoneyToCents(item?.returned_total ?? "0") > 0
          );
        });
      if (ids.length) {
        sp.set("transaction_line_ids", ids.join(","));
      }
      if (exchangeReturnTransactionId) {
        sp.set("exchange_return_transaction_id", exchangeReturnTransactionId);
      }
      if (
        (!refundRequest && transactionDetail?.status === "fulfilled") ||
        (!refundRequest && ids.length > 0) ||
        (orderPaymentLines && orderPaymentLines.length > 0)
      ) {
        sp.set("pickup", "true");
      }
      const s = sp.toString();
      return s ? `?${s}` : "";
    },
    [
      registerSessionId,
      refundEventId,
      transactionDetail?.status,
      transactionDetail?.items,
      receiptTransactionLineIds,
      exchangeReturnTransactionId,
      orderPaymentLines,
    ],
  );

  const shouldKickCashDrawer = useCallback(() => {
    if (!isTauri()) return false;
    if (window.localStorage.getItem("ros.hardware.cashDrawer.enabled") === "false") {
      return false;
    }
    const tenderSummary = transactionDetail?.payment_methods_summary ?? "";
    return /\b(CASH|CHECK|CHEQUE)\b/i.test(tenderSummary);
  }, [transactionDetail?.payment_methods_summary]);

  const openCashDrawerForSale = useCallback(async () => {
    if (cashDrawerKicked || !shouldKickCashDrawer()) return;
    try {
      await printReceiptBase64("G3AAMvo=");
      setCashDrawerKicked(true);
    } catch (e) {
      console.error("Cash drawer kick failed", e);
      toast("Cash drawer did not open. Check the Epson receipt printer connection.", "error");
    }
  }, [cashDrawerKicked, shouldKickCashDrawer, toast]);

  useEffect(() => {
    setCashDrawerKicked(false);
    setTransactionDetail(null);
  }, [transactionId]);

  useEffect(() => {
    const rows = transactionDetail?.items;
    if (!rows?.length) {
      setGiftLinePick({});
      return;
    }
    setGiftLinePick((prev) => {
      const next = { ...prev };
      for (const it of rows) {
        if (next[it.transaction_line_id] === undefined) {
          next[it.transaction_line_id] = true;
        }
      }
      return next;
    });
  }, [transactionId, transactionDetail?.items]);

  useEffect(() => {
    if (!transactionDetail) return;
    void openCashDrawerForSale();
  }, [transactionDetail, openCashDrawerForSale]);

  useEffect(() => {
    if (!transactionId) return;
    const controller = new AbortController();
    const detailParams = new URLSearchParams();
    if (registerSessionId) {
      detailParams.set("register_session_id", registerSessionId);
    }
    const detailQuery = detailParams.toString();
    const detailUrl = `${baseUrl}/api/transactions/${transactionId}${
      detailQuery ? `?${detailQuery}` : ""
    }`;

    const fetchDetail = async () => {
      try {
        let res: Response | null = null;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            res = await fetch(detailUrl, {
              headers: getAuthHeaders(),
              cache: "no-store",
              signal: controller.signal,
            });
            if (res.ok || ![502, 503, 504].includes(res.status) || attempt === 1) {
              break;
            }
          } catch (error) {
            if (controller.signal.aborted) throw error;
            lastError = error;
            if (attempt === 1) throw error;
          }
        }
        if (!res) throw lastError ?? new Error("transaction detail request failed");
        if (res.ok) {
          const data = (await res.json()) as OrderDetail;
          if (controller.signal.aborted) return;
          setTransactionDetail(data);
          const c = data.customer;
          if (c) {
            setPhoneDraft((c.phone ?? "").trim());
            setEmailDraft((c.email ?? "").trim());
          }
        } else {
          let body: { error?: string } = {};
          try {
            body = await res.json() as { error?: string };
          } catch {
            const text = await res.text().catch(() => "");
            body = { error: text || `Could not load receipt details (${res.status})` };
          }
          toast(body.error || "Could not load receipt details.", "error");
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        console.error("Failed to fetch order detail", e);
        toast("Could not load receipt details", "error");
      }
    };
    void fetchDetail();
    return () => controller.abort();
  }, [transactionId, baseUrl, registerSessionId, getAuthHeaders, toast]);

  useEffect(() => {
    if (!transactionDetail) return;
    const eligible =
      !!transactionDetail.customer &&
      transactionDetail.store_review_invites_enabled === true &&
      !transactionDetail.review_invite_sent_at &&
      !transactionDetail.review_invite_suppressed_at &&
      transactionDetail.customer_review_requests_opt_out !== true &&
      transactionDetail.status === "fulfilled" &&
      (transactionDetail.items ?? []).length > 0 &&
      (transactionDetail.items ?? [])
        .filter((it) => !it.is_internal)
        .every((it) => it.is_fulfilled === true);
    if (eligible) {
      setSkipReviewInvite(transactionDetail.store_send_review_invite_by_default === false);
    } else {
      setSkipReviewInvite(false);
    }
  }, [transactionDetail]);

  const submitReviewInviteIfNeeded = useCallback(async () => {
    if (!transactionId || !transactionDetail) return;
    const eligible =
      !!transactionDetail.customer &&
      transactionDetail.store_review_invites_enabled === true &&
      !transactionDetail.review_invite_sent_at &&
      !transactionDetail.review_invite_suppressed_at &&
      transactionDetail.customer_review_requests_opt_out !== true &&
      transactionDetail.status === "fulfilled" &&
      (transactionDetail.items ?? []).length > 0 &&
      (transactionDetail.items ?? [])
        .filter((it) => !it.is_internal)
        .every((it) => it.is_fulfilled === true);
    if (!eligible) return;
    setReviewInviteSaving(true);
    try {
      const q = buildReceiptQuery(undefined, false);
      const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/review-invite${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ skip: skipReviewInvite }),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not save review invite choice.", "error");
        return;
      }
      const result = (await res.json().catch(() => ({}))) as ReviewInviteChoiceResult;
      if (result.status === "sent") {
        toast("Review request sent through Podium.", "success");
      } else if (result.status === "suppressed") {
        toast("Review request skipped for this sale.", "info");
      } else if (result.status === "skipped_recent_180d") {
        toast("Review request skipped. This customer was asked in the last 180 days.", "info");
      } else if (result.status === "skipped_no_contact") {
        toast("Review request skipped. Add a phone or email to ask later.", "info");
      } else if (result.status === "skipped_customer_opt_out") {
        toast("Review request skipped. This customer has opted out of review requests.", "info");
      } else if (result.status === "not_ready") {
        toast("Review request will only send after completed or picked-up sales.", "info");
      }
    } catch {
      toast("Could not save review invite choice", "error");
    } finally {
      setReviewInviteSaving(false);
    }
  }, [
    transactionId,
    transactionDetail,
    buildReceiptQuery,
    baseUrl,
    getAuthHeaders,
    skipReviewInvite,
    toast,
  ]);

  const closeWithReviewChoice = useCallback(async () => {
    await submitReviewInviteIfNeeded();
    onClose();
  }, [submitReviewInviteIfNeeded, onClose]);

  const handlePrint = useCallback(
    async (opts?: { gift?: boolean; transactionLineIds?: string[] }) => {
      if (!transactionId) return;
      const attemptLabel = opts?.gift ? "gift receipt" : "receipt";
      if (opts?.gift) {
        const ids = opts.transactionLineIds;
        if (ids !== undefined && ids.length === 0) {
          toast("Select at least one line for the gift receipt.", "error");
          return;
        }
      }
      setPrinting(true);
      setError(null);
      setPrintingFailure(null);
      setPrintingFailureTitle(null);
      setPrintingFailureDetail(null);
      setPrintingSuccessMessage(null);
      setPrinterCheckMessage(null);
      setLastPrintAttemptLabel(attemptLabel);
      setLastPrintRequest(opts);
      let printableBase64 = "";
      const printerTarget = resolvePrinterTarget("receipt");
      try {
        const q = buildReceiptQuery(
          opts?.gift || opts?.transactionLineIds?.length
            ? { gift: opts?.gift, transactionLineIds: opts?.transactionLineIds }
            : undefined,
        );

        const res = await fetch(`${baseUrl}/api/transactions/${receiptDeliveryTransactionId}/receipt.escpos${q}`, {
          headers: getAuthHeaders(),
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Receipt generation failed");
        const escposPayload = (await res.json()) as {
          escpos_base64?: string;
          receiptline_markdown?: string;
        };
        const prepared = prepareReceiptPayload(
          {
            escposBase64: escposPayload.escpos_base64,
            receiptlineMarkdown: escposPayload.receiptline_markdown,
          },
          { cpl: 48, preferReceiptline: true },
        );

        printableBase64 = prepared.printableBase64;
        await printReceiptBase64(printableBase64, printerTarget);
        setPrintingSuccessMessage(
          `${opts?.gift ? "Gift receipt" : "Receipt"} sent to the station printer.`,
        );
      } catch (e: unknown) {
        console.error("Printing failed", e);
        const message = "Receipt did not print. Check the receipt printer, then use Reprint Receipt.";
        setError(message);
        setPrintingFailureTitle(
          opts?.gift ? "Gift receipt did not print" : "Receipt did not print",
        );
        setPrintingFailure(
          `${message} The transaction is already recorded. Retry printing, run printer check, or send the receipt by SMS or email.`,
        );
        const detail = e instanceof Error ? e.message : String(e);
        setPrintingFailureDetail(
          `Target: ${describePrinterTarget(printerTarget)}. Error: ${detail}`,
        );
        // Queue for retry from the POS header
        if (transactionId && printableBase64.trim()) {
          void enqueueFailedPrint({
            transactionId,
            label: opts?.gift ? "Gift receipt" : "Receipt",
            printableBase64,
          });
        }
      } finally {
        setPrinting(false);
      }
    },
    [
      transactionId,
      receiptDeliveryTransactionId,
      baseUrl,
      buildReceiptQuery,
      getAuthHeaders,
      toast,
    ],
  );

  const runPrinterCheck = useCallback(async () => {
    setCheckingPrinter(true);
    setPrinterCheckMessage(null);
    try {
      const printer = resolvePrinterTarget("receipt");
      await checkReceiptPrinterConnection(printer);
      setPrinterCheckMessage(
        `Receipt printer responded at ${describePrinterTarget(printer)}. You can retry printing now.`,
      );
    } catch (e) {
      console.error("Printer check failed", e);
      const message = "Printer connection failed.";
      setPrinterCheckMessage(
        `${message} Verify printer power, cable/network path, and station printer settings before retrying.`,
      );
    } finally {
      setCheckingPrinter(false);
    }
  }, []);

  useEffect(() => {
    if (
      autoPrintOnOpen &&
      pendingRefundAmountCents == null &&
      transactionId &&
      transactionDetail &&
      autoPrintAttemptedTransactionRef.current !== transactionId &&
      localStorage.getItem("ros.hardware.printer.receipt.autoPrint") === "true"
    ) {
      autoPrintAttemptedTransactionRef.current = transactionId;
      void handlePrint();
    }
  }, [
    autoPrintOnOpen,
    pendingRefundAmountCents,
    transactionId,
    transactionDetail,
    handlePrint,
  ]);

  const getGiftLineIds = (): string[] =>
    (transactionDetail?.items ?? [])
      .filter((it) => giftLinePick[it.transaction_line_id])
      .map((it) => it.transaction_line_id);

  const saveCustomerContact = async () => {
    const cid = transactionDetail?.customer?.id;
    if (!cid) return;
    setSavingContact(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/${encodeURIComponent(cid)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({
          phone: phoneDraft.trim() || null,
          email: emailDraft.trim() || null,
        }),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not save contact. Manager access may be needed.", "error");
        return;
      }
      toast("Customer contact updated", "success");
      setTransactionDetail((prev) =>
        prev?.customer
          ? {
              ...prev,
              customer: {
                ...prev.customer,
                phone: phoneDraft.trim() || null,
                email: emailDraft.trim() || null,
              },
            }
          : prev,
      );
    } catch {
      toast("Could not save contact", "error");
    } finally {
      setSavingContact(false);
    }
  };

  const sendEmailReceipt = async (variant: "standard" | "gift") => {
    if (!transactionId) return;
    const gift = variant === "gift";
    if (gift) {
      const rows = transactionDetail?.items ?? [];
      if (rows.length > 0 && getGiftLineIds().length === 0) {
        toast("Select at least one line for the gift receipt.", "error");
        return;
      }
    }
    const typed = emailDraft.trim();
    const onFile = transactionDetail?.customer?.email?.trim() ?? "";
    if (!typed && !onFile) {
      toast("Add an email address first (or save contact).", "error");
      return;
    }
    setSendingEmail(true);
    try {
      const q = buildReceiptQuery();
      const baseBody: {
        to_email?: string;
        gift?: boolean;
        transaction_line_ids?: string[];
      } = typed ? { to_email: typed } : {};
      if (gift) {
        baseBody.gift = true;
        const rows = transactionDetail?.items ?? [];
        const picked = getGiftLineIds();
        if (rows.length > 0 && picked.length > 0 && picked.length < rows.length) {
          baseBody.transaction_line_ids = picked;
        }
      }
      const res = await fetch(`${baseUrl}/api/transactions/${receiptDeliveryTransactionId}/receipt/send-email${q}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify(baseBody),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not email receipt.", "error");
        return;
      }
      toast(gift ? "Gift receipt emailed" : "Receipt emailed", "success");
    } catch (e) {
      console.error(e);
      toast("Could not email receipt", "error");
    } finally {
      setSendingEmail(false);
    }
  };

  const sendSmsReceipt = async (variant: "standard" | "gift") => {
    if (!transactionId) return;
    const gift = variant === "gift";
    if (gift) {
      const rows = transactionDetail?.items ?? [];
      if (rows.length > 0 && getGiftLineIds().length === 0) {
        toast("Select at least one line for the gift receipt.", "error");
        return;
      }
    }
    const typed = phoneDraft.trim();
    const onFile = transactionDetail?.customer?.phone?.trim() ?? "";
    if (!typed && !onFile) {
      toast("Add a phone number first (or save contact).", "error");
      return;
    }
    setSendingSms(true);
    try {
      const rows = transactionDetail?.items ?? [];
      const picked = getGiftLineIds();
      const giftItemParam =
        gift && rows.length > 0 && picked.length > 0 && picked.length < rows.length
          ? picked
          : undefined;
      const htmlQ = buildReceiptQuery(
        gift ? { gift: true, transactionLineIds: giftItemParam } : undefined,
      );

      let pngBase64: string | undefined;
      if (transactionDetail?.receipt_studio_layout_available) {
        try {
          const hres = await fetch(`${baseUrl}/api/transactions/${receiptDeliveryTransactionId}/receipt.html${htmlQ}`, {
            headers: getAuthHeaders(),
            cache: "no-store",
          });
          if (hres.ok) {
            const html = await hres.text();
            if (!html.toLowerCase().includes("no receipt builder html")) {
              pngBase64 = await receiptHtmlToPngBase64(html);
            }
          }
        } catch (e) {
          console.warn("Receipt PNG for SMS skipped", e);
        }
      }

      const postQ = buildReceiptQuery();
      const payload: {
        to_phone?: string;
        png_base64?: string;
        gift?: boolean;
        transaction_line_ids?: string[];
      } = {};
      if (typed) payload.to_phone = typed;
      if (pngBase64) payload.png_base64 = pngBase64;
      if (gift) {
        payload.gift = true;
        if (rows.length > 0 && picked.length > 0 && picked.length < rows.length) {
          payload.transaction_line_ids = picked;
        }
      }

      const res = await fetch(`${baseUrl}/api/transactions/${receiptDeliveryTransactionId}/receipt/send-sms${postQ}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        await res.json().catch(() => ({}));
        toast("Could not text receipt.", "error");
        return;
      }
      const j = (await res.json().catch(() => ({}))) as { mode?: string };
      const okMsg =
        j.mode === "mms_attachment"
          ? gift
            ? "Gift receipt image sent (MMS)"
            : "Receipt image sent (MMS)"
          : gift
            ? "Gift receipt text sent"
            : "Receipt text sent";
      toast(okMsg, "success");
    } catch (e) {
      console.error(e);
      toast("Could not text receipt", "error");
    } finally {
      setSendingSms(false);
    }
  };

  if (!transactionId) return null;

  const cust = transactionDetail?.customer;
  const itemRows = transactionDetail?.items ?? [];
  const phoneOnFile = transactionDetail?.customer?.phone?.trim() ?? "";
  const emailOnFile = transactionDetail?.customer?.email?.trim() ?? "";
  const hasSmsTarget = Boolean(phoneDraft.trim() || phoneOnFile);
  const hasEmailTarget = Boolean(emailDraft.trim() || emailOnFile);
  const contactChanged =
    phoneDraft.trim() !== phoneOnFile || emailDraft.trim() !== emailOnFile;
  const loadedGiftCards = Array.from(
    new Set(
      itemRows
        .map((it) => maskGiftCardCode(it.gift_card_load_code))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const giftPickEmpty = itemRows.length > 0 && getGiftLineIds().length === 0;
  const reviewInviteEligible =
    !!transactionDetail?.customer &&
    transactionDetail.store_review_invites_enabled === true &&
    !transactionDetail.review_invite_sent_at &&
    !transactionDetail.review_invite_suppressed_at &&
    transactionDetail.customer_review_requests_opt_out !== true &&
    transactionDetail.status === "fulfilled" &&
    itemRows.length > 0 &&
    itemRows.filter((it) => !it.is_internal).every((it) => it.is_fulfilled === true);
  const serverOrderPayments = transactionDetail?.payment_applications ?? [];
  const displayedOrderPayments =
    serverOrderPayments.length > 0
      ? serverOrderPayments.map((payment) => ({
          key: `${payment.target_transaction_id}:${payment.target_display_id}`,
          targetDisplayId: payment.target_display_id,
          amount: payment.amount,
          remainingBalance: payment.remaining_balance,
        }))
      : orderPaymentLines.map((line) => ({
          key: line.cart_row_id,
          targetDisplayId: line.target_display_id,
          amount: line.amount,
          remainingBalance: line.projected_balance_after,
        }));
  const orderPaymentTotalCents = displayedOrderPayments.reduce(
    (sum, line) => sum + parseMoneyToCents(line.amount),
    0,
  );
  const pickupApplications = transactionDetail?.pickup_applications ?? [];
  const transactionTotalCents = parseMoneyToCents(transactionDetail?.total_price ?? "0");
  const exchangeCheckout = Boolean(exchangeReturnTransactionId);
  const refundCheckout =
    !exchangeCheckout &&
    (Boolean(refundEventId || refundResult) ||
      (receiptTransactionLineIds.length > 0 &&
        receiptTransactionLineIds.every((id) => {
          const item = itemRows.find((row) => row.transaction_line_id === id);
          return (
            (item?.quantity_returned ?? 0) > 0 &&
            parseMoneyToCents(item?.returned_total ?? "0") > 0
          );
        })));
  const pickupCheckout =
    !refundCheckout && !exchangeCheckout && receiptTransactionLineIds.length > 0;
  const paymentOnlyCheckout =
    !refundCheckout &&
    !exchangeCheckout &&
    !pickupCheckout &&
    transactionTotalCents === 0 &&
    orderPaymentTotalCents > 0;
  const linkedPickupCheckout =
    !refundCheckout && !exchangeCheckout && !pickupCheckout && pickupApplications.length > 0;
  const giftReceiptAvailable =
    !refundCheckout &&
    !paymentOnlyCheckout &&
    itemRows.some((item) => item.is_internal !== true);
  const exactRefundAmountCents = refundResult
    ? Math.abs(parseMoneyToCents(refundResult.refund_amount))
    : null;
  const currentCheckoutAmountCents = refundCheckout
    ? -(exactRefundAmountCents ?? 0)
    : pickupCheckout || paymentOnlyCheckout
      ? orderPaymentTotalCents
      : parseMoneyToCents(transactionDetail?.amount_paid ?? "0");
  const activityLabel = refundCheckout
    ? "Return and refund recorded"
    : exchangeCheckout
      ? "Return and replacement recorded"
      : pickupCheckout
        ? currentCheckoutAmountCents > 0
          ? "Pickup and payment recorded"
          : "Pickup completed"
        : paymentOnlyCheckout
          ? "Payment applied to an existing Transaction Record"
          : linkedPickupCheckout && orderPaymentTotalCents > 0
            ? "Sale, pickup, and payment recorded"
            : linkedPickupCheckout
              ? "Sale and pickup recorded"
              : orderPaymentTotalCents > 0
                ? "Sale and payment recorded"
                : "Sale recorded";
  const completionTitle = refundCheckout
    ? pendingRefundAmountCents != null
      ? "Refund pending"
      : "Refund complete"
    : exchangeCheckout
      ? pendingRefundAmountCents != null
        ? "Refund pending"
        : "Exchange complete"
      : pickupCheckout
        ? "Pickup complete"
        : paymentOnlyCheckout
          ? "Payment recorded"
          : linkedPickupCheckout
            ? "Sale and pickup complete"
            : orderPaymentTotalCents > 0
              ? "Sale and payment complete"
              : "Sale complete";
  const completionKind = refundCheckout
    ? "Refund"
    : exchangeCheckout
      ? "Exchange"
      : pickupCheckout
        ? "Pickup"
        : paymentOnlyCheckout
          ? "Payment"
          : "Sale";
  const totalLabel = refundCheckout
    ? "Total refunded"
    : exchangeCheckout
      ? "Replacement total"
      : pickupCheckout || paymentOnlyCheckout
        ? "Collected now"
        : "Sale total";
  const summaryTotal =
    refundCheckout
      ? exactRefundAmountCents == null
        ? "…"
        : `-${centsToFixed2(exactRefundAmountCents)}`
      : pickupCheckout || paymentOnlyCheckout
        ? centsToFixed2(currentCheckoutAmountCents)
      : transactionDetail?.total_price ?? transactionDetail?.amount_paid ?? "…";
  const summaryPaid = transactionDetail?.amount_paid ?? "…";
  const summaryBalance = transactionDetail?.balance_due ?? "…";
  const refundProviderLabel =
    refundResult?.payment_provider?.trim() ||
    refundResult?.payment_method.replaceAll("_", " ").trim() ||
    "Refund tender";
  const refundStatusLabel =
    refundResult?.provider_status?.trim() || refundResult?.status.trim() || "Recorded";
  const refundCardLabel = refundResult
    ? [
        refundResult.card_brand?.trim().toUpperCase(),
        refundResult.card_last4?.trim()
          ? `•••• ${refundResult.card_last4.trim()}`
          : null,
      ]
        .filter(Boolean)
        .join(" ")
    : "";
  const customerName = transactionDetail?.customer
    ? `${transactionDetail.customer.first_name} ${transactionDetail.customer.last_name}`.trim()
    : "Walk-in customer";

  const runGiftPrint = () => {
    if (giftPickEmpty) {
      toast(
        "Select at least one line for the gift receipt (or keep all lines checked).",
        "error",
      );
      return;
    }
    const ids = getGiftLineIds();
    void handlePrint({
      gift: true,
      transactionLineIds: ids.length > 0 && ids.length < itemRows.length ? ids : undefined,
    });
  };

  const fetchReceiptHtml = async (
    opts?: { gift?: boolean; transactionLineIds?: string[] },
  ) => {
    if (!transactionId) throw new Error("Missing transaction.");
    const q = buildReceiptQuery(opts);
    const res = await fetch(
      `${baseUrl}/api/transactions/${receiptDeliveryTransactionId}/receipt.html${q}`,
      {
        headers: getAuthHeaders(),
        cache: "no-store",
      },
    );
    if (!res.ok) throw new Error("Receipt preview could not load.");
    return res.text();
  };

  const fetchReceiptPreviewMarkup = async (
    opts?: { gift?: boolean; transactionLineIds?: string[] },
  ) => {
    if (!transactionId) throw new Error("Missing transaction.");
    const q = buildReceiptQuery(opts);
    try {
      const res = await fetch(`${baseUrl}/api/transactions/${receiptDeliveryTransactionId}/receipt.escpos${q}`, {
        headers: getAuthHeaders(),
        cache: "no-store",
      });
      if (res.ok) {
        const payload = (await res.json()) as { receiptline_markdown?: string };
        if (payload.receiptline_markdown?.trim()) {
          return String(
            transform(payload.receiptline_markdown, {
              cpl: 48,
              encoding: "cp437",
              spacing: false,
              margin: "full",
            }),
          );
        }
      }
    } catch (e) {
      console.warn("ReceiptLine preview unavailable; falling back to HTML receipt", e);
    }
    return fetchReceiptHtml(opts);
  };

  const openReceiptPreview = async () => {
    setReceiptPreviewOpen(true);
    setReceiptPreviewLoading(true);
    setReceiptPreviewError(null);
    setReceiptPreviewHtml(null);
    try {
      setReceiptPreviewHtml(await fetchReceiptPreviewMarkup());
    } catch (e) {
      console.error("Receipt preview failed", e);
      setReceiptPreviewError("Receipt preview could not load.");
    } finally {
      setReceiptPreviewLoading(false);
    }
  };

  const printReceiptOnReportPrinter = async () => {
    try {
      let content = receiptPreviewHtml ?? (await fetchReceiptPreviewMarkup());

      if (content.trim().startsWith("<svg")) {
        content = `
          <!DOCTYPE html>
          <html>
            <head>
              <title>Receipt Preview</title>
              <style>
                body {
                  margin: 0;
                  min-height: 100vh;
                  display: flex;
                  justify-content: center;
                  background: #f0f0f0;
                }
                .receipt-container {
                  width: 360px;
                  padding: 24px 16px;
                }
                svg {
                  width: 100%;
                  height: auto;
                }
                @media print {
                  body { background: white; }
                  .receipt-container { padding: 0; width: 80mm; max-width: 80mm; }
                }
              </style>
            </head>
            <body>
              <div class="receipt-container">
                ${content}
              </div>
            </body>
          </html>
        `;
      }

      await openPrintableHtml(content, "Receipt Copy", {
        filename: "riverside-receipt-copy.html",
        width: 420,
        height: 760,
      });
      toast("Receipt opened for the reports printer.", "success");
    } catch (e) {
      console.error("Receipt print view failed", e);
      toast("Could not open receipt print view.", "error");
    }
  };

  const compactActionButton =
    "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text shadow-sm transition-colors hover:bg-app-surface-3 disabled:opacity-50 touch-manipulation";

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <>
      <div className="ui-overlay-backdrop !z-[200] p-2 sm:p-4">
        <div
          className="w-full max-w-none overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-[0_32px_64px_-16px_rgba(0,0,0,0.35)] animate-in zoom-in-95 duration-200 dark:shadow-[0_32px_64px_-12px_rgba(0,0,0,0.65)] sm:max-w-4xl"
          role="dialog"
          aria-modal="true"
          aria-labelledby="receipt-summary-title"
        >
          <div
            className="flex max-h-[calc(100dvh-1rem)] flex-col overflow-hidden text-app-text sm:max-h-[calc(100dvh-2rem)]"
            data-testid="receipt-summary-modal"
          >
            <header className="relative flex shrink-0 items-center gap-3 border-b border-app-border px-3 py-3 pr-14 sm:px-5 sm:py-4 sm:pr-16">
              <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ring-1 sm:h-12 sm:w-12 ${
                pendingRefundAmountCents != null
                  ? "bg-app-warning/15 text-app-warning ring-app-warning/35"
                  : "bg-[color-mix(in_srgb,var(--app-success)_18%,var(--app-surface-2))] text-[var(--app-success)] ring-[color-mix(in_srgb,var(--app-success)_35%,var(--app-border))]"
              }`}>
                {pendingRefundAmountCents != null ? (
                  <AlertTriangle className="h-6 w-6 sm:h-7 sm:w-7" strokeWidth={1.5} />
                ) : (
                  <CheckCircle2 className="h-6 w-6 sm:h-7 sm:w-7" strokeWidth={1.5} />
                )}
              </div>
              <div className="min-w-0 text-left">
                <h2
                  id="receipt-summary-title"
                  className="text-lg font-black uppercase italic tracking-tighter text-app-text sm:text-2xl"
                >
                  {completionTitle}
                </h2>
                <p className="line-clamp-2 text-[9px] font-bold uppercase tracking-wider text-app-text-muted sm:text-[10px] sm:tracking-widest">
                  {activityLabel} · {customerName} · Transaction #{transactionDetail?.transaction_display_id ?? transactionDisplayFallback(transactionId)}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void closeWithReviewChoice()}
                disabled={reviewInviteSaving}
                className="absolute right-3 top-3 flex min-h-10 min-w-10 items-center justify-center rounded-full border border-app-border bg-app-surface-2 text-app-text-muted transition-colors hover:bg-app-surface-3 hover:text-app-text sm:right-4 sm:top-4 touch-manipulation disabled:opacity-50"
                aria-label="Close"
              >
                <X size={18} />
              </button>
            </header>

            <section className="shrink-0 border-b border-app-border bg-app-surface px-3 py-2.5 sm:px-5 sm:py-3" aria-label="Receipt actions">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <button
                  type="button"
                  disabled={
                    printing ||
                    !transactionDetail ||
                    pendingRefundAmountCents != null
                  }
                  onClick={() => void handlePrint()}
                  className="col-span-2 inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border-b-4 border-emerald-800 bg-emerald-600 px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-md transition-all hover:bg-emerald-500 active:scale-[0.99] disabled:opacity-60 touch-manipulation sm:col-span-1"
                >
                  <Printer className="h-4 w-4 shrink-0" />
                  {printing ? "Generating…" : "Print receipt"}
                </button>
                <button
                  type="button"
                  disabled={!transactionDetail || pendingRefundAmountCents != null}
                  onClick={() => void openReceiptPreview()}
                  className={compactActionButton}
                >
                  <Eye className="h-4 w-4 shrink-0" />
                  View receipt
                </button>
                <button
                  type="button"
                  disabled={
                    sendingSms ||
                    !transactionDetail ||
                    !hasSmsTarget ||
                    pendingRefundAmountCents != null
                  }
                  onClick={() => void sendSmsReceipt("standard")}
                  className={compactActionButton}
                >
                  <MessageSquare className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-300" />
                  {sendingSms ? "Sending…" : "Text receipt"}
                </button>
                <button
                  type="button"
                  disabled={
                    sendingEmail ||
                    !transactionDetail ||
                    !hasEmailTarget ||
                    pendingRefundAmountCents != null
                  }
                  onClick={() => void sendEmailReceipt("standard")}
                  className={compactActionButton}
                >
                  <Mail className="h-4 w-4 shrink-0 text-sky-700 dark:text-sky-300" />
                  {sendingEmail ? "Sending…" : "Email receipt"}
                </button>
                <button
                  type="button"
                  disabled={!transactionDetail || !giftReceiptAvailable}
                  onClick={() => setGiftDialogOpen(true)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-violet-500 bg-[color-mix(in_srgb,violet_16%,var(--app-surface-2))] px-3 text-[10px] font-black uppercase tracking-widest text-violet-800 shadow-sm transition-colors hover:bg-[color-mix(in_srgb,violet_24%,var(--app-surface-2))] disabled:opacity-50 dark:text-violet-200"
                >
                  <Gift className="h-4 w-4 shrink-0" />
                  Gift receipt
                </button>
              </div>
            </section>

            <div className="grid min-h-0 flex-1 content-start gap-3 p-3 sm:grid-cols-[minmax(0,1.05fr)_minmax(18rem,0.95fr)] sm:p-4 lg:gap-4 lg:px-5">
              <div className="min-w-0 space-y-3">
                {pendingRefundAmountCents != null ? (
                  <section
                    className="rounded-2xl border border-app-warning/40 bg-app-warning/10 px-3 py-3 sm:px-4"
                    aria-label="Refund pending approval"
                    data-testid="refund-pending-panel"
                  >
                    <div className="flex items-start gap-3">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-app-warning" />
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-warning">
                          Original-card refund not approved
                        </p>
                        <p className="mt-1 text-xl font-black tabular-nums text-app-text">
                          ${centsToFixed2(pendingRefundAmountCents)} pending
                        </p>
                        <p className="mt-1 text-[11px] font-semibold leading-relaxed text-app-text">
                          The exchange and returned items are saved, but Helcim has
                          not approved this refund. Finish it from the refund queue.
                          Receipt printing and delivery stay unavailable until the
                          provider refund is complete.
                        </p>
                      </div>
                    </div>
                  </section>
                ) : null}

                {refundResult ? (
                  <section
                    className="rounded-2xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-3 sm:px-4"
                    aria-label="Refund approval confirmation"
                    data-testid="refund-approval-panel"
                  >
                    <div className="flex items-start gap-3">
                      <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-700 dark:text-emerald-300" />
                      <div className="min-w-0 flex-1">
                        <p className="text-[9px] font-black uppercase tracking-widest text-emerald-800 dark:text-emerald-200">
                          Refund approved
                        </p>
                        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                          <p className="text-2xl font-black tabular-nums tracking-tighter text-app-text">
                            ${centsToFixed2(exactRefundAmountCents ?? 0)}
                          </p>
                          <p className="text-[10px] font-black uppercase tracking-wider text-app-text">
                            {refundProviderLabel} · {refundStatusLabel}
                          </p>
                        </div>
                        <p className="mt-1 text-[11px] font-semibold leading-relaxed text-app-text">
                          {refundResult.message}
                        </p>
                        {(refundCardLabel ||
                          refundResult.provider_refund_id ||
                          refundResult.original_provider_transaction_id) ? (
                          <div className="mt-2 space-y-0.5 border-t border-emerald-500/20 pt-2 text-[9px] font-semibold text-app-text-muted">
                            {refundCardLabel ? <p>Card: {refundCardLabel}</p> : null}
                            {refundResult.provider_refund_id ? (
                              <p className="break-all">
                                Refund reference: {refundResult.provider_refund_id}
                              </p>
                            ) : null}
                            {refundResult.original_provider_transaction_id ? (
                              <p className="break-all">
                                Original payment reference:{" "}
                                {refundResult.original_provider_transaction_id}
                              </p>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </section>
                ) : null}

                <section className="rounded-2xl border border-app-border bg-app-surface-2 px-3 py-3 sm:px-4" aria-label="Transaction summary">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted sm:text-[10px]">
                        {totalLabel}
                      </p>
                      <p className="text-2xl font-black tabular-nums tracking-tighter text-app-text sm:text-3xl">
                        {summaryTotal.startsWith("-")
                          ? `-$${summaryTotal.slice(1)}`
                          : `$${summaryTotal}`}
                      </p>
                    </div>
                    <div className="min-w-0 max-w-[52%] text-right">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted sm:text-[10px]">
                        {refundCheckout
                          ? "Refund method"
                          : pickupCheckout
                            ? "Tender(s) on transaction"
                            : "Tender"}
                      </p>
                      <p className="line-clamp-2 text-[11px] font-black uppercase tracking-tight text-app-text sm:text-sm">
                        {refundCheckout
                          ? refundResult
                            ? `${refundProviderLabel}${refundCardLabel ? ` · ${refundCardLabel}` : ""}`
                            : (transactionDetail?.refund_payment_methods_summary ?? "…")
                          : (transactionDetail?.payment_methods_summary ?? "…")}
                      </p>
                    </div>
                  </div>
                  {!paymentOnlyCheckout && !refundCheckout ? (
                    <div className="mt-2.5 grid grid-cols-2 gap-3 border-t border-app-border/50 pt-2.5">
                      <div>
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Paid on transaction
                        </p>
                        <p className="mt-0.5 text-base font-black tabular-nums text-app-success sm:text-lg">
                          {summaryPaid.startsWith("-")
                            ? `-$${summaryPaid.slice(1)}`
                            : `$${summaryPaid}`}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          Balance due
                        </p>
                        <p className="mt-0.5 text-base font-black tabular-nums text-app-warning sm:text-lg">
                          ${summaryBalance}
                        </p>
                      </div>
                    </div>
                  ) : null}
                </section>

                {printingFailure ? (
                  <section className="rounded-2xl border border-app-danger/30 bg-app-danger/10 px-3 py-3" aria-label="Receipt print recovery">
                    <div className="flex items-start gap-2.5">
                      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-app-danger" strokeWidth={2} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[9px] font-black uppercase tracking-widest text-app-danger">
                          {completionKind} succeeded · {printingFailureTitle ?? "Receipt did not print"}
                        </p>
                        <p className="mt-1 text-[11px] font-semibold leading-relaxed text-app-text">
                          {printingFailure}
                        </p>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={printing}
                        onClick={() => void handlePrint(lastPrintRequest)}
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-app-danger/30 bg-app-surface px-2 text-[9px] font-black uppercase tracking-wider text-app-danger transition-colors hover:bg-app-danger/10 disabled:opacity-50"
                      >
                        <RefreshCw className="h-4 w-4" />
                        {printing ? "Retrying…" : `Retry ${lastPrintAttemptLabel ?? "print"}`}
                      </button>
                      <button
                        type="button"
                        disabled={checkingPrinter}
                        onClick={() => void runPrinterCheck()}
                        className="inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface px-2 text-[9px] font-black uppercase tracking-wider text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50"
                      >
                        <Printer className="h-4 w-4" />
                        {checkingPrinter ? "Checking…" : "Check printer"}
                      </button>
                    </div>
                    {printerCheckMessage ? (
                      <p className="mt-2 text-[9px] font-semibold leading-relaxed text-app-text-muted">
                        {printerCheckMessage}
                      </p>
                    ) : null}
                    {printingFailureDetail ? (
                      <p className="mt-2 break-words text-[9px] font-semibold leading-relaxed text-app-text-muted">
                        {printingFailureDetail}
                      </p>
                    ) : null}
                  </section>
                ) : printingSuccessMessage ? (
                  <p className="flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-[10px] font-bold text-app-text">
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-700 dark:text-emerald-200" />
                    {printingSuccessMessage}
                  </p>
                ) : null}

                {(cashChangeDueCents > 0 ||
                  loadedGiftCards.length > 0 ||
                  displayedOrderPayments.length > 0 ||
                  pickupApplications.length > 0) ? (
                  <section className="space-y-2 rounded-2xl border border-app-border bg-app-surface-2 px-3 py-2.5" aria-label="Completion details">
                    {cashChangeDueCents > 0 ? (
                      <div className="flex items-center justify-between gap-3 text-sm font-black text-emerald-700 dark:text-emerald-200">
                        <span>Change due</span>
                        <span className="tabular-nums">${centsToFixed2(cashChangeDueCents)}</span>
                      </div>
                    ) : null}
                    {loadedGiftCards.length > 0 ? (
                      <div className="text-[10px] font-semibold text-app-text">
                        <span className="font-black uppercase tracking-wider text-violet-700 dark:text-violet-300">
                          Gift card loaded ·
                        </span>{" "}
                        {loadedGiftCards.join(", ")}
                      </div>
                    ) : null}
                    {displayedOrderPayments.map((payment) => (
                      <div key={payment.key} className="flex items-baseline justify-between gap-3 text-[10px] font-bold text-app-text">
                        <span className="min-w-0 truncate">Payment on {payment.targetDisplayId}</span>
                        <span className="shrink-0 tabular-nums">
                          ${payment.amount} · ${payment.remainingBalance} due
                        </span>
                      </div>
                    ))}
                    {pickupApplications.map((pickup) => {
                      const itemCount = pickup.items.reduce(
                        (sum, item) => sum + Math.max(0, item.quantity),
                        0,
                      );
                      return (
                        <div key={pickup.target_transaction_id} className="flex items-baseline justify-between gap-3 text-[10px] font-bold text-app-text">
                          <span className="min-w-0 truncate">Picked up from {pickup.target_display_id}</span>
                          <span className="shrink-0 tabular-nums">
                            {itemCount} {itemCount === 1 ? "item" : "items"}
                          </span>
                        </div>
                      );
                    })}
                  </section>
                ) : null}
              </div>

              <div className="min-w-0 space-y-3">
                {cust ? (
                  <section className="rounded-2xl border border-app-border bg-app-surface-2 p-3" aria-label="Receipt delivery contact">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Receipt contact · {cust.first_name} {cust.last_name}
                      </p>
                      <p className="shrink-0 text-[8px] font-semibold text-app-text-muted">Save changes to profile</p>
                    </div>
                    <div className="mt-2 grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2">
                      <label className="min-w-0">
                        <span className="text-[8px] font-bold uppercase tracking-wider text-app-text-muted">Mobile</span>
                        <input
                          type="tel"
                          value={phoneDraft}
                          onChange={(e) => setPhoneDraft(e.target.value)}
                          className="ui-input mt-0.5 min-h-9 w-full px-2 text-xs"
                          placeholder="Mobile"
                          autoComplete="tel"
                        />
                      </label>
                      <label className="min-w-0">
                        <span className="text-[8px] font-bold uppercase tracking-wider text-app-text-muted">Email</span>
                        <input
                          type="email"
                          value={emailDraft}
                          onChange={(e) => setEmailDraft(e.target.value)}
                          className="ui-input mt-0.5 min-h-9 w-full px-2 text-xs"
                          placeholder="Email"
                          autoComplete="email"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={() => void saveCustomerContact()}
                        disabled={savingContact || !contactChanged}
                        className="mt-[14px] inline-flex min-h-9 items-center justify-center gap-1 rounded-xl border border-app-border bg-app-surface px-2 text-[8px] font-black uppercase tracking-wider text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50 touch-manipulation"
                      >
                        <Save size={12} />
                        {savingContact ? "Saving…" : "Save"}
                      </button>
                    </div>
                    {!hasSmsTarget || !hasEmailTarget ? (
                      <p className="mt-1.5 text-[9px] font-semibold text-app-warning">
                        Add the missing {(!hasSmsTarget && !hasEmailTarget) ? "mobile and email" : !hasSmsTarget ? "mobile" : "email"} to enable that receipt option.
                      </p>
                    ) : null}
                  </section>
                ) : (
                  <p className="rounded-xl border border-amber-500/35 bg-[color-mix(in_srgb,var(--app-warning)_12%,var(--app-surface-2))] px-3 py-2 text-left text-[9px] font-semibold uppercase tracking-wide text-app-text">
                    Walk-in — print and view remain available. Text and email require a customer on file.
                  </p>
                )}

                {reviewInviteEligible ? (
                  <section className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-app-border bg-app-surface-2 p-3" aria-label="Review request">
                    <div className="min-w-0 flex-1">
                      <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">Review request</p>
                      <p className="mt-0.5 text-[9px] font-semibold text-app-text-muted">Eligible after this completed handoff; at most once per 180 days.</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button
                        type="button"
                        aria-pressed={!skipReviewInvite}
                        onClick={() => setSkipReviewInvite(false)}
                        className={`min-h-9 rounded-xl border px-3 text-[9px] font-black uppercase tracking-wider ${
                          !skipReviewInvite
                            ? "border-app-success bg-app-success/10 text-app-success"
                            : "border-app-border bg-app-surface text-app-text-muted"
                        }`}
                      >
                        Send
                      </button>
                      <button
                        type="button"
                        aria-pressed={skipReviewInvite}
                        onClick={() => setSkipReviewInvite(true)}
                        className={`min-h-9 rounded-xl border px-3 text-[9px] font-black uppercase tracking-wider ${
                          skipReviewInvite
                            ? "border-app-warning bg-app-warning/10 text-app-warning"
                            : "border-app-border bg-app-surface text-app-text-muted"
                        }`}
                      >
                        Skip
                      </button>
                    </div>
                  </section>
                ) : transactionDetail?.customer_review_requests_opt_out === true ? (
                  <p className="rounded-xl border border-app-warning/20 bg-app-warning/5 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-app-warning">
                    This customer has opted out of review requests.
                  </p>
                ) : transactionDetail?.review_invite_sent_at || transactionDetail?.review_invite_suppressed_at ? (
                  <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-app-text-muted">
                    Review invite choice already saved for this transaction.
                  </p>
                ) : transactionDetail?.store_review_invites_enabled === false && transactionDetail?.status === "fulfilled" && !!transactionDetail?.customer ? (
                  <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[9px] font-semibold uppercase tracking-wide text-app-text-muted">
                    Review invites are off in Back Office → Settings → Reviews.
                  </p>
                ) : null}
              </div>
            </div>

            {error && !printingFailure ? (
              <p className="shrink-0 px-3 pb-2 text-center text-[9px] font-black uppercase tracking-widest text-[var(--app-danger)]">
                {error}
              </p>
            ) : null}

            <footer className="shrink-0 border-t border-app-border bg-app-surface px-3 py-2.5 sm:px-5 sm:py-3">
              <button
                type="button"
                onClick={() => void closeWithReviewChoice()}
                disabled={reviewInviteSaving}
                className="group flex min-h-12 w-full items-center justify-between rounded-2xl bg-app-accent px-4 py-1.5 text-white shadow-lg transition-all hover:opacity-90 active:scale-[0.99] touch-manipulation disabled:opacity-60"
              >
                <div className="flex flex-col text-left">
                  <span className="text-[8px] font-black uppercase tracking-widest text-white/80">Next guest</span>
                  <span className="text-sm font-black tracking-tight">
                    {reviewInviteSaving ? "Saving review preference…" : "Begin new sale"}
                  </span>
                </div>
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-app-surface text-app-accent shadow-lg transition-transform group-hover:translate-x-0.5">
                  <ArrowRight className="h-[18px] w-[18px]" />
                </div>
              </button>
            </footer>
          </div>
        </div>
      </div>

      {giftDialogOpen ? (
        <div
          className="ui-overlay-backdrop !z-[220] items-end justify-center p-0 sm:items-center sm:p-4"
        >
          <div
            className="w-full max-w-none overflow-hidden rounded-t-3xl border border-app-border bg-app-surface text-app-text shadow-2xl sm:max-w-2xl sm:rounded-3xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="gift-receipt-dialog-title"
          >
            <div className="flex items-center justify-between border-b border-app-border px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-violet-600/15 text-violet-700 dark:text-violet-300">
                  <Gift className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300">
                    Gift receipt
                  </p>
                  <h3 id="gift-receipt-dialog-title" className="text-lg font-black tracking-tight">
                    Choose lines and delivery
                  </h3>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setGiftDialogOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-surface-3 hover:text-app-text"
                aria-label="Close gift receipt"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="max-h-[80dvh] space-y-4 overflow-y-auto p-4 sm:max-h-[70dvh] sm:p-5">
              {itemRows.length > 0 ? (
                <ul className="space-y-2 text-left">
                  {itemRows.map((it) => (
                    <li key={it.transaction_line_id}>
                      <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-3 touch-manipulation">
                        <input
                          type="checkbox"
                          checked={giftLinePick[it.transaction_line_id] !== false}
                          onChange={(e) =>
                            setGiftLinePick((p) => ({
                              ...p,
                              [it.transaction_line_id]: e.target.checked,
                            }))
                          }
                          className="mt-0.5 h-5 w-5 shrink-0 rounded border border-app-input-border bg-app-surface accent-[var(--app-accent)]"
                        />
                        <span className="min-w-0 text-sm font-bold leading-snug text-app-text">
                          <span className="tabular-nums">{it.quantity}×</span>{" "}
                          {it.product_name}
                          <span className="block text-[10px] font-semibold text-app-text-muted">
                            {it.sku}
                          </span>
                          {it.gift_card_load_code ? (
                            <span className="mt-1 block text-[10px] font-semibold text-violet-700 dark:text-violet-300">
                              Gift card {maskGiftCardCode(it.gift_card_load_code)}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-3 text-sm font-semibold text-app-text-muted">
                  Line items are not shown here. Gift receipts still include every item from this sale.
                </p>
              )}
              {cust ? (
                <p className="rounded-xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-semibold text-app-text-muted">
                  Text and email use the phone/email currently shown on the sale complete screen.
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-3">
                <button
                  type="button"
                  disabled={printing || giftPickEmpty}
                  onClick={() => void runGiftPrint()}
                  className="inline-flex min-h-12 items-center justify-center gap-2 rounded-xl border border-violet-500 bg-violet-600 px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-md hover:bg-violet-500 disabled:opacity-50"
                >
                  <Printer className="h-4 w-4" />
                  {printing ? "Printing…" : "Print"}
                </button>
                <button
                  type="button"
                  disabled={sendingSms || giftPickEmpty}
                  onClick={() => void sendSmsReceipt("gift")}
                  className={compactActionButton}
                >
                  <MessageSquare className="h-4 w-4" />
                  {sendingSms ? "Sending…" : "Text"}
                </button>
                <button
                  type="button"
                  disabled={sendingEmail || giftPickEmpty}
                  onClick={() => void sendEmailReceipt("gift")}
                  className={compactActionButton}
                >
                  <Mail className="h-4 w-4" />
                  {sendingEmail ? "Sending…" : "Email"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {receiptPreviewOpen ? (
        <div
          className="ui-overlay-backdrop !z-[220] items-end justify-center p-0 sm:items-center sm:p-4"
        >
          <div
            className="flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl border border-app-border bg-app-surface text-app-text shadow-2xl sm:max-h-[88dvh] sm:max-w-4xl sm:rounded-3xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="receipt-preview-dialog-title"
          >
            <div className="flex items-center justify-between border-b border-app-border px-5 py-4">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Receipt preview
                </p>
                <h3 id="receipt-preview-dialog-title" className="text-lg font-black tracking-tight">
                  Transaction #{transactionDetail?.transaction_display_id ?? transactionDisplayFallback(transactionId)}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setReceiptPreviewOpen(false)}
                className="flex h-11 w-11 items-center justify-center rounded-full border border-app-border bg-app-surface-2 text-app-text-muted hover:bg-app-surface-3 hover:text-app-text"
                aria-label="Close receipt preview"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 p-5 lg:grid-cols-[minmax(0,1fr)_14rem]">
              <div className="min-h-[28rem] overflow-auto rounded-2xl border border-app-border bg-white">
                {receiptPreviewLoading ? (
                  <div className="flex h-full items-center justify-center text-sm font-bold text-app-text-muted">
                    Loading receipt…
                  </div>
                ) : receiptPreviewError ? (
                  <div className="flex h-full items-center justify-center px-6 text-center text-sm font-bold text-app-danger">
                    {receiptPreviewError}
                  </div>
                ) : receiptPreviewHtml?.trim().startsWith("<svg") ? (
                  <div className="min-h-full overflow-x-auto rounded-[2rem] bg-white p-4 shadow-inner sm:p-6">
                    <div
                      className="receiptline-preview mx-auto w-full max-w-[360px] [&_svg]:h-auto [&_svg]:w-full"
                      dangerouslySetInnerHTML={{ __html: receiptPreviewHtml }}
                    />
                  </div>
                ) : (
                  <iframe
                    title="Receipt preview"
                    srcDoc={receiptPreviewHtml ?? ""}
                    className="h-full min-h-[28rem] w-full bg-white"
                  />
                )}
              </div>
              <div className="space-y-2">
                <button
                  type="button"
                  disabled={printing || !transactionDetail}
                  onClick={() => void handlePrint()}
                  className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border-b-8 border-emerald-800 bg-emerald-600 px-3 text-[10px] font-black uppercase tracking-widest text-white shadow-md hover:bg-emerald-500 disabled:opacity-50"
                >
                  <Printer className="h-4 w-4" />
                  Receipt printer
                </button>
                <button
                  type="button"
                  disabled={!transactionDetail}
                  onClick={() => void printReceiptOnReportPrinter()}
                  className={`${compactActionButton} w-full`}
                >
                  <Printer className="h-4 w-4" />
                  Reports printer
                </button>
                <p className="text-[10px] font-semibold leading-relaxed text-app-text-muted">
                  Receipt printer sends to the station thermal printer. Reports printer opens the formatted receipt for the workstation report printer.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>,
    root,
  );
}
