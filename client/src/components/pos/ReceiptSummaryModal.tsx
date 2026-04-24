import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Gift,
  Mail,
  MessageSquare,
  Printer,
  RefreshCw,
  X,
  ArrowRight,
  Save,
} from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import {
  checkReceiptPrinterConnection,
  printRawEscPosBase64,
  printZplReceipt,
  resolvePrinterAddress,
} from "../../lib/printerBridge";
import { receiptHtmlToPngBase64 } from "../../lib/receiptHtmlToPng";
import { useToast } from "../ui/ToastProviderLogic";
import type { OrderPaymentCartLine } from "./types";

export interface ReceiptSummaryModalProps {
  transactionId: string | null;
  onClose: () => void;
  baseUrl: string;
  /** When set, order read/receipt use register-session authorization (no BO headers). */
  registerSessionId?: string | null;
  /** Required: POS + staff merged headers for `/api/transactions/*`. */
  getAuthHeaders: () => Record<string, string>;
  orderPaymentLines?: OrderPaymentCartLine[];
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
  amount_paid?: string;
  payment_methods_summary?: string;
  customer?: OrderCustomer | null;
  items?: OrderLineRow[];
  receipt_studio_layout_available?: boolean;
  receipt_thermal_mode?: string;
  store_review_invites_enabled?: boolean;
  store_send_review_invite_by_default?: boolean;
  review_invite_sent_at?: string | null;
  review_invite_suppressed_at?: string | null;
};

