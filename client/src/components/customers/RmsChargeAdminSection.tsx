import { getBaseUrl } from "../../lib/apiConfig";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { mergedPosStaffHeaders } from "../../lib/posRegisterAuth";
import { formatUsdFromCents, parseMoneyToCents } from "../../lib/money";
import { useToast } from "../ui/ToastProviderLogic";
import CustomerSearchInput from "../ui/CustomerSearchInput";
import type { Customer } from "../pos/CustomerSelector";
import PromptModal from "../ui/PromptModal";
import { ClipboardCheck, RefreshCw, Upload, FileSpreadsheet, CheckCircle2, AlertTriangle, Loader2 } from "lucide-react";
import RosieInsightSummary from "../help/RosieInsightSummary";
import RosieIcon from "../common/RosieIcon";

const baseUrl = getBaseUrl();
const PAGE = 100;

function fmtMoney(s?: string | number | null) {
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

function fmtDateOnly(value?: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleDateString();
}

function reportStatusLabel(
  row?: Pick<RmsRecordRow, "r2s_reporting_required" | "r2s_report_status" | "r2s_report_due_at"> | null,
) {
  if (!row) return "—";
  if (!row.r2s_reporting_required || row.r2s_report_status === "not_required") return "Not required";
  if (row.r2s_report_status === "reported") return "Reported";
  if (row.r2s_report_due_at && new Date(row.r2s_report_due_at).getTime() < Date.now()) return "Overdue";
  return "Unreported";
}

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
  customer_name?: string | null;
  customer_code?: string | null;
  order_short_ref: string | null;
  tender_family?: string | null;
  program_code?: string | null;
  program_label?: string | null;
  masked_account?: string | null;
  resolution_status?: string | null;
  posting_status: string;
  host_reference?: string | null;
  external_transaction_id?: string | null;
  r2s_reporting_required?: boolean | null;
  r2s_report_status?: string | null;
  r2s_report_due_at?: string | null;
  r2s_reported_at?: string | null;
  r2s_reported_by_staff_id?: string | null;
  r2s_reported_by_name?: string | null;
  r2s_report_note?: string | null;
  operator_name?: string | null;
};

type RmsRecordDetail = RmsRecordRow & {
  external_auth_code?: string | null;
  posting_error_message?: string | null;
  posted_at?: string | null;
  reversed_at?: string | null;
  refunded_at?: string | null;
  idempotency_key?: string | null;
  external_transaction_type?: string | null;
};

interface AccountListBatchSummary {
  id: string;
  source_filename?: string | null;
  source_file_hash: string;
  institution_name?: string | null;
  merchant_name?: string | null;
  report_run_at?: string | null;
  uploaded_by_staff_id?: string | null;
  uploaded_at: string;
  parsed_account_count: number;
  footer_account_count?: number | null;
  total_balance?: string | null;
  total_minimum_due?: string | null;
  total_past_due?: string | null;
  total_open_to_buy?: string | null;
  warning_summary: unknown;
  status: string;
  created_at: string;
}

interface AccountListLatestImportResponse {
  latest: AccountListBatchSummary | null;
  stale: boolean;
  stale_after_days: number;
  matched_count: number;
  unmatched_count: number;
}

interface AccountListDataQualitySummary {
  missing_phones: number;
  invalid_phones: number;
  missing_addresses: number;
  active_balance_count: number;
  past_due_count: number;
  zero_open_to_buy_count: number;
  duplicate_account_number_count: number;
}

interface AccountListPreviewAccount {
  account_number: string;
  account_year?: string | null;
  name: string;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  phone?: string | null;
  normalized_phone?: string | null;
  high_balance: string;
  previous_balance: string;
  payments: string;
  returns: string;
  charges: string;
  finance_charge: string;
  balance: string;
  minimum_due: string;
  past_due: string;
  aging_30: string;
  aging_60: string;
  aging_90_plus: string;
  open_to_buy: string;
  payment_history_codes: string[];
  parser_warnings: string[];
  raw_payload: unknown;
}

interface AccountListPreviewResponse {
  source: string;
  snapshot_label: string;
  metadata: {
    sheet_name: string;
    report_title?: string | null;
    institution_name?: string | null;
    merchant_name?: string | null;
    report_run_at?: string | null;
    report_run_at_raw?: string | null;
  };
  parsed_account_count: number;
  footer_count?: number | null;
  total_balance: string;
  total_minimum_due: string;
  total_past_due: string;
  total_open_to_buy: string;
  warning_count: number;
  warnings: string[];
  data_quality: AccountListDataQualitySummary;
  sample_accounts: AccountListPreviewAccount[];
}

interface RmsAccountListUnmatchedRow {
  id: string;
  masked_account: string;
  account_year?: string | null;
  customer_name?: string | null;
  business_name?: string | null;
  address_line?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  phone?: string | null;
  balance?: string | number | null;
  minimum_due?: string | number | null;
  past_due?: string | number | null;
  open_to_buy?: string | number | null;
  payments?: string | number | null;
  charges?: string | number | null;
  match_status: string;
  match_method?: string | null;
  parser_warnings: unknown;
  batch_id: string;
  import_uploaded_at: string;
  import_report_run_at?: string | null;
  source_filename?: string | null;
}

