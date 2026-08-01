import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronRight,
  Plus,
  ReceiptText,
  Search,
  ShoppingCart,
  UserPlus,
  Users,
  X,
} from "lucide-react";

import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { getBaseUrl } from "../../lib/apiConfig";
import { centsToFixed2, parseMoneyToCents } from "../../lib/money";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { splitWeddingPartyWithMembers } from "../../lib/weddingPartyApiShape";
import type { Customer, WeddingMember } from "./types";

type DepositParty = {
  id: string;
  party_name: string;
  event_date: string;
  members: WeddingMember[];
};

type WorkflowAllocation = {
  id: string;
  wedding_member_id: string;
  beneficiary_customer_id: string;
  beneficiary_name: string;
  role: string;
  amount: string;
  remaining_amount: string;
  destination_kind: "held_for_future_order" | "existing_transaction";
  target_transaction_id?: string | null;
  target_display_id?: string | null;
  source_credit_ledger_id?: string | null;
  member_transaction_id?: string | null;
  member_transaction_display_id?: string | null;
};

type DepositWorkflow = {
  id: string;
  payer_transaction_id: string;
  payer_transaction_display_id: string;
  payer_name: string;
  wedding_party_id: string;
  party_name: string;
  event_date: string;
  total_amount: string;
  remaining_amount: string;
  status: string;
  created_at: string;
  allocations: WorkflowAllocation[];
};

type CustomerSearchRow = {
  id: string;
  customer_code?: string;
  first_name: string;
  last_name: string;
  phone?: string | null;
  email?: string | null;
};

type OpenTransactionTarget = {
  transaction_id: string;
  display_id: string;
  balance_due: string;
};

type Step = "start" | "party" | "members" | "review" | "history";
type PostPaymentAction = "build_orders" | "deposit_only";

const ROLE_OPTIONS = [
  "Groom",
  "Best Man",
  "Groomsman",
  "Father of Groom",
  "Father of Bride",
  "Usher",
  "Ring Bearer",
  "Other",
];

function parseParty(value: unknown): DepositParty | null {
  const { party, members } = splitWeddingPartyWithMembers(value);
  if (!party?.id) return null;
  return {
    id: String(party.id),
    party_name:
      String(party.party_tracking_label ?? party.wedding_number ?? party.party_name ?? "Wedding party").trim() ||
      "Wedding party",
    event_date: String(party.event_date ?? ""),
    members: (members as Array<Record<string, unknown>>).map((member) => ({
      id: String(member.id),
      first_name: String(member.first_name ?? ""),
      last_name: String(member.last_name ?? ""),
      role: String(member.role ?? "Member"),
      status: String(member.status ?? "prospect"),
      measured: Boolean(member.measured),
      suit_ordered: Boolean(member.suit_ordered),
      customer_id: String(member.customer_id ?? ""),
      customer_email: typeof member.customer_email === "string" ? member.customer_email : undefined,
      customer_phone: typeof member.customer_phone === "string" ? member.customer_phone : undefined,
      suit_variant_id: member.suit_variant_id != null ? String(member.suit_variant_id) : null,
      is_free_suit_promo: Boolean(member.is_free_suit_promo),
    })),
  };
}

function normalizedAmount(value: string): string | null {
  const normalized = value.replace(/[$,\s]/g, "");
  return /^\d*(?:\.\d{0,2})?$/.test(normalized) ? normalized : null;
}

