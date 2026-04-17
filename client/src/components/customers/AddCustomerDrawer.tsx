import React, { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import DetailDrawer from "../layout/DetailDrawer";
import { useToast } from "../ui/ToastProviderLogic";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { DuplicateCandidateRow } from "./CustomerWorkspaceTypes";

const baseUrl = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:3000";

interface AddCustomerForm {
  first_name: string;
  last_name: string;
  company_name: string;
  date_of_birth: string;
  anniversary_date: string;
  custom_field_1: string;
  custom_field_2: string;
  custom_field_3: string;
  custom_field_4: string;
  email: string;
  phone: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string;
  postal_code: string;
  marketing_email_opt_in: boolean;
  marketing_sms_opt_in: boolean;
  transactional_sms_opt_in: boolean;
  phone_primary_label: string;
  phone_secondary_label: string;
  phone_secondary: string;
  is_vip: boolean;
  notes: string;
}

const EMPTY_ADD_CUSTOMER_FORM: AddCustomerForm = {
  first_name: "",
  last_name: "",
  company_name: "",
  date_of_birth: "",
  anniversary_date: "",
  custom_field_1: "",
  custom_field_2: "",
  custom_field_3: "",
  custom_field_4: "",
  email: "",
  phone: "",
  address_line1: "",
  address_line2: "",
  city: "",
  state: "",
  postal_code: "",
  marketing_email_opt_in: false,
  marketing_sms_opt_in: false,
  transactional_sms_opt_in: false,
  phone_primary_label: "Primary",
  phone_secondary_label: "Secondary",
  phone_secondary: "",
  is_vip: false,
  notes: "",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STATE_RE = /^[A-Za-z]{2}$/;
const POSTAL_RE = /^\d{5}(?:-\d{4})?$/;

function formatPhoneInput(raw: string): string {
  const d = raw.replace(/\D/g, "").slice(0, 10);
  if (d.length <= 3) return d;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function AddCustomerDrawer({
  isOpen,
  onClose,
  onSaved,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );
  const [form, setForm] = useState<AddCustomerForm>(() => ({
    ...EMPTY_ADD_CUSTOMER_FORM,
  }));
  const [dupCandidates, setDupCandidates] = useState<DuplicateCandidateRow[]>(
    [],
  );
  const [dupLoading, setDupLoading] = useState(false);
  const dupAbortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [emailPromptOpen, setEmailPromptOpen] = useState(false);
  const [emailPromptValue, setEmailPromptValue] = useState("");

  const set = (k: keyof AddCustomerForm, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const email = form.email.trim();
  const state = form.state.trim();
  const postal = form.postal_code.trim();
  const phoneDigits = form.phone.replace(/\D/g, "");

  const errors = {
    first_name:
      form.first_name.trim().length === 0 ? "First name is required." : "",
    last_name:
      form.last_name.trim().length === 0 ? "Last name is required." : "",
    email:
      email.length > 0 && !EMAIL_RE.test(email)
        ? "Enter a valid email address."
        : "",
    phone:
      phoneDigits.length > 0 && phoneDigits.length < 10
        ? "Phone must be 10 digits."
        : "",
    state:
      state.length > 0 && !STATE_RE.test(state)
        ? "Use 2-letter state code."
        : "",
    postal:
      postal.length > 0 && !POSTAL_RE.test(postal)
        ? "Use ZIP format 12345 or 12345-6789."
        : "",
  };

  const identityValid =
    !errors.first_name && !errors.last_name && !errors.phone;
  const formValid =
    identityValid &&
    !errors.email &&
    !errors.phone &&
    !errors.state &&
    !errors.postal;

  const resetForm = useCallback(() => {
    setForm({ ...EMPTY_ADD_CUSTOMER_FORM });
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setEmailPromptOpen(false);
      setEmailPromptValue("");
      setErr(null);
      setTouched({});
      setDupCandidates([]);
      dupAbortRef.current?.abort();
      resetForm();
    }
  }, [isOpen, resetForm]);

  useEffect(() => {
    if (!isOpen) return;
    const em = form.email.trim();
    const fn = form.first_name.trim();
    const ln = form.last_name.trim();
    const pd = form.phone.replace(/\D/g, "");
    const emailOk = em.length > 0 && EMAIL_RE.test(em);
    const phoneOk = pd.length >= 10;
    const nameOk = fn.length > 0 && ln.length > 0;
    if (!emailOk && !phoneOk && !nameOk) {
      setDupCandidates([]);
      return;
    }
    dupAbortRef.current?.abort();
    const ac = new AbortController();
    dupAbortRef.current = ac;
    const t = window.setTimeout(() => {
      void (async () => {
        setDupLoading(true);
        try {
          const p = new URLSearchParams();
          if (emailOk) p.set("email", em);
          if (phoneOk) p.set("phone", pd);
          if (nameOk) {
            p.set("first_name", fn);
            p.set("last_name", ln);
          }
          p.set("limit", "12");
          const res = await fetch(
            `${baseUrl}/api/customers/duplicate-candidates?${p.toString()}`,
            { headers: apiAuth(), signal: ac.signal },
          );
          if (ac.signal.aborted) return;
          if (!res.ok) {
            setDupCandidates([]);
            return;
          }
          const rows = (await res.json()) as DuplicateCandidateRow[];
          setDupCandidates(Array.isArray(rows) ? rows : []);
        } catch {
          if (!ac.signal.aborted) setDupCandidates([]);
        } finally {
          if (!ac.signal.aborted) setDupLoading(false);
        }
      })();
    }, 450);
    return () => {
      window.clearTimeout(t);
      ac.abort();
    };
  }, [
    isOpen,
    form.email,
    form.phone,
    form.first_name,
    form.last_name,
    apiAuth,
  ]);

  useEffect(() => {
    if (!emailPromptOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setEmailPromptOpen(false);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [emailPromptOpen]);

  const submitToApi = async (
    resolvedEmail: string,
    skipEmailPrompt = false,
  ) => {
    setTouched({
      first_name: true,
      last_name: true,
      email: true,
      phone: true,
      state: true,
      postal: true,
    });
    if (!formValid) {
      setErr("Please fix validation errors before saving.");
      return;
    }
    if (!resolvedEmail.trim() && !skipEmailPrompt) {
      setEmailPromptValue(form.email.trim());
      setEmailPromptOpen(true);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const primaryPhone = form.phone.trim();
      const phoneLine2 = form.phone_secondary.trim();
      const phonePrimaryLabel = form.phone_primary_label.trim() || "Primary";
      const phoneSecondaryLabel =
        form.phone_secondary_label.trim() || "Secondary";
      const combinedPhone = phoneLine2
        ? `${phonePrimaryLabel}: ${primaryPhone} | ${phoneSecondaryLabel}: ${phoneLine2}`
        : `${phonePrimaryLabel}: ${primaryPhone}`;
      const payload: Record<string, unknown> = {
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        email: resolvedEmail.trim() || null,
        phone: combinedPhone,
        address_line1: form.address_line1.trim() || null,
        address_line2: form.address_line2.trim() || null,
        city: form.city.trim() || null,
        state: form.state.trim() || null,
        postal_code: form.postal_code.trim() || null,
        marketing_email_opt_in: form.marketing_email_opt_in,
        marketing_sms_opt_in: form.marketing_sms_opt_in,
        transactional_sms_opt_in: form.transactional_sms_opt_in,
      };
      const co = form.company_name.trim();
      if (co) payload.company_name = co;
      const dob = form.date_of_birth.trim();
      if (dob) payload.date_of_birth = dob;
      const ann = form.anniversary_date.trim();
      if (ann) payload.anniversary_date = ann;
      const cf1 = form.custom_field_1.trim();
      const cf2 = form.custom_field_2.trim();
      const cf3 = form.custom_field_3.trim();
      const cf4 = form.custom_field_4.trim();
      if (cf1) payload.custom_field_1 = cf1;
      if (cf2) payload.custom_field_2 = cf2;
      if (cf3) payload.custom_field_3 = cf3;
      if (cf4) payload.custom_field_4 = cf4;
      const res = await fetch(`${baseUrl}/api/customers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiAuth() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error ?? "Failed to create customer");
      }
      const created = (await res.json()) as {
        id: string;
        customer_code?: string;
      };
      if (created.customer_code) {
        toast(`Customer created — code ${created.customer_code}`, "success");
      }
      if (form.is_vip) {
        if (!hasPermission("customers.hub_edit")) {
          toast("VIP flag not saved: missing customers.hub_edit.", "error");
        } else {
          const vipRes = await fetch(`${baseUrl}/api/customers/${created.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", ...apiAuth() },
            body: JSON.stringify({ is_vip: true }),
          });
          if (!vipRes.ok) {
            const vb = (await vipRes.json().catch(() => ({}))) as {
              error?: string;
            };
            toast(vb.error ?? "Could not set VIP flag", "error");
          }
        }
      }
      if (form.notes.trim()) {
        if (!hasPermission("customers.timeline")) {
          toast("Note not saved: missing customers.timeline.", "error");
        } else {
          const noteRes = await fetch(
            `${baseUrl}/api/customers/${created.id}/notes`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json", ...apiAuth() },
              body: JSON.stringify({
                body: form.notes.trim(),
                created_by_staff_id: null,
              }),
            },
          );
          if (!noteRes.ok) {
            const nb = (await noteRes.json().catch(() => ({}))) as {
              error?: string;
            };
            toast(nb.error ?? "Could not save note", "error");
          }
        }
      }
      resetForm();
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create customer");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await submitToApi(form.email.trim());
  };

  return (
    <>
      <DetailDrawer
        isOpen={isOpen}
        onClose={onClose}
        title="Add customer"
        subtitle="Create a new customer profile."
        panelMaxClassName="max-w-3xl"
        footer={
          <div className="flex gap-3">
            <button
              type="button"
              onClick={onClose}
              className="ui-btn-secondary flex-1 py-3"
            >
              Cancel
            </button>
            <button
              type="submit"
              form="add-customer-form"
              disabled={busy}
              className="ui-btn-primary flex-1 py-3 disabled:opacity-50"
            >
              {busy ? "Saving…" : "Create customer"}
            </button>
          </div>
        }
      >
        <form
          id="add-customer-form"
          className="space-y-8"
          onSubmit={(e) => void handleSubmit(e)}
        >
          {err ? (
            <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-semibold text-red-600">
              {err}
            </p>
          ) : null}

          {(dupLoading || dupCandidates.length > 0) && (
            <div
              className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3"
              data-testid="crm-duplicate-candidates"
            >
              <p className="text-[10px] font-black uppercase tracking-widest text-amber-900">
                Possible existing customers
              </p>
              {dupLoading ? (
                <p className="mt-2 text-xs text-amber-800">Checking…</p>
              ) : (
                <ul className="mt-2 space-y-2 text-xs text-amber-950">
                  {dupCandidates.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-lg border border-amber-200/80 bg-app-surface/90 px-2 py-1.5 dark:border-amber-800/50 dark:bg-app-surface-2/80"
                    >
                      <span className="font-mono font-bold">
                        {c.customer_code}
                      </span>
                      {" — "}
                      {[c.first_name, c.last_name].filter(Boolean).join(" ") ||
                        "(no name)"}
                      {c.email ? (
                        <span className="block text-[10px] text-amber-800">
                          {c.email}
                        </span>
                      ) : null}
                      <span className="block text-[10px] font-semibold uppercase tracking-tight text-amber-700">
                        {c.match_reason.replace(/_/g, " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!dupLoading && dupCandidates.length > 0 ? (
                <p className="mt-2 text-[10px] font-semibold text-amber-900">
                  Open an existing profile in Customers if this is the same
                  person; merge tools live under customer admin when you have
                  access.
                </p>
              ) : null}
            </div>
          )}

          <section className="space-y-3" aria-labelledby="add-cust-identity">
            <h3
              id="add-cust-identity"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Identity
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                First name *
                <input
                  value={form.first_name}
                  onBlur={() => setTouched((t) => ({ ...t, first_name: true }))}
                  onChange={(e) => set("first_name", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  required
                />
                {touched.first_name && errors.first_name ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.first_name}
                  </span>
                ) : null}
              </label>
              <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Last name *
                <input
                  value={form.last_name}
                  onBlur={() => setTouched((t) => ({ ...t, last_name: true }))}
                  onChange={(e) => set("last_name", e.target.value)}
                  className="ui-input mt-1 w-full text-sm"
                  required
                />
                {touched.last_name && errors.last_name ? (
                  <span className="mt-1 block text-[11px] font-semibold text-red-600">
                    {errors.last_name}
                  </span>
                ) : null}
              </label>
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Company (optional)
              <input
                value={form.company_name}
                onChange={(e) => set("company_name", e.target.value)}
                className="ui-input mt-1 w-full text-sm"
                placeholder="Business or organization"
              />
            </label>
          </section>

          <section className="space-y-3" aria-labelledby="add-cust-contact">
            <h3
              id="add-cust-contact"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Contact
            </h3>
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Phones (primary required when provided; optional secondary)
              </p>
              <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-[150px_1fr]">
                <input
                  value={form.phone_primary_label}
                  onChange={(e) => set("phone_primary_label", e.target.value)}
                  className="ui-input text-sm"
                  placeholder="Primary label"
                />
                <div>
                  <input
                    type="tel"
                    value={form.phone}
                    onBlur={() => setTouched((t) => ({ ...t, phone: true }))}
                    onChange={(e) =>
                      set("phone", formatPhoneInput(e.target.value))
                    }
                    className="ui-input w-full text-sm"
                    placeholder="(555) 000-0000"
                  />
                  {touched.phone && errors.phone ? (
                    <span className="mt-1 block text-[11px] font-semibold text-red-600">
                      {errors.phone}
                    </span>
                  ) : null}
                </div>
                <input
                  value={form.phone_secondary_label}
                  onChange={(e) => set("phone_secondary_label", e.target.value)}
                  className="ui-input text-sm"
                  placeholder="Secondary label"
                />
                <input
                  type="tel"
                  value={form.phone_secondary}
                  onChange={(e) =>
                    set("phone_secondary", formatPhoneInput(e.target.value))
                  }
                  className="ui-input text-sm"
                  placeholder="(555) 000-0000"
                />
              </div>
            </div>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Email (optional)
              <input
                type="email"
                value={form.email}
                onBlur={() => setTouched((t) => ({ ...t, email: true }))}
                onChange={(e) => set("email", e.target.value)}
                className="ui-input mt-1 w-full text-sm"
                placeholder="customer@email.com"
              />
              {touched.email && errors.email ? (
                <span className="mt-1 block text-[11px] font-semibold text-red-600">
                  {errors.email}
                </span>
              ) : null}
            </label>
            <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Notes
              <textarea
                value={form.notes}
                onChange={(e) => set("notes", e.target.value)}
                rows={4}
                className="ui-input mt-1 w-full resize-none text-sm"
                placeholder="Fitting notes, preferences…"
              />
            </label>
          </section>

          <section className="space-y-3" aria-labelledby="add-cust-address">
            <h3
              id="add-cust-address"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Address
            </h3>
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Optional mailing address
              </p>
              <div className="mt-2 space-y-3">
                <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Address line 1
                  <input
                    value={form.address_line1}
                    onChange={(e) => set("address_line1", e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                    placeholder="123 Main St"
                  />
                </label>
                <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Address line 2
                  <input
                    value={form.address_line2}
                    onChange={(e) => set("address_line2", e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                    placeholder="Suite, unit, floor"
                  />
                </label>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    City
                    <input
                      value={form.city}
                      onChange={(e) => set("city", e.target.value)}
                      className="ui-input mt-1 w-full text-sm"
                    />
                  </label>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    State
                    <input
                      value={form.state}
                      onBlur={() => setTouched((t) => ({ ...t, state: true }))}
                      onChange={(e) =>
                        set("state", e.target.value.toUpperCase())
                      }
                      className="ui-input mt-1 w-full text-sm"
                      maxLength={2}
                    />
                    {touched.state && errors.state ? (
                      <span className="mt-1 block text-[11px] font-semibold text-red-600">
                        {errors.state}
                      </span>
                    ) : null}
                  </label>
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Postal code
                    <input
                      value={form.postal_code}
                      onBlur={() => setTouched((t) => ({ ...t, postal: true }))}
                      onChange={(e) => set("postal_code", e.target.value)}
                      className="ui-input mt-1 w-full text-sm"
                    />
                    {touched.postal && errors.postal ? (
                      <span className="mt-1 block text-[11px] font-semibold text-red-600">
                        {errors.postal}
                      </span>
                    ) : null}
                  </label>
                </div>
              </div>
            </div>
          </section>

          <details className="rounded-xl border border-app-border bg-app-surface-2 p-3 [&_summary::-webkit-details-marker]:hidden">
            <summary className="cursor-pointer select-none text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Advanced — dates and custom fields
            </summary>
            <div className="mt-3 space-y-3">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Date of birth
                  <input
                    type="date"
                    value={form.date_of_birth}
                    onChange={(e) => set("date_of_birth", e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                  />
                </label>
                <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Wedding / anniversary
                  <input
                    type="date"
                    value={form.anniversary_date}
                    onChange={(e) => set("anniversary_date", e.target.value)}
                    className="ui-input mt-1 w-full text-sm"
                  />
                </label>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {([1, 2, 3, 4] as const).map((n) => (
                  <label
                    key={n}
                    className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                  >
                    Custom field {n}
                    <input
                      value={
                        form[
                          `custom_field_${n}` as keyof AddCustomerForm
                        ] as string
                      }
                      onChange={(e) =>
                        set(
                          `custom_field_${n}` as keyof AddCustomerForm,
                          e.target.value,
                        )
                      }
                      className="ui-input mt-1 w-full text-sm"
                    />
                  </label>
                ))}
              </div>
            </div>
          </details>

          <section className="space-y-3" aria-labelledby="add-cust-prefs">
            <h3
              id="add-cust-prefs"
              className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted"
            >
              Preferences
            </h3>
            <div className="rounded-xl border border-app-border bg-app-surface-2 p-3">
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Marketing (optional)
              </p>
              <div className="mt-2 flex flex-wrap gap-3">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
                  <input
                    type="checkbox"
                    checked={form.marketing_email_opt_in}
                    onChange={(e) =>
                      set("marketing_email_opt_in", e.target.checked)
                    }
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                  Email opt-in
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
                  <input
                    type="checkbox"
                    checked={form.marketing_sms_opt_in}
                    onChange={(e) =>
                      set("marketing_sms_opt_in", e.target.checked)
                    }
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                  SMS opt-in
                </label>
                <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-app-text">
                  <input
                    type="checkbox"
                    checked={form.transactional_sms_opt_in}
                    onChange={(e) =>
                      set("transactional_sms_opt_in", e.target.checked)
                    }
                    className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
                  />
                  Operational SMS (pickup / alterations)
                </label>
              </div>
            </div>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-app-border bg-app-surface-2 px-4 py-3">
              <input
                type="checkbox"
                checked={form.is_vip}
                onChange={(e) => set("is_vip", e.target.checked)}
                className="h-4 w-4 rounded border-app-border accent-[var(--app-accent)]"
              />
              <div>
                <p className="text-sm font-semibold text-app-text">
                  VIP customer
                </p>
                <p className="text-xs text-app-text-muted">
                  Mark for priority service and special pricing.
                </p>
              </div>
            </label>
          </section>
        </form>
      </DetailDrawer>

      {emailPromptOpen && isOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 p-4 backdrop-blur-md"
              onClick={() => setEmailPromptOpen(false)}
              role="presentation"
            >
              <div
                className="ui-modal max-w-lg shadow-2xl"
                onClick={(e) => e.stopPropagation()}
                role="dialog"
                aria-modal="true"
                aria-labelledby="add-cust-email-prompt-title"
              >
                <div className="ui-modal-header">
                  <h3
                    id="add-cust-email-prompt-title"
                    className="text-base font-black text-app-text"
                  >
                    Did you ask for their email?
                  </h3>
                  <p className="text-sm text-app-text-muted">
                    Email is optional, but recommended for receipts and
                    reminders.
                  </p>
                </div>
                <div className="ui-modal-body">
                  <label className="block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Email (optional)
                    <input
                      type="email"
                      value={emailPromptValue}
                      onChange={(e) => setEmailPromptValue(e.target.value)}
                      className="ui-input mt-1 w-full text-sm"
                      placeholder="customer@email.com"
                    />
                  </label>
                </div>
                <div className="ui-modal-footer">
                  <button
                    type="button"
                    className="ui-btn-secondary flex-1 py-3"
                    onClick={() => {
                      setEmailPromptOpen(false);
                      void submitToApi("", true);
                    }}
                  >
                    Save without email
                  </button>
                  <button
                    type="button"
                    className="ui-btn-primary flex-1 py-3"
                    onClick={() => {
                      setEmailPromptOpen(false);
                      void submitToApi(emailPromptValue);
                    }}
                  >
                    Save with email
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
