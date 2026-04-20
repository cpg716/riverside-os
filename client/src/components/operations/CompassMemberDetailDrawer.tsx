import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";
import { weddingApi } from "../../lib/weddingApi";
import {
  CalendarClock,
  CreditCard,
  Ruler,
  Shirt,
  ExternalLink,
} from "lucide-react";
import type { CompassActionRow } from "../../lib/morningCompassQueue";
import DetailDrawer from "../layout/DetailDrawer";
import type {
  AppointmentRow,
  WeddingLedgerResponse,
  WeddingMember,
  WeddingPartyDetail,
} from "../../types/weddings";
import SmartButton from "../ui/SmartButton";
import { formatUsdFromCents, parseMoneyToCents, sumMoneyToCents } from "../../lib/money";
import { WEDDING_MEMBER_RETAIL_SIZE_FIELDS } from "../customers/retailMeasurementLabels";

const baseUrl = getBaseUrl();

function money(s: string) {
  return formatUsdFromCents(parseMoneyToCents(s));
}

function suitSummary(m: WeddingMember | null): string {
  if (!m) return "—";
  const parts = [m.suit, m.waist, m.vest, m.shirt, m.shoe].filter(
    (x) => x && String(x).trim(),
  );
  if (parts.length) return parts.join(" · ");
  return m.measured ? "OK" : "—";
}

interface CompassMemberDetailDrawerProps {
  row: CompassActionRow | null;
  onClose: () => void;
  onOpenFullParty: (partyId: string) => void;
}