export default function ReceiptSummaryModal({
  transactionId,
  onClose,
  baseUrl,
  registerSessionId,
  getAuthHeaders,
  orderPaymentLines = [],
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
  const [lastPrintAttemptLabel, setLastPrintAttemptLabel] = useState<string | null>(
    null,
  );
  const [lastPrintRequest, setLastPrintRequest] = useState<
    { gift?: boolean; transactionLineIds?: string[] } | undefined
  >(undefined);
  const [printingSuccessMessage, setPrintingSuccessMessage] = useState<
    string | null
  >(null);
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
  /** Per line; only lines checked here are included on the next gift receipt. */
  const [giftLinePick, setGiftLinePick] = useState<Record<string, boolean>>({});

  const buildReceiptQuery = useCallback(
    (extra?: { gift?: boolean; transactionLineIds?: string[] }) => {
      const sp = new URLSearchParams();
      if (registerSessionId) {
        sp.set("register_session_id", registerSessionId);
      }
      if (extra?.gift) {
        sp.set("gift", "1");
      }
      if (extra?.transactionLineIds?.length) {
        sp.set("transaction_line_ids", extra.transactionLineIds.join(","));
      }
      const s = sp.toString();
      return s ? `?${s}` : "";
    },
    [registerSessionId],
  );

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
    if (!transactionId) return;
    const fetchDetail = async () => {
      try {
        const q = buildReceiptQuery();
        const res = await fetch(`${baseUrl}/api/transactions/${transactionId}${q}`, {
          headers: getAuthHeaders(),
          cache: "no-store",
        });
        if (res.ok) {
          const data = (await res.json()) as OrderDetail;
          setTransactionDetail(data);
          const c = data.customer;
          if (c) {
            setPhoneDraft((c.phone ?? "").trim());
            setEmailDraft((c.email ?? "").trim());
          }
        } else {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          toast(
            typeof b.error === "string" ? b.error : "Could not load receipt details",
            "error",
          );
        }
      } catch (e) {
        console.error("Failed to fetch order detail", e);
        toast("Could not load receipt details", "error");
      }
    };
    void fetchDetail();
  }, [transactionId, baseUrl, buildReceiptQuery, getAuthHeaders, toast]);

  useEffect(() => {
    if (!transactionDetail) return;
    const eligible =
      !!transactionDetail.customer &&
      transactionDetail.store_review_invites_enabled === true &&
      !transactionDetail.review_invite_sent_at &&
      !transactionDetail.review_invite_suppressed_at &&
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
      transactionDetail.status === "fulfilled" &&
      (transactionDetail.items ?? []).length > 0 &&
      (transactionDetail.items ?? [])
        .filter((it) => !it.is_internal)
        .every((it) => it.is_fulfilled === true);
    if (!eligible) return;
    setReviewInviteSaving(true);
    try {
      const q = buildReceiptQuery();
      const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/review-invite${q}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...getAuthHeaders() },
        body: JSON.stringify({ skip: skipReviewInvite }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          typeof b.error === "string" ? b.error : "Could not save review invite choice",
          "error",
        );
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
      setPrintingSuccessMessage(null);
      setPrinterCheckMessage(null);
      setLastPrintAttemptLabel(attemptLabel);
      setLastPrintRequest(opts);
      try {
        const q = buildReceiptQuery(
          opts?.gift || opts?.transactionLineIds?.length
            ? { gift: opts?.gift, transactionLineIds: opts?.transactionLineIds }
            : undefined,
        );

        const studioReady = transactionDetail?.receipt_studio_layout_available === true;

        if (studioReady && transactionDetail?.receipt_thermal_mode === "escpos_raster") {
          const hres = await fetch(`${baseUrl}/api/transactions/${transactionId}/receipt.html${q}`, {
            headers: getAuthHeaders(),
            cache: "no-store",
          });
          if (!hres.ok) throw new Error("Receipt HTML generation failed");
          const fragment = await hres.text();
          const pngB64 = await receiptHtmlToPngBase64(fragment);
          const conv = await fetch(`${baseUrl}/api/hardware/escpos-from-png`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...getAuthHeaders(),
            },
            body: JSON.stringify({ png_base64: pngB64 }),
          });
          if (!conv.ok) {
            const err = (await conv.json().catch(() => ({}))) as { error?: string };
            throw new Error(err.error ?? "Raster receipt conversion failed");
          }
          const j = (await conv.json()) as { escpos_base64?: string };
          if (typeof j.escpos_base64 !== "string" || !j.escpos_base64) {
            throw new Error("Missing ESC/POS payload from server");
          }
          const printerIp = localStorage.getItem("ros.hardware.printer.receipt.ip") || "127.0.0.1";
          const printerPort = parseInt(localStorage.getItem("ros.hardware.printer.receipt.port") || "9100", 10);
          await printRawEscPosBase64(j.escpos_base64, printerIp, printerPort);
          setPrintingSuccessMessage(
            `${opts?.gift ? "Gift receipt" : "Receipt"} sent to the station printer.`,
          );
          return;
        }

        if (studioReady && transactionDetail?.receipt_thermal_mode === "studio_html") {
          const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/receipt.html${q}`, {
            headers: getAuthHeaders(),
            cache: "no-store",
          });
          if (!res.ok) throw new Error("Receipt HTML generation failed");
          const html = await res.text();
          const w = window.open("", "_blank", "noopener,noreferrer");
          if (!w) {
            throw new Error("Popup blocked — allow popups to print the studio receipt.");
          }
          w.document.open();
          w.document.write(html);
          w.document.close();
          w.focus();
          requestAnimationFrame(() => {
            try {
              w.print();
            } catch {
              /* ignore */
            }
          });
          setPrintingSuccessMessage(
            `${opts?.gift ? "Gift receipt" : "Receipt"} opened in the print window.`,
          );
          return;
        }

        const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/receipt.zpl${q}`, {
          headers: getAuthHeaders(),
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Receipt generation failed");
        const zpl = await res.text();

        const printerIp = localStorage.getItem("ros.hardware.printer.receipt.ip") || "127.0.0.1";
        const printerPort = parseInt(localStorage.getItem("ros.hardware.printer.receipt.port") || "9100");

        if (!isTauri()) {
          throw new Error("Physical printing requires the Riverside OS Desktop App.");
        }

        await printZplReceipt(zpl, printerIp, printerPort);
        setPrintingSuccessMessage(
          `${opts?.gift ? "Gift receipt" : "Receipt"} sent to the station printer.`,
        );
      } catch (e: unknown) {
        console.error("Printing failed", e);
        const message = e instanceof Error ? e.message : "Thermal Dispatch Error";
        setError(message);
        setPrintingFailureTitle(
          opts?.gift ? "Gift receipt did not print" : "Receipt did not print",
        );
        setPrintingFailure(
          `${message} The sale is already complete. Retry printing, check the station printer, or send the receipt by SMS or email.`,
        );
      } finally {
        setPrinting(false);
      }
    },
    [transactionId, baseUrl, buildReceiptQuery, getAuthHeaders, transactionDetail, toast],
  );

  const runPrinterCheck = useCallback(async () => {
    setCheckingPrinter(true);
    setPrinterCheckMessage(null);
    try {
      const printer = resolvePrinterAddress("receipt");
      await checkReceiptPrinterConnection(printer);
      setPrinterCheckMessage(
        `Receipt printer responded at ${printer.ip}:${printer.port}. You can retry printing now.`,
      );
    } catch (e) {
      const message =
        e instanceof Error ? e.message : "Printer connection failed.";
      setPrinterCheckMessage(
        `${message} Verify printer power, cable/network path, and station printer settings before retrying.`,
      );
    } finally {
      setCheckingPrinter(false);
    }
  }, []);

  useEffect(() => {
    if (transactionDetail && localStorage.getItem("ros.hardware.printer.receipt.autoPrint") === "true") {
      void handlePrint();
    }
  }, [transactionDetail, handlePrint]);

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
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          typeof b.error === "string"
            ? b.error
            : "Could not save contact (need customers.hub_edit or use Back Office).",
          "error",
        );
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
      const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/receipt/send-email${q}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify(baseBody),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          typeof b.error === "string" ? b.error : "Could not email receipt",
          "error",
        );
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
          const hres = await fetch(`${baseUrl}/api/transactions/${transactionId}/receipt.html${htmlQ}`, {
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

      const res = await fetch(`${baseUrl}/api/transactions/${transactionId}/receipt/send-sms${postQ}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...getAuthHeaders(),
        },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        toast(
          typeof b.error === "string" ? b.error : "Could not text receipt",
          "error",
        );
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
    transactionDetail.status === "fulfilled" &&
    itemRows.length > 0 &&
    itemRows.filter((it) => !it.is_internal).every((it) => it.is_fulfilled === true);

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

  return (
    <div
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/50 dark:bg-black/70"
      style={{
        paddingTop: "max(0.75rem, env(safe-area-inset-top))",
        paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))",
        paddingLeft: "max(0.75rem, env(safe-area-inset-left))",
        paddingRight: "max(0.75rem, env(safe-area-inset-right))",
      }}
    >
      {/* 24" 1080p: lg/xl widen dialog; iPad Pro 11: md+ = two columns, 44px+ taps, dvh height */}
      <div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-[0_32px_64px_-16px_rgba(0,0,0,0.35)] animate-in zoom-in-95 duration-200 dark:shadow-[0_32px_64px_-12px_rgba(0,0,0,0.65)] sm:rounded-[2.5rem] lg:max-w-5xl xl:max-w-[72rem]">
        <div className="relative flex max-h-[min(90dvh,42rem)] flex-col gap-4 overflow-hidden p-5 text-app-text sm:gap-4 sm:p-6 lg:max-h-[min(88vh,43rem)] lg:gap-5 lg:p-7">
          <button
            type="button"
            onClick={() => void closeWithReviewChoice()}
            disabled={reviewInviteSaving}
            className="absolute right-3 top-3 z-10 flex min-h-11 min-w-11 items-center justify-center rounded-full border border-app-border bg-app-surface-2 text-app-text-muted transition-colors hover:bg-app-surface-3 hover:text-app-text sm:right-4 sm:top-4 touch-manipulation disabled:opacity-50"
            aria-label="Close"
          >
            <X size={20} />
          </button>

          <div className="flex shrink-0 items-center gap-3 pr-11 sm:pr-14">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--app-success)_18%,var(--app-surface-2))] text-[var(--app-success)] ring-1 ring-[color-mix(in_srgb,var(--app-success)_35%,var(--app-border))] sm:h-14 sm:w-14 lg:h-16 lg:w-16">
              <CheckCircle2 className="h-7 w-7 sm:h-8 sm:w-8 lg:h-9 lg:w-9" strokeWidth={1.5} />
            </div>
            <div className="min-w-0 text-left">
              <h2 className="text-xl font-black uppercase italic tracking-tighter text-app-text sm:text-2xl lg:text-3xl">
                Sale complete
              </h2>
              <p className="text-[10px] font-bold uppercase tracking-widest text-app-text-muted">
                Transaction #{transactionDetail?.transaction_display_id ?? transactionId?.split("-")[0]}
              </p>
            </div>
          </div>

          {printingFailure ? (
            <div className="shrink-0 rounded-2xl border border-app-danger/30 bg-app-danger/10 px-4 py-3 sm:px-5 sm:py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-app-danger/15 text-app-danger">
                  <AlertTriangle className="h-5 w-5" strokeWidth={2} />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-danger">
                    Sale succeeded
                  </p>
                  <h3 className="mt-1 text-sm font-black uppercase tracking-tight text-app-text sm:text-base">
                    {printingFailureTitle ?? "Receipt did not print"}
                  </h3>
                  <p className="mt-2 text-xs font-semibold leading-relaxed text-app-text">
                    {printingFailure}
                  </p>
                  <p className="mt-2 text-[10px] font-bold uppercase tracking-wide text-app-text-muted">
                    Recovery: retry {lastPrintAttemptLabel ?? "receipt"} print, run printer check, or send by SMS/email.
                  </p>
                </div>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  disabled={printing}
                  onClick={() => void handlePrint(lastPrintRequest)}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-app-danger/30 bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-danger transition-colors hover:bg-app-danger/10 disabled:opacity-50"
                >
                  <RefreshCw className="h-4 w-4" />
                  {printing ? "Retrying…" : `Retry ${lastPrintAttemptLabel ?? "print"}`}
                </button>
                <button
                  type="button"
                  disabled={checkingPrinter}
                  onClick={() => void runPrinterCheck()}
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface px-3 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50"
                >
                  <Printer className="h-4 w-4" />
                  {checkingPrinter ? "Checking printer…" : "Check station printer"}
                </button>
              </div>
              {printerCheckMessage ? (
                <p className="mt-3 text-[10px] font-semibold leading-relaxed text-app-text-muted">
                  {printerCheckMessage}
                </p>
              ) : null}
            </div>
          ) : printingSuccessMessage ? (
            <div className="shrink-0 rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-3 sm:px-5 sm:py-4">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-700 dark:text-emerald-200">
                  <CheckCircle2 className="h-5 w-5" strokeWidth={2} />
                </div>
                <div className="min-w-0">
                  <p className="text-[10px] font-black uppercase tracking-widest text-emerald-700 dark:text-emerald-200">
                    Receipt delivery
                  </p>
                  <p className="mt-1 text-xs font-semibold leading-relaxed text-app-text">
                    {printingSuccessMessage}
                  </p>
                </div>
              </div>
            </div>
          ) : null}

          <div className="shrink-0 rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 sm:px-5 sm:py-4 lg:px-6 lg:py-5">
            <div className="flex flex-wrap items-end justify-between gap-3 lg:gap-6">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted lg:text-[11px]">
                  Sale total
                </p>
                <p className="text-2xl font-black tabular-nums tracking-tighter text-app-text sm:text-3xl lg:text-4xl">
                  ${transactionDetail?.amount_paid ?? "…"}
                </p>
              </div>
              <div className="min-w-0 max-w-full text-right md:max-w-[50%]">
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted lg:text-[11px]">
                  Tender
                </p>
                <p className="line-clamp-2 text-xs font-black uppercase tracking-tight text-app-text sm:text-sm lg:text-base">
                  {transactionDetail?.payment_methods_summary ?? "…"}
                </p>
              </div>
            </div>
            {loadedGiftCards.length > 0 ? (
              <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-left">
                <p className="text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300">
                  Gift card loaded
                </p>
                <p className="mt-1 text-xs font-bold text-app-text">
                  {loadedGiftCards.join(", ")}
                </p>
              </div>
            ) : null}
            {orderPaymentLines.length > 0 ? (
              <div className="mt-3 rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-2 text-left">
                <p className="text-[10px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300">
                  Existing order payments
                </p>
                <div className="mt-2 space-y-1">
                  {orderPaymentLines.map((line) => (
                    <div
                      key={line.cart_row_id}
                      className="flex items-baseline justify-between gap-3 text-xs font-bold text-app-text"
                    >
                      <span className="min-w-0 truncate">
                        Payment on {line.target_display_id}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        ${line.amount} · remaining ${line.projected_balance_after}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid shrink-0 grid-cols-1 gap-2 sm:grid-cols-2 sm:gap-3">
            <button
              type="button"
              disabled={printing || !transactionDetail}
              onClick={() => void handlePrint()}
              className="group flex min-h-[56px] w-full items-center justify-between rounded-2xl border-b-8 border-emerald-800 bg-emerald-600 px-4 py-2 text-left text-white shadow-lg transition-all hover:bg-emerald-500 active:scale-[0.99] disabled:opacity-60 sm:min-h-[4.25rem] touch-manipulation"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-[9px] font-black uppercase tracking-widest text-emerald-950/70 lg:text-[10px]">
                  Thermal printer
                </span>
                <span className="truncate text-sm font-black tracking-tight sm:text-base lg:text-lg">
                  {printing ? "Generating…" : "Print receipt"}
                </span>
              </div>
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white/20 text-white shadow-md transition-transform group-hover:scale-105 sm:h-12 sm:w-12">
                <Printer size={22} />
              </div>
            </button>
            <button
              type="button"
              disabled={printing || !transactionDetail || giftPickEmpty}
              onClick={() => void runGiftPrint()}
              className="group flex min-h-[56px] w-full items-center justify-between rounded-2xl border-2 border-violet-500 bg-[color-mix(in_srgb,violet_22%,var(--app-surface-2))] px-4 py-2 text-left text-app-text shadow-md transition-all hover:bg-[color-mix(in_srgb,violet_30%,var(--app-surface-2))] active:scale-[0.99] disabled:opacity-60 dark:border-violet-400 sm:min-h-[4.25rem] touch-manipulation"
            >
              <div className="flex min-w-0 flex-col">
                <span className="text-[9px] font-black uppercase tracking-widest text-violet-700 dark:text-violet-300 lg:text-[10px]">
                  Gift option
                </span>
                <span className="truncate text-sm font-black tracking-tight sm:text-base lg:text-lg">
                  {printing ? "Generating…" : "Print gift receipt"}
                </span>
              </div>
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-violet-600/25 text-violet-700 dark:text-violet-300">
                <Gift size={22} strokeWidth={2} />
              </div>
            </button>
          </div>

          <div className="grid min-h-0 grid-cols-1 gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] xl:gap-4">
          {itemRows.length > 0 ? (
            <div className="rounded-2xl border border-app-border bg-app-surface-2 px-4 py-3 sm:px-5 sm:py-4">
              <div className="mb-2 flex items-center gap-2">
                <Gift className="h-4 w-4 text-violet-600 dark:text-violet-400" strokeWidth={2} />
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text">
                  Gift receipt lines
                </p>
              </div>
              <p className="mb-3 text-[9px] font-semibold leading-snug text-app-text-muted">
                Uncheck items to leave off this gift copy. SMS and email gift actions use the same
                selection. Staff names on customer receipts use first name and last initial only.
              </p>
              <ul className="mb-1 max-h-28 space-y-1.5 overflow-y-auto pr-1 text-left">
                {itemRows.map((it) => (
                  <li key={it.transaction_line_id}>
                    <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-app-border bg-app-surface px-2 py-1.5 touch-manipulation">
                      <input
                        type="checkbox"
                        checked={giftLinePick[it.transaction_line_id] !== false}
                        onChange={(e) =>
                          setGiftLinePick((p) => ({
                            ...p,
                            [it.transaction_line_id]: e.target.checked,
                          }))
                        }
                        className="mt-0.5 h-4 w-4 shrink-0 rounded border border-app-input-border bg-app-surface accent-[var(--app-accent)]"
                      />
                      <span className="min-w-0 text-[11px] font-semibold leading-snug text-app-text">
                        <span className="tabular-nums">{it.quantity}×</span> {it.product_name}
                        <span className="block text-[9px] font-normal text-app-text-muted">
                          {it.sku}
                        </span>
                        {it.gift_card_load_code ? (
                          <span className="mt-1 block text-[9px] font-semibold text-violet-700 dark:text-violet-300">
                            Gift card {maskGiftCardCode(it.gift_card_load_code)}
                          </span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </div>
          ) : transactionDetail ? (
            <p className="rounded-2xl border border-app-border bg-app-surface-2 px-3 py-2 text-[10px] font-semibold text-app-text-muted">
              Line items are not listed for this transaction here. Gift and full receipts still include all
              lines from the server when you print.
            </p>
          ) : (
            <p className="rounded-2xl border border-dashed border-app-border bg-app-surface-2 px-3 py-2 text-center text-[10px] font-semibold text-app-text-muted">
              Loading transaction…
            </p>
          )}

          {cust ? (
            <div className="flex flex-col gap-3">
              <p className="shrink-0 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Customer · {cust.first_name} {cust.last_name}
              </p>
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 md:gap-3 lg:gap-4">
                <div className="flex min-h-0 flex-col rounded-xl border border-app-border bg-app-surface-2 p-3 sm:p-4">
                  <label className="block shrink-0">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-app-text-muted md:text-[10px]">
                      Mobile
                    </span>
                    <input
                      type="tel"
                      value={phoneDraft}
                      onChange={(e) => setPhoneDraft(e.target.value)}
                      className="ui-input mt-1 min-h-11 w-full text-base md:text-base"
                      placeholder="Mobile number"
                      autoComplete="tel"
                    />
                  </label>
                  {!hasSmsTarget ? (
                    <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[10px] font-semibold leading-relaxed text-app-text">
                      SMS receipt needs a phone number on file or entered above.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    disabled={sendingSms}
                    onClick={() => void sendSmsReceipt("standard")}
                    className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-emerald-600/35 bg-[color-mix(in_srgb,var(--app-success)_14%,var(--app-surface))] px-3 text-[10px] font-black uppercase tracking-widest text-emerald-800 transition-colors hover:bg-[color-mix(in_srgb,var(--app-success)_22%,var(--app-surface))] disabled:opacity-50 dark:text-emerald-200 md:text-[11px]"
                  >
                    <MessageSquare className="h-4 w-4 shrink-0" />
                    {sendingSms ? "Sending…" : "Send SMS receipt"}
                  </button>
                  <button
                    type="button"
                    disabled={sendingSms || giftPickEmpty}
                    onClick={() => void sendSmsReceipt("gift")}
                    className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-500/40 bg-[color-mix(in_srgb,violet_12%,var(--app-surface))] px-3 text-[10px] font-black uppercase tracking-widest text-violet-800 transition-colors hover:bg-[color-mix(in_srgb,violet_18%,var(--app-surface))] disabled:opacity-50 dark:text-violet-200 md:text-[11px]"
                  >
                    <Gift className="h-4 w-4 shrink-0" />
                    {sendingSms ? "Sending…" : "Send SMS gift receipt"}
                  </button>
                </div>
                <div className="flex min-h-0 flex-col rounded-xl border border-app-border bg-app-surface-2 p-3 sm:p-4">
                  <label className="block shrink-0">
                    <span className="text-[9px] font-bold uppercase tracking-wider text-app-text-muted md:text-[10px]">
                      Email
                    </span>
                    <input
                      type="email"
                      value={emailDraft}
                      onChange={(e) => setEmailDraft(e.target.value)}
                      className="ui-input mt-1 min-h-11 w-full text-base md:text-base"
                      placeholder="Email address"
                      autoComplete="email"
                    />
                  </label>
                  {!hasEmailTarget ? (
                    <p className="mt-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[10px] font-semibold leading-relaxed text-app-text">
                      Email receipt needs an address on file or entered above.
                    </p>
                  ) : null}
                  <button
                    type="button"
                    disabled={sendingEmail}
                    onClick={() => void sendEmailReceipt("standard")}
                    className="mt-3 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-sky-600/35 bg-[color-mix(in_srgb,var(--app-accent-2)_14%,var(--app-surface))] px-3 text-[10px] font-black uppercase tracking-widest text-sky-900 transition-colors hover:bg-[color-mix(in_srgb,var(--app-accent-2)_22%,var(--app-surface))] disabled:opacity-50 dark:text-sky-200 md:text-[11px]"
                  >
                    <Mail className="h-4 w-4 shrink-0" />
                    {sendingEmail ? "Sending…" : "Send email receipt"}
                  </button>
                  <button
                    type="button"
                    disabled={sendingEmail || giftPickEmpty}
                    onClick={() => void sendEmailReceipt("gift")}
                    className="mt-2 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-xl border border-violet-500/40 bg-[color-mix(in_srgb,violet_12%,var(--app-surface))] px-3 text-[10px] font-black uppercase tracking-widest text-violet-800 transition-colors hover:bg-[color-mix(in_srgb,violet_18%,var(--app-surface))] disabled:opacity-50 dark:text-violet-200 md:text-[11px]"
                  >
                    <Gift className="h-4 w-4 shrink-0" />
                    {sendingEmail ? "Sending…" : "Send email gift receipt"}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void saveCustomerContact()}
                disabled={savingContact}
                className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-xl border border-app-border bg-app-surface-2 px-3 text-[10px] font-black uppercase tracking-widest text-app-text transition-colors hover:bg-app-surface-3 disabled:opacity-50 touch-manipulation md:text-[11px]"
              >
                <Save size={14} />
                {savingContact ? "Saving…" : "Save phone & email to account"}
              </button>
              {contactChanged ? (
                <p className="shrink-0 text-[10px] font-semibold leading-snug text-app-text-muted">
                  You can send with the contact typed above right now. Use save if this should stay on the customer account for future receipts.
                </p>
              ) : null}
              <p className="shrink-0 text-[9px] leading-snug text-app-text-muted">
                Email sends inline HTML from Receipt Builder (not an attachment). SMS uses a receipt
                image when MMS is supported; otherwise plain summary. Requires Podium in Integrations.
              </p>
              {reviewInviteEligible ? (
                <label className="flex shrink-0 cursor-pointer items-start gap-3 rounded-xl border border-app-border bg-app-surface-2 px-3 py-3 touch-manipulation">
                  <input
                    type="checkbox"
                    checked={!skipReviewInvite}
                    onChange={(e) => setSkipReviewInvite(!e.target.checked)}
                    className="mt-0.5 h-4 w-4 shrink-0 rounded border border-app-input-border bg-app-surface accent-[var(--app-accent)]"
                  />
                  <span className="text-left text-[10px] font-semibold leading-snug text-app-text">
                    Send post-sale review invite for this fully fulfilled sale. This is on by default, and staff can turn it off for this transaction.
                  </span>
                </label>
              ) : transactionDetail?.review_invite_sent_at || transactionDetail?.review_invite_suppressed_at ? (
                <p className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-app-text-muted">
                  Review invite choice already saved for this transaction.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="rounded-xl border border-amber-500/35 bg-[color-mix(in_srgb,var(--app-warning)_12%,var(--app-surface-2))] px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-app-text">
              Walk-in — no customer on file. Attach a customer on the next sale to send a receipt by
              SMS or email.
            </p>
          )}
          </div>

          <button
            type="button"
            onClick={() => void closeWithReviewChoice()}
            disabled={reviewInviteSaving}
            className="group flex min-h-[52px] w-full shrink-0 items-center justify-between rounded-2xl bg-app-accent px-4 py-2 text-white shadow-lg transition-all hover:opacity-90 active:scale-[0.99] sm:h-14 sm:min-h-0 lg:min-h-[3.75rem] touch-manipulation disabled:opacity-60"
          >
            <div className="flex flex-col text-left">
              <span className="text-[9px] font-black uppercase tracking-widest text-white/80 lg:text-[10px]">
                Next guest
              </span>
              <span className="text-sm font-black tracking-tight lg:text-base">
                {reviewInviteSaving ? "Saving review preference…" : "Begin new sale"}
              </span>
            </div>
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-app-surface text-app-accent shadow-xl transition-transform group-hover:translate-x-0.5 sm:h-12 sm:w-12">
              <ArrowRight className="h-[18px] w-[18px] sm:h-5 sm:w-5" />
            </div>
          </button>

          {error && !printingFailure ? (
            <p className="shrink-0 text-center text-[10px] font-black uppercase tracking-widest text-[var(--app-danger)]">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
