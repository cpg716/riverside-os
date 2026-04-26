import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useRef, useState } from "react";
import { CreditCard, Loader2, X } from "lucide-react";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useToast } from "../ui/ToastProviderLogic";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";

const baseUrl = getBaseUrl();

const NUM_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "0"];

/** Response from GET /api/gift-cards/code/:code */
type GiftCardLookupRow = {
  id: string;
  code: string;
  card_kind: string;
  card_status: string;
  current_balance: string | number;
  original_value?: string | number | null;
  customer_name?: string | null;
};

interface Props {
  open: boolean;
  onClose: () => void;
  getHeaders: () => HeadersInit;
  /** Adds internal POS gift card load line; server credits the card only when the sale is fully paid. */
  onAddToCart: (code: string, amountCents: number) => void;
}

export default function RegisterGiftCardLoadModal({
  open,
  onClose,
  getHeaders,
  onAddToCart,
}: Props) {
  const { toast } = useToast();
  useShellBackdropLayer(open);
  const [amountBuffer, setAmountBuffer] = useState("");
  const [cardCode, setCardCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewRow, setPreviewRow] = useState<GiftCardLookupRow | null>(null);
  const [previewIsNew, setPreviewIsNew] = useState(false);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const previewAbortRef = useRef<AbortController | null>(null);
  const { dialogRef, titleId } = useDialogAccessibility(open, {
    onEscape: onClose,
    closeOnEscape: !busy,
  });

  const clearPreview = useCallback(() => {
    previewAbortRef.current?.abort();
    previewAbortRef.current = null;
    setPreviewLoading(false);
    setPreviewError(null);
    setPreviewRow(null);
    setPreviewIsNew(false);
  }, []);

  const runCardLookup = useCallback(
    async (rawCode: string, signal?: AbortSignal) => {
      const code = rawCode.trim().toUpperCase();
      if (code.length < 4) return;
      setPreviewLoading(true);
      setPreviewError(null);
      setPreviewRow(null);
      setPreviewIsNew(false);
      try {
        const res = await fetch(
          `${baseUrl}/api/gift-cards/code/${encodeURIComponent(code)}`,
          { headers: getHeaders(), signal },
        );
        if (signal?.aborted) return;
        if (res.ok) {
          const row = (await res.json()) as GiftCardLookupRow;
          setPreviewRow(row);
          setPreviewIsNew(false);
          return;
        }
        if (res.status === 404) {
          setPreviewIsNew(true);
          return;
        }
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setPreviewError(b.error ?? "Could not look up this code");
      } catch (e) {
        if (signal?.aborted || (e instanceof DOMException && e.name === "AbortError"))
          return;
        setPreviewError("Network error while looking up the card");
      } finally {
        if (!signal?.aborted) setPreviewLoading(false);
      }
    },
    [getHeaders],
  );

  useEffect(() => {
    if (!open) return;
    setAmountBuffer("");
    setCardCode("");
    setBusy(false);
    clearPreview();
    const t = window.requestAnimationFrame(() => codeInputRef.current?.focus());
    return () => window.cancelAnimationFrame(t);
  }, [open, clearPreview]);

  useEffect(() => {
    if (!open) return;
    const code = cardCode.trim();
    if (code.length < 4) {
      clearPreview();
      return;
    }
    previewAbortRef.current?.abort();
    const ac = new AbortController();
    previewAbortRef.current = ac;
    const t = window.setTimeout(() => {
      void runCardLookup(code, ac.signal);
    }, 400);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [cardCode, open, runCardLookup, clearPreview]);

  const appendAmountKey = useCallback((key: string) => {
    setAmountBuffer((prev) => {
      if (key === ".") {
        if (prev.includes(".")) return prev;
        return prev.length === 0 ? "0." : `${prev}.`;
      }
      if (prev === "0" && key !== ".") return key;
      const next = prev + key;
      const parts = next.split(".");
      if (parts.length > 1 && parts[1] && parts[1].length > 2) return prev;
      return next;
    });
  }, []);

  const clearAmount = useCallback(() => setAmountBuffer(""), []);

  const submit = () => {
    const cents = parseMoneyToCents(amountBuffer.trim() || "0");
    if (!Number.isFinite(cents) || cents <= 0) {
      toast("Enter a load amount greater than zero.", "error");
      return;
    }
    const code = cardCode.trim();
    if (code.length < 4) {
      toast("Scan or type the full card code (at least 4 characters).", "error");
      return;
    }
    if (previewRow && previewRow.card_kind.toLowerCase() !== "purchased") {
      toast("This code is not a purchased gift card. Use Back Office for other card types.", "error");
      return;
    }
    if (previewRow && previewRow.card_status.toLowerCase() === "void") {
      toast("This card is void and cannot be loaded.", "error");
      return;
    }
    setBusy(true);
    try {
      onAddToCart(code.toUpperCase(), cents);
      toast(
        "Added to cart. The card is credited only when this sale is fully paid.",
        "success",
      );
      clearPreview();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  const displayAmount = `$${centsToFixed2(parseMoneyToCents(amountBuffer || "0"))}`;
  const loadCents = parseMoneyToCents(amountBuffer.trim() || "0");
  const loadAmountLabel =
    Number.isFinite(loadCents) && loadCents > 0
      ? `$${centsToFixed2(loadCents)}`
      : "—";

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal flex max-h-[96dvh] w-full max-w-none flex-col overflow-hidden rounded-t-3xl outline-none sm:max-h-[90vh] sm:w-[min(44rem,calc(100vw-1.25rem))] sm:rounded-3xl"
      >
        <div className="flex shrink-0 items-center justify-between border-b border-app-border/70 bg-app-surface-2 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-app-success text-white shadow-lg shadow-app-success/20">
              <CreditCard className="h-5 w-5" aria-hidden />
            </div>
            <div>
              <h2
                id={titleId}
                className="text-lg font-black uppercase tracking-tight text-app-text"
              >
                Gift card
              </h2>
              <p className="text-[10px] font-bold uppercase tracking-wide text-app-text-muted">
                Add to cart · credits when the sale is fully paid
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="ui-touch-target rounded-xl text-app-text-muted hover:bg-app-surface-2"
            aria-label="Close"
          >
            <X size={22} aria-hidden />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-4 sm:grid-cols-2 sm:gap-6 sm:overflow-hidden sm:p-6">
          <div className="flex min-h-0 flex-col gap-3">
            <p className="text-xs leading-snug text-app-text-muted">
              Key the value, then scan the card. Complete checkout to activate
              the balance. You can remove the line from the cart before payment
              if you change your mind.
            </p>
            <div>
              <p className="mb-1.5 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Load amount
              </p>
              <div className="mb-3 flex h-16 items-center justify-between rounded-2xl border-2 border-app-border/80 bg-app-surface-2/80 px-4 shadow-inner">
                <span className="text-[10px] font-black uppercase text-app-text-muted">
                  Value
                </span>
                <span className="text-3xl font-black tabular-nums text-app-text">
                  {displayAmount}
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {NUM_KEYS.map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy}
                    onClick={() => appendAmountKey(k)}
                    className="flex h-12 items-center justify-center rounded-xl border border-app-border/60 bg-app-surface-2 text-lg font-black text-app-text transition-colors hover:bg-app-surface sm:h-[3.25rem] sm:text-xl"
                  >
                    {k}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={busy}
                  onClick={clearAmount}
                  className="col-span-3 flex h-11 items-center justify-center rounded-xl bg-app-danger/10 text-xs font-black uppercase tracking-widest text-app-danger transition-colors hover:bg-app-danger/15"
                >
                  Clear amount
                </button>
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col gap-4">
            <div className="shrink-0 space-y-2">
              <label
                htmlFor="register-gc-code"
                className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
              >
                Card code
              </label>
              <input
                ref={codeInputRef}
                id="register-gc-code"
                type="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={busy}
                value={cardCode}
                onChange={(e) => setCardCode(e.target.value.toUpperCase())}
                onBlur={() => {
                  const c = cardCode.trim();
                  if (c.length >= 4) void runCardLookup(c);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  e.preventDefault();
                  const c = (e.currentTarget as HTMLInputElement).value.trim();
                  if (c.length >= 4) void runCardLookup(c);
                }}
                placeholder="Scan barcode or type code…"
                className="ui-input min-h-[3.25rem] w-full font-mono text-lg font-bold tracking-wide"
              />
              <p className="text-[10px] leading-relaxed text-app-text-muted">
                Press <span className="font-bold text-app-text">Enter</span> or
                leave the field (<span className="font-bold text-app-text">Tab</span>
                ) to refresh immediately, or wait briefly — it also updates
                automatically while you type.
              </p>
            </div>

            <div className="ui-panel ui-tint-success flex min-h-[8.5rem] flex-1 flex-col p-3.5 sm:p-4">
              <p className="mb-3 text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Card data (before checkout)
              </p>
              {previewLoading ? (
                <div className="flex flex-1 items-center justify-center gap-2 text-app-text-muted">
                  <Loader2 className="h-5 w-5 shrink-0 animate-spin" aria-hidden />
                  <span className="text-xs font-bold">Looking up card…</span>
                </div>
              ) : previewError ? (
                <p className="text-sm font-bold text-app-danger">{previewError}</p>
              ) : cardCode.trim().length < 4 ? (
                <p className="text-xs leading-relaxed text-app-text-muted">
                  Enter at least 4 characters of the code to see gift card
                  number and balance here.
                </p>
              ) : previewIsNew ? (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Gift card #
                    </dt>
                    <dd className="text-right font-mono text-base font-black text-app-text">
                      {cardCode.trim().toUpperCase()}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="shrink-0 font-black uppercase tracking-wide text-app-text-muted">
                      Status
                    </dt>
                    <dd className="text-right font-bold text-app-success">
                      New code — activates on paid checkout
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 pt-1">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Load amount
                    </dt>
                    <dd className="text-right text-lg font-black tabular-nums text-app-text">
                      {loadAmountLabel}
                    </dd>
                  </div>
                </dl>
              ) : previewRow ? (
                <dl className="space-y-2 text-sm">
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Gift card #
                    </dt>
                    <dd className="max-w-[min(100%,14rem)] break-all text-right font-mono text-base font-black text-app-text">
                      {previewRow.code}
                    </dd>
                  </div>
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Status
                    </dt>
                    <dd className="text-right font-bold capitalize text-app-text">
                      {previewRow.card_status.replace(/_/g, " ")}
                    </dd>
                  </div>
                  {previewRow.card_kind.toLowerCase() !== "purchased" ? (
                    <p className="ui-panel ui-tint-warning px-2 py-1.5 text-xs font-bold text-app-text">
                      This code is not a purchased gift card. Use Back Office to
                      manage this card type — register load only supports
                      purchased cards.
                    </p>
                  ) : null}
                  <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Current balance
                    </dt>
                    <dd className="text-right text-base font-black tabular-nums text-app-text">
                      $
                      {centsToFixed2(
                        parseMoneyToCents(String(previewRow.current_balance)),
                      )}
                    </dd>
                  </div>
                  {previewRow.customer_name ? (
                    <div className="flex justify-between gap-3 border-b border-app-border/50 pb-2">
                      <dt className="font-black uppercase tracking-wide text-app-text-muted">
                        Linked customer
                      </dt>
                      <dd className="text-right font-bold text-app-text">
                        {previewRow.customer_name}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3 pt-1">
                    <dt className="font-black uppercase tracking-wide text-app-text-muted">
                      Load amount
                    </dt>
                    <dd className="text-right text-lg font-black tabular-nums text-app-success">
                      {loadAmountLabel}
                    </dd>
                  </div>
                  {previewRow.card_status.toLowerCase() === "void" ? (
                    <p className="pt-2 text-xs font-bold text-app-danger">
                      This card is void — it cannot be loaded.
                    </p>
                  ) : null}
                </dl>
              ) : (
                <p className="text-xs text-app-text-muted">
                  Waiting for lookup…
                </p>
              )}
            </div>

            <button
              type="button"
              disabled={busy}
              onClick={() => void submit()}
              className="ui-touch-target flex h-14 w-full shrink-0 items-center justify-center rounded-2xl border-b-[6px] border-emerald-900 bg-emerald-600 text-sm font-black uppercase tracking-widest text-white shadow-xl shadow-emerald-600/25 transition-all hover:bg-emerald-500 active:translate-y-0.5 active:border-b-4 disabled:opacity-50"
            >
              {busy ? "Adding…" : "Add to cart"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
