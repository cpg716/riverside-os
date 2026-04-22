import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { useToast } from "../ui/ToastProviderLogic";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import ConfirmationModal from "../ui/ConfirmationModal";
import PromptModal from "../ui/PromptModal";
import { Link2, RefreshCw, ShieldCheck, Unlink, X as CloseIcon } from "lucide-react";

const baseUrl = getBaseUrl();
const PAGE = 100;

function fmtMoney(s?: string | null) {
  const t = String(s ?? "").trim();
  if (!t) return "—";
  const normalized = t.replace(/,/g, "");
  if (!Number.isFinite(Number.parseFloat(normalized))) return t;
  return formatUsdFromCents(parseMoneyToCents(normalized));
}

function fmtDate(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

type RmsLinkedAccount = {
  id: string;
  customer_id: string;
  corecredit_customer_id: string;
  corecredit_account_id: string;
  corecredit_card_id?: string | null;
  masked_account: string;
  status: string;
  is_primary: boolean;
  program_group?: string | null;
  last_verified_at?: string | null;
  verified_by_staff_id?: string | null;
  verification_source?: string | null;
  notes?: string | null;
  created_at: string;
  updated_at: string;
};

type RmsRecordRow = {
  id: string;
  record_kind: string;
  created_at: string;
  transaction_id: string;
  register_session_id: string;
  customer_id: string | null;
  payment_method: string;
  amount: string;
  operator_staff_id: string | null;
  payment_transaction_id: string | null;
  customer_display: string | null;
  order_short_ref: string | null;
  tender_family?: string | null;
  program_code?: string | null;
  program_label?: string | null;
  masked_account?: string | null;
  linked_corecredit_customer_id?: string | null;
  linked_corecredit_account_id?: string | null;
  resolution_status?: string | null;
  posting_status: string;
  posting_error_code?: string | null;
  host_reference?: string | null;
  external_transaction_id?: string | null;
  customer_name: string | null;
  customer_code: string | null;
  operator_name: string | null;
};

type RmsRecordDetail = RmsRecordRow & {
  external_auth_code?: string | null;
  posting_error_message?: string | null;
  posted_at?: string | null;
  reversed_at?: string | null;
  refunded_at?: string | null;
  idempotency_key?: string | null;
  external_transaction_type?: string | null;
  metadata_json?: Record<string, unknown> | null;
  host_metadata_json?: Record<string, unknown> | null;
  request_snapshot_json?: Record<string, unknown> | null;
  response_snapshot_json?: Record<string, unknown> | null;
};

type PosAccountSummary = {
  corecredit_customer_id: string;
  corecredit_account_id: string;
  masked_account: string;
  account_status: string;
  available_credit?: string | null;
  current_balance?: string | null;
  resolution_status?: string | null;
  source: string;
  recent_history?: Array<{
    created_at: string;
    record_kind: string;
    amount: string;
    payment_method: string;
    program_label?: string | null;
    masked_account?: string | null;
    order_short_ref?: string | null;
  }>;
};

type PosProgramOption = {
  program_code: string;
  program_label: string;
  eligible: boolean;
  disclosure?: string | null;
};

type AccountTransactionRow = {
  occurred_at: string;
  kind: string;
  amount: string;
  status: string;
  program_label?: string | null;
  masked_account?: string | null;
  order_short_ref?: string | null;
  external_reference?: string | null;
};

type RmsOverviewResponse = {
  totals: {
    charge_count?: number;
    payment_count?: number;
    failed_count?: number;
    pending_count?: number;
    charge_amount?: string;
    payment_amount?: string;
  };
  recent_activity?: RmsRecordDetail[];
  failed_host_actions?: RmsExceptionRow[];
  pending_exceptions?: RmsExceptionRow[];
  program_mix?: Array<{
    program_code: string;
    program_label: string;
    row_count: number;
    total_amount: string;
  }>;
  accounts?: Array<RmsLinkedAccount & {
    available_credit_snapshot?: string | null;
    current_balance_snapshot?: string | null;
    past_due_snapshot?: string | null;
    restrictions_snapshot_json?: Record<string, unknown>;
    last_balance_sync_at?: string | null;
    last_status_sync_at?: string | null;
    last_transactions_sync_at?: string | null;
    last_sync_error?: string | null;
  }>;
  sync_health?: {
    last_repair_poll_at?: string | null;
    active_exception_count?: number;
    pending_webhook_count?: number;
    failed_webhook_count?: number;
    stale_account_count?: number;
  };
};

type RmsExceptionRow = {
  id: string;
  rms_record_id?: string | null;
  account_id?: string | null;
  exception_type: string;
  severity: string;
  status: string;
  assigned_to_staff_id?: string | null;
  opened_at: string;
  resolved_at?: string | null;
  notes?: string | null;
  resolution_notes?: string | null;
  retry_count: number;
  last_retry_at?: string | null;
  metadata_json?: Record<string, unknown>;
};

type RmsReconciliationRun = {
  id: string;
  run_scope: string;
  status: string;
  started_at: string;
  completed_at?: string | null;
  requested_by_staff_id?: string | null;
  date_from?: string | null;
  date_to?: string | null;
  summary_json?: {
    mismatch_count?: number;
    retryable_count?: number;
  };
  error_message?: string | null;
};

type RmsReconciliationItem = {
  id: string;
  run_id: string;
  rms_record_id?: string | null;
  account_id?: string | null;
  mismatch_type: string;
  severity: string;
  status: string;
  riverside_value_json?: Record<string, unknown>;
  host_value_json?: Record<string, unknown>;
  qbo_value_json?: Record<string, unknown>;
  notes?: string | null;
  created_at: string;
};

type RmsReconciliationResponse = {
  runs?: RmsReconciliationRun[];
  items?: RmsReconciliationItem[];
};

export interface RmsChargeAdminSectionProps {
  onOpenTransactionInBackoffice?: (orderId: string) => void;
  surface?: "backoffice" | "pos";
}

export default function RmsChargeAdminSection({
  onOpenTransactionInBackoffice,
  surface = "backoffice",
}: RmsChargeAdminSectionProps) {
  const { backofficeHeaders, hasPermission, staffId, staffDisplayName } = useBackofficeAuth();
  const { toast } = useToast();
  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const canLegacyView =
    hasPermission("customers.rms_charge") || hasPermission("customers.rms_charge.view");
  const canManageLinks =
    hasPermission("customers.rms_charge") ||
    hasPermission("customers.rms_charge.manage_links");
  const canPosLookup =
    hasPermission("pos.rms_charge.lookup") || canManageLinks;
  const canPosUse = hasPermission("pos.rms_charge.use") || canManageLinks;
  const canPosHistory =
    hasPermission("pos.rms_charge.history_basic") || canPosLookup;
  const canPosPaymentCollect =
    hasPermission("pos.rms_charge.payment_collect") || canManageLinks;
  const canResolveExceptions =
    hasPermission("customers.rms_charge.resolve_exceptions") || canManageLinks;
  const canReconcile =
    hasPermission("customers.rms_charge.reconcile") ||
    hasPermission("customers.rms_charge.reporting") ||
    canManageLinks;
  const canReporting =
    hasPermission("customers.rms_charge.reporting") || canLegacyView;

  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [selectedCustomerLabel, setSelectedCustomerLabel] = useState("");
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<
    "overview" | "accounts" | "transactions" | "programs" | "exceptions" | "reconciliation"
  >("overview");
  const [accounts, setAccounts] = useState<RmsLinkedAccount[]>([]);
  const [activeAccountId, setActiveAccountId] = useState("");
  const [accountSummary, setAccountSummary] = useState<PosAccountSummary | null>(null);
  const [programs, setPrograms] = useState<PosProgramOption[]>([]);
  const [records, setRecords] = useState<RmsRecordRow[]>([]);
  const [recordDetail, setRecordDetail] = useState<RmsRecordDetail | null>(null);
  const [loadingRecordDetail, setLoadingRecordDetail] = useState(false);
  const [accountTransactions, setAccountTransactions] = useState<AccountTransactionRow[]>([]);
  const [overview, setOverview] = useState<RmsOverviewResponse | null>(null);
  const [exceptions, setExceptions] = useState<RmsExceptionRow[]>([]);
  const [reconciliation, setReconciliation] = useState<RmsReconciliationResponse | null>(null);
  const [resolvingException, setResolvingException] = useState<RmsExceptionRow | null>(null);
  const [confirmUnlinkAccount, setConfirmUnlinkAccount] = useState<RmsLinkedAccount | null>(null);
  const [loadingOverview, setLoadingOverview] = useState(false);
  const [loadingExceptions, setLoadingExceptions] = useState(false);
  const [loadingReconciliation, setLoadingReconciliation] = useState(false);
  const [overviewError, setOverviewError] = useState("");
  const [exceptionsError, setExceptionsError] = useState("");
  const [reconciliationError, setReconciliationError] = useState("");
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [loadingAccounts, setLoadingAccounts] = useState(false);
  const [assigningExceptionId, setAssigningExceptionId] = useState("");
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 90);
    return d.toISOString().slice(0, 10);
  });
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [kind, setKind] = useState<"" | "charge" | "payment">("");
  const [q, setQ] = useState("");
  const [linkForm, setLinkForm] = useState({
    corecredit_customer_id: "",
    corecredit_account_id: "",
    status: "active",
    is_primary: false,
    program_group: "",
    verification_source: "manual_backoffice",
    notes: "",
  });
  const activeAccount = useMemo(
    () => accounts.find((account) => account.corecredit_account_id === activeAccountId) ?? null,
    [accounts, activeAccountId],
  );
  const reconciliationScopeMessage = useMemo(() => {
    if (selectedCustomerId) {
      return "Reconciliation reviews all RMS activity. The selected customer helps with account review, but it does not filter mismatch results on this tab.";
    }
    return "Reconciliation reviews all RMS activity across linked RMS accounts. Use this tab for support and finance review, not customer-by-customer browsing.";
  }, [selectedCustomerId]);

  const loadAccounts = useCallback(async () => {
    if (!selectedCustomerId || !(canLegacyView || canManageLinks || canPosUse || canPosLookup)) {
      setAccounts([]);
      setActiveAccountId("");
      return;
    }
    setLoadingAccounts(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/rms-charge/customer/${encodeURIComponent(selectedCustomerId)}/accounts`,
        { headers: apiAuth() },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load linked accounts");
      }
      const data = (await res.json()) as RmsLinkedAccount[];
      setAccounts(Array.isArray(data) ? data : []);
      const preferred =
        data.find((account) => account.is_primary)?.corecredit_account_id ??
        data[0]?.corecredit_account_id ??
        "";
      setActiveAccountId((current) => current || preferred);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load linked accounts", "error");
      setAccounts([]);
      setActiveAccountId("");
    } finally {
      setLoadingAccounts(false);
    }
  }, [apiAuth, canLegacyView, canManageLinks, canPosLookup, canPosUse, selectedCustomerId, toast]);

  const loadPosSummary = useCallback(async () => {
    if (
      !selectedCustomerId ||
      !activeAccountId ||
      !(
        canPosUse ||
        canPosLookup ||
        canLegacyView ||
        canManageLinks
      )
    ) {
      setAccountSummary(null);
      setPrograms([]);
      setAccountTransactions([]);
      return;
    }
    try {
      const params = new URLSearchParams({ customer_id: selectedCustomerId });
      const summaryUrl =
        surface === "pos"
          ? `${baseUrl}/api/pos/rms-charge/account-summary?customer_id=${encodeURIComponent(selectedCustomerId)}&account_id=${encodeURIComponent(activeAccountId)}`
          : `${baseUrl}/api/customers/rms-charge/accounts/${encodeURIComponent(activeAccountId)}/balances?${params.toString()}`;
      const programsUrl =
        surface === "pos"
          ? `${baseUrl}/api/pos/rms-charge/programs?customer_id=${encodeURIComponent(selectedCustomerId)}&account_id=${encodeURIComponent(activeAccountId)}`
          : `${baseUrl}/api/pos/rms-charge/programs?customer_id=${encodeURIComponent(selectedCustomerId)}&account_id=${encodeURIComponent(activeAccountId)}`;
      const txUrl = `${baseUrl}/api/customers/rms-charge/accounts/${encodeURIComponent(activeAccountId)}/transactions?${params.toString()}`;
      const [programsRes, summaryRes, transactionsRes] = await Promise.all([
        fetch(programsUrl, { headers: apiAuth() }),
        fetch(summaryUrl, { headers: apiAuth() }),
        fetch(txUrl, { headers: apiAuth() }),
      ]);
      if (!programsRes.ok || !summaryRes.ok || !transactionsRes.ok) {
        const body = (await summaryRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load RMS Charge details");
      }
      const programsBody = (await programsRes.json()) as PosProgramOption[];
      const summaryBody = (await summaryRes.json()) as PosAccountSummary;
      const transactionsBody = (await transactionsRes.json()) as {
        rows?: AccountTransactionRow[];
      };
      setPrograms(Array.isArray(programsBody) ? programsBody : []);
      setAccountSummary(summaryBody as PosAccountSummary);
      setAccountTransactions(Array.isArray(transactionsBody?.rows) ? transactionsBody.rows : []);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load RMS Charge details", "error");
      setPrograms([]);
      setAccountSummary(null);
      setAccountTransactions([]);
    }
  }, [activeAccountId, apiAuth, canLegacyView, canManageLinks, canPosLookup, canPosUse, selectedCustomerId, surface, toast]);

  const fetchRecords = useCallback(async (nextOffset: number, append: boolean) => {
    if (surface === "pos" || !canLegacyView) return;
    setLoadingRecords(true);
    try {
      const params = new URLSearchParams();
      params.set("from", from);
      params.set("to", to);
      if (kind) params.set("kind", kind);
      if (selectedCustomerId) params.set("customer_id", selectedCustomerId);
      if (q.trim()) params.set("q", q.trim());
      params.set("limit", String(PAGE));
      params.set("offset", String(nextOffset));
      const res = await fetch(
        `${baseUrl}/api/customers/rms-charge/records?${params.toString()}`,
        { headers: apiAuth() },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load records");
      }
      const data = (await res.json()) as RmsRecordRow[];
      setHasMore(data.length >= PAGE);
      setOffset(nextOffset + data.length);
      setRecords((prev) => (append ? [...prev, ...data] : data));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load records", "error");
      if (!append) setRecords([]);
      setHasMore(false);
    } finally {
      setLoadingRecords(false);
    }
  }, [apiAuth, canLegacyView, from, kind, q, selectedCustomerId, surface, to, toast]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  useEffect(() => {
    void loadPosSummary();
  }, [loadPosSummary]);

  useEffect(() => {
    if (surface === "pos" || !canLegacyView) return;
    setOffset(0);
    void fetchRecords(0, false);
  }, [canLegacyView, fetchRecords, from, kind, q, selectedCustomerId, surface, to]);

  const loadRecordDetail = useCallback(async (recordId: string) => {
    if (!recordId || surface === "pos") return;
    setLoadingRecordDetail(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/records/${encodeURIComponent(recordId)}`, {
        headers: apiAuth(),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? "Could not load RMS Charge record detail");
      }
      const data = (await res.json()) as RmsRecordDetail;
      setRecordDetail(data);
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load RMS Charge record detail", "error");
      setRecordDetail(null);
    } finally {
      setLoadingRecordDetail(false);
    }
  }, [apiAuth, surface, toast]);

  const loadOperationalData = useCallback(async () => {
    if (surface === "pos") return;
    if (!(canLegacyView || canManageLinks || canReporting || canResolveExceptions || canReconcile)) {
      setOverview(null);
      setExceptions([]);
      setReconciliation(null);
      setOverviewError("");
      setExceptionsError("");
      setReconciliationError("");
      return;
    }
    const customerParam = selectedCustomerId ? `customer_id=${encodeURIComponent(selectedCustomerId)}` : "";
    let failureCount = 0;

    const loadOverviewSection = async () => {
      setLoadingOverview(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/rms-charge/overview${customerParam ? `?${customerParam}` : ""}`,
          { headers: apiAuth() },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "We couldn't refresh the RMS overview right now.");
        }
        const overviewBody = (await res.json()) as RmsOverviewResponse;
        setOverview(overviewBody);
        setOverviewError("");
      } catch (error) {
        failureCount += 1;
        setOverviewError(
          error instanceof Error ? error.message : "We couldn't refresh the RMS overview right now.",
        );
      } finally {
        setLoadingOverview(false);
      }
    };

    const loadExceptionsSection = async () => {
      setLoadingExceptions(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/rms-charge/exceptions?${new URLSearchParams({
            ...(selectedCustomerId ? { customer_id: selectedCustomerId } : {}),
            limit: "50",
          }).toString()}`,
          { headers: apiAuth() },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "We couldn't refresh RMS issues right now.");
        }
        const exceptionsBody = (await res.json()) as RmsExceptionRow[];
        setExceptions(Array.isArray(exceptionsBody) ? exceptionsBody : []);
        setExceptionsError("");
      } catch (error) {
        failureCount += 1;
        setExceptionsError(
          error instanceof Error ? error.message : "We couldn't refresh RMS issues right now.",
        );
      } finally {
        setLoadingExceptions(false);
      }
    };

    const loadReconciliationSection = async () => {
      setLoadingReconciliation(true);
      try {
        const res = await fetch(`${baseUrl}/api/customers/rms-charge/reconciliation?limit=10`, {
          headers: apiAuth(),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "We couldn't refresh reconciliation review right now.");
        }
        const reconciliationBody = (await res.json()) as RmsReconciliationResponse;
        setReconciliation(reconciliationBody);
        setReconciliationError("");
      } catch (error) {
        failureCount += 1;
        setReconciliationError(
          error instanceof Error ? error.message : "We couldn't refresh reconciliation review right now.",
        );
      } finally {
        setLoadingReconciliation(false);
      }
    };

    await Promise.all([
      loadOverviewSection(),
      loadExceptionsSection(),
      loadReconciliationSection(),
    ]);

    if (failureCount >= 3) {
      toast("We couldn't load RMS Charge activity right now.", "error");
    } else if (failureCount > 0) {
      toast("Some RMS support sections could not be refreshed. Other sections are still available.", "error");
    }
  }, [
    apiAuth,
    canLegacyView,
    canManageLinks,
    canReconcile,
    canReporting,
    canResolveExceptions,
    selectedCustomerId,
    surface,
    toast,
  ]);

  const retryException = useCallback(async (exceptionId: string) => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/exceptions/${encodeURIComponent(exceptionId)}/retry`, {
        method: "POST",
        headers: apiAuth(),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; status?: string };
      if (!res.ok) throw new Error(body.error ?? "We couldn't try this issue again.");
      toast("The issue was sent for another try.", "success");
      await Promise.all([loadOperationalData(), loadAccounts()]);
    } catch (error) {
      toast(error instanceof Error ? error.message : "We couldn't try this issue again.", "error");
    }
  }, [apiAuth, loadAccounts, loadOperationalData, toast]);

  const assignExceptionToCurrentStaff = useCallback(async (exception: RmsExceptionRow) => {
    if (!staffId) {
      toast("Sign back in before claiming RMS issues.", "error");
      return;
    }
    setAssigningExceptionId(exception.id);
    try {
      const res = await fetch(
        `${baseUrl}/api/customers/rms-charge/exceptions/${encodeURIComponent(exception.id)}/assign`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...apiAuth(),
          },
          body: JSON.stringify({
            assigned_to_staff_id: staffId,
            notes: `Claimed by ${staffDisplayName || "current staff member"} in RMS Charge workspace`,
          }),
        },
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "We couldn't claim this RMS issue.");
      toast("RMS issue assigned to you.", "success");
      await loadOperationalData();
    } catch (error) {
      toast(error instanceof Error ? error.message : "We couldn't claim this RMS issue.", "error");
    } finally {
      setAssigningExceptionId("");
    }
  }, [apiAuth, loadOperationalData, staffDisplayName, staffId, toast]);

  const resolveException = useCallback(async (exceptionId: string) => {
    setResolvingException(exceptions.find((row) => row.id === exceptionId) ?? null);
  }, [exceptions]);

  const submitResolutionNote = useCallback(async (note: string) => {
    const trimmed = note.trim();
    if (!resolvingException) return false;
    if (!trimmed) {
      toast("Add a short resolution note so the next staff member knows what cleared the issue.", "error");
      return false;
    }
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/exceptions/${encodeURIComponent(resolvingException.id)}/resolve`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({ resolution_notes: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "We couldn't mark this issue as resolved.");
      toast("Issue marked as resolved.", "success");
      await loadOperationalData();
      setResolvingException(null);
      return true;
    } catch (error) {
      toast(
        error instanceof Error ? error.message : "We couldn't mark this issue as resolved.",
        "error",
      );
      return false;
    }
  }, [apiAuth, loadOperationalData, resolvingException, toast]);

  const runReconciliation = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/reconciliation/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({ run_scope: "manual_workspace" }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? "We couldn't run reconciliation right now.");
      toast("Reconciliation finished.", "success");
      await loadOperationalData();
    } catch (error) {
      toast(error instanceof Error ? error.message : "We couldn't run reconciliation right now.", "error");
    }
  }, [apiAuth, loadOperationalData, toast]);

  useEffect(() => {
    void loadOperationalData();
  }, [loadOperationalData]);

  const submitLink = useCallback(async () => {
    if (!selectedCustomerId) {
      toast("Select a customer before linking an account.", "error");
      return;
    }
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/link-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          customer_id: selectedCustomerId,
          ...linkForm,
          program_group: linkForm.program_group || undefined,
          notes: linkForm.notes || undefined,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Could not link account");
      }
      toast("RMS Charge account linked.", "success");
      setLinkForm({
        corecredit_customer_id: "",
        corecredit_account_id: "",
        status: "active",
        is_primary: false,
        program_group: "",
        verification_source: "manual_backoffice",
        notes: "",
      });
      await loadAccounts();
    } catch (error) {
      toast(error instanceof Error ? error.message : "We couldn't link this account. Please try again.", "error");
    }
  }, [apiAuth, linkForm, loadAccounts, selectedCustomerId, toast]);

  const unlinkAccount = useCallback(async (account: RmsLinkedAccount) => {
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/unlink-account`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...apiAuth(),
        },
        body: JSON.stringify({
          customer_id: account.customer_id,
          link_id: account.id,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(body.error ?? "Could not unlink account");
      }
      toast("RMS Charge account removed.", "success");
      await loadAccounts();
      setConfirmUnlinkAccount(null);
    } catch (error) {
      toast(error instanceof Error ? error.message : "We couldn't remove this account link. Please try again.", "error");
    }
  }, [apiAuth, loadAccounts, toast]);

  return (
    <div className="ui-page flex min-h-0 flex-1 flex-col p-6">
      <div className="mb-4 shrink-0">
        <p className="text-[10px] font-black uppercase tracking-[0.16em] text-app-text-muted">
          {surface === "pos" ? "Register" : "Customers"}
        </p>
        <h2 className="text-2xl font-black tracking-tight text-app-text">
          RMS Charge
        </h2>
        <p className="mt-1 max-w-3xl text-sm text-app-text-muted">
          {surface === "pos"
            ? "Use this view to check the customer's RMS account, recent activity, and available plans."
            : "Use this workspace to manage linked RMS Charge accounts, transactions, issues, and reconciliation for the selected customer."}
        </p>
      </div>

      {surface === "backoffice" ? (
        <div className="mb-4 flex flex-wrap gap-2">
          {[
            ["overview", "Overview"],
            ["accounts", "Accounts"],
            ["transactions", "Transactions"],
            ["programs", "Programs"],
            ["exceptions", "Exceptions"],
            ["reconciliation", "Reconciliation"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              data-testid={`rms-workspace-tab-${id}`}
              onClick={() =>
                setActiveWorkspaceTab(
                  id as
                    | "overview"
                    | "accounts"
                    | "transactions"
                    | "programs"
                    | "exceptions"
                    | "reconciliation",
                )
              }
              className={`rounded-full border px-4 py-2 text-[10px] font-black uppercase tracking-widest transition-colors ${
                activeWorkspaceTab === id
                  ? "border-app-accent bg-app-accent/10 text-app-accent"
                  : "border-app-border bg-app-surface text-app-text-muted hover:text-app-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="mb-4 grid gap-4 xl:grid-cols-[1.3fr,1fr]">
        <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Customer Context
              </p>
              <h3 className="text-lg font-black tracking-tight text-app-text">
                Active Linked Accounts
              </h3>
            </div>
            <button
              type="button"
              data-testid="rms-linked-accounts-refresh"
              onClick={() => void loadAccounts()}
              className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
            >
              <RefreshCw size={14} />
            </button>
          </div>

          <div className="mt-4">
            {selectedCustomerId ? (
              <div className="flex h-[42px] items-center justify-between rounded-xl border border-app-accent bg-app-accent/5 px-3">
                <div className="min-w-0">
                  <div className="truncate text-sm font-black text-app-text">
                    {selectedCustomerLabel || "Selected customer"}
                  </div>
                  <div
                    data-testid="rms-selected-customer-id"
                    className="truncate text-[10px] font-black uppercase tracking-widest text-app-accent"
                  >
                    {selectedCustomerId}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCustomerId("");
                    setSelectedCustomerLabel("");
                  }}
                  className="ml-3 text-app-accent hover:text-black"
                  aria-label="Clear customer context"
                >
                  <CloseIcon size={14} />
                </button>
              </div>
            ) : canPosLookup || canLegacyView || canManageLinks ? (
              <CustomerSearchInput
                onSelect={(customer) => {
                  setSelectedCustomerId(customer.id);
                  setSelectedCustomerLabel(
                    `${customer.first_name} ${customer.last_name}${customer.customer_code ? ` · ${customer.customer_code}` : ""}`,
                  );
                }}
                placeholder="Search customer for RMS Charge…"
                className="py-0.5"
              />
            ) : (
              <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                Your role does not include RMS Charge lookup access.
              </div>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {loadingAccounts ? (
              <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                Loading linked accounts…
              </div>
            ) : accounts.length === 0 ? (
              <div className="rounded-xl border border-dashed border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                {selectedCustomerId
                  ? "No linked CoreCredit/CoreCard accounts for this customer yet."
                  : "Select a customer to view linked accounts."}
              </div>
            ) : (
              accounts.map((account) => (
                <div
                  key={account.id}
                  className={`rounded-xl border p-4 transition-all ${
                    activeAccountId === account.corecredit_account_id
                      ? "border-app-accent bg-app-accent/5"
                      : "border-app-border bg-app-bg"
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setActiveAccountId(account.corecredit_account_id)}
                      className="min-w-0 text-left"
                    >
                      <div className="text-lg font-black italic text-app-text">
                        {account.masked_account}
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        <span className="rounded-full bg-app-surface px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                          {account.status}
                        </span>
                        {account.is_primary ? (
                          <span className="rounded-full bg-emerald-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-emerald-700">
                            Primary
                          </span>
                        ) : null}
                        {account.program_group ? (
                          <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-amber-700">
                            {account.program_group}
                          </span>
                        ) : null}
                      </div>
                    </button>

                    {surface === "backoffice" && canManageLinks ? (
                      <button
                        type="button"
                        data-testid={`rms-account-unlink-${account.id}`}
                        onClick={() => setConfirmUnlinkAccount(account)}
                        className="rounded-lg border border-rose-300/40 bg-rose-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-widest text-rose-700"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Unlink size={14} />
                          Remove Link
                        </span>
                      </button>
                    ) : null}
                  </div>

                  <div className="mt-3 grid gap-2 md:grid-cols-2 text-[11px]">
                    <div className="rounded-lg bg-app-surface px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        CoreCredit Customer
                      </div>
                      <div className="mt-1 font-mono text-app-text">
                        {account.corecredit_customer_id}
                      </div>
                    </div>
                    <div className="rounded-lg bg-app-surface px-3 py-2">
                      <div className="text-[9px] font-black uppercase tracking-widest text-app-text-muted">
                        Last Verified
                      </div>
                      <div className="mt-1 text-app-text">
                        {fmtDate(account.last_verified_at)}
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
          <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            {surface === "pos" ? "Register RMS" : activeWorkspaceTab}
          </p>
          <h3 className="text-lg font-black tracking-tight text-app-text">
            {surface === "pos"
              ? "Slim RMS Charge Workspace"
              : activeWorkspaceTab === "overview"
                ? "Operational Overview"
                : activeWorkspaceTab === "accounts"
                  ? "Accounts & Verification"
                  : activeWorkspaceTab === "transactions"
                    ? "Posting Transactions"
                    : activeWorkspaceTab === "programs"
                      ? "Program Visibility"
                      : activeWorkspaceTab === "exceptions"
                        ? "Exception Queue"
                        : "Reconciliation & QBO Support"}
          </h3>

          {surface === "backoffice" && activeWorkspaceTab === "accounts" && canManageLinks ? (
            <div className="mt-4 space-y-3">
              <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                Link only after you confirm the customer and RMS account belong together. Removing a link only changes Riverside's customer relationship to that account, and the action is recorded in the staff audit trail.
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  data-testid="rms-link-corecredit-customer-id"
                  value={linkForm.corecredit_customer_id}
                  onChange={(event) =>
                    setLinkForm((prev) => ({
                      ...prev,
                      corecredit_customer_id: event.target.value,
                    }))
                  }
                  placeholder="CoreCredit customer id"
                  className="ui-input py-2 text-sm"
                />
                <input
                  data-testid="rms-link-corecredit-account-id"
                  value={linkForm.corecredit_account_id}
                  onChange={(event) =>
                    setLinkForm((prev) => ({
                      ...prev,
                      corecredit_account_id: event.target.value,
                    }))
                  }
                  placeholder="CoreCredit account id"
                  className="ui-input py-2 text-sm"
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <input
                  data-testid="rms-link-program-group"
                  value={linkForm.program_group}
                  onChange={(event) =>
                    setLinkForm((prev) => ({
                      ...prev,
                      program_group: event.target.value,
                    }))
                  }
                  placeholder="Program group"
                  className="ui-input py-2 text-sm"
                />
                <select
                  data-testid="rms-link-status"
                  value={linkForm.status}
                  onChange={(event) =>
                    setLinkForm((prev) => ({ ...prev, status: event.target.value }))
                  }
                  className="ui-input py-2 text-sm"
                >
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                  <option value="restricted">Restricted</option>
                  <option value="suspended">Suspended</option>
                </select>
              </div>
              <input
                data-testid="rms-link-notes"
                value={linkForm.notes}
                onChange={(event) =>
                  setLinkForm((prev) => ({ ...prev, notes: event.target.value }))
                }
                placeholder="Verification notes"
                className="ui-input py-2 text-sm"
              />
              <label className="flex items-center gap-2 text-sm font-semibold text-app-text">
                <input
                  data-testid="rms-link-primary"
                  type="checkbox"
                  checked={linkForm.is_primary}
                  onChange={(event) =>
                    setLinkForm((prev) => ({
                      ...prev,
                      is_primary: event.target.checked,
                    }))
                  }
                />
                Mark as primary linked account
              </label>
              <button
                type="button"
                data-testid="rms-link-submit"
                onClick={() => void submitLink()}
                className="ui-btn-primary inline-flex items-center gap-2 px-4 py-2"
              >
                <Link2 size={14} />
                Link Account
              </button>
            </div>
          ) : surface === "backoffice" && activeWorkspaceTab === "overview" ? (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {overviewError ? (
                <div
                  data-testid="rms-overview-load-warning"
                  className="sm:col-span-2 rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm text-amber-800"
                >
                  {overview
                    ? `${overviewError} Showing the last loaded overview while other RMS sections keep updating.`
                    : overviewError}
                </div>
              ) : null}
              {[
                ["Charges", `${overview?.totals?.charge_count ?? 0} · ${fmtMoney(overview?.totals?.charge_amount)}`],
                ["Payments", `${overview?.totals?.payment_count ?? 0} · ${fmtMoney(overview?.totals?.payment_amount)}`],
                ["Failed host actions", String(overview?.totals?.failed_count ?? 0)],
                ["Pending exceptions", String(overview?.sync_health?.active_exception_count ?? 0)],
                ["Updates waiting", String(overview?.sync_health?.pending_webhook_count ?? 0)],
                ["Last automatic refresh", fmtDate(overview?.sync_health?.last_repair_poll_at)],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-app-border bg-app-bg p-4">
                  <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {label}
                  </div>
                  <div className="mt-2 text-sm font-bold text-app-text">{value}</div>
                </div>
              ))}
              <div className="sm:col-span-2 rounded-xl border border-app-border bg-app-bg p-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Program Mix
                </div>
                <div className="mt-3 grid gap-2">
                  {loadingOverview && !overview ? (
                    <div className="text-sm text-app-text-muted">Loading overview…</div>
                  ) : (overview?.program_mix?.length ?? 0) === 0 ? (
                    <div className="text-sm text-app-text-muted">No program activity in the current workspace scope.</div>
                  ) : (
                    overview?.program_mix?.map((row) => (
                      <div key={`${row.program_code}-${row.program_label}`} className="flex items-center justify-between rounded-lg border border-app-border px-3 py-2 text-sm">
                        <span className="font-black text-app-text">{row.program_label}</span>
                        <span className="text-app-text-muted">
                          {row.row_count} · {fmtMoney(row.total_amount)}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : surface === "backoffice" && activeWorkspaceTab === "programs" ? (
            <div className="mt-4 space-y-3">
              {programs.length === 0 ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                  Select an account to review available RMS Charge plans. Program totals still appear in Overview.
                </div>
              ) : (
                programs.map((program) => (
                  <div key={program.program_code} className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-black uppercase tracking-wide text-app-text">{program.program_label}</div>
                        <div className="text-[11px] text-app-text-muted">{program.program_code}</div>
                      </div>
                      <div className={`text-[10px] font-black uppercase tracking-widest ${program.eligible ? "text-emerald-700" : "text-rose-700"}`}>
                        {program.eligible ? "Eligible" : "Blocked"}
                      </div>
                    </div>
                    {program.disclosure ? <div className="mt-2 text-xs text-app-text-muted">{program.disclosure}</div> : null}
                  </div>
                ))
              )}
            </div>
          ) : surface === "backoffice" && activeWorkspaceTab === "exceptions" ? (
            <div className="mt-4 space-y-3">
              {exceptionsError ? (
                <div
                  data-testid="rms-exceptions-load-warning"
                  className="rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm text-amber-800"
                >
                  {exceptions.length
                    ? `${exceptionsError} Showing the last loaded issue queue.`
                    : exceptionsError}
                </div>
              ) : null}
              {loadingExceptions && !exceptions.length ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">Loading open issues…</div>
              ) : exceptions.length === 0 ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">No active RMS Charge exceptions.</div>
              ) : (
                exceptions.slice(0, 8).map((exception) => (
                  <div key={exception.id} className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-black uppercase tracking-wide text-app-text">{exception.exception_type.replaceAll("_", " ")}</div>
                        <div className="text-[11px] text-app-text-muted">{fmtDate(exception.opened_at)} · {exception.status} · {exception.severity}</div>
                      </div>
                      <div className="text-xs font-mono text-app-text-muted">{exception.account_id || "Customer-level issue"}</div>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {exception.assigned_to_staff_id ? (
                        <span
                          data-testid={`rms-exception-assignee-${exception.id}`}
                          className="rounded-full bg-app-surface px-2 py-1 text-[9px] font-black uppercase tracking-widest text-app-text-muted"
                        >
                          {exception.assigned_to_staff_id === staffId ? "Assigned to you" : "Assigned"}
                        </span>
                      ) : (
                        <span
                          data-testid={`rms-exception-assignee-${exception.id}`}
                          className="rounded-full bg-amber-500/10 px-2 py-1 text-[9px] font-black uppercase tracking-widest text-amber-700"
                        >
                          Unassigned
                        </span>
                      )}
                    </div>
                    {exception.notes ? <div className="mt-2 text-sm text-app-text-muted">{exception.notes}</div> : null}
                    {exception.resolution_notes ? (
                      <div className="mt-2 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text-muted">
                        Resolution note: {exception.resolution_notes}
                      </div>
                    ) : null}
                    {canResolveExceptions ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {!exception.assigned_to_staff_id || exception.assigned_to_staff_id !== staffId ? (
                          <button
                            type="button"
                            data-testid={`rms-exception-assign-self-${exception.id}`}
                            disabled={assigningExceptionId === exception.id}
                            onClick={() => void assignExceptionToCurrentStaff(exception)}
                            className="ui-btn-secondary px-3 py-2 text-[10px] disabled:opacity-60"
                          >
                            {assigningExceptionId === exception.id ? "Claiming…" : "Assign to Me"}
                          </button>
                        ) : null}
                        <button type="button" data-testid={`rms-exception-retry-${exception.id}`} onClick={() => void retryException(exception.id)} className="ui-btn-secondary px-3 py-2 text-[10px]">
                          Retry
                        </button>
                        <button type="button" data-testid={`rms-exception-resolve-${exception.id}`} onClick={() => void resolveException(exception.id)} className="ui-btn-secondary px-3 py-2 text-[10px]">
                          Resolve
                        </button>
                      </div>
                    ) : null}
                  </div>
                ))
              )}
            </div>
          ) : surface === "backoffice" && activeWorkspaceTab === "reconciliation" ? (
            <div className="mt-4 space-y-3">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-app-border bg-app-bg p-4">
                <div>
                  <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">All RMS activity</div>
                  <div data-testid="rms-reconciliation-scope" className="mt-1 text-sm text-app-text-muted">{reconciliationScopeMessage}</div>
                </div>
                {canReconcile ? (
                  <button type="button" data-testid="rms-run-reconciliation" onClick={() => void runReconciliation()} className="ui-btn-primary px-4 py-2">
                    Run Reconciliation
                  </button>
                ) : null}
              </div>
              {reconciliationError ? (
                <div
                  data-testid="rms-reconciliation-load-warning"
                  className="rounded-xl border border-amber-300/40 bg-amber-500/10 p-4 text-sm text-amber-800"
                >
                  {reconciliation?.runs?.length || reconciliation?.items?.length
                    ? `${reconciliationError} Showing the last loaded reconciliation review.`
                    : `${reconciliationError} Overview and exceptions are still available while this review is offline.`}
                </div>
              ) : null}
              {loadingReconciliation && !reconciliation ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">Loading reconciliation review…</div>
              ) : (reconciliation?.runs?.length ?? 0) === 0 ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">No reconciliation runs yet.</div>
              ) : (
                reconciliation?.runs?.slice(0, 4).map((run) => (
                  <div key={run.id} className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-black uppercase tracking-wide text-app-text">{run.run_scope}</div>
                        <div className="text-[11px] text-app-text-muted">{fmtDate(run.started_at)} · {run.status}</div>
                      </div>
                      <div className="text-sm font-black text-app-text">
                        {run.summary_json?.mismatch_count ?? 0} mismatches
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              {[
                ["Balances", activeAccount ? fmtMoney(accountSummary?.available_credit) : "Select account"],
                ["Transactions", `${accountTransactions.length} visible`],
                ["Transaction status", activeAccount ? (recordDetail?.posting_status || accountSummary?.account_status || activeAccount.status) : "Awaiting selection"],
                ["Programs", `${programs.length} available`],
                ["Payment collection", canPosPaymentCollect ? "Allowed" : "Manager or sales support only"],
                ["Reprint / refs", canPosHistory ? "Visible" : "Restricted"],
              ].map(([label, value]) => (
                <div key={label} className="rounded-xl border border-app-border bg-app-bg p-4">
                  <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {label}
                  </div>
                  <div className="mt-2 text-sm font-bold text-app-text">
                    {value}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {surface === "pos" ? (
        <div className="grid gap-4 xl:grid-cols-[1fr,1fr]">
          <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <div className="flex items-center gap-2">
              <ShieldCheck size={16} className="text-app-accent" />
              <h3 className="text-lg font-black tracking-tight text-app-text">
                Account Summary
              </h3>
            </div>
            <div className="mt-4 space-y-3">
              {activeAccount ? (
                <>
                  <div className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Selected Account
                    </div>
                    <div className="mt-2 text-xl font-black italic text-app-text">
                      {activeAccount.masked_account}
                    </div>
                    <div className="mt-2 text-sm text-app-text-muted">
                      Status: {accountSummary?.account_status ?? activeAccount.status}
                    </div>
                    <div className="mt-2 text-sm text-app-text-muted">
                      Available credit: {fmtMoney(accountSummary?.available_credit)}
                    </div>
                    <div className="mt-1 text-sm text-app-text-muted">
                      Current balance: {fmtMoney(accountSummary?.current_balance)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Programs
                    </div>
                    <div className="mt-3 grid gap-2">
                      {programs.length === 0 ? (
                        <div className="text-sm text-app-text-muted">
                          No program data returned for this account yet.
                        </div>
                      ) : (
                        programs.map((program) => (
                          <div
                            key={program.program_code}
                            className="rounded-lg border border-app-border px-3 py-2"
                          >
                            <div className="flex items-center justify-between">
                              <span className="font-black uppercase tracking-wide text-app-text">
                                {program.program_label}
                              </span>
                              <span className={`text-[10px] font-black uppercase tracking-widest ${program.eligible ? "text-emerald-700" : "text-rose-700"}`}>
                                {program.eligible ? "Eligible" : "Blocked"}
                              </span>
                            </div>
                            {program.disclosure ? (
                              <div className="mt-1 text-xs text-app-text-muted">
                                {program.disclosure}
                              </div>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                  <div className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Host Activity
                    </div>
                    <div className="mt-3 space-y-2">
                      {accountTransactions.length === 0 ? (
                        <div className="text-sm text-app-text-muted">
                          No account-level RMS activity returned yet.
                        </div>
                      ) : (
                        accountTransactions.slice(0, 5).map((row) => (
                          <div key={`${row.occurred_at}-${row.external_reference ?? row.amount}`} className="rounded-lg border border-app-border px-3 py-2">
                            <div className="flex items-center justify-between gap-3">
                              <div>
                                <div className="font-black uppercase tracking-wide text-app-text">
                                  {row.program_label || row.kind}
                                </div>
                                <div className="text-[11px] text-app-text-muted">
                                  {fmtDate(row.occurred_at)} · {row.status}
                                </div>
                              </div>
                              <div className="text-sm font-black text-app-text">
                                {fmtMoney(row.amount)}
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                  Select a linked account to view POS summary details.
                </div>
              )}
            </div>
          </div>

          <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
            <h3 className="text-lg font-black tracking-tight text-app-text">
              Recent RMS Activity
            </h3>
            <div className="mt-4 space-y-2">
              {!canPosHistory ? (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                  History preview requires `pos.rms_charge.history_basic`.
                </div>
              ) : accountSummary?.recent_history?.length ? (
                accountSummary.recent_history.map((row) => (
                  <div key={`${row.created_at}-${row.order_short_ref ?? row.amount}`} className="rounded-xl border border-app-border bg-app-bg p-3">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-sm font-black uppercase tracking-wide text-app-text">
                          {row.program_label || row.payment_method}
                        </div>
                        <div className="text-[11px] text-app-text-muted">
                          {fmtDate(row.created_at)} · {row.record_kind}
                        </div>
                      </div>
                      <div className="text-sm font-black text-app-text">
                        {fmtMoney(row.amount)}
                      </div>
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                  No recent RMS Charge activity for the selected account.
                </div>
              )}
            </div>
          </div>
        </div>
      ) : (
        activeWorkspaceTab !== "transactions" ? (
          <div className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    {activeWorkspaceTab}
                  </p>
                  <h3 className="text-lg font-black tracking-tight text-app-text">
                    {activeWorkspaceTab === "overview"
                      ? "Recent RMS Activity"
                      : activeWorkspaceTab === "accounts"
                        ? "Linked Accounts Snapshot"
                        : activeWorkspaceTab === "programs"
                          ? "Program Eligibility & Mix"
                          : activeWorkspaceTab === "exceptions"
                            ? "Manual Review Queue"
                            : "Latest Reconciliation Mismatches Across All RMS Activity"}
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => void loadOperationalData()}
                  className="rounded-xl border border-app-border bg-app-surface px-3 py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted"
                >
                  Refresh
                </button>
              </div>
              <div className="mt-4 space-y-3">
                {activeWorkspaceTab === "overview" && (overview?.recent_activity?.length ?? 0) > 0
                  ? overview?.recent_activity?.map((row) => (
                      <div key={row.id} className="rounded-xl border border-app-border bg-app-bg p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-black uppercase tracking-wide text-app-text">
                              {row.program_label || row.payment_method}
                            </div>
                            <div className="text-[11px] text-app-text-muted">
                              {fmtDate(row.created_at)} · {row.posting_status}
                            </div>
                          </div>
                          <div className="text-sm font-black text-app-text">{fmtMoney(row.amount)}</div>
                        </div>
                      </div>
                    ))
                  : null}
                {activeWorkspaceTab === "accounts" && (overview?.accounts?.length ?? 0) > 0
                  ? overview?.accounts?.map((account) => (
                      <div key={account.id} className="rounded-xl border border-app-border bg-app-bg p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-black uppercase tracking-wide text-app-text">{account.masked_account}</div>
                            <div className="text-[11px] text-app-text-muted">{account.status} · verified {fmtDate(account.last_verified_at)}</div>
                          </div>
                          <div className="text-right text-[11px] text-app-text-muted">
                            <div>Avail: {fmtMoney(account.available_credit_snapshot)}</div>
                            <div>Bal: {fmtMoney(account.current_balance_snapshot)}</div>
                          </div>
                        </div>
                      </div>
                    ))
                  : null}
                {activeWorkspaceTab === "programs" && (overview?.program_mix?.length ?? 0) > 0
                  ? overview?.program_mix?.map((row) => (
                      <div key={`${row.program_code}-${row.program_label}`} className="rounded-xl border border-app-border bg-app-bg p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-black uppercase tracking-wide text-app-text">{row.program_label}</div>
                            <div className="text-[11px] text-app-text-muted">{row.program_code}</div>
                          </div>
                          <div className="text-right text-[11px] text-app-text-muted">
                            <div>{row.row_count} records</div>
                            <div>{fmtMoney(row.total_amount)}</div>
                          </div>
                        </div>
                      </div>
                    ))
                  : null}
                {activeWorkspaceTab === "exceptions" && exceptions.length > 0
                  ? exceptions.map((row) => (
                      <div key={row.id} className="rounded-xl border border-app-border bg-app-bg p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-black uppercase tracking-wide text-app-text">{row.exception_type.replaceAll("_", " ")}</div>
                            <div className="text-[11px] text-app-text-muted">{fmtDate(row.opened_at)} · {row.status}</div>
                          </div>
                          <div className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">{row.severity}</div>
                        </div>
                      </div>
                    ))
                  : null}
                {activeWorkspaceTab === "reconciliation" && (reconciliation?.items?.length ?? 0) > 0
                  ? reconciliation?.items?.slice(0, 8).map((item) => (
                      <div key={item.id} className="rounded-xl border border-app-border bg-app-bg p-4">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-sm font-black uppercase tracking-wide text-app-text">{item.mismatch_type.replaceAll("_", " ")}</div>
                            <div className="text-[11px] text-app-text-muted">{fmtDate(item.created_at)} · {item.status}</div>
                          </div>
                          <div className="text-[11px] font-black uppercase tracking-widest text-app-text-muted">{item.severity}</div>
                        </div>
                      </div>
                    ))
                  : null}
                {((activeWorkspaceTab === "overview" && !(overview?.recent_activity?.length)) ||
                  (activeWorkspaceTab === "accounts" && !(overview?.accounts?.length)) ||
                  (activeWorkspaceTab === "programs" && !(overview?.program_mix?.length)) ||
                  (activeWorkspaceTab === "exceptions" && !exceptions.length) ||
                  (activeWorkspaceTab === "reconciliation" && !(reconciliation?.items?.length))) ? (
                  <div className="rounded-xl border border-app-border bg-app-bg p-4 text-sm text-app-text-muted">
                    {activeWorkspaceTab === "overview" && loadingOverview
                      ? "Loading overview…"
                      : activeWorkspaceTab === "exceptions" && loadingExceptions
                        ? "Loading RMS issues…"
                        : activeWorkspaceTab === "reconciliation" && loadingReconciliation
                          ? "Loading reconciliation review…"
                          : "No data in this RMS Charge operational section yet."}
                  </div>
                ) : null}
              </div>
            </div>
            <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
              <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">System-wide RMS support</div>
              {overviewError ? (
                <div className="mt-3 rounded-xl border border-amber-300/40 bg-amber-500/10 p-3 text-sm text-amber-800">
                  RMS support totals could not be refreshed. Other RMS sections may still be current.
                </div>
              ) : null}
              <div className="mt-4 grid gap-3">
                {[
                  ["Automatic refresh", fmtDate(overview?.sync_health?.last_repair_poll_at)],
                  ["Active exceptions", String(overview?.sync_health?.active_exception_count ?? 0)],
                  ["Missed updates", String(overview?.sync_health?.failed_webhook_count ?? 0)],
                  ["Stale accounts", String(overview?.sync_health?.stale_account_count ?? 0)],
                  ["Financing clearing", "RMS_CHARGE_FINANCING_CLEARING"],
                  ["Payment clearing", "RMS_R2S_PAYMENT_CLEARING"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-xl border border-app-border bg-app-bg p-4">
                    <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">{label}</div>
                    <div className="mt-2 text-sm font-bold text-app-text">{value}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
        <div className="ui-card flex min-h-0 flex-1 flex-col overflow-hidden p-0">
          <div className="flex flex-wrap items-end gap-3 border-b border-app-border bg-app-surface-2 p-4">
            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              From
              <input
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
                className="ui-input py-2 text-xs font-semibold normal-case"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              To
              <input
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
                className="ui-input py-2 text-xs font-semibold normal-case"
              />
            </label>
            <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Kind
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as "" | "charge" | "payment")}
                className="ui-input py-2 text-xs font-semibold normal-case"
              >
                <option value="">All</option>
                <option value="charge">Charge</option>
                <option value="payment">Payment</option>
              </select>
            </label>
            <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              Search
              <input
                value={q}
                onChange={(event) => setQ(event.target.value)}
                placeholder="Customer, program, ref, account…"
                className="ui-input py-2 text-xs font-semibold normal-case"
              />
            </label>
          </div>

          <div className="no-scrollbar min-h-0 flex-1 overflow-auto">
            <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
              <thead className="sticky top-0 z-[1] bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                <tr>
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Kind</th>
                  <th className="px-4 py-3">Posting</th>
                  <th className="px-4 py-3 text-right">Amount</th>
                  <th className="px-4 py-3">Tender</th>
                  <th className="px-4 py-3">Program</th>
                  <th className="px-4 py-3">Account</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {records.length === 0 && !loadingRecords ? (
                  <tr>
                    <td colSpan={9} className="px-4 py-10 text-center text-sm text-app-text-muted">
                      No RMS Charge activity in this date range.
                    </td>
                  </tr>
                ) : null}
                {records.map((row) => (
                  <tr
                    key={row.id}
                    className="cursor-pointer border-t border-app-border transition-colors hover:bg-app-surface-2"
                    onClick={() => void loadRecordDetail(row.id)}
                  >
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-app-text-muted">
                      {fmtDate(row.created_at)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                        row.record_kind === "payment"
                          ? "bg-emerald-500/15 text-emerald-800"
                          : "bg-amber-500/15 text-amber-900"
                      }`}>
                        {row.record_kind}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                          row.posting_status === "posted"
                            ? "bg-emerald-500/15 text-emerald-800"
                            : row.posting_status === "failed"
                              ? "bg-rose-500/15 text-rose-800"
                              : row.posting_status === "reversed" || row.posting_status === "refunded"
                                ? "bg-sky-500/15 text-sky-800"
                                : "bg-app-surface text-app-text-muted"
                        }`}>
                          {row.posting_status}
                        </span>
                        {row.host_reference ? (
                          <span className="font-mono text-[11px] text-app-text-muted">
                            {row.host_reference}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs tabular-nums">
                      {fmtMoney(row.amount)}
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-app-text">
                      {row.tender_family === "rms_charge" ? "RMS Charge" : row.payment_method}
                    </td>
                    <td className="px-4 py-3 text-xs text-app-text">
                      {row.program_label || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs text-app-text">
                      {row.masked_account || "—"}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      <div className="font-semibold text-app-text">
                        {row.customer_name || row.customer_display || "—"}
                      </div>
                      {row.customer_code ? (
                        <div className="mt-0.5 font-mono text-[11px] text-app-text-muted">
                          {row.customer_code}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      {onOpenTransactionInBackoffice ? (
                        <button
                          type="button"
                          onClick={() => onOpenTransactionInBackoffice(row.transaction_id)}
                          className="text-xs font-black uppercase tracking-widest text-app-accent"
                        >
                          {row.order_short_ref || row.transaction_id.slice(0, 8)}
                        </button>
                      ) : (
                        <span className="font-mono text-xs text-app-text-muted">
                          {row.order_short_ref || row.transaction_id.slice(0, 8)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {hasMore ? (
            <div className="border-t border-app-border p-3">
              <button
                type="button"
                disabled={loadingRecords}
                onClick={() => void fetchRecords(offset, true)}
                className="ui-btn-secondary px-4 py-2"
              >
                {loadingRecords ? "Loading…" : "Load more"}
              </button>
            </div>
          ) : null}

          <div className="border-t border-app-border bg-app-surface-2 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Transaction Detail
                </p>
                <h3 className="text-lg font-black tracking-tight text-app-text">
                  Transaction Status & Reference
                </h3>
              </div>
              {loadingRecordDetail ? (
                <div className="text-sm text-app-text-muted">Loading…</div>
              ) : null}
            </div>
            <div className="mt-4 grid gap-3 xl:grid-cols-2">
              <div className="rounded-xl border border-app-border bg-app-bg p-4">
                {recordDetail ? (
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Status</span>
                      <span className="font-black uppercase tracking-wide text-app-text">{recordDetail.posting_status}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Host reference</span>
                      <span className="font-mono text-app-text">{recordDetail.host_reference || "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Host transaction</span>
                      <span className="font-mono text-app-text">{recordDetail.external_transaction_id || "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Program</span>
                      <span className="font-black text-app-text">{recordDetail.program_label || "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Masked account</span>
                      <span className="font-black text-app-text">{recordDetail.masked_account || "—"}</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Completed at</span>
                      <span className="text-app-text">{fmtDate(recordDetail.posted_at)}</span>
                    </div>
                    {recordDetail.posting_error_message ? (
                      <div className="rounded-lg border border-rose-300/40 bg-rose-500/10 px-3 py-2 text-sm font-semibold text-rose-700">
                        {recordDetail.posting_error_message}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <div className="text-sm text-app-text-muted">
                    Select an RMS Charge transaction to view its current status and reference number.
                  </div>
                )}
              </div>
              <div className="rounded-xl border border-app-border bg-app-bg p-4">
                <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                  Account History Snapshot
                </div>
                <div className="mt-3 space-y-2">
                  {accountTransactions.length === 0 ? (
                    <div className="text-sm text-app-text-muted">
                      Select an account to view recent host/account activity.
                    </div>
                  ) : (
                    accountTransactions.slice(0, 6).map((row) => (
                      <div key={`${row.occurred_at}-${row.external_reference ?? row.amount}`} className="rounded-lg border border-app-border px-3 py-2">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="font-black uppercase tracking-wide text-app-text">
                              {row.program_label || row.kind}
                            </div>
                            <div className="text-[11px] text-app-text-muted">
                              {fmtDate(row.occurred_at)} · {row.status}
                            </div>
                          </div>
                          <div className="text-sm font-black text-app-text">
                            {fmtMoney(row.amount)}
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>)
      )}
      <PromptModal
        isOpen={Boolean(resolvingException)}
        onClose={() => setResolvingException(null)}
        onSubmit={(value) => submitResolutionNote(value)}
        title="Resolve RMS Issue"
        message={
          resolvingException
            ? `Add a short support note for ${resolvingException.exception_type.replaceAll("_", " ")}.\n\nExplain what cleared the issue so the next staff member can follow the audit trail.`
            : ""
        }
        placeholder="Example: CoreCard confirmed the original post and no retry was needed."
        defaultValue={resolvingException?.resolution_notes ?? ""}
        confirmLabel="Save Resolution"
      />
      <ConfirmationModal
        isOpen={Boolean(confirmUnlinkAccount)}
        onClose={() => setConfirmUnlinkAccount(null)}
        onConfirm={() => {
          if (confirmUnlinkAccount) {
            void unlinkAccount(confirmUnlinkAccount);
          }
        }}
        title="Remove RMS Account Link"
        message={
          confirmUnlinkAccount
            ? `Remove ${confirmUnlinkAccount.masked_account} from ${selectedCustomerLabel || "this customer"} in Riverside?\n\nThis only removes the customer-to-account link in Riverside. It does not change the CoreCard account itself, and the correction is recorded in the audit trail.`
            : ""
        }
        confirmLabel="Remove Link"
        cancelLabel="Keep Link"
        variant="danger"
      />
    </div>
  );
}