interface RmsAccountListUnmatchedResponse {
  items: RmsAccountListUnmatchedRow[];
  total_count: number;
}

export interface RmsChargeAdminSectionProps {
  surface: "pos" | "backoffice";
  onOpenTransactionInBackoffice?: (transactionId: string) => void;
}

export default function RmsChargeAdminSection({
  onOpenTransactionInBackoffice,
}: RmsChargeAdminSectionProps) {
  const { backofficeHeaders, hasPermission } = useBackofficeAuth();
  const { toast } = useToast();

  const canLegacyView =
    hasPermission("customers.rms_charge") || hasPermission("customers.rms_charge.view");

  const canReportToR2s =
    hasPermission("rms_charge.report_to_r2s") ||
    hasPermission("customers.rms_charge.reporting") ||
    hasPermission("customers.rms_charge");

  const canManageLinks =
    hasPermission("customers.rms_charge.manage_links") ||
    hasPermission("customers.rms_charge");

  const apiAuth = useCallback(
    () => mergedPosStaffHeaders(backofficeHeaders),
    [backofficeHeaders],
  );

  const [selectedCustomerId, setSelectedCustomerId] = useState("");
  const [selectedCustomerLabel, setSelectedCustomerLabel] = useState("");

  const [records, setRecords] = useState<RmsRecordRow[]>([]);
  const [loadingRecords, setLoadingRecords] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);

  const [recordDetail, setRecordDetail] = useState<RmsRecordDetail | null>(null);
  const [loadingRecordDetail, setLoadingRecordDetail] = useState(false);

  const [reportingRecord, setReportingRecord] = useState<RmsRecordDetail | null>(null);

  const [from, setFrom] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 30);
    return d.toISOString().split("T")[0];
  });
  const [to, setTo] = useState(() => new Date().toISOString().split("T")[0]);
  const [kind, setKind] = useState<"" | "charge" | "payment">("");
  const [reportStatus, setReportStatus] = useState<
    "all" | "unreported" | "reported" | "overdue"
  >("all");
  const [q, setQ] = useState("");

  const [activeTab, setActiveTab] = useState<"transactions" | "import">("transactions");
  const [latestImport, setLatestImport] = useState<AccountListLatestImportResponse | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(false);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [previewData, setPreviewData] = useState<AccountListPreviewResponse | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [unmatchedRows, setUnmatchedRows] = useState<RmsAccountListUnmatchedRow[]>([]);
  const [unmatchedTotal, setUnmatchedTotal] = useState(0);
  const [unmatchedLoading, setUnmatchedLoading] = useState(false);
  const [unmatchedSearch, setUnmatchedSearch] = useState("");
  const [matchingSnapshotId, setMatchingSnapshotId] = useState<string | null>(null);
  const rmsInsightFacts = useMemo(() => {
    const latest = latestImport?.latest;
    return {
      title: "RMS Charge weekly review",
      metrics: [
        { id: "parsed-accounts", label: "Parsed accounts", value: latest ? String(latest.parsed_account_count) : "0" },
        { id: "matched-accounts", label: "Matched accounts", value: latestImport ? String(latestImport.matched_count) : "0" },
        { id: "unmatched-accounts", label: "Unmatched accounts", value: latestImport ? String(latestImport.unmatched_count) : "0" },
        { id: "snapshot-balance", label: "Snapshot balance", value: latest ? fmtMoney(latest.total_balance) : "—" },
        { id: "past-due", label: "Past due", value: latest ? fmtMoney(latest.total_past_due) : "—" },
      ],
      bullets: [
        {
          id: "import-freshness",
          label: !latest
            ? "No weekly RMS account list has been imported yet."
            : latestImport?.stale
              ? `The latest import is older than ${latestImport.stale_after_days} days and should be refreshed.`
              : "The latest RMS account list import is fresh.",
          severity: !latest || latestImport?.stale ? "warning" : "success",
        },
        {
          id: "matching",
          label:
            latestImport && latestImport.unmatched_count > 0
              ? `${latestImport.unmatched_count} imported account${latestImport.unmatched_count === 1 ? "" : "s"} still need customer matching.`
              : "No unmatched imported accounts are visible in the latest import.",
          severity: latestImport && latestImport.unmatched_count > 0 ? "warning" : "success",
        },
        {
          id: "reporting",
          label: "RMS Charge and RMS Payment reporting stays manual in the R2S review workflow.",
          severity: "info",
        },
      ],
      disclaimers: [
        "Explain visible RMS import and reporting facts only. Do not report to R2S, post charges, post payments, or match customers without staff confirmation.",
      ],
    };
  }, [latestImport]);

  const fetchLatestImport = useCallback(async () => {
    setLoadingLatest(true);
    try {
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/account-list/latest`, {
        headers: apiAuth(),
      });
      if (!res.ok) throw new Error("Could not load latest import details");
      const data = await res.json();
      setLatestImport(data);
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingLatest(false);
    }
  }, [apiAuth]);

  const fetchUnmatchedRows = useCallback(async () => {
    setUnmatchedLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "25");
      if (unmatchedSearch.trim()) params.set("q", unmatchedSearch.trim());
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/account-list/unmatched?${params.toString()}`, {
        headers: apiAuth(),
      });
      const data = (await res.json().catch(() => ({}))) as Partial<RmsAccountListUnmatchedResponse> & {
        error?: string;
      };
      if (!res.ok) throw new Error(data.error ?? "Could not load unmatched RMS accounts");
      setUnmatchedRows(Array.isArray(data.items) ? data.items : []);
      setUnmatchedTotal(Number(data.total_count ?? 0));
    } catch (error) {
      toast(error instanceof Error ? error.message : "Could not load unmatched RMS accounts", "error");
      setUnmatchedRows([]);
      setUnmatchedTotal(0);
    } finally {
      setUnmatchedLoading(false);
    }
  }, [apiAuth, toast, unmatchedSearch]);

  useEffect(() => {
    if (activeTab === "import") {
      void fetchLatestImport();
      void fetchUnmatchedRows();
    }
  }, [activeTab, fetchLatestImport, fetchUnmatchedRows]);

  const matchImportedAccount = useCallback(
    async (snapshotId: string, customer: Customer) => {
      if (!canManageLinks) return;
      setMatchingSnapshotId(snapshotId);
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/rms-charge/account-list/snapshots/${encodeURIComponent(snapshotId)}/match`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", ...apiAuth() },
            body: JSON.stringify({ customer_id: customer.id }),
          },
        );
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Could not match RMS account");
        toast(`Matched RMS account to ${customer.first_name} ${customer.last_name}.`, "success");
        await Promise.all([fetchLatestImport(), fetchUnmatchedRows()]);
      } catch (error) {
        toast(error instanceof Error ? error.message : "Could not match RMS account", "error");
      } finally {
        setMatchingSnapshotId(null);
      }
    },
    [apiAuth, canManageLinks, fetchLatestImport, fetchUnmatchedRows, toast],
  );

  const handlePreview = async (file: File) => {
    setUploading(true);
    setPreviewError(null);
    setPreviewData(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/account-list/preview`, {
        method: "POST",
        headers: apiAuth(),
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to preview file");
      setPreviewData(data);
      toast("Spreadsheet preview loaded successfully.", "success");
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Failed to preview file");
      toast(error instanceof Error ? error.message : "Failed to preview file", "error");
    } finally {
      setUploading(false);
    }
  };

  const handleImport = async () => {
    if (!uploadFile) return;
    setUploading(true);
    setPreviewError(null);
    try {
      const formData = new FormData();
      formData.append("file", uploadFile);
      const res = await fetch(`${baseUrl}/api/customers/rms-charge/account-list/import`, {
        method: "POST",
        headers: apiAuth(),
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to import file");
      toast("RMS account list imported successfully.", "success");
      setPreviewData(null);
      setUploadFile(null);
      void fetchLatestImport();
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Failed to import file");
      toast(error instanceof Error ? error.message : "Failed to import file", "error");
    } finally {
      setUploading(false);
    }
  };

  const fetchRecords = useCallback(
    async (nextOffset: number, append: boolean) => {
      if (!canLegacyView) return;
      setLoadingRecords(true);
      try {
        const params = new URLSearchParams();
        params.set("from", from);
        params.set("to", to);
        if (kind) params.set("kind", kind);
        if (reportStatus !== "all") params.set("r2s_report_status", reportStatus);
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
    },
    [apiAuth, canLegacyView, from, kind, q, reportStatus, selectedCustomerId, to, toast],
  );

  useEffect(() => {
    if (!canLegacyView) return;
    setOffset(0);
    void fetchRecords(0, false);
  }, [canLegacyView, fetchRecords, from, kind, q, reportStatus, selectedCustomerId, to]);

  const loadRecordDetail = useCallback(
    async (recordId: string) => {
      if (!recordId) return;
      setLoadingRecordDetail(true);
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/rms-charge/records/${encodeURIComponent(recordId)}`,
          {
            headers: apiAuth(),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? "We couldn't load transaction details.");
        }
        const data = (await res.json()) as RmsRecordDetail;
        setRecordDetail(data);
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "We couldn't load transaction details.",
          "error",
        );
        setRecordDetail(null);
      } finally {
        setLoadingRecordDetail(false);
      }
    },
    [apiAuth, toast],
  );

  const submitR2sReportNote = useCallback(
    async (note: string) => {
      if (!reportingRecord) return false;
      try {
        const res = await fetch(
          `${baseUrl}/api/customers/rms-charge/records/${encodeURIComponent(reportingRecord.id)}/r2s-report`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...apiAuth(),
            },
            body: JSON.stringify({ note: note.trim() || undefined }),
          },
        );
        const body = (await res.json().catch(() => ({}))) as RmsRecordDetail & { error?: string };
        if (!res.ok) throw new Error(body.error ?? "We couldn't mark this RMS Charge record reported.");
        setRecordDetail(body);
        setRecords((current) =>
          current.map((row) => (row.id === body.id ? { ...row, ...body } : row)),
        );
        setReportingRecord(null);
        toast("RMS Charge marked reported to R2S.", "success");
        await fetchRecords(0, false);
        return true;
      } catch (error) {
        toast(
          error instanceof Error ? error.message : "We couldn't mark this RMS Charge record reported.",
          "error",
        );
        return false;
      }
    },
    [apiAuth, fetchRecords, reportingRecord, toast],
  );

  const refreshAll = useCallback(() => {
    setOffset(0);
    void fetchRecords(0, false);
  }, [fetchRecords]);

  if (!canLegacyView) {
    return (
      <div className="ui-page p-6">
        <p className="text-sm text-app-text-muted">
          You don&apos;t have permission to view the RMS Charge transactions log.
        </p>
      </div>
    );
  }

  return (
    <div className="ui-page flex h-full flex-col p-4 sm:p-6 animate-in fade-in duration-500">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4 border-b border-app-border/40 pb-4">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tight text-app-text">
            RMS Charge Workspace
          </h2>
          <p className="mt-1 text-xs text-app-text-muted">
            View manual RMS Charge transactions log, reference postings, and upload the weekly accounts lists.
          </p>
        </div>
        {activeTab === "transactions" ? (
          <button
            type="button"
            onClick={refreshAll}
            className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs"
          >
            <RefreshCw size={14} className={loadingRecords ? "animate-spin" : ""} />
            Refresh
          </button>
        ) : (
          <button
            type="button"
            onClick={fetchLatestImport}
            className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs"
          >
            <RefreshCw size={14} className={loadingLatest ? "animate-spin" : ""} />
            Refresh Status
          </button>
        )}
      </div>

      <div className="mb-6 flex gap-2 rounded-xl bg-app-surface-3 p-1 w-fit border border-app-border">
        <button
          type="button"
          onClick={() => setActiveTab("transactions")}
          className={`rounded-lg px-4 py-2 text-xs font-black uppercase tracking-widest transition-all ${
            activeTab === "transactions"
              ? "bg-app-accent text-white shadow-md shadow-app-accent/20"
              : "text-app-text-muted hover:text-app-text"
          }`}
        >
          Transactions Log
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("import")}
          className={`rounded-lg px-4 py-2 text-xs font-black uppercase tracking-widest transition-all ${
            activeTab === "import"
              ? "bg-app-accent text-white shadow-md shadow-app-accent/20"
              : "text-app-text-muted hover:text-app-text"
          }`}
        >
          Weekly Account Import
        </button>
      </div>

      {activeTab === "transactions" ? (
        <>
          <div className="mb-4 grid gap-4 xl:grid-cols-[1.3fr,1fr]">
        <div className="rounded-2xl border border-app-border bg-app-surface-2 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                Customer filter
              </p>
              <h3 className="text-lg font-black tracking-tight text-app-text">
                Filter by Customer
              </h3>
            </div>
            {selectedCustomerId ? (
              <button
                type="button"
                onClick={() => {
                  setSelectedCustomerId("");
                  setSelectedCustomerLabel("");
                }}
                className="text-xs font-black uppercase tracking-widest text-app-danger"
              >
                Clear Filter
              </button>
            ) : null}
          </div>
          <div className="mt-4">
            <CustomerSearchInput
              key={selectedCustomerId}
              defaultValue={selectedCustomerLabel}
              onSelect={(customer: Customer) => {
                setSelectedCustomerId(customer.id);
                setSelectedCustomerLabel(`${customer.first_name} ${customer.last_name}`);
              }}
              placeholder="Search customers to filter RMS records..."
            />
          </div>
        </div>
      </div>

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
          <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Report to R2S
            <select
              value={reportStatus}
              onChange={(event) =>
                setReportStatus(event.target.value as "all" | "unreported" | "reported" | "overdue")
              }
              className="ui-input py-2 text-xs font-semibold normal-case"
            >
              <option value="all">All</option>
              <option value="unreported">Unreported</option>
              <option value="reported">Reported</option>
              <option value="overdue">Overdue</option>
            </select>
          </label>
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
            Search
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Customer, ref, account…"
              className="ui-input py-2 text-xs font-semibold normal-case"
            />
          </label>
        </div>

        <div className="no-scrollbar min-h-0 flex-1 overflow-auto">
          <table className="w-full min-w-[1000px] border-collapse text-left text-sm">
            <thead className="sticky top-0 z-[1] bg-app-surface text-[10px] font-black uppercase tracking-widest text-app-text-muted">
              <tr>
                <th className="px-4 py-3">When</th>
                <th className="px-4 py-3">Kind</th>
                <th className="px-4 py-3">Record</th>
                <th className="px-4 py-3">Report to R2S</th>
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
                  <td colSpan={10} className="px-4 py-10 text-center text-sm text-app-text-muted">
                    No RMS Charge activity found.
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
                    <span
                      className={`rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                        row.record_kind === "payment"
                          ? "bg-emerald-500/15 text-emerald-800"
                          : "bg-amber-500/15 text-amber-900"
                      }`}
                    >
                      {row.record_kind}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span
                        className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                          row.posting_status === "posted"
                            ? "bg-emerald-500/15 text-emerald-800"
                            : row.posting_status === "failed"
                              ? "bg-rose-500/15 text-rose-800"
                              : row.posting_status === "reversed" ||
                                  row.posting_status === "refunded"
                                ? "bg-sky-500/15 text-sky-800"
                                : "bg-app-surface text-app-text-muted"
                        }`}
                      >
                        {row.posting_status}
                      </span>
                      {row.host_reference ? (
                        <span className="font-mono text-[11px] text-app-text-muted">
                          {row.host_reference}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-col gap-1">
                      <span
                        className={`inline-flex w-fit rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ${
                          reportStatusLabel(row) === "Reported"
                            ? "bg-emerald-500/15 text-emerald-800"
                            : reportStatusLabel(row) === "Overdue"
                              ? "bg-rose-500/15 text-rose-800"
                              : reportStatusLabel(row) === "Not required"
                                ? "bg-slate-500/10 text-app-text-muted"
                                : "bg-amber-500/15 text-amber-900"
                        }`}
                      >
                        {reportStatusLabel(row)}
                      </span>
                      {row.r2s_reporting_required ? (
                        <span className="text-[11px] text-app-text-muted">
                          Due {fmtDateOnly(row.r2s_report_due_at)}
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
          <div className="mt-4">
            <div className="rounded-xl border border-app-border bg-app-bg p-4 max-w-2xl">
              {recordDetail ? (
                <div className="space-y-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-app-text-muted">Status</span>
                    <span className="font-black uppercase tracking-wide text-app-text">
                      {recordDetail.posting_status}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-app-text-muted">Report to R2S</span>
                    <span className="font-black uppercase tracking-wide text-app-text">
                      {reportStatusLabel(recordDetail)}
                    </span>
                  </div>
                  {recordDetail.r2s_reporting_required ? (
                    <div className="flex items-center justify-between">
                      <span className="text-app-text-muted">Due date</span>
                      <span className="text-app-text">
                        {fmtDateOnly(recordDetail.r2s_report_due_at)}
                      </span>
                    </div>
                  ) : null}
                  {recordDetail.r2s_reported_at ? (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-app-text-muted">Reported at</span>
                        <span className="text-app-text">{fmtDate(recordDetail.r2s_reported_at)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-app-text-muted">Reported by</span>
                        <span className="text-app-text">
                          {recordDetail.r2s_reported_by_name || "Recorded staff member"}
                        </span>
                      </div>
                    </>
                  ) : null}
                  <div className="flex items-center justify-between">
                    <span className="text-app-text-muted">Reference Number</span>
                    <span className="font-mono text-app-text">{recordDetail.host_reference || "—"}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-app-text-muted">External reference</span>
                    <span className="font-mono text-app-text">
                      {recordDetail.external_transaction_id || "—"}
                    </span>
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
                  {recordDetail.r2s_report_note ? (
                    <div className="rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text">
                      {recordDetail.r2s_report_note}
                    </div>
                  ) : null}
                  {canReportToR2s &&
                  recordDetail.r2s_reporting_required &&
                  recordDetail.r2s_report_status !== "reported" ? (
                    <button
                      type="button"
                      onClick={() => setReportingRecord(recordDetail)}
                      className="ui-btn-primary mt-2 inline-flex items-center gap-2 px-3 py-2 text-xs"
                    >
                      <ClipboardCheck size={14} />
                      Mark Reported
                    </button>
                  ) : null}
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
          </div>
        </div>
      </div>

      <PromptModal
        isOpen={Boolean(reportingRecord)}
        onClose={() => setReportingRecord(null)}
        onSubmit={(value) => submitR2sReportNote(value)}
        title="Mark Reported to R2S"
        message={
          reportingRecord
            ? `Record that this ${
                reportingRecord.record_kind === "payment" ? "RMS Charge Payment" : "RMS Charge Sale"
              } was reported to R2S. This updates reporting follow-up only; it does not change the transaction amount.`
            : ""
        }
        placeholder="Optional note or R2S reference"
        defaultValue={reportingRecord?.r2s_report_note ?? ""}
        confirmLabel="Mark Reported"
      />
        </>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[1fr,1.5fr] min-h-0 flex-1 overflow-auto no-scrollbar">
          {/* Left Column: Status and Upload */}
          <div className="space-y-6 animate-in fade-in duration-300">
            {/* Latest Status */}
            <div className="ui-card p-6">
              <h3 className="text-xs font-black uppercase tracking-widest text-app-text-muted mb-4">
                Latest Spreadsheet Status
              </h3>
              {loadingLatest ? (
                <div className="flex items-center gap-2 text-sm text-app-text-muted">
                  <Loader2 size={16} className="animate-spin" />
                  Loading latest status...
                </div>
              ) : latestImport?.latest ? (
                <div className="space-y-4">
                  <div className={`p-4 rounded-xl border ${
                    latestImport.stale
                      ? "bg-amber-500/10 border-amber-500/20 text-amber-900"
                      : "bg-emerald-500/10 border-emerald-500/20 text-emerald-900"
                  }`}>
                    <div className="flex items-center gap-2 font-bold text-sm">
                      {latestImport.stale ? (
                        <>
                          <AlertTriangle size={18} className="text-amber-600" />
                          Status: Out of Date
                        </>
                      ) : (
                        <>
                          <CheckCircle2 size={18} className="text-emerald-600" />
                          Status: Fresh (Active)
                        </>
                      )}
                    </div>
                    <p className="mt-2 text-xs opacity-90 leading-relaxed">
                      {latestImport.stale
                        ? `The last import is older than ${latestImport.stale_after_days} days. Please upload the current weekly Nexo/RMS Account List to avoid out-of-date balances.`
                        : `This weekly snapshot is fresh. Balances are matched with customer records.`}
                    </p>
                  </div>

                  <div className="space-y-2 text-xs">
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">File Name</span>
                      <span className="font-semibold text-app-text break-all max-w-[200px] text-right">
                        {latestImport.latest.source_filename || "Manual Excel Upload"}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Report Run Date</span>
                      <span className="font-semibold text-app-text">
                        {fmtDate(latestImport.latest.report_run_at)}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Imported At</span>
                      <span className="font-semibold text-app-text">
                        {fmtDate(latestImport.latest.uploaded_at)}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Parsed Accounts</span>
                      <span className="font-mono font-semibold text-app-text">
                        {latestImport.latest.parsed_account_count}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Matched snapshotted accounts</span>
                      <span className="font-mono font-semibold text-emerald-600">
                        {latestImport.matched_count}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Unmatched snapshotted accounts</span>
                      <span className="font-mono font-semibold text-amber-600">
                        {latestImport.unmatched_count}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Total Snapshot Balance</span>
                      <span className="font-mono font-semibold text-app-text">
                        {fmtMoney(latestImport.latest.total_balance)}
                      </span>
                    </div>
                    <div className="flex justify-between border-b border-app-border/40 pb-2">
                      <span className="text-app-text-muted">Total Past Due</span>
                      <span className="font-mono font-semibold text-rose-600">
                        {fmtMoney(latestImport.latest.total_past_due)}
                      </span>
                    </div>
                    <div className="flex justify-between pb-2">
                      <span className="text-app-text-muted">File Hash (SHA256)</span>
                      <span className="font-mono text-[10px] text-app-text-muted truncate max-w-[150px]" title={latestImport.latest.source_file_hash}>
                        {latestImport.latest.source_file_hash}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl border border-dotted border-app-border bg-app-surface/20 text-center text-xs text-app-text-muted">
                  No Excel list has been imported yet.
                </div>
              )}
              <div className="mt-4 rounded-xl border border-app-accent/25 bg-app-accent/5 px-3 py-3">
                <p className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-app-accent">
                  <RosieIcon size={14} alt="" />
                  RMS review explainer
                </p>
                <p className="mt-1 text-xs font-semibold text-app-text-muted">
                  ROSIE summarizes the visible import status. Matching, R2S reporting, charges, and
                  payments remain staff-reviewed actions.
                </p>
                <RosieInsightSummary
                  surface="rms_charge_review"
                  title="RMS Charge Weekly Review"
                  mode="explain"
                  getHeaders={apiAuth}
                  facts={rmsInsightFacts}
                  className="mt-3"
                />
              </div>
            </div>

            <div className="ui-card p-6">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-app-text-muted">
                    Unmatched Accounts
                  </h3>
                  <p className="mt-1 text-[11px] text-app-text-muted">
                    Match imported RMS accounts that did not automatically link to a Riverside customer.
                  </p>
                </div>
                <button
                  type="button"
                  disabled={unmatchedLoading}
                  onClick={() => void fetchUnmatchedRows()}
                  className="ui-btn-secondary inline-flex items-center gap-2 px-3 py-2 text-xs"
                >
                  <RefreshCw size={14} className={unmatchedLoading ? "animate-spin" : ""} />
                  Refresh
                </button>
              </div>
              <div className="mb-4">
                <input
                  value={unmatchedSearch}
                  onChange={(event) => setUnmatchedSearch(event.target.value)}
                  placeholder="Search unmatched account, name, phone, or address..."
                  className="ui-input w-full py-2 text-xs font-semibold normal-case"
                />
              </div>
              {unmatchedLoading ? (
                <div className="flex items-center gap-2 text-sm text-app-text-muted">
                  <Loader2 size={16} className="animate-spin" />
                  Loading unmatched accounts...
                </div>
              ) : unmatchedRows.length === 0 ? (
                <div className="rounded-xl border border-dotted border-app-border bg-app-surface/20 p-4 text-center text-xs text-app-text-muted">
                  {latestImport?.latest ? "No unmatched accounts in the latest import." : "Upload an account list to review unmatched accounts."}
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                    Showing {unmatchedRows.length} of {unmatchedTotal}
                  </div>
                  {unmatchedRows.map((row) => (
                    <div
                      key={row.id}
                      className="rounded-xl border border-app-border bg-app-surface-2 p-4"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <div className="font-black text-app-text">
                            {row.customer_name || row.business_name || "Unnamed RMS account"}
                          </div>
                          <div className="mt-1 font-mono text-[11px] font-bold text-app-text-muted">
                            {row.masked_account}
                            {row.account_year ? ` · ${row.account_year}` : ""}
                          </div>
                          <div className="mt-2 text-[11px] leading-relaxed text-app-text-muted">
                            {[row.phone, row.address_line, row.city, row.state, row.postal_code]
                              .filter(Boolean)
                              .join(" · ") || "No phone or address imported"}
                          </div>
                        </div>
                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-right text-[11px]">
                          <span className="text-app-text-muted">Balance</span>
                          <span className="font-mono font-bold text-app-text">{fmtMoney(row.balance)}</span>
                          <span className="text-app-text-muted">Open to buy</span>
                          <span className="font-mono font-bold text-app-text">{fmtMoney(row.open_to_buy)}</span>
                          <span className="text-app-text-muted">Past due</span>
                          <span className="font-mono font-bold text-rose-600">{fmtMoney(row.past_due)}</span>
                        </div>
                      </div>
                      <div className="mt-4 rounded-xl border border-app-border bg-app-surface p-3">
                        <div className="mb-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                          Match to Riverside customer
                        </div>
                        {canManageLinks ? (
                          <CustomerSearchInput
                            key={row.id}
                            disabled={matchingSnapshotId === row.id}
                            placeholder="Search customer by name, phone, email, or code..."
                            onSelect={(customer) => void matchImportedAccount(row.id, customer)}
                          />
                        ) : (
                          <p className="text-xs text-app-text-muted">
                            RMS Charge link permission is needed to match imported accounts.
                          </p>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Upload Form */}
            <div className="ui-card p-6">
              <h3 className="text-xs font-black uppercase tracking-widest text-app-text-muted mb-4">
                Import Nexo/RMS Account List
              </h3>

              <div className="space-y-4">
                <div className="p-3 rounded-xl bg-app-surface-2 border border-app-border text-xs text-app-text-muted leading-relaxed">
                  Ensure you are importing the weekly <strong>Account List Report</strong> Excel sheet (.xlsx format) downloaded from the RMS administration system. Do not modify columns prior to upload.
                </div>

                <div className="relative group flex flex-col items-center justify-center rounded-2xl border-2 border-dashed border-app-border bg-app-surface-2 p-8 hover:border-app-accent hover:bg-app-surface-3 transition-all cursor-pointer">
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    className="absolute inset-0 cursor-pointer opacity-0"
                    disabled={uploading}
                    onChange={(e) => {
                      const file = e.target.files?.[0] || null;
                      setUploadFile(file);
                      setPreviewData(null);
                      setPreviewError(null);
                      if (file) {
                        void handlePreview(file);
                      }
                    }}
                  />
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-app-surface border border-app-border group-hover:scale-105 transition-transform">
                    <FileSpreadsheet className="text-app-text-muted group-hover:text-app-accent transition-colors" size={24} />
                  </div>
                  <div className="text-xs font-semibold text-app-text text-center">
                    {uploadFile ? uploadFile.name : "Select weekly Excel spreadsheet..."}
                  </div>
                  {uploadFile && (
                    <div className="text-[10px] text-app-text-muted mt-1">
                      {(uploadFile.size / 1024).toFixed(1)} KB
                    </div>
                  )}
                </div>

                {uploadFile && !uploading && (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setUploadFile(null);
                        setPreviewData(null);
                        setPreviewError(null);
                      }}
                      className="ui-btn-secondary flex-1 text-xs py-2"
                    >
                      Clear File
                    </button>
                    <button
                      type="button"
                      disabled={!previewData || uploading}
                      onClick={handleImport}
                      className="ui-btn-primary flex-1 text-xs py-2 flex items-center justify-center gap-1"
                    >
                      {uploading ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Upload size={12} />
                      )}
                      Commit Import
                    </button>
                  </div>
                )}

                {uploading && (
                  <div className="flex items-center justify-center gap-2 text-xs font-bold text-app-accent py-2">
                    <Loader2 size={14} className="animate-spin" />
                    Processing spreadsheet...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Right Column: Preview and errors */}
          <div className="space-y-6 animate-in fade-in duration-300">
            {previewError && (
              <div className="ui-card border-rose-500/30 bg-rose-500/5 p-6 text-sm text-rose-700">
                <div className="flex items-center gap-2 font-bold mb-2">
                  <AlertTriangle size={18} className="text-rose-600" />
                  Failed to Parse Spreadsheet
                </div>
                <p className="text-xs leading-relaxed opacity-90">{previewError}</p>
              </div>
            )}

            {previewData ? (
              <div className="ui-card p-6 space-y-6">
                <div>
                  <h3 className="text-xs font-black uppercase tracking-widest text-app-text mb-1">
                    Spreadsheet Preview & Integrity Check
                  </h3>
                  <p className="text-[11px] text-app-text-muted">
                    Verify these metadata items match your report before committing the import.
                  </p>
                </div>

                <div className="grid grid-cols-2 gap-4 text-xs bg-app-surface-2 p-4 rounded-xl border border-app-border">
                  <div>
                    <div className="text-app-text-muted mb-0.5">Institution</div>
                    <div className="font-bold text-app-text">
                      {previewData.metadata.institution_name || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-app-text-muted mb-0.5">Merchant</div>
                    <div className="font-bold text-app-text">
                      {previewData.metadata.merchant_name || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-app-text-muted mb-0.5">Report Title</div>
                    <div className="font-bold text-app-text">
                      {previewData.metadata.report_title || "—"}
                    </div>
                  </div>
                  <div>
                    <div className="text-app-text-muted mb-0.5">Report Run Date</div>
                    <div className="font-bold text-app-text">
                      {fmtDate(previewData.metadata.report_run_at)}
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <h4 className="text-xs font-black uppercase tracking-wider text-app-text-muted">
                    Data Quality & Summary Counts
                  </h4>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Total Accounts
                      </div>
                      <div className="font-mono font-bold text-sm text-app-text">
                        {previewData.parsed_account_count}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Missing Phone
                      </div>
                      <div className={`font-mono font-bold text-sm ${previewData.data_quality.missing_phones > 0 ? "text-amber-600" : "text-app-text"}`}>
                        {previewData.data_quality.missing_phones}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Missing Address
                      </div>
                      <div className={`font-mono font-bold text-sm ${previewData.data_quality.missing_addresses > 0 ? "text-amber-600" : "text-app-text"}`}>
                        {previewData.data_quality.missing_addresses}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Duplicates
                      </div>
                      <div className={`font-mono font-bold text-sm ${previewData.data_quality.duplicate_account_number_count > 0 ? "text-rose-600" : "text-app-text"}`}>
                        {previewData.data_quality.duplicate_account_number_count}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2">
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Active Balances
                      </div>
                      <div className="font-mono font-bold text-sm text-app-text">
                        {previewData.data_quality.active_balance_count}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Past Due
                      </div>
                      <div className={`font-mono font-bold text-sm ${previewData.data_quality.past_due_count > 0 ? "text-amber-600" : "text-app-text"}`}>
                        {previewData.data_quality.past_due_count}
                      </div>
                    </div>
                    <div className="p-3 rounded-lg bg-app-surface border border-app-border text-center">
                      <div className="text-[9px] font-black uppercase tracking-wider text-app-text-muted opacity-60 mb-1">
                        Zero Credit Limit
                      </div>
                      <div className="font-mono font-bold text-sm text-app-text">
                        {previewData.data_quality.zero_open_to_buy_count}
                      </div>
                    </div>
                  </div>
                </div>

                {previewData.warnings && previewData.warnings.length > 0 && (
                  <div className="space-y-2">
                    <h4 className="text-xs font-black uppercase tracking-wider text-amber-700 flex items-center gap-1">
                      <AlertTriangle size={14} /> Warnings ({previewData.warnings.length})
                    </h4>
                    <div className="max-h-[120px] overflow-y-auto bg-amber-500/5 border border-amber-500/10 rounded-lg p-3 space-y-1.5 no-scrollbar">
                      {previewData.warnings.map((warn: string, idx: number) => (
                        <div key={idx} className="text-[11px] text-amber-800 leading-normal">
                          • {warn}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  <h4 className="text-xs font-black uppercase tracking-wider text-app-text-muted">
                    Sample Accounts Preview (First 10)
                  </h4>
                  <div className="overflow-x-auto border border-app-border rounded-lg bg-app-surface-2">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="bg-app-surface border-b border-app-border text-[9px] font-black uppercase tracking-wider text-app-text-muted">
                          <th className="p-2">Acc #</th>
                          <th className="p-2">Name</th>
                          <th className="p-2">Phone</th>
                          <th className="p-2 text-right">Balance</th>
                          <th className="p-2 text-right">Limit</th>
                          <th className="p-2 text-right">Min Due</th>
                        </tr>
                      </thead>
                      <tbody>
                        {previewData.sample_accounts.map((acc: AccountListPreviewAccount, idx: number) => (
                          <tr key={idx} className="border-b border-app-border last:border-0">
                            <td className="p-2 font-mono">{acc.account_number}</td>
                            <td className="p-2 font-semibold text-app-text truncate max-w-[120px]" title={acc.name}>
                              {acc.name}
                            </td>
                            <td className="p-2 text-app-text-muted font-mono">{acc.phone || "—"}</td>
                            <td className="p-2 text-right font-mono tabular-nums">{fmtMoney(acc.balance)}</td>
                            <td className="p-2 text-right font-mono tabular-nums">{fmtMoney(acc.open_to_buy)}</td>
                            <td className="p-2 text-right font-mono tabular-nums text-rose-600">{fmtMoney(acc.minimum_due)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ui-card p-8 border-dotted border-app-border bg-app-surface/20 text-center flex flex-col items-center justify-center min-h-[300px]">
                <FileSpreadsheet className="text-app-text-muted opacity-40 mb-3" size={36} />
                <div className="text-xs font-black uppercase tracking-wider text-app-text mb-1">
                  Awaiting Upload
                </div>
                <p className="text-xs text-app-text-muted max-w-[280px] leading-relaxed">
                  Select an Excel report spreadsheet file on the left. The system will inspect its structure and show a preview of parsed data and summary verification checks.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
