import { useState, useEffect } from "react";
import {
  Elements,
  CardElement,
  useStripe,
  useElements,
} from "@stripe/react-stripe-js";
import { loadStripe, Stripe } from "@stripe/stripe-js";
import { X, ShieldCheck, Loader2, Lock } from "lucide-react";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useToast } from "../ui/ToastProviderLogic";

interface StripeVaultCardModalProps {
  customerId: string;
  baseUrl: string;
  headers: Record<string, string> | (() => HeadersInit);
  onClose: () => void;
  onSuccess: () => void;
}

const CARD_ELEMENT_OPTIONS = {
  style: {
    base: {
      color: "#ffffff",
      fontFamily: '"Outfit", sans-serif',
      fontSmoothing: "antialiased",
      fontSize: "16px",
      "::placeholder": {
        color: "rgba(255, 255, 255, 0.4)",
      },
    },
    invalid: {
      color: "#f87171",
      iconColor: "#f87171",
    },
  },
};

function VaultForm({
  customerId,
  baseUrl,
  headers,
  onClose,
  onSuccess,
}: StripeVaultCardModalProps) {
  const stripe = useStripe();
  const elements = useElements();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setBusy(true);
    setError(null);

    try {
      // 1. Get SetupIntent client secret
      const res = await fetch(
        `${baseUrl}/api/payments/customers/${customerId}/setup-intent`,
        {
          method: "POST",
          headers: mergedPosStaffHeaders(headers),
        },
      );
      if (!res.ok) throw new Error("Could not initialize vaulting session");
      const { client_secret } = await res.json();

      // 2. Confirm SetupIntent
      const cardElement = elements.getElement(CardElement);
      if (!cardElement) throw new Error("Card element not found");

      const { setupIntent, error: stripeError } = await stripe.confirmCardSetup(
        client_secret,
        {
          payment_method: {
            card: cardElement,
          },
        },
      );

      if (stripeError) {
        throw new Error(stripeError.message);
      }

      if (setupIntent?.status === "succeeded") {
        // 3. Record in local DB
        const pmRes = await fetch(
          `${baseUrl}/api/payments/customers/${customerId}/payment-methods/record`,
          {
            method: "POST",
            headers: {
              ...mergedPosStaffHeaders(headers),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              stripe_payment_method_id: setupIntent.payment_method,
              // Metadata usually comes from PM fetch, but for quick record:
              brand: "card", // Placeholder; record endpoint could fetch full PM from Stripe
              last4: "xxxx",
              exp_month: 0,
              exp_year: 0,
            }),
          },
        );

        if (!pmRes.ok) {
          console.warn("Card vaulted on Stripe but local record update failed");
        }

        toast("Payment method vaulted successfully", "info");
        onSuccess();
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Vaulting failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-xl border border-white/10 bg-black/40 p-4">
        <CardElement options={CARD_ELEMENT_OPTIONS} />
      </div>

      {error && (
        <div className="rounded-lg bg-rose-500/10 p-3 text-center text-xs font-bold text-rose-500">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-3">
        <button
          type="submit"
          disabled={!stripe || busy}
          className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 font-black uppercase tracking-widest text-white transition-all hover:bg-indigo-500 disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="animate-spin" size={18} />
          ) : (
            <Lock size={16} />
          )}
          {busy ? "Authorizing…" : "Authorize & Vault Card"}
        </button>
        <p className="text-center text-[9px] font-bold uppercase tracking-widest text-app-text-muted opacity-50">
          By vaulting, you authorize future off-session charges.
        </p>
      </div>
    </form>
  );
}

export default function StripeVaultCardModal(props: StripeVaultCardModalProps) {
  const [stripePromise, setStripePromise] =
    useState<Promise<Stripe | null> | null>(null);

  useEffect(() => {
    async function init() {
      try {
        const res = await fetch(`${props.baseUrl}/api/payments/config`, {
          headers: mergedPosStaffHeaders(props.headers),
        });
        if (!res.ok) return;
        const { stripe_public_key } = await res.json();
        if (stripe_public_key) {
          setStripePromise(loadStripe(stripe_public_key));
        }
      } catch (e) {
        console.error("Failed to load Stripe config", e);
      }
    }
    void init();
  }, [props.baseUrl, props.headers]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm animate-in fade-in duration-300">
      <div className="relative w-full max-w-md overflow-hidden rounded-[2.5rem] border border-white/10 bg-app-text p-8 shadow-2xl animate-in zoom-in-95 duration-300">
        <button
          onClick={props.onClose}
          className="absolute right-6 top-6 rounded-full p-2 text-white/40 hover:bg-white/10 hover:text-white"
        >
          <X size={20} />
        </button>

        <div className="mb-8 flex flex-col items-center text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-indigo-500/10 text-indigo-400">
            <ShieldCheck size={32} />
          </div>
          <h2 className="text-xl font-black uppercase tracking-tighter text-white">
            Secure Card Vault
          </h2>
          <p className="mt-2 text-xs font-medium text-white/40">
            Link a payment method to {props.customerId.slice(0, 8)}… profile
          </p>
        </div>

        {stripePromise ? (
          <Elements stripe={stripePromise}>
            <VaultForm {...props} />
          </Elements>
        ) : (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="animate-spin text-white/20" size={32} />
          </div>
        )}

        <div className="mt-8 flex items-center justify-center gap-2 border-t border-white/5 pt-6 opacity-30">
          <Lock size={12} className="text-white" />
          <p className="text-[9px] font-black uppercase tracking-widest text-white">
            PCI-DSS Level 1 Encrypted
          </p>
        </div>
      </div>
    </div>
  );
}
