import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { Loader2, MapPin, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export interface AddressSuggestion {
  id: string;
  label: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  state: string;
  postal_code: string;
  country?: string | null;
  source?: string | null;
}

interface AddressAutocompleteInputProps {
  value: string;
  onChange: (value: string) => void;
  onSelectAddress: (suggestion: AddressSuggestion) => void;
  label?: string;
  placeholder?: string;
  className?: string;
  inputClassName?: string;
  readOnly?: boolean;
}

const MIN_LOOKUP_LENGTH = 4;

export default function AddressAutocompleteInput({
  value,
  onChange,
  onSelectAddress,
  label = "Address line 1",
  placeholder = "123 Main St",
  className = "",
  inputClassName = "ui-input mt-1 w-full text-sm",
  readOnly = false,
}: AddressAutocompleteInputProps) {
  const { backofficeHeaders } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  const inputId = useId();
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const [lookupComplete, setLookupComplete] = useState(false);
  const blurTimerRef = useRef<number | null>(null);
  const selectedValueRef = useRef<string | null>(null);
  const trimmedValue = value.trim();

  useEffect(() => {
    if (selectedValueRef.current === trimmedValue) {
      setSuggestions([]);
      setBusy(false);
      setLookupFailed(false);
      setLookupComplete(false);
      return;
    }
    if (readOnly || trimmedValue.length < MIN_LOOKUP_LENGTH) {
      setSuggestions([]);
      setBusy(false);
      setLookupFailed(false);
      setLookupComplete(false);
      return;
    }

    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setBusy(true);
        setLookupFailed(false);
        setLookupComplete(false);
        try {
          const params = new URLSearchParams({ q: trimmedValue });
          const res = await fetch(
            `${baseUrl}/api/customers/address-suggestions?${params.toString()}`,
            {
              headers: mergedPosStaffHeaders(backofficeHeaders),
              signal: ac.signal,
            },
          );
          if (!res.ok) {
            setSuggestions([]);
            setLookupFailed(true);
            setLookupComplete(true);
            return;
          }
          const data = (await res.json()) as AddressSuggestion[];
          const next = Array.isArray(data) ? data.slice(0, 5) : [];
          setSuggestions(next);
          setOpen(next.length > 0);
          setLookupComplete(true);
        } catch {
          if (!ac.signal.aborted) {
            setSuggestions([]);
            setLookupFailed(true);
            setLookupComplete(true);
          }
        } finally {
          if (!ac.signal.aborted) setBusy(false);
        }
      })();
    }, 350);

    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [backofficeHeaders, baseUrl, readOnly, trimmedValue]);

  const statusText = useMemo(() => {
    if (readOnly || trimmedValue.length < MIN_LOOKUP_LENGTH) return "";
    if (busy) return "Searching U.S. addresses (Western NY first)...";
    if (lookupFailed) return "Address lookup unavailable. Manual entry is okay.";
    if (lookupComplete && suggestions.length === 0) return "No suggestions found. Manual entry is okay.";
    if (suggestions.length > 0) return "U.S. matches found with Western NY prioritized. Select the correct address.";
    return "";
  }, [
    busy,
    lookupComplete,
    lookupFailed,
    readOnly,
    suggestions.length,
    trimmedValue.length,
  ]);

  const handleBlur = () => {
    blurTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  };

  const handleFocus = () => {
    if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
    if (suggestions.length > 0) setOpen(true);
  };

  const selectSuggestion = (suggestion: AddressSuggestion) => {
    selectedValueRef.current = suggestion.address_line1.trim();
    onSelectAddress(suggestion);
    setSuggestions([]);
    setOpen(false);
  };

  return (
    <div className={`relative block text-[10px] font-black uppercase tracking-widest text-app-text-muted ${className}`}>
      <label htmlFor={inputId}>{label}</label>
      <div className="relative mt-1">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-app-text-muted"
        />
        <input
          id={inputId}
          readOnly={readOnly}
          value={value}
          onBlur={handleBlur}
          onFocus={handleFocus}
          onChange={(e) => {
            selectedValueRef.current = null;
            onChange(e.target.value);
            setOpen(true);
          }}
          className={`${inputClassName} mt-0 pl-9 pr-9`}
          placeholder={placeholder}
          autoComplete="address-line1"
        />
        {busy ? (
          <Loader2
            size={15}
            className="absolute right-3 top-1/2 -translate-y-1/2 animate-spin text-app-accent"
            aria-hidden
          />
        ) : null}
      </div>
      {statusText ? (
        <span
          className={`mt-1 flex items-center gap-1 text-[10px] font-semibold normal-case tracking-normal ${
            busy
              ? "text-app-accent"
              : lookupFailed
                ? "text-app-warning"
                : "text-app-text-muted"
          }`}
          aria-live="polite"
        >
          {busy ? (
            <Loader2 size={11} className="animate-spin" aria-hidden />
          ) : null}
          {statusText}
        </span>
      ) : null}
      {open && suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-2xl ring-1 ring-black/10">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs font-semibold normal-case tracking-normal text-app-text transition hover:bg-app-surface-2"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectSuggestion(suggestion)}
            >
              <MapPin size={14} className="mt-0.5 shrink-0 text-app-accent" />
              <span className="min-w-0">
                <span className="block truncate">{suggestion.address_line1}</span>
                {suggestion.address_line2 ? (
                  <span className="block truncate text-[10px] font-bold text-app-text-muted">
                    {suggestion.address_line2}
                  </span>
                ) : null}
                <span className="block truncate text-[10px] font-bold text-app-text-muted">
                  {suggestion.city}, {suggestion.state} {suggestion.postal_code}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