export default function CompassMemberDetailDrawer({
  row,
  onClose,
  onOpenFullParty,
}: CompassMemberDetailDrawerProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();
  const canEditWedding = hasPermission("weddings.mutate");
  const [party, setParty] = useState<WeddingPartyDetail | null>(null);
  const [ledger, setLedger] = useState<WeddingLedgerResponse | null>(null);
  const [appts, setAppts] = useState<AppointmentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [measEditing, setMeasEditing] = useState(false);
  const [measDraft, setMeasDraft] = useState<Record<string, string>>({});
  const [measSaving, setMeasSaving] = useState(false);

  const load = useCallback(async (r: CompassActionRow) => {
    setLoading(true);
    setErr(null);
    try {
      const h = backofficeHeaders();
      const now = new Date();
      const from = new Date(now);
      from.setDate(from.getDate() - 30);
      const to = new Date(now);
      to.setDate(to.getDate() + 120);
      const aq = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
      });

      const [pRes, lRes, aRes] = await Promise.all([
        fetch(`${baseUrl}/api/weddings/parties/${r.wedding_party_id}`, { headers: h }),
        fetch(`${baseUrl}/api/weddings/parties/${r.wedding_party_id}/ledger`, { headers: h }),
        fetch(`${baseUrl}/api/weddings/appointments?${aq}`, { headers: h }),
      ]);

      if (!pRes.ok) throw new Error("Could not load party");
      const p = (await pRes.json()) as WeddingPartyDetail;
      setParty(p);

      if (lRes.ok) {
        setLedger((await lRes.json()) as WeddingLedgerResponse);
      } else {
        setLedger(null);
      }

      if (aRes.ok) {
        const all = (await aRes.json()) as AppointmentRow[];
        setAppts(
          all.filter((a) => a.wedding_member_id === r.wedding_member_id),
        );
      } else {
        setAppts([]);
      }
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "Load failed");
      setParty(null);
      setLedger(null);
      setAppts([]);
    } finally {
      setLoading(false);
    }
  }, [backofficeHeaders]);

  useEffect(() => {
    if (!row) {
      setParty(null);
      setLedger(null);
      setAppts([]);
      setErr(null);
      return;
    }
    void load(row);
  }, [row, load]);

  const member =
    party?.members.find((m) => m.id === row?.wedding_member_id) ?? null;

  useEffect(() => {
    if (!member) {
      setMeasDraft({});
      return;
    }
    const d: Record<string, string> = {};
    for (const { memberField } of WEDDING_MEMBER_RETAIL_SIZE_FIELDS) {
      const v = member[memberField];
      d[memberField] = v != null && String(v).trim() !== "" ? String(v) : "";
    }
    setMeasDraft(d);
  }, [member]);

  const memberPaid = ledger
    ? sumMoneyToCents(
        ledger.lines
          .filter(
            (l) =>
              l.wedding_member_id === row?.wedding_member_id &&
              (l.kind.toLowerCase().includes("pay") ||
                l.kind.toLowerCase().includes("sale") ||
                l.kind.toLowerCase().includes("retail")),
          )
          .map((l) => l.amount),
      ) / 100
    : 0;

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth" });
  };

  const isOpen = !!row;

  const actions =
    row && !loading && !err ? (
      <>
        <SmartButton
          icon={<Shirt size={18} aria-hidden />}
          label="Suit / sizes"
          value={suitSummary(member)}
          color="blue"
          onClick={() => scrollTo("drawer-measurements")}
        />
        <SmartButton
          icon={<CreditCard size={18} aria-hidden />}
          label="Paid (est.)"
          value={money(String(memberPaid))}
          color="emerald"
          onClick={() => scrollTo("drawer-financial")}
        />
        <SmartButton
          icon={<CalendarClock size={18} aria-hidden />}
          label="Appointments"
          value={appts.length}
          color="accent"
          onClick={() => scrollTo("drawer-appts")}
        />
      </>
    ) : null;

  return (
    <DetailDrawer
      isOpen={isOpen}
      onClose={onClose}
      title={row?.customer_name ?? ""}
      subtitle={row ? `${row.role} · ${row.party_name}` : undefined}
      actions={actions}
    >
      {!row ? null : loading ? (
        <p className="text-sm text-app-text-muted">Loading member…</p>
      ) : err ? (
        <p className="text-sm text-red-600">{err}</p>
      ) : (
        <div className="space-y-8">
          <section id="drawer-measurements">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <Ruler size={14} aria-hidden />
                Measurements
              </h3>
              {canEditWedding && member ? (
                <button
                  type="button"
                  onClick={() => setMeasEditing((e) => !e)}
                  className="rounded-lg border border-app-border px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text hover:bg-app-surface-2"
                >
                  {measEditing ? "Done" : "Edit"}
                </button>
              ) : null}
            </div>
            <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4 text-sm">
              <div className="mb-3 flex justify-between gap-4 border-b border-app-border/80 pb-2">
                <span className="text-app-text-muted">Measured</span>
                <span className="font-bold text-app-text">
                  {member?.measured ? "Yes" : "No"}
                </span>
              </div>
              {measEditing && canEditWedding && member ? (
                <div className="space-y-3">
                  <div className="grid gap-2 sm:grid-cols-2">
                    {WEDDING_MEMBER_RETAIL_SIZE_FIELDS.map(({ memberField, label }) => (
                      <label key={memberField} className="block">
                        <span className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {label}
                        </span>
                        <input
                          className="ui-input mt-1 w-full font-mono text-sm"
                          value={measDraft[memberField] ?? ""}
                          onChange={(e) =>
                            setMeasDraft((d) => ({ ...d, [memberField]: e.target.value }))
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <button
                    type="button"
                    disabled={measSaving}
                    onClick={async () => {
                      if (!member) return;
                      setMeasSaving(true);
                      try {
                        await weddingApi.updateMember(
                          member.id,
                          {
                            suit: measDraft.suit?.trim() || null,
                            waist: measDraft.waist?.trim() || null,
                            vest: measDraft.vest?.trim() || null,
                            shirt: measDraft.shirt?.trim() || null,
                            shoe: measDraft.shoe?.trim() || null,
                            activity_description: "Retail sizing updated (Compass)",
                          },
                          { headers: backofficeHeaders() },
                        );
                        toast("Saved. CRM vault and other party members sync from server.", "success");
                        setMeasEditing(false);
                        if (row) void load(row);
                      } catch {
                        toast("Could not save member sizing.", "error");
                      } finally {
                        setMeasSaving(false);
                      }
                    }}
                    className="ui-btn-primary w-full py-2 text-[10px] font-black uppercase"
                  >
                    {measSaving ? "Saving…" : "Save sizing (mirrors to CRM vault)"}
                  </button>
                </div>
              ) : (
                <dl className="grid gap-2">
                  {WEDDING_MEMBER_RETAIL_SIZE_FIELDS.map(({ memberField, label }) => {
                    const v = member?.[memberField];
                    return (
                      <div key={memberField} className="flex justify-between gap-4">
                        <dt className="text-app-text-muted">{label}</dt>
                        <dd className="font-semibold text-app-text">{v || "—"}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </div>
          </section>

          <section id="drawer-financial">
            <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Party ledger (summary)
            </h3>
            {ledger ? (
              <div className="rounded-2xl border border-app-border bg-app-surface-2/80 p-4 text-sm">
                <div className="flex justify-between border-b border-app-border/80 py-2">
                  <span className="text-app-text-muted">Party balance</span>
                  <span className="font-black text-app-text">
                    {money(ledger.summary.balance_due)}
                  </span>
                </div>
                <div className="flex justify-between py-2">
                  <span className="text-app-text-muted">Total paid (party)</span>
                  <span className="font-bold text-emerald-700">
                    {money(ledger.summary.total_paid)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-app-text-muted">
                  Member-level lines below are filtered to this groomsman.
                </p>
                <ul className="mt-3 max-h-40 space-y-2 overflow-y-auto text-xs">
                  {ledger.lines
                    .filter(
                      (l) => l.wedding_member_id === row.wedding_member_id,
                    )
                    .map((l) => (
                      <li
                        key={`${l.kind}-${l.created_at}-${l.amount}`}
                        className="flex justify-between gap-2 border-b border-app-border pb-2"
                      >
                        <span className="text-app-text-muted">{l.kind}</span>
                        <span className="font-mono font-semibold">
                          {money(l.amount)}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            ) : (
              <p className="text-sm text-app-text-muted">No ledger loaded.</p>
            )}
          </section>

          <section id="drawer-appts">
            <h3 className="mb-3 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Appointments
            </h3>
            {appts.length === 0 ? (
              <p className="text-sm text-app-text-muted">None scheduled in window.</p>
            ) : (
              <ul className="space-y-2">
                {appts.map((a) => (
                  <li
                    key={a.id}
                    className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-sm"
                  >
                    <p className="font-bold text-app-text">
                      {a.appointment_type}
                    </p>
                    <p className="text-xs text-app-text-muted">
                      {new Date(a.starts_at).toLocaleString()} · {a.status}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="border-t border-app-border pt-6">
            <button
              type="button"
              onClick={() => {
                onOpenFullParty(row.wedding_party_id);
                onClose();
              }}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-nexoNavy py-4 text-sm font-black uppercase tracking-tight text-white transition-colors hover:bg-black/80"
            >
              <ExternalLink size={18} aria-hidden />
              Open full wedding file
            </button>
          </div>
        </div>
      )}
    </DetailDrawer>
  );
}