export default function WeddingDepositWorkspace({
  isOpen,
  payer,
  initialPartyId,
  initialView = "deposit",
  focusWorkflowId,
  focusPayerTransactionId,
  autoStartFirstMember = false,
  salespeople,
  salespersonId,
  onSalespersonChange,
  onClose,
  onAddDeposits,
  onStartMemberOrder,
  onOpenReceipt,
}: {
  isOpen: boolean;
  payer: Customer;
  initialPartyId?: string | null;
  initialView?: "deposit" | "orders";
  focusWorkflowId?: string | null;
  focusPayerTransactionId?: string | null;
  autoStartFirstMember?: boolean;
  salespeople: Array<{ id: string; full_name: string }>;
  salespersonId: string;
  onSalespersonChange: (staffId: string) => void;
  onClose: () => void;
  onAddDeposits: (
    members: WeddingMember[],
    partyName: string,
    payerMember: WeddingMember,
    options: { continueToOrders: boolean },
  ) => void;
  onStartMemberOrder: (
    member: WeddingMember,
    partyName: string,
    source: { workflowId: string; sourceCreditLedgerId: string; remainingCents: number },
  ) => void;
  onOpenReceipt: (transactionId: string) => void;
}) {
  const { backofficeHeaders, staffDisplayName } = useBackofficeAuth();
  const baseUrl = getBaseUrl();
  const headers = useCallback(
    () => ({ "Content-Type": "application/json", ...mergedPosStaffHeaders(backofficeHeaders) }),
    [backofficeHeaders],
  );
  const [step, setStep] = useState<Step>(initialView === "orders" ? "history" : "start");
  const [party, setParty] = useState<DepositParty | null>(null);
  const [partySearch, setPartySearch] = useState("");
  const [partyResults, setPartyResults] = useState<DepositParty[]>([]);
  const [partyBusy, setPartyBusy] = useState(Boolean(initialPartyId));
  const [newPartyOpen, setNewPartyOpen] = useState(false);
  const [newPartyName, setNewPartyName] = useState("");
  const [newPartyDate, setNewPartyDate] = useState("");
  const [memberEditorOpen, setMemberEditorOpen] = useState(false);
  const [memberMode, setMemberMode] = useState<"existing" | "new">("existing");
  const [memberSearch, setMemberSearch] = useState("");
  const [customerResults, setCustomerResults] = useState<CustomerSearchRow[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<CustomerSearchRow | null>(null);
  const [memberFirstName, setMemberFirstName] = useState("");
  const [memberLastName, setMemberLastName] = useState("");
  const [memberPhone, setMemberPhone] = useState("");
  const [memberRole, setMemberRole] = useState("Groomsman");
  const [customRole, setCustomRole] = useState("");
  const [memberBusy, setMemberBusy] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<Set<string>>(new Set());
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [openTargets, setOpenTargets] = useState<Record<string, OpenTransactionTarget[]>>({});
  const [destinations, setDestinations] = useState<Record<string, string>>({});
  const [workflows, setWorkflows] = useState<DepositWorkflow[]>([]);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [postPaymentAction, setPostPaymentAction] = useState<PostPaymentAction>("build_orders");
  const [error, setError] = useState<string | null>(null);
  const searchRequest = useRef(0);
  const autoStartedAllocation = useRef<string | null>(null);

  const payerName = `${payer.first_name} ${payer.last_name}`.trim();
  const payerMember = party?.members.find((member) => member.customer_id === payer.id) ?? null;
  const selectedMembers = useMemo(
    () => party?.members.filter((member) => selectedMemberIds.has(member.id)) ?? [],
    [party?.members, selectedMemberIds],
  );
  const fundedMembers = useMemo(
    () =>
      selectedMembers.filter(
        (member) => parseMoneyToCents(amounts[member.id] ?? "0") > 0,
      ),
    [amounts, selectedMembers],
  );
  const selectedWithoutAmount = useMemo(
    () =>
      selectedMembers.filter(
        (member) => parseMoneyToCents(amounts[member.id] ?? "0") <= 0,
      ),
    [amounts, selectedMembers],
  );
  const totalCents = useMemo(
    () => fundedMembers.reduce((total, member) => total + parseMoneyToCents(amounts[member.id] ?? "0"), 0),
    [amounts, fundedMembers],
  );
  const invalidDestinationMembers = useMemo(
    () => fundedMembers.filter((member) => {
      const amountCents = parseMoneyToCents(amounts[member.id] ?? "0");
      const destination = destinations[member.id] ?? "held_for_future_order";
      if (destination === "held_for_future_order") return false;
      const target = (openTargets[member.id] ?? []).find(
        (candidate) => candidate.transaction_id === destination,
      );
      return !target || amountCents > parseMoneyToCents(target.balance_due);
    }),
    [amounts, destinations, fundedMembers, openTargets],
  );
  const validAmounts = fundedMembers.length > 0 && invalidDestinationMembers.length === 0;

  const loadParty = useCallback(
    async (partyId: string, nextStep: Step | null = "members") => {
      setPartyBusy(true);
      setError(null);
      try {
        const response = await fetch(`${baseUrl}/api/weddings/parties/${encodeURIComponent(partyId)}`, {
          headers: headers(),
        });
        if (!response.ok) throw new Error("Wedding party could not be loaded.");
        const parsed = parseParty(await response.json());
        if (!parsed) throw new Error("Wedding party response was incomplete.");
        const depositContextResponse = await fetch(
          `${baseUrl}/api/weddings/parties/${encodeURIComponent(partyId)}/deposit-context`,
          { headers: headers() },
        );
        if (!depositContextResponse.ok) {
          throw new Error(
            "Member balances are unavailable. Resolve the connection before entering deposits.",
          );
        }
        const depositContext = (await depositContextResponse.json()) as {
          members?: Array<{
            wedding_member_id: string;
            open_transactions: OpenTransactionTarget[];
          }>;
        };
        setOpenTargets(
          Object.fromEntries(
            (depositContext.members ?? []).map((member) => [
              member.wedding_member_id,
              member.open_transactions,
            ]),
          ),
        );
        setParty(parsed);
        if (nextStep) setStep(nextStep);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Wedding party could not be loaded.");
      } finally {
        setPartyBusy(false);
      }
    },
    [baseUrl, headers],
  );

  const loadWorkflows = useCallback(async () => {
    setHistoryBusy(true);
    try {
      const response = await fetch(
        `${baseUrl}/api/weddings/deposit-workflows?payer_customer_id=${encodeURIComponent(payer.id)}`,
        { headers: headers() },
      );
      if (!response.ok) throw new Error("Previous wedding deposits could not be loaded.");
      setWorkflows((await response.json()) as DepositWorkflow[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Previous wedding deposits could not be loaded.");
    } finally {
      setHistoryBusy(false);
    }
  }, [baseUrl, headers, payer.id]);

  useEffect(() => {
    if (!isOpen) return;
    setError(null);
    void loadWorkflows();
    if (initialPartyId) void loadParty(initialPartyId, null);
  }, [initialPartyId, isOpen, loadParty, loadWorkflows]);

  useEffect(() => {
    if (!isOpen || step !== "history" || !autoStartFirstMember || historyBusy) return;
    const workflow = workflows.find(
      (candidate) =>
        candidate.id === focusWorkflowId ||
        candidate.payer_transaction_id === focusPayerTransactionId,
    );
    const allocation = workflow?.allocations.find(
      (candidate) =>
        candidate.source_credit_ledger_id &&
        !candidate.member_transaction_id &&
        parseMoneyToCents(candidate.remaining_amount) > 0,
    );
    if (!workflow || !allocation || !allocation.source_credit_ledger_id) return;
    const allocationKey = `${workflow.id}:${allocation.id}`;
    if (autoStartedAllocation.current === allocationKey) return;
    autoStartedAllocation.current = allocationKey;
    onStartMemberOrder(
      {
        id: allocation.wedding_member_id,
        customer_id: allocation.beneficiary_customer_id,
        first_name: allocation.beneficiary_name.split(" ")[0] ?? "Wedding",
        last_name: allocation.beneficiary_name.split(" ").slice(1).join(" ") || "Member",
        role: allocation.role,
        status: "active",
        measured: false,
        suit_ordered: false,
        is_free_suit_promo: false,
      },
      workflow.party_name,
      {
        workflowId: workflow.id,
        sourceCreditLedgerId: allocation.source_credit_ledger_id,
        remainingCents: parseMoneyToCents(allocation.remaining_amount),
      },
    );
  }, [
    autoStartFirstMember,
    focusPayerTransactionId,
    focusWorkflowId,
    historyBusy,
    isOpen,
    onStartMemberOrder,
    step,
    workflows,
  ]);

  useEffect(() => {
    if (!isOpen) return;
    const query = partySearch.trim();
    if (query.length < 2) {
      setPartyResults([]);
      return;
    }
    const requestId = ++searchRequest.current;
    const timer = window.setTimeout(async () => {
      setPartyBusy(true);
      try {
        const response = await fetch(
          `${baseUrl}/api/weddings/parties?search=${encodeURIComponent(query)}&limit=20`,
          { headers: headers() },
        );
        if (!response.ok) throw new Error("Wedding search is unavailable.");
        const payload = (await response.json()) as { data?: unknown[] };
        if (requestId !== searchRequest.current) return;
        setPartyResults((payload.data ?? []).map(parseParty).filter((row): row is DepositParty => row != null));
      } catch (cause) {
        if (requestId === searchRequest.current) {
          setError(cause instanceof Error ? cause.message : "Wedding search is unavailable.");
        }
      } finally {
        if (requestId === searchRequest.current) setPartyBusy(false);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [baseUrl, headers, isOpen, partySearch]);

  useEffect(() => {
    if (!memberEditorOpen || memberMode !== "existing") return;
    const query = memberSearch.trim();
    if (query.length < 2) {
      setCustomerResults([]);
      return;
    }
    const requestId = ++searchRequest.current;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `${baseUrl}/api/customers/search?q=${encodeURIComponent(query)}&limit=20`,
          { headers: headers() },
        );
        if (!response.ok) throw new Error("Customer search is unavailable.");
        if (requestId === searchRequest.current) {
          setCustomerResults((await response.json()) as CustomerSearchRow[]);
        }
      } catch (cause) {
        if (requestId === searchRequest.current) {
          setError(cause instanceof Error ? cause.message : "Customer search is unavailable.");
        }
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [baseUrl, headers, memberEditorOpen, memberMode, memberSearch]);

  const createParty = async () => {
    if (!newPartyName.trim() || !newPartyDate) {
      setError("Party Name and Wedding Date are required.");
      return;
    }
    setPartyBusy(true);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/api/weddings/parties`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          party_name: newPartyName.trim(),
          groom_name: "",
          event_date: newPartyDate,
          party_type: "Wedding",
          start_empty: true,
          actor_name: staffDisplayName || "Register staff",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Wedding party could not be created.");
      const parsed = parseParty(payload);
      if (!parsed) throw new Error("Created wedding party could not be loaded.");
      setParty(parsed);
      setNewPartyOpen(false);
      setStep("members");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wedding party could not be created.");
    } finally {
      setPartyBusy(false);
    }
  };

  const addCustomerToParty = async (customer: CustomerSearchRow, role: string) => {
    if (!party) return;
    setMemberBusy(true);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/api/weddings/parties/${party.id}/members`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          customer_id: customer.id,
          role,
          actor_name: staffDisplayName || "Register staff",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Wedding member could not be added.");
      await loadParty(party.id);
      setMemberEditorOpen(false);
      setSelectedCustomer(null);
      setMemberSearch("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Wedding member could not be added.");
    } finally {
      setMemberBusy(false);
    }
  };

  const addMember = async () => {
    const role = memberRole === "Other" ? customRole.trim() : memberRole;
    if (!role) {
      setError("Select or enter the member role.");
      return;
    }
    if (memberMode === "existing") {
      if (!selectedCustomer) {
        setError("Select the existing customer to add.");
        return;
      }
      await addCustomerToParty(selectedCustomer, role);
      return;
    }
    if (!party || !memberFirstName.trim() || !memberLastName.trim()) {
      setError("First and last name are required for a new customer.");
      return;
    }
    setMemberBusy(true);
    setError(null);
    try {
      const response = await fetch(`${baseUrl}/api/weddings/parties/${party.id}/members`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          first_name: memberFirstName.trim(),
          last_name: memberLastName.trim(),
          phone: memberPhone.trim() || null,
          role,
          actor_name: staffDisplayName || "Register staff",
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? "Customer and wedding member could not be created.");
      await loadParty(party.id);
      setMemberEditorOpen(false);
      setMemberFirstName("");
      setMemberLastName("");
      setMemberPhone("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Customer and wedding member could not be created.");
    } finally {
      setMemberBusy(false);
    }
  };

  const toggleMember = (member: WeddingMember) => {
    if (member.customer_id === payer.id) return;
    setSelectedMemberIds((current) => {
      const next = new Set(current);
      if (next.has(member.id)) {
        next.delete(member.id);
        setAmounts((values) => {
          const copy = { ...values };
          delete copy[member.id];
          return copy;
        });
      } else {
        next.add(member.id);
        setDestinations((values) => ({
          ...values,
          [member.id]: values[member.id] ?? "held_for_future_order",
        }));
      }
      return next;
    });
  };

  const beginWorkflow = (action: PostPaymentAction) => {
    setPostPaymentAction(action);
    setError(null);
    setStep(party ? "members" : "party");
  };

  const addDeposits = () => {
    if (!party || !payerMember || !validAmounts) return;
    onAddDeposits(
      fundedMembers.map((member) => ({
        ...member,
        split_deposit_amount: centsToFixed2(parseMoneyToCents(amounts[member.id] ?? "0")),
        deposit_destination_kind:
          destinations[member.id] === "held_for_future_order"
            ? "held_for_future_order"
            : "existing_transaction",
        deposit_target_transaction_id:
          destinations[member.id] === "held_for_future_order"
            ? null
            : destinations[member.id],
      })),
      party.party_name,
      payerMember,
      { continueToOrders: postPaymentAction === "build_orders" },
    );
  };

  if (!isOpen) return null;
  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200] p-2 sm:p-5">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="wedding-deposit-title"
        className="flex h-[min(94dvh,900px)] w-full max-w-6xl flex-col overflow-hidden rounded-3xl border border-app-border bg-app-surface shadow-2xl"
      >
        <header className="flex items-center justify-between border-b border-app-border px-4 py-3 sm:px-6">
          <div>
            <h2 id="wedding-deposit-title" className="text-lg font-black text-app-text sm:text-2xl">
              Wedding Deposit
            </h2>
            <p className="text-xs font-semibold text-app-text-muted">
              Payer: {payerName} · Resolve the party and member allocations before Payment.
            </p>
          </div>
          <button type="button" onClick={onClose} className="ui-touch-target rounded-xl p-2 text-app-text-muted hover:bg-app-surface-2" aria-label="Close Wedding Deposit">
            <X size={22} />
          </button>
        </header>

        <div className="grid min-h-0 flex-1 md:grid-cols-[220px_minmax(0,1fr)_260px]">
          <aside className="border-b border-app-border bg-app-surface-2 p-3 md:border-b-0 md:border-r md:p-5">
            <ol className="grid grid-cols-4 gap-2 md:grid-cols-1">
              {[
                ["start", "1", "Choose Workflow"],
                ["party", "2", "Wedding Party"],
                ["members", "3", "Members & Amounts"],
                ["review", "4", "Review Before Payment"],
              ].map(([value, number, label]) => {
                const active = step === value;
                const complete = value === "start"
                  ? step !== "start" && step !== "history"
                  : value === "party"
                    ? Boolean(party)
                    : value === "members"
                      ? validAmounts && Boolean(payerMember)
                      : false;
                return (
                  <li key={value} className={`rounded-2xl border p-2.5 ${active ? "border-app-accent bg-app-accent/10" : "border-app-border bg-app-surface"}`}>
                    <div className="flex items-center gap-2">
                      <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-black ${complete ? "bg-app-success text-white" : active ? "bg-app-accent text-white" : "bg-app-surface-3 text-app-text-muted"}`}>
                        {complete ? <Check size={14} /> : number}
                      </span>
                      <span className="hidden text-xs font-black text-app-text md:block">{label}</span>
                    </div>
                  </li>
                );
              })}
            </ol>
            <button type="button" onClick={() => setStep("history")} className={`mt-3 flex w-full items-center gap-2 rounded-2xl border p-3 text-left text-xs font-black ${step === "history" ? "border-app-info bg-app-info/10 text-app-info" : "border-app-border bg-app-surface text-app-text"}`}>
              <ReceiptText size={16} /> Orders &amp; Receipts
            </button>
          </aside>

          <main className="min-h-0 overflow-y-auto p-4 sm:p-6">
            {error ? <div className="mb-4 rounded-2xl border border-app-danger/30 bg-app-danger/10 p-3 text-sm font-bold text-app-danger">{error}</div> : null}

            {step === "start" ? (
              <div className="space-y-5">
                <div>
                  <h3 className="text-xl font-black text-app-text">What are you doing today?</h3>
                  <p className="text-sm text-app-text-muted">
                    Choose the workflow first. You can change this choice before adding anything to the Cart.
                  </p>
                </div>
                {partyBusy ? (
                  <div className="rounded-2xl border border-app-info/30 bg-app-info/8 p-4 text-sm font-bold text-app-info">
                    Loading the linked wedding party…
                  </div>
                ) : null}
                <div className="grid gap-4 lg:grid-cols-2">
                  <button
                    type="button"
                    disabled={partyBusy}
                    onClick={() => beginWorkflow("deposit_only")}
                    className="group rounded-3xl border-2 border-app-info/40 bg-app-info/8 p-6 text-left transition hover:border-app-info hover:bg-app-info/12 disabled:opacity-50"
                  >
                    <ReceiptText className="mb-4 text-app-info" size={32} />
                    <span className="block text-xl font-black text-app-text">Deposit Only</span>
                    <span className="mt-2 block text-sm text-app-text-muted">
                      Collect deposits for party members, print the payer receipt, and finish. Build member orders later from Orders &amp; Receipts.
                    </span>
                    <span className="mt-5 inline-flex items-center gap-1 text-xs font-black text-app-info">
                      Start Deposit <ChevronRight size={15} />
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={partyBusy}
                    onClick={() => beginWorkflow("build_orders")}
                    className="group rounded-3xl border-2 border-app-accent/40 bg-app-accent/8 p-6 text-left transition hover:border-app-accent hover:bg-app-accent/12 disabled:opacity-50"
                  >
                    <ShoppingCart className="mb-4 text-app-accent" size={32} />
                    <span className="block text-xl font-black text-app-text">Collect &amp; Build Orders</span>
                    <span className="mt-2 block text-sm text-app-text-muted">
                      Collect the payer deposit first, print its truthful receipt, then continue member by member to select items and complete each Wedding Order.
                    </span>
                    <span className="mt-5 inline-flex items-center gap-1 text-xs font-black text-app-accent">
                      Start Collect and Build Orders <ChevronRight size={15} />
                    </span>
                  </button>
                </div>
                <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4 text-sm text-app-text-muted">
                  Both paths use one payer payment and the same audited member allocations. No deposit or member order posts until its successful Pay → Complete Sale / Record Sale checkout.
                </div>
              </div>
            ) : null}

            {step === "party" ? (
              <div className="space-y-5">
                <div>
                  <h3 className="text-xl font-black text-app-text">Choose the wedding party</h3>
                  <p className="text-sm text-app-text-muted">Search first so an existing party is not duplicated.</p>
                </div>
                <div className="relative">
                  <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-app-text-muted" size={18} />
                  <input value={partySearch} onChange={(event) => setPartySearch(event.target.value)} placeholder="Party name, wedding number, groom, or member" className="ui-input h-14 w-full pl-12" autoFocus />
                </div>
                <div className="space-y-2">
                  {partyResults.map((result) => (
                    <button key={result.id} type="button" onClick={() => void loadParty(result.id)} className="flex w-full items-center justify-between rounded-2xl border border-app-border bg-app-surface-2 p-4 text-left hover:border-app-accent">
                      <div>
                        <p className="font-black text-app-text">{result.party_name}</p>
                        <p className="text-xs text-app-text-muted">{result.event_date} · {result.members.length} members</p>
                      </div>
                      <ChevronRight size={18} className="text-app-text-muted" />
                    </button>
                  ))}
                  {partyBusy ? <p className="py-4 text-center text-sm text-app-text-muted">Loading…</p> : null}
                </div>
                {!newPartyOpen ? (
                  <button type="button" onClick={() => setNewPartyOpen(true)} className="ui-btn-secondary flex items-center gap-2">
                    <Plus size={16} /> Start a New Wedding Party
                  </button>
                ) : (
                  <div className="rounded-3xl border border-app-accent/30 bg-app-accent/5 p-4">
                    <h4 className="font-black text-app-text">Start with the essentials</h4>
                    <p className="mb-4 text-xs text-app-text-muted">Members and roles are added on the next step.</p>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="text-xs font-black text-app-text">Party Name<input value={newPartyName} onChange={(event) => setNewPartyName(event.target.value)} className="ui-input mt-1 w-full" placeholder="Smith Wedding" /></label>
                      <label className="text-xs font-black text-app-text">Wedding Date<input type="date" value={newPartyDate} onChange={(event) => setNewPartyDate(event.target.value)} className="ui-input mt-1 w-full" /></label>
                    </div>
                    <div className="mt-4 flex gap-2">
                      <button type="button" onClick={() => void createParty()} disabled={partyBusy} className="ui-btn-primary">Create Party and Add Members</button>
                      <button type="button" onClick={() => setNewPartyOpen(false)} className="ui-btn-secondary">Cancel</button>
                    </div>
                  </div>
                )}
              </div>
            ) : null}

            {step === "members" && party ? (
              <div className="space-y-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <button type="button" onClick={() => { setParty(null); setStep("party"); }} className="mb-2 flex items-center gap-1 text-xs font-black text-app-accent"><ArrowLeft size={14} /> Change Party</button>
                    <h3 className="text-xl font-black text-app-text">{party.party_name}</h3>
                    <p className="text-sm text-app-text-muted"><Calendar className="mr-1 inline" size={14} />{party.event_date}</p>
                  </div>
                  <button type="button" onClick={() => setMemberEditorOpen(true)} className="ui-btn-secondary flex items-center gap-2"><UserPlus size={16} /> Add Member</button>
                </div>

                {!payerMember ? (
                  <div className="rounded-2xl border border-app-warning/40 bg-app-warning/10 p-4">
                    <p className="font-black text-app-text">Add the payer before continuing</p>
                    <p className="mb-3 text-sm text-app-text-muted">{payerName} must be linked to this party and assigned a role.</p>
                    <div className="flex flex-wrap gap-2">
                      <select value={memberRole} onChange={(event) => setMemberRole(event.target.value)} className="ui-input">
                        {ROLE_OPTIONS.map((role) => <option key={role}>{role}</option>)}
                      </select>
                      <button type="button" onClick={() => void addCustomerToParty({ id: payer.id, first_name: payer.first_name, last_name: payer.last_name, phone: payer.phone, email: payer.email }, memberRole)} className="ui-btn-primary">Add {payer.first_name} as Payer</button>
                    </div>
                  </div>
                ) : (
                  <div className="rounded-2xl border border-app-success/30 bg-app-success/8 p-3 text-sm font-bold text-app-success">Payer verified: {payerName} · {payerMember.role}</div>
                )}

                <div className="rounded-2xl border border-app-info/30 bg-app-info/8 p-3 text-sm text-app-text">
                  <strong>{postPaymentAction === "build_orders" ? "Collect & Build Orders selected." : "Deposit Only selected."}</strong>{" "}
                  {postPaymentAction === "build_orders"
                    ? "After the payer payment succeeds, continue directly into each funded member's item selection."
                    : "After the payer payment and receipt succeed, this workflow finishes; member orders can be built later."}
                  <button type="button" onClick={() => setStep("start")} className="ml-2 font-black text-app-accent underline">
                    Change workflow
                  </button>
                </div>

                {memberEditorOpen ? (
                  <div className="rounded-3xl border border-app-border bg-app-surface-2 p-4">
                    <div className="mb-3 flex items-center justify-between"><h4 className="font-black text-app-text">Add Wedding Member</h4><button type="button" onClick={() => setMemberEditorOpen(false)}><X size={18} /></button></div>
                    <div className="mb-4 flex gap-2">
                      <button type="button" onClick={() => setMemberMode("existing")} className={memberMode === "existing" ? "ui-btn-primary" : "ui-btn-secondary"}>Find Existing Customer</button>
                      <button type="button" onClick={() => setMemberMode("new")} className={memberMode === "new" ? "ui-btn-primary" : "ui-btn-secondary"}>Create New Customer</button>
                    </div>
                    {memberMode === "existing" ? (
                      <div className="space-y-2">
                        <input value={memberSearch} onChange={(event) => { setMemberSearch(event.target.value); setSelectedCustomer(null); }} className="ui-input w-full" placeholder="Search name, phone, email, or customer code" />
                        {customerResults.map((customer) => (
                          <button key={customer.id} type="button" onClick={() => setSelectedCustomer(customer)} className={`w-full rounded-xl border p-3 text-left ${selectedCustomer?.id === customer.id ? "border-app-accent bg-app-accent/10" : "border-app-border bg-app-surface"}`}>
                            <span className="font-black text-app-text">{customer.first_name} {customer.last_name}</span>
                            <span className="ml-2 text-xs text-app-text-muted">{customer.customer_code ?? customer.phone ?? ""}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-3">
                        <input value={memberFirstName} onChange={(event) => setMemberFirstName(event.target.value)} className="ui-input" placeholder="First name" />
                        <input value={memberLastName} onChange={(event) => setMemberLastName(event.target.value)} className="ui-input" placeholder="Last name" />
                        <input value={memberPhone} onChange={(event) => setMemberPhone(event.target.value)} className="ui-input" placeholder="Phone (recommended)" />
                      </div>
                    )}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <select value={memberRole} onChange={(event) => setMemberRole(event.target.value)} className="ui-input">{ROLE_OPTIONS.map((role) => <option key={role}>{role}</option>)}</select>
                      {memberRole === "Other" ? <input value={customRole} onChange={(event) => setCustomRole(event.target.value)} className="ui-input" placeholder="Custom role" /> : null}
                      <button type="button" onClick={() => void addMember()} disabled={memberBusy} className="ui-btn-primary">Add Member</button>
                    </div>
                  </div>
                ) : null}

                <div className="space-y-2">
                  {party.members.map((member) => {
                    const isPayer = member.customer_id === payer.id;
                    const selected = selectedMemberIds.has(member.id);
                    const amountCents = parseMoneyToCents(amounts[member.id] ?? "0");
                    const destination = destinations[member.id] ?? "held_for_future_order";
                    const target = (openTargets[member.id] ?? []).find(
                      (candidate) => candidate.transaction_id === destination,
                    );
                    const destinationAmountInvalid =
                      selected &&
                      amountCents > 0 &&
                      destination !== "held_for_future_order" &&
                      (!target || amountCents > parseMoneyToCents(target.balance_due));
                    return (
                      <div key={member.id} className={`rounded-2xl border p-4 ${isPayer ? "border-app-border bg-app-surface-3" : selected ? "border-app-accent bg-app-accent/8" : "border-app-border bg-app-surface-2"}`}>
                        <div className="flex items-center justify-between gap-3">
                          <button type="button" disabled={isPayer} onClick={() => toggleMember(member)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                            <span className={`flex h-9 w-9 items-center justify-center rounded-full ${selected ? "bg-app-accent text-white" : "bg-app-surface text-app-text-muted"}`}>{selected ? <Check size={16} /> : <Users size={16} />}</span>
                            <span><span className="block font-black text-app-text">{member.first_name} {member.last_name}</span><span className="text-xs text-app-text-muted">{member.role}{isPayer ? " · Payer" : ""}</span></span>
                          </button>
                          {selected ? (
                            <label className="flex items-center gap-1 text-sm font-black text-app-text">$<input value={amounts[member.id] ?? ""} onChange={(event) => { const value = normalizedAmount(event.target.value); if (value != null) setAmounts((current) => ({ ...current, [member.id]: value })); }} className="ui-input w-28 text-right text-lg font-black" inputMode="decimal" placeholder="0.00" /></label>
                          ) : null}
                        </div>
                        {selected && amountCents <= 0 ? (
                          <p className="mt-2 rounded-xl bg-app-warning/10 px-3 py-2 text-xs font-bold text-app-warning">
                            Enter an amount to fund this member. A $0 selection is excluded and will not block the other funded members.
                          </p>
                        ) : null}
                        {destinationAmountInvalid ? (
                          <p className="mt-2 rounded-xl bg-app-danger/10 px-3 py-2 text-xs font-bold text-app-danger">
                            {target
                              ? `This amount exceeds the $${target.balance_due} balance on ${target.display_id}. Lower the amount or hold it for a future order.`
                              : "Choose a current open Transaction Record or hold this deposit for a future order."}
                          </p>
                        ) : null}
                        {selected ? (
                          <label className="mt-3 block text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                            Deposit destination
                            <select
                              value={destinations[member.id] ?? "held_for_future_order"}
                              onChange={(event) =>
                                setDestinations((values) => ({
                                  ...values,
                                  [member.id]: event.target.value,
                                }))
                              }
                              className="ui-input mt-1 w-full normal-case tracking-normal"
                            >
                              <option value="held_for_future_order">Hold for this member's future order</option>
                              {(openTargets[member.id] ?? []).map((target) => (
                                <option key={target.transaction_id} value={target.transaction_id}>
                                  Apply to {target.display_id} · ${target.balance_due} due
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {step === "review" && party ? (
              <div className="space-y-5">
                <button type="button" onClick={() => setStep("members")} className="flex items-center gap-1 text-xs font-black text-app-accent"><ArrowLeft size={14} /> Edit Members and Amounts</button>
                <div><h3 className="text-xl font-black text-app-text">Review before Payment</h3><p className="text-sm text-app-text-muted">This is what the payer receipt will report.</p></div>
                <div className="rounded-3xl border border-app-border bg-app-surface-2 p-4">
                  <div className="mb-4 flex items-start justify-between"><div><p className="font-black text-app-text">{payerName}</p><p className="text-xs text-app-text-muted">Paying deposits for {party.party_name}</p></div><p className="text-2xl font-black text-app-accent">${centsToFixed2(totalCents)}</p></div>
                  <div className="space-y-2 border-t border-app-border pt-3">
                    {fundedMembers.map((member) => {
                      const destination = destinations[member.id] ?? "held_for_future_order";
                      const target = (openTargets[member.id] ?? []).find(
                        (candidate) => candidate.transaction_id === destination,
                      );
                      return <div key={member.id} className="flex justify-between gap-3 text-sm"><span><strong>{member.first_name} {member.last_name}</strong><span className="ml-2 text-app-text-muted">{member.role} · {target ? `apply to ${target.display_id}` : "held until an order exists"}</span></span><strong>${centsToFixed2(parseMoneyToCents(amounts[member.id] ?? "0"))}</strong></div>;
                    })}
                  </div>
                </div>
                <div className="rounded-2xl border border-app-info/30 bg-app-info/8 p-4 text-sm text-app-text">Payment will be collected once from {payerName}. Each member amount remains separate and will not be shown as the payer’s merchandise.</div>
                <label className="block rounded-2xl border border-app-border bg-app-surface-2 p-4 text-xs font-black uppercase tracking-widest text-app-text-muted">
                  Responsible salesperson
                  <select value={salespersonId} onChange={(event) => onSalespersonChange(event.target.value)} className="ui-input mt-2 w-full normal-case tracking-normal">
                    <option value="">Select salesperson…</option>
                    {salespeople.map((salesperson) => <option key={salesperson.id} value={salesperson.id}>{salesperson.full_name}</option>)}
                  </select>
                  {!salespersonId ? <span className="mt-2 block normal-case tracking-normal text-app-warning">Choose the salesperson here before continuing to Payment.</span> : null}
                </label>
                <div className={`rounded-2xl border p-4 ${postPaymentAction === "build_orders" ? "border-app-accent bg-app-accent/10" : "border-app-info bg-app-info/10"}`}>
                  <div className="flex items-start gap-3">
                    {postPaymentAction === "build_orders" ? <ShoppingCart className="mt-0.5 shrink-0 text-app-accent" size={20} /> : <ReceiptText className="mt-0.5 shrink-0 text-app-info" size={20} />}
                    <div className="min-w-0 flex-1">
                      <p className="font-black text-app-text">{postPaymentAction === "build_orders" ? "Collect & Build Orders" : "Deposit Only"}</p>
                      <p className="mt-1 text-xs text-app-text-muted">
                        {postPaymentAction === "build_orders"
                          ? "This action adds the reviewed deposits and opens Payment. After the approved payer receipt, Continue Wedding Orders opens the first funded member immediately; each successful member sale advances to the next member."
                          : "Finish after the payer receipt. Return through Wedding Deposit → Orders & Receipts when the party is ready for merchandise."}
                      </p>
                    </div>
                    <button type="button" onClick={() => setStep("start")} className="shrink-0 text-xs font-black text-app-accent underline">Change</button>
                  </div>
                </div>
              </div>
            ) : null}

            {step === "history" ? (
              <div className="space-y-4">
                <div><h3 className="text-xl font-black text-app-text">Wedding Orders &amp; Receipts</h3><p className="text-sm text-app-text-muted">Choose a funded member to return to the Register, select merchandise, confirm Wedding Order and salesperson, then choose Pay to post that member&apos;s Transaction Record.</p></div>
                <div className="rounded-2xl border border-app-accent/30 bg-app-accent/8 p-4 text-sm text-app-text"><p className="font-black">How item selection works</p><p className="mt-1 text-app-text-muted">Select <strong>Choose Member &amp; Add Items</strong>. Riverside closes this workspace, selects the member&apos;s Customer account, and shows the Wedding Checklist. Add a linked item there or search/scan any item, then set each deferred line to <strong>Order (Wedding)</strong>.</p><p className="mt-2 font-bold text-app-text">Nothing posts from this dashboard. Only a successful Pay → Complete Sale / Record Sale atomic checkout creates the member Transaction and applies the exact held deposit.</p></div>
                <div className="rounded-2xl border border-app-warning/30 bg-app-warning/8 p-4 text-sm text-app-text">
                  Funded deposits are financial records. Refund one member allocation at a time
                  from that member&apos;s Transaction/account. An original-card refund returns to the
                  original wedding deposit payer—not the member. Ordinary Cancel and same-day Void
                  remain blocked so no deposit ledger is silently changed.
                </div>
                {historyBusy ? <p className="py-8 text-center text-app-text-muted">Loading previous deposits…</p> : null}
                {workflows.map((workflow) => {
                  const focused = workflow.id === focusWorkflowId || workflow.payer_transaction_id === focusPayerTransactionId;
                  return (
                  <article key={workflow.id} className={`rounded-3xl border bg-app-surface-2 p-4 ${focused ? "border-app-accent ring-2 ring-app-accent/20" : "border-app-border"}`}>
                    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-black text-app-text">{workflow.party_name}</p><p className="text-xs text-app-text-muted">{workflow.event_date} · Payer receipt {workflow.payer_transaction_display_id}</p><button type="button" onClick={() => onOpenReceipt(workflow.payer_transaction_id)} className="mt-2 inline-flex items-center gap-1 text-xs font-black text-app-accent"><ReceiptText size={14} /> View / Print Payer Receipt</button></div><div className="text-right"><p className="text-lg font-black text-app-text">${workflow.total_amount}</p><p className="text-xs font-bold text-app-info">${workflow.remaining_amount} still held</p></div></div>
                    <div className="mt-3 space-y-2 border-t border-app-border pt-3">
                      {workflow.allocations.map((allocation) => {
                        const postedTransactionId = allocation.member_transaction_id ?? allocation.target_transaction_id;
                        const postedDisplayId = allocation.member_transaction_display_id ?? allocation.target_display_id;
                        const remainingCents = parseMoneyToCents(allocation.remaining_amount);
                        const orderStatus = postedTransactionId ? `Order posted${postedDisplayId ? ` · ${postedDisplayId}` : ""}` : "Order not started";
                        const depositStatus = remainingCents > 0 ? `Deposit held · $${allocation.remaining_amount}` : "Deposit applied";
                        return (
                          <div key={allocation.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-app-surface p-3">
                            <div><p className="text-sm font-black text-app-text">{allocation.beneficiary_name}</p><p className="text-xs text-app-text-muted">{allocation.role} · ${allocation.amount} funded</p><div className="mt-1 flex flex-wrap gap-1.5"><span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${remainingCents > 0 ? "bg-app-info/10 text-app-info" : "bg-app-success/10 text-app-success"}`}>{depositStatus}</span><span className={`rounded-full px-2 py-0.5 text-[10px] font-black ${postedTransactionId ? "bg-app-success/10 text-app-success" : "bg-app-warning/10 text-app-warning"}`}>{orderStatus}</span></div></div>
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {postedTransactionId ? <button type="button" onClick={() => onOpenReceipt(postedTransactionId)} className="ui-btn-secondary inline-flex items-center gap-1"><ReceiptText size={14} /> Receipt · {postedDisplayId}</button> : null}
                              {allocation.source_credit_ledger_id && remainingCents > 0 ? (
                                <button type="button" onClick={() => onStartMemberOrder({ id: allocation.wedding_member_id, customer_id: allocation.beneficiary_customer_id, first_name: allocation.beneficiary_name.split(" ")[0] ?? "Wedding", last_name: allocation.beneficiary_name.split(" ").slice(1).join(" ") || "Member", role: allocation.role, status: "active", measured: false, suit_ordered: false, is_free_suit_promo: false }, workflow.party_name, { workflowId: workflow.id, sourceCreditLedgerId: allocation.source_credit_ledger_id!, remainingCents })} className="ui-btn-primary inline-flex items-center gap-1"><ShoppingCart size={14} /> Choose Member &amp; Add Items</button>
                              ) : postedDisplayId ? <span className="rounded-full bg-app-success/10 px-3 py-1 text-xs font-black text-app-success">Posted</span> : null}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </article>
                  );
                })}
                {!historyBusy && workflows.length === 0 ? <div className="rounded-2xl border border-app-border p-8 text-center text-sm text-app-text-muted">No source-tracked wedding deposits have been posted for this payer yet.</div> : null}
              </div>
            ) : null}
          </main>

          <aside className="border-t border-app-border bg-app-surface-2 p-4 md:border-l md:border-t-0">
            <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">Deposit Summary</p>
            <p className="mt-2 text-3xl font-black text-app-text">${centsToFixed2(totalCents)}</p>
            <p className="text-xs text-app-text-muted">
              {fundedMembers.length} funded {fundedMembers.length === 1 ? "member" : "members"}
              {selectedWithoutAmount.length > 0 ? ` · ${selectedWithoutAmount.length} selected without an amount (excluded)` : ""}
            </p>
            <dl className="mt-5 space-y-3 text-xs">
              <div><dt className="font-black text-app-text-muted">Workflow</dt><dd className="font-bold text-app-text">{step === "start" ? "Choose Deposit Only or Collect & Build Orders" : postPaymentAction === "build_orders" ? "Collect & Build Orders" : "Deposit Only"}</dd></div>
              <div><dt className="font-black text-app-text-muted">Payer</dt><dd className="font-bold text-app-text">{payerName}</dd></div>
              <div><dt className="font-black text-app-text-muted">Wedding Party</dt><dd className="font-bold text-app-text">{party?.party_name ?? "Not selected"}</dd></div>
              <div><dt className="font-black text-app-text-muted">Status</dt><dd className="font-bold text-app-text">{step === "start" ? "Choose workflow" : !party ? "Choose party" : !payerMember ? "Add payer to party" : fundedMembers.length === 0 ? "Enter at least one member amount" : invalidDestinationMembers.length > 0 ? "Resolve the highlighted destination amount" : step === "review" && !salespersonId ? "Select responsible salesperson" : step === "review" ? "Ready for Payment" : selectedWithoutAmount.length > 0 ? `${selectedWithoutAmount.length} zero-dollar selection excluded · ready to review` : "Ready to review"}</dd></div>
            </dl>
            {step === "members" ? <button type="button" disabled={!payerMember || !validAmounts} onClick={() => setStep("review")} className="ui-btn-primary mt-6 w-full">Review ${centsToFixed2(totalCents)} for {fundedMembers.length} {fundedMembers.length === 1 ? "Member" : "Members"}</button> : null}
            {step === "review" ? <button type="button" disabled={!salespersonId} onClick={addDeposits} className="ui-btn-primary mt-6 w-full">{postPaymentAction === "build_orders" ? "Continue to Payment & Build Orders" : "Add Deposits & Continue to Payment"}</button> : null}
            {step === "history" ? <button type="button" onClick={() => setStep("start")} className="ui-btn-secondary mt-6 w-full">Start New Deposit or Collect &amp; Build</button> : null}
          </aside>
        </div>
      </section>
    </div>,
    root,
  );
}
