import React, { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  Save,
  Send,
  TestTube,
  FileText,
  Mail,
  Calendar,
  CheckCircle,
  XCircle,
  Clock,
  ChevronDown,
  ChevronUp,
  Eye,
  RotateCcw,
  X,
} from "lucide-react";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import { useToast } from "../ui/ToastProviderLogic";

interface DailyReportConfig {
  enabled: boolean;
  recipient_emails: string[];
  subject_template: string;
  include_qbo_status: boolean;
  include_inventory_activity: boolean;
  auto_send_after_close: boolean;
}

interface ReportListRow {
  id: string;
  report_date: string;
  generated_at: string | null;
  sent_at: string | null;
  sent_to: string[] | null;
  send_error: string | null;
  is_test: boolean;
  net_sales: string | null;
  transaction_count: number | null;
  total_tendered: string | null;
}

interface ReportDetail {
  id: string;
  report_date: string;
  generated_at: string | null;
  report_payload: Record<string, unknown>;
  html_content: string | null;
  sent_at: string | null;
  sent_to: string[] | null;
  send_error: string | null;
  is_test: boolean;
}

interface DailyFinancialReportPanelProps {
  baseUrl: string;
}

const DailyFinancialReportPanel: React.FC<DailyFinancialReportPanelProps> = ({
  baseUrl,
}) => {
  const { backofficeHeaders } = useBackofficeAuth();
  const { toast } = useToast();

  const [config, setConfig] = useState<DailyReportConfig | null>(null);
  const [reports, setReports] = useState<ReportListRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [previewReport, setPreviewReport] = useState<ReportDetail | null>(null);
  const [showHistory, setShowHistory] = useState(true);
  const [generateDate, setGenerateDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [testEmailOverride, setTestEmailOverride] = useState("");

  const hdrs = useCallback(
    () =>
      ({
        "Content-Type": "application/json",
        ...(backofficeHeaders() as Record<string, string>),
      }) as Record<string, string>,
    [backofficeHeaders],
  );

  const fetchConfig = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/daily-reports/config`, {
        headers: hdrs(),
      });
      if (res.ok) {
        setConfig((await res.json()) as DailyReportConfig);
      }
    } catch {
      /* ignore */
    }
  }, [baseUrl, hdrs]);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/api/daily-reports/history?limit=50`, {
        headers: hdrs(),
      });
      if (res.ok) {
        setReports((await res.json()) as ReportListRow[]);
      }
    } catch {
      /* ignore */
    }
  }, [baseUrl, hdrs]);

  useEffect(() => {
    void fetchConfig();
    void fetchHistory();
  }, [fetchConfig, fetchHistory]);

  const saveConfig = async () => {
    if (!config || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/daily-reports/config`, {
        method: "PUT",
        headers: hdrs(),
        body: JSON.stringify(config),
      });
      if (res.ok) {
        toast("Daily report settings saved", "success");
        await fetchConfig();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Save failed", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const addEmail = () => {
    if (!config || !emailInput.trim()) return;
    const email = emailInput.trim().toLowerCase();
    if (config.recipient_emails.includes(email)) {
      toast("Email already added", "info");
      return;
    }
    setConfig({
      ...config,
      recipient_emails: [...config.recipient_emails, email],
    });
    setEmailInput("");
  };

  const removeEmail = (email: string) => {
    if (!config) return;
    setConfig({
      ...config,
      recipient_emails: config.recipient_emails.filter((e) => e !== email),
    });
  };

  const handleGenerate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/daily-reports/generate`, {
        method: "POST",
        headers: hdrs(),
        body: JSON.stringify({ date: generateDate }),
      });
      if (res.ok) {
        toast("Report generated successfully", "success");
        await fetchHistory();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Generate failed", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleSend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${baseUrl}/api/daily-reports/send`, {
        method: "POST",
        headers: hdrs(),
        body: JSON.stringify({ date: generateDate }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        status?: string;
        errors?: string;
        sent_to?: string[];
      };
      if (res.ok) {
        toast(
          j.status === "sent"
            ? `Report sent to ${(j.sent_to ?? []).join(", ")}`
            : `Sent with errors: ${j.errors}`,
          j.status === "sent" ? "success" : "info",
        );
        await fetchHistory();
      } else {
        toast((j as { error?: string }).error ?? "Send failed", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleTestSend = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const body: { email_override?: string } = {};
      if (testEmailOverride.trim()) {
        body.email_override = testEmailOverride.trim();
      }
      const res = await fetch(`${baseUrl}/api/daily-reports/test-send`, {
        method: "POST",
        headers: hdrs(),
        body: JSON.stringify(body),
      });
      const j = (await res.json().catch(() => ({}))) as {
        status?: string;
        errors?: string;
        sent_to?: string[];
      };
      if (res.ok) {
        toast(
          j.status === "sent"
            ? `Test report sent to ${(j.sent_to ?? []).join(", ")}`
            : `Test sent with errors: ${j.errors}`,
          j.status === "sent" ? "success" : "info",
        );
        await fetchHistory();
      } else {
        toast((j as { error?: string }).error ?? "Test send failed", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleResend = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(
        `${baseUrl}/api/daily-reports/${encodeURIComponent(id)}/resend`,
        {
          method: "POST",
          headers: hdrs(),
          body: JSON.stringify({}),
        },
      );
      if (res.ok) {
        toast("Report resent successfully", "success");
        await fetchHistory();
      } else {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        toast(j.error ?? "Resend failed", "error");
      }
    } catch {
      toast("Communication error", "error");
    } finally {
      setBusy(false);
    }
  };

  const viewReport = async (id: string) => {
    try {
      const res = await fetch(
        `${baseUrl}/api/daily-reports/${encodeURIComponent(id)}`,
        { headers: hdrs() },
      );
      if (res.ok) {
        setPreviewReport((await res.json()) as ReportDetail);
      }
    } catch {
      toast("Failed to load report", "error");
    }
  };

  if (!config) {
    return (
      <div className="flex h-64 items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-app-accent opacity-20" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-app-text flex items-center gap-2">
            <FileText className="w-6 h-6 text-app-accent" />
            Daily Financial Report
          </h2>
          <p className="text-sm text-app-text-muted mt-1">
            Automatically generate and email a comprehensive daily financial
            summary after register close.
          </p>
        </div>
      </div>

      {/* Configuration */}
      <section className="ui-card p-6 space-y-5">
        <h3 className="text-sm font-bold text-app-text uppercase tracking-wide">
          Report Settings
        </h3>

        {/* Enable Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-app-text">Enable Daily Financial Report</p>
            <p className="text-xs text-app-text-muted">
              When enabled, the system will generate and store a financial
              summary at end of each business day.
            </p>
          </div>
          <button
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.enabled ? "bg-app-accent" : "bg-gray-300 dark:bg-gray-600"}`}
            onClick={() => setConfig({ ...config, enabled: !config.enabled })}
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-app-surface transition-transform ${config.enabled ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {/* Auto-send Toggle */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-app-text">Auto-Send After Close</p>
            <p className="text-xs text-app-text-muted">
              Automatically email the report after the daily register close (Z
              report).
            </p>
          </div>
          <button
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.auto_send_after_close ? "bg-app-accent" : "bg-gray-300 dark:bg-gray-600"}`}
            onClick={() =>
              setConfig({
                ...config,
                auto_send_after_close: !config.auto_send_after_close,
              })
            }
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-app-surface transition-transform ${config.auto_send_after_close ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {/* Include QBO Status */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-app-text">Include QuickBooks Status</p>
            <p className="text-xs text-app-text-muted">
              Show the QBO journal status in the report.
            </p>
          </div>
          <button
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.include_qbo_status ? "bg-app-accent" : "bg-gray-300 dark:bg-gray-600"}`}
            onClick={() =>
              setConfig({
                ...config,
                include_qbo_status: !config.include_qbo_status,
              })
            }
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-app-surface transition-transform ${config.include_qbo_status ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {/* Include Inventory */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold text-app-text">Include Inventory Activity</p>
            <p className="text-xs text-app-text-muted">
              Show inventory receiving activity in the report.
            </p>
          </div>
          <button
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${config.include_inventory_activity ? "bg-app-accent" : "bg-gray-300 dark:bg-gray-600"}`}
            onClick={() =>
              setConfig({
                ...config,
                include_inventory_activity: !config.include_inventory_activity,
              })
            }
          >
            <span
              className={`inline-block h-4 w-4 rounded-full bg-app-surface transition-transform ${config.include_inventory_activity ? "translate-x-6" : "translate-x-1"}`}
            />
          </button>
        </div>

        {/* Subject Template */}
        <div>
          <label className="text-xs font-semibold text-app-text-muted uppercase tracking-wide">
            Email Subject Template
          </label>
          <input
            type="text"
            className="mt-1 w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text placeholder:text-app-text-muted focus:outline-none focus:ring-2 focus:ring-app-accent"
            placeholder="Riverside OS — Daily Financial Report — {date}"
            value={config.subject_template}
            onChange={(e) =>
              setConfig({ ...config, subject_template: e.target.value })
            }
          />
          <p className="text-xs text-app-text-muted mt-1">
            Use <code className="text-app-accent">{"{date}"}</code> as a
            placeholder for the business date.
          </p>
        </div>

        {/* Recipient Emails */}
        <div>
          <label className="text-xs font-semibold text-app-text-muted uppercase tracking-wide">
            Recipient Email Addresses
          </label>
          <div className="flex gap-2 mt-1">
            <input
              type="email"
              className="flex-1 rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text placeholder:text-app-text-muted focus:outline-none focus:ring-2 focus:ring-app-accent"
              placeholder="owner@store.com"
              value={emailInput}
              onChange={(e) => setEmailInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addEmail();
                }
              }}
            />
            <button
              className="rounded-lg bg-app-accent px-4 py-2 text-sm font-semibold text-white hover:bg-app-accent/90 transition"
              onClick={addEmail}
            >
              Add
            </button>
          </div>
          {config.recipient_emails.length > 0 && (
            <div className="flex flex-wrap gap-2 mt-3">
              {config.recipient_emails.map((email) => (
                <span
                  key={email}
                  className="inline-flex items-center gap-1.5 rounded-full bg-app-surface-2 px-3 py-1 text-xs font-medium text-app-text"
                >
                  <Mail className="w-3 h-3 text-app-text-muted" />
                  {email}
                  <button
                    className="ml-1 hover:text-red-500 transition"
                    onClick={() => removeEmail(email)}
                    title="Remove"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Save */}
        <div className="flex justify-end pt-2">
          <button
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg bg-app-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-app-accent/90 transition disabled:opacity-50"
            onClick={saveConfig}
          >
            <Save className="w-4 h-4" />
            Save Settings
          </button>
        </div>
      </section>

      {/* Actions */}
      <section className="ui-card p-6 space-y-5">
        <h3 className="text-sm font-bold text-app-text uppercase tracking-wide">
          Generate & Send
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Generate / Send */}
          <div className="space-y-3">
            <label className="text-xs font-semibold text-app-text-muted uppercase tracking-wide">
              Business Date
            </label>
            <input
              type="date"
              className="w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text focus:outline-none focus:ring-2 focus:ring-app-accent"
              value={generateDate}
              onChange={(e) => setGenerateDate(e.target.value)}
            />
            <div className="flex gap-2">
              <button
                disabled={busy}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700 transition disabled:opacity-50"
                onClick={handleGenerate}
              >
                <FileText className="w-4 h-4" />
                Generate
              </button>
              <button
                disabled={busy || config.recipient_emails.length === 0}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition disabled:opacity-50"
                onClick={handleSend}
                title={
                  config.recipient_emails.length === 0
                    ? "Add recipients first"
                    : "Generate and send to all recipients"
                }
              >
                <Send className="w-4 h-4" />
                Generate & Send
              </button>
            </div>
          </div>

          {/* Test Send */}
          <div className="space-y-3">
            <label className="text-xs font-semibold text-app-text-muted uppercase tracking-wide">
              Test Send
            </label>
            <p className="text-xs text-app-text-muted">
              Send the most recent report as a test. Optionally override the
              recipient.
            </p>
            <input
              type="email"
              className="w-full rounded-lg border border-app-border bg-app-surface px-3 py-2 text-sm text-app-text placeholder:text-app-text-muted focus:outline-none focus:ring-2 focus:ring-app-accent"
              placeholder="Override email (optional)"
              value={testEmailOverride}
              onChange={(e) => setTestEmailOverride(e.target.value)}
            />
            <button
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 transition disabled:opacity-50"
              onClick={handleTestSend}
            >
              <TestTube className="w-4 h-4" />
              Send Test Report
            </button>
          </div>
        </div>
      </section>

      {/* Report History */}
      <section className="ui-card overflow-hidden">
        <button
          className="w-full flex items-center justify-between p-5 bg-app-surface/30 border-b border-app-border hover:bg-app-surface-2/50 transition"
          onClick={() => setShowHistory(!showHistory)}
        >
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-app-accent" />
            <h3 className="text-sm font-bold text-app-text uppercase tracking-wide">
              Report History
            </h3>
            <span className="text-xs text-app-text-muted ml-2">
              ({reports.length} reports)
            </span>
          </div>
          {showHistory ? (
            <ChevronUp className="w-4 h-4 text-app-text-muted" />
          ) : (
            <ChevronDown className="w-4 h-4 text-app-text-muted" />
          )}
        </button>

        {showHistory && (
          <div className="divide-y divide-app-border max-h-[500px] overflow-y-auto">
            {reports.length === 0 ? (
              <div className="p-8 text-center text-sm text-app-text-muted">
                No reports generated yet. Generate your first report above.
              </div>
            ) : (
              reports.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between px-5 py-3 hover:bg-app-surface-2/30 transition"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex-shrink-0">
                      {r.sent_at && !r.send_error ? (
                        <CheckCircle className="w-5 h-5 text-emerald-500" />
                      ) : r.send_error ? (
                        <XCircle className="w-5 h-5 text-red-500" />
                      ) : (
                        <Clock className="w-5 h-5 text-amber-500" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-app-text">
                          {r.report_date}
                        </span>
                        {r.is_test && (
                          <span className="text-[10px] font-bold uppercase tracking-wider bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300 px-2 py-0.5 rounded-full">
                            Test
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-app-text-muted flex items-center gap-3 mt-0.5">
                        {r.net_sales != null && (
                          <span>
                            Net Sales:{" "}
                            <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                              $
                              {Number(r.net_sales).toLocaleString(undefined, {
                                minimumFractionDigits: 2,
                              })}
                            </span>
                          </span>
                        )}
                        {r.transaction_count != null && (
                          <span>{r.transaction_count} transactions</span>
                        )}
                        {r.sent_to && r.sent_to.length > 0 && (
                          <span className="truncate max-w-[200px]">
                            → {r.sent_to.join(", ")}
                          </span>
                        )}
                      </div>
                      {r.send_error && (
                        <p className="text-xs text-red-500 mt-0.5 truncate max-w-[400px]">
                          {r.send_error}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                      className="p-2 rounded-lg hover:bg-app-surface-2 transition text-app-text-muted hover:text-app-accent"
                      title="View report"
                      onClick={() => viewReport(r.id)}
                    >
                      <Eye className="w-4 h-4" />
                    </button>
                    <button
                      className="p-2 rounded-lg hover:bg-app-surface-2 transition text-app-text-muted hover:text-blue-500"
                      title="Resend report"
                      onClick={() => handleResend(r.id)}
                      disabled={busy}
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}
      </section>

      {/* Report Preview Modal */}
      {previewReport && (
        <div className="fixed inset-0 z-[200] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-app-surface rounded-2xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col">
            <div className="flex items-center justify-between p-5 border-b border-app-border">
              <div>
                <h3 className="text-lg font-bold text-app-text">
                  Daily Financial Report — {previewReport.report_date}
                </h3>
                <p className="text-xs text-app-text-muted">
                  Generated{" "}
                  {previewReport.generated_at
                    ? new Date(previewReport.generated_at).toLocaleString()
                    : "—"}
                  {previewReport.is_test && " (Test)"}
                </p>
              </div>
              <button
                className="p-2 rounded-lg hover:bg-app-surface-2 transition"
                onClick={() => setPreviewReport(null)}
              >
                <X className="w-5 h-5 text-app-text-muted" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-1">
              {previewReport.html_content ? (
                <iframe
                  srcDoc={previewReport.html_content}
                  className="w-full h-full min-h-[600px] border-0 rounded-xl"
                  title="Report Preview"
                  sandbox="allow-same-origin"
                />
              ) : (
                <div className="p-8 text-center text-sm text-app-text-muted">
                  No HTML content available for this report.
                </div>
              )}
            </div>
            <div className="flex items-center justify-end gap-2 p-4 border-t border-app-border">
              <button
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition disabled:opacity-50"
                onClick={() => {
                  handleResend(previewReport.id);
                  setPreviewReport(null);
                }}
                disabled={busy}
              >
                <Send className="w-4 h-4" />
                Resend
              </button>
              <button
                className="rounded-lg bg-app-surface-2 px-4 py-2 text-sm font-semibold text-app-text hover:bg-app-surface-2/80 transition"
                onClick={() => setPreviewReport(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default DailyFinancialReportPanel;
