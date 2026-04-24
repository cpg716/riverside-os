import { getBaseUrl } from "../../lib/apiConfig";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { useEffect, useMemo, useRef, useState } from "react";

export interface AddressSuggestion {
  id: string;
  label: string;
  address_line1: string;
  city: string;
  state: string;
  postal_code: string;
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

const MIN_LOOKUP_LENGTH = 8;

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
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([]);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const blurTimerRef = useRef<number | null>(null);
  const trimmedValue = value.trim();

  useEffect(() => {
    if (readOnly || trimmedValue.length < MIN_LOOKUP_LENGTH) {
      setSuggestions([]);
      setBusy(false);
      setLookupFailed(false);
      return;
    }

    const ac = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        setBusy(true);
        setLookupFailed(false);
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
            return;
          }
          const data = (await res.json()) as AddressSuggestion[];
          const next = Array.isArray(data) ? data.slice(0, 5) : [];
          setSuggestions(next);
          setOpen(next.length > 0);
        } catch {
          if (!ac.signal.aborted) {
            setSuggestions([]);
            setLookupFailed(true);
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
    if (busy) return "Checking address...";
    if (lookupFailed) return "Address lookup unavailable. Manual entry is okay.";
    return "";
  }, [busy, lookupFailed, readOnly, trimmedValue.length]);

  const handleBlur = () => {
    blurTimerRef.current = window.setTimeout(() => setOpen(false), 120);
  };

  const handleFocus = () => {
    if (blurTimerRef.current) window.clearTimeout(blurTimerRef.current);
    if (suggestions.length > 0) setOpen(true);
  };

  return (
    <label className={`relative block text-[10px] font-black uppercase tracking-widest text-app-text-muted ${className}`}>
      {label}
      <input
        readOnly={readOnly}
        value={value}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        className={inputClassName}
        placeholder={placeholder}
        autoComplete="street-address"
      />
      {statusText ? (
        <span className="mt-1 block text-[10px] font-semibold normal-case tracking-normal text-app-text-muted">
          {statusText}
        </span>
      ) : null}
      {open && suggestions.length > 0 ? (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-xl border border-app-border bg-app-surface shadow-xl">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion.id}
              type="button"
              className="block w-full px-3 py-2 text-left text-xs font-semibold normal-case tracking-normal text-app-text transition hover:bg-app-surface-2"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onSelectAddress(suggestion);
                setOpen(false);
              }}
            >
              <span className="block truncate">{suggestion.label}</span>
              <span className="block truncate text-[10px] font-bold text-app-text-muted">
                {suggestion.city}, {suggestion.state} {suggestion.postal_code}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </label>
  );
}
