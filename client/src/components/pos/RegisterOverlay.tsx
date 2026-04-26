import { getBaseUrl } from "../../lib/apiConfig";
import { isTauri } from "@tauri-apps/api/core";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Printer,
  RefreshCw,
  Search,
  Wifi,
} from "lucide-react";
import { centsToFixed2, parseMoney, parseMoneyToCents } from "../../lib/money";
import {
  checkReceiptPrinterConnection,
  resolvePrinterAddress,
} from "../../lib/printerBridge";
import {
  getPosRegisterAuth,
  mergedPosStaffHeaders,
  posRegisterAuthHeaders,
} from "../../lib/posRegisterAuth";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import RiversideJustLogo from "../../assets/images/logo1.png";

export interface SessionOpenedPayload {
  cashierName: string;
  cashierCode: string;
  cashierAvatarKey: string;
  floatAmount: number;
  sessionId: string;
  registerLane: number;
  registerOrdinal: number;
  lifecycleStatus: string;
  role: string;
  receiptTimezone?: string;
  posApiToken?: string;
}

interface RegisterOverlayProps {
  onSessionOpened: (payload: SessionOpenedPayload) => void;
}

const BYPASS =
  import.meta.env.VITE_REGISTER_AUTH_BYPASS === "true" ||
  import.meta.env.VITE_REGISTER_AUTH_BYPASS === "1";
const DEV_CASHIER_CODE = "1234";
const DEV_OPENING_FLOAT = "200.00";

type CurrentSessionJson = {
  cashier_name: string;
  cashier_avatar_key?: string;
  cashier_code: string;
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  lifecycle_status: string;
  role: string;
  receipt_timezone?: string;
  opening_float: string | number;
  till_close_group_id?: string;
};

type OpenSessionSummaryJson = {
  session_id: string;
  register_lane: number;
  register_ordinal: number;
  cashier_name: string;
  opened_at: string;
  till_close_group_id: string;
};

/** Admin POS path when Register #1 is not open yet. */
type AdminPrimaryPath = null | "opening_lane1" | "waiting_lane1_elsewhere";
type ReadinessStatus = "checking" | "ready" | "warning" | "error";

interface ReadinessCheck {
  status: ReadinessStatus;
  detail: string;
}

function readinessTone(status: ReadinessStatus): string {
  if (status === "ready") {
    return "ui-tint-success text-app-success";
  }
  if (status === "warning") {
    return "ui-tint-warning text-app-warning";
  }
  if (status === "error") {
    return "ui-tint-danger text-app-danger";
  }
  return "ui-tint-neutral text-app-text-muted";
}

function ReadinessIcon({ status }: { status: ReadinessStatus }) {
  if (status === "ready") {
    return <CheckCircle2 size={16} className="shrink-0" aria-hidden />;
  }
  if (status === "warning" || status === "error") {
    return <AlertTriangle size={16} className="shrink-0" aria-hidden />;
  }
  return (
    <RefreshCw size={16} className="shrink-0 animate-spin" aria-hidden />
  );
}

function payloadFromSessionJson(
  data: CurrentSessionJson,
  posApiToken?: string,
): SessionOpenedPayload {
  const floatVal =
    typeof data.opening_float === "number"
      ? data.opening_float
      : parseMoney(String(data.opening_float));
  return {
    cashierName: data.cashier_name,
    cashierCode: data.cashier_code,
    cashierAvatarKey:
      typeof data.cashier_avatar_key === "string" &&
      data.cashier_avatar_key.trim()
        ? data.cashier_avatar_key.trim()
        : "ros_default",
    floatAmount: floatVal,
    sessionId: data.session_id,
    registerLane: data.register_lane,
    registerOrdinal: data.register_ordinal,
    lifecycleStatus: data.lifecycle_status,
    role: data.role,
    receiptTimezone:
      typeof data.receipt_timezone === "string" && data.receipt_timezone.trim()
        ? data.receipt_timezone.trim()
        : undefined,
    posApiToken,
  };
}

export default function RegisterOverlay({
  onSessionOpened,
}: RegisterOverlayProps) {
  const { backofficeHeaders, staffRole, permissionsLoaded } =
    useBackofficeAuth();
  const [credential, setCredential] = useState("");
  const [roster, setRoster] = useState<{ id: string; full_name: string }[]>([]);

  const baseUrl = getBaseUrl();

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          const data = await res.json();
          setRoster(data);
        }
      } catch (e) {
        console.error("Roster load failed", e);
      }
    })();
  }, [baseUrl]);

  const [registerLane, setRegisterLane] = useState(1);
  /** After the user picks a lane, do not auto-switch (e.g. admin default to #2). */
  const registerLaneUserChosenRef = useRef(false);
  const [openingFloat, setOpeningFloat] = useState(DEV_OPENING_FLOAT);
  const [booting, setBooting] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [primarySessionId, setPrimarySessionId] = useState<string | null>(null);
  const [linkStatus, setLinkStatus] = useState<string | null>(null);
  /** Admin only: null = not checked yet; whether any open session is Register #1. */
  const [register1OpenForAdmin, setRegister1OpenForAdmin] = useState<
    boolean | null
  >(null);
  const [adminPrimaryPath, setAdminPrimaryPath] =
    useState<AdminPrimaryPath>(null);
  const [adminListOpenError, setAdminListOpenError] = useState<string | null>(
    null,
  );
  const [adminRecheckBusy, setAdminRecheckBusy] = useState(false);
  const [apiReadiness, setApiReadiness] = useState<ReadinessCheck>({
    status: "checking",
    detail: "Checking the Riverside API for this station…",
  });
  const [printerReadiness, setPrinterReadiness] = useState<ReadinessCheck>({
    status: "checking",
    detail: "Checking the receipt printer for this station…",
  });
  const [focusReadiness, setFocusReadiness] = useState<ReadinessCheck>({
    status: "ready",
    detail:
      "Product search auto-focuses when Register opens. Use Focus in the cart if a scan lands elsewhere.",
  });
  const [readinessBusy, setReadinessBusy] = useState(false);

  const onOpenedRef = useRef(onSessionOpened);
  onOpenedRef.current = onSessionOpened;
  const credentialRef = useRef(credential);
  credentialRef.current = credential;
  const openingFloatRef = useRef(openingFloat);
  openingFloatRef.current = openingFloat;
  const registerLaneRef = useRef(registerLane);
  registerLaneRef.current = registerLane;

  const jsonAuthHeaders = useCallback(() => {
    const h = new Headers(mergedPosStaffHeaders(backofficeHeaders));
    h.set("Content-Type", "application/json");
    return h;
  }, [backofficeHeaders]);

  const fetchRegister1IsOpen = useCallback(async (): Promise<boolean> => {
    setAdminListOpenError(null);
    try {
      const res = await fetch(`${baseUrl}/api/sessions/list-open`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        const msg =
          b.error ??
          (res.status === 403
            ? "Missing permission to view open registers (register.session_attach)."
            : `Could not load open registers (${res.status}).`);
        setAdminListOpenError(msg);
        return false;
      }
      const rows = (await res.json()) as OpenSessionSummaryJson[];
      return rows.some((r) => r.register_lane === 1);
    } catch {
      setAdminListOpenError("Network error while checking open registers.");
      return false;
    }
  }, [baseUrl, backofficeHeaders]);

  // Admins in POS: discover if Register #1 is open before showing the open form (unless opening #1 themselves).
  useEffect(() => {
    if (BYPASS) return;
    if (!permissionsLoaded) return;
    if (staffRole !== "admin") {
      setRegister1OpenForAdmin(null);
      setAdminPrimaryPath(null);
      setAdminListOpenError(null);
      return;
    }
    if (booting) return;
    let cancelled = false;
    setRegister1OpenForAdmin(null);
    void (async () => {
      const open = await fetchRegister1IsOpen();
      if (!cancelled) setRegister1OpenForAdmin(open);
    })();
    return () => {
      cancelled = true;
    };
  }, [staffRole, permissionsLoaded, booting, error, fetchRegister1IsOpen]);

  useEffect(() => {
    if (BYPASS) return;
    if (
      permissionsLoaded &&
      staffRole === "admin" &&
      !registerLaneUserChosenRef.current &&
      register1OpenForAdmin === true &&
      adminPrimaryPath !== "opening_lane1"
    ) {
      setRegisterLane(3); // Default BO activity to Register 3 (Back Office)
    }
  }, [permissionsLoaded, staffRole, register1OpenForAdmin, adminPrimaryPath]);

  useEffect(() => {
    if (BYPASS || registerLane <= 1) {
      setPrimarySessionId(null);
      setLinkStatus(null);
      return;
    }
    let cancelled = false;
    setLinkStatus("Looking for Register #1…");
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/sessions/list-open`, {
          headers: mergedPosStaffHeaders(backofficeHeaders),
        });
        if (!res.ok) {
          const b = (await res.json().catch(() => ({}))) as { error?: string };
          if (!cancelled) {
            setPrimarySessionId(null);
            setLinkStatus(
              b.error ??
                (res.status === 403
                  ? "You need permission to view open registers (register.session_attach)."
                  : "Could not load open registers."),
            );
          }
          return;
        }
        const rows = (await res.json()) as OpenSessionSummaryJson[];
        const primary = rows.find((r) => r.register_lane === 1);
        if (!cancelled) {
          if (primary?.session_id) {
            setPrimarySessionId(primary.session_id);
            setLinkStatus(
              `Linked to Register #1 (${primary.cashier_name}) · till shift ${primary.till_close_group_id.slice(0, 8)}…`,
            );
          } else {
            setPrimarySessionId(null);
            setLinkStatus(
              "Register #1 must be open before opening a satellite lane. Open the cash drawer first.",
            );
          }
        }
      } catch {
        if (!cancelled) {
          setPrimarySessionId(null);
          setLinkStatus("Network error while loading open registers.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [baseUrl, backofficeHeaders, registerLane]);

  useEffect(() => {
    if (registerLane > 1) {
      setOpeningFloat("0.00");
    } else if (!BYPASS) {
      setOpeningFloat(DEV_OPENING_FLOAT);
    }
  }, [registerLane]);

  const tryResumeOrBypass = useCallback(async () => {
    setBooting(true);
    setError(null);
    try {
      const posHeaders = posRegisterAuthHeaders();
      if (posHeaders["x-riverside-pos-session-id"]) {
        const cur = await fetch(`${baseUrl}/api/sessions/current`, {
          headers: posHeaders,
        });
        if (cur.ok) {
          const data = (await cur.json()) as CurrentSessionJson;
          const auth = getPosRegisterAuth();
          if (!auth?.token) {
            throw new Error(
              "Register session is active but this browser has no POS token. Close the session from Back Office or open the register again with your 4-digit code.",
            );
          }
          onOpenedRef.current(payloadFromSessionJson(data, auth.token));
          return;
        }
      }

      if (BYPASS) {
        const floatStr = centsToFixed2(
          parseMoneyToCents(openingFloatRef.current),
        );
        const res = await fetch(`${baseUrl}/api/sessions/open`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            cashier_code: DEV_CASHIER_CODE,
            pin: DEV_CASHIER_CODE,
            opening_float: floatStr,
            register_lane: 1,
          }),
        });
        if (!res.ok) {
          const errData = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          throw new Error(errData.error ?? `Open failed (${res.status})`);
        }
        const data = (await res.json()) as CurrentSessionJson & {
          pos_api_token?: string;
        };
        onOpenedRef.current(payloadFromSessionJson(data, data.pos_api_token));
      }
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : "Could not restore register session";
      setError(message);
    } finally {
      setBooting(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void tryResumeOrBypass();
  }, [tryResumeOrBypass]);

  const openWithCredential = async (code: string) => {
    const lane = registerLaneRef.current;
    if (lane > 1 && !primarySessionId) {
      throw new Error(
        linkStatus?.includes("Register #1")
          ? linkStatus
          : "Register #1 must be open before opening this lane.",
      );
    }
    const floatStr = centsToFixed2(parseMoneyToCents(openingFloatRef.current));
    const body: Record<string, unknown> = {
      cashier_code: code,
      pin: code,
      opening_float: floatStr,
      register_lane: lane,
    };
    if (lane > 1 && primarySessionId) {
      body.primary_session_id = primarySessionId;
    }
    const res = await fetch(`${baseUrl}/api/sessions/open`, {
      method: "POST",
      headers: jsonAuthHeaders(),
      body: JSON.stringify(body),
    });

    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        session_id?: string;
        register_lane?: number;
      };
      if (body.error === "register_lane_in_use") {
        throw new Error(
          `Register #${body.register_lane ?? registerLaneRef.current} already has an open session. Pick another register number or join that session from Back Office.`,
        );
      }
      const sid = body.session_id?.trim();
      if (sid) {
        const tokRes = await fetch(
          `${baseUrl}/api/sessions/${encodeURIComponent(sid)}/pos-api-token`,
          {
            method: "POST",
            headers: jsonAuthHeaders(),
            body: JSON.stringify({ cashier_code: code, pin: code }),
          },
        );
        if (tokRes.ok) {
          const tokJson = (await tokRes.json()) as {
            pos_api_token?: string;
          };
          const token = tokJson.pos_api_token;
          if (token) {
            const cur = await fetch(`${baseUrl}/api/sessions/current`, {
              headers: {
                "x-riverside-pos-session-id": sid,
                "x-riverside-pos-session-token": token,
              },
            });
            if (cur.ok) {
              const data = (await cur.json()) as CurrentSessionJson;
              onOpenedRef.current(payloadFromSessionJson(data, token));
              return;
            }
          }
        }
      }
      throw new Error(
        body.error ??
          "Could not open the register. If another drawer is already open, pick a different register number or join that session from Back Office.",
      );
    }

    if (!res.ok) {
      let message = "Failed to open register";
      try {
        const errData = (await res.json()) as { error?: string };
        if (errData.error) message = errData.error;
      } catch {
        message = `Request failed (${res.status})`;
      }
      throw new Error(message);
    }

    const data = (await res.json()) as CurrentSessionJson & {
      pos_api_token?: string;
    };
    onOpenedRef.current(payloadFromSessionJson(data, data.pos_api_token));
  };

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (BYPASS) return;
    const code = credentialRef.current.trim();
    if (code.length !== 4) {
      setError("Enter your 4-digit staff code.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await openWithCredential(code);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to open register");
    } finally {
      setSubmitting(false);
    }
  };

  const busy = booting || submitting;

  const overlayVisible = useMemo(
    () => !BYPASS || booting || Boolean(error),
    [booting, error],
  );
  useShellBackdropLayer(overlayVisible);
  const { dialogRef, titleId } = useDialogAccessibility(overlayVisible, {});

  const runReadinessChecks = useCallback(async () => {
    setReadinessBusy(true);
    setApiReadiness({
      status: "checking",
      detail: "Checking the Riverside API for this station…",
    });
    setPrinterReadiness({
      status: "checking",
      detail: "Checking the receipt printer for this station…",
    });
    setFocusReadiness({
      status: "ready",
      detail:
        "Product search auto-focuses when Register opens. Use Focus in the cart if a scan lands elsewhere.",
    });

    try {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`, {
          cache: "no-store",
        });
        if (!res.ok) {
          setApiReadiness({
            status: "error",
            detail: `Cannot reach the Riverside API (${res.status}). Check the server URL and network before opening the register.`,
          });
        } else {
          const data = (await res.json().catch(() => [])) as unknown[];
          setApiReadiness({
            status: "ready",
            detail: `Riverside API is reachable${
              Array.isArray(data) ? ` (${data.length} staff records loaded).` : "."
            }`,
          });
        }
      } catch {
        setApiReadiness({
          status: "error",
          detail:
            "Cannot reach the Riverside API. Check the server URL and network before opening the register.",
        });
      }

      const receiptPrinter = resolvePrinterAddress("receipt");
      const printerRequired = registerLaneRef.current <= 1;
      if (!isTauri()) {
        setPrinterReadiness({
          status: "warning",
          detail:
            "Printer diagnostics run only in the Riverside desktop app. Use the Windows register app for live receipt readiness.",
        });
      } else if (!receiptPrinter.ip.trim()) {
        setPrinterReadiness({
          status: printerRequired ? "error" : "warning",
          detail:
            "Receipt printer IP is not configured for this station. Set it in Printers & Scanners before customer checkout.",
        });
      } else if (
        !Number.isFinite(receiptPrinter.port) ||
        receiptPrinter.port <= 0
      ) {
        setPrinterReadiness({
          status: printerRequired ? "error" : "warning",
          detail:
            "Receipt printer port is invalid for this station. Correct the station printer settings before customer checkout.",
        });
      } else {
        try {
          await checkReceiptPrinterConnection(receiptPrinter);
          setPrinterReadiness({
            status: "ready",
            detail: `Receipt printer responded at ${receiptPrinter.ip}:${receiptPrinter.port}.`,
          });
        } catch (err) {
          const detail =
            err instanceof Error ? err.message : "Printer connection failed.";
          setPrinterReadiness({
            status: printerRequired ? "error" : "warning",
            detail: `${detail} Check printer power, IP, and cable/network path before customer checkout.`,
          });
        }
      }
    } finally {
      setReadinessBusy(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    if (booting) return;
    void runReadinessChecks();
  }, [booting, registerLane, runReadinessChecks]);

  const hasBlockingReadinessIssue =
    apiReadiness.status === "error" ||
    (registerLane <= 1 && printerReadiness.status === "error");

  if (BYPASS && booting) {
    return (
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy="true"
          tabIndex={-1}
          className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-[420px] sm:rounded-[32px]"
        >
          <h2 id={titleId} className="sr-only">
            Initializing register
          </h2>
          <div className="ui-modal-body flex flex-col items-center space-y-6 py-12 text-center">
            <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-2xl bg-app-accent/10">
              <div className="h-6 w-6 animate-spin rounded-full border-2 border-app-accent border-t-transparent" />
            </div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
              Initializing register (dev bypass)…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (BYPASS && error) {
    return (
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal w-full max-w-none overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-[420px] sm:rounded-[32px]"
        >
          <div className="ui-modal-body space-y-4 p-8 text-center">
            <h2 id={titleId} className="text-lg font-black text-app-text">
              Register error
            </h2>
            <p className="text-sm font-bold text-app-danger">{error}</p>
            <button
              type="button"
              onClick={() => void tryResumeOrBypass()}
              className="ui-btn-primary w-full py-4 text-sm"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (BYPASS) {
    return null;
  }

  const adminGate = staffRole === "admin" && permissionsLoaded && !booting;
  const adminCheckingPrimary = adminGate && register1OpenForAdmin === null;
  const adminChoosePrimaryPath =
    adminGate && register1OpenForAdmin === false && adminPrimaryPath === null;
  const adminWaitingForElsewhere =
    adminGate &&
    register1OpenForAdmin === false &&
    adminPrimaryPath === "waiting_lane1_elsewhere";

  const onAdminRecheck = async () => {
    setAdminRecheckBusy(true);
    setAdminListOpenError(null);
    try {
      const open = await fetchRegister1IsOpen();
      setRegister1OpenForAdmin(open);
      if (open) {
        setAdminPrimaryPath(null);
      }
    } finally {
      setAdminRecheckBusy(false);
    }
  };

  if (adminCheckingPrimary) {
    return (
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-busy="true"
          tabIndex={-1}
          className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-md sm:rounded-[32px]"
        >
          <div className="ui-modal-body flex flex-col items-center gap-4 p-8 text-center">
            <h2 id={titleId} className="sr-only">
              Checking register status
            </h2>
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-app-border border-t-app-accent" />
            <p className="text-xs font-bold text-app-text-muted">
              Checking whether Register #1 is open…
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (adminChoosePrimaryPath) {
    return (
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 bg-app-bg-alt/95 shadow-2xl outline-none backdrop-blur-xl sm:max-w-lg sm:rounded-[32px]"
        >
          <div className="ui-modal-body p-8 sm:p-10 space-y-8">
            <div className="text-center">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                Terminal Requirement
              </p>
              <h2
                id={titleId}
                className="mt-2 text-2xl font-black text-app-text tracking-tight"
              >
                Cash drawer not open yet
              </h2>
              <div className="mx-auto mt-4 h-1 w-12 rounded-full bg-app-accent/20" />
              <p className="mt-4 text-xs text-app-text-muted leading-relaxed font-medium">
                Registers #2 (iPad) and #3 (Back Office) open automatically once
                Register #1 is active. Register #1 manages the physical cash
                drawer and Z-reconciliation for all lanes.
              </p>
            </div>
            {adminListOpenError ? (
              <p className="rounded-xl border border-app-danger/20 bg-app-danger/5 p-3 text-center text-[10px] font-bold text-app-danger">
                {adminListOpenError}
              </p>
            ) : null}
            <div className="grid gap-4 pt-4">
              <button
                type="button"
                onClick={() => {
                  registerLaneUserChosenRef.current = true;
                  setRegisterLane(1);
                  setAdminPrimaryPath("opening_lane1");
                }}
                className="ui-btn-primary w-full py-5 text-sm font-black rounded-2xl shadow-lg shadow-app-accent/10 transition-all hover:scale-[1.02]"
              >
                Open Register #1 (I am at the main terminal)
              </button>
              <button
                type="button"
                onClick={() => setAdminPrimaryPath("waiting_lane1_elsewhere")}
                className="ui-btn-secondary w-full py-5 text-sm font-bold rounded-2xl border-app-border/40"
              >
                Someone else is opening Register #1
              </button>
            </div>
            <button
              type="button"
              onClick={() => void onAdminRecheck()}
              disabled={adminRecheckBusy}
              className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-app-accent"
            >
              {adminRecheckBusy ? "Checking…" : "Check again"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (adminWaitingForElsewhere) {
    return (
      <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-md sm:rounded-[32px]"
        >
          <div className="ui-modal-body space-y-4 p-6 sm:p-8">
            <div className="text-center">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                Waiting on Register #1
              </p>
              <h2
                id={titleId}
                className="mt-1 text-lg font-black text-app-text"
              >
                Drawer not open on this store yet
              </h2>
              <p className="mt-2 text-xs text-app-text-muted leading-relaxed">
                Ask a cashier to open Register #1 and count in the opening float
                on that terminal. When it is open, tap Check again to continue
                with Register #2 (or another lane).
              </p>
            </div>
            {adminListOpenError ? (
              <p className="rounded-xl border border-app-danger/20 bg-app-danger/5 p-3 text-center text-[10px] font-bold text-app-danger">
                {adminListOpenError}
              </p>
            ) : null}
            <div className="grid gap-3 pt-4">
              <button
                type="button"
                onClick={() => void onAdminRecheck()}
                disabled={adminRecheckBusy}
                className="ui-btn-primary w-full py-5 text-sm font-black rounded-2xl shadow-lg shadow-app-accent/10 transition-all"
              >
                {adminRecheckBusy ? "Checking Status…" : "Check Again Now"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdminPrimaryPath(null);
                  setAdminListOpenError(null);
                }}
                className="ui-btn-secondary w-full py-4 text-sm font-bold rounded-xl border-app-border/20"
              >
                Return Home
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[120] flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 bg-app-bg-alt/95 shadow-2xl outline-none backdrop-blur-xl sm:max-w-4xl sm:rounded-[32px]"
      >
        <form
          onSubmit={(e) => void onSubmit(e)}
          className="ui-modal-body p-8 sm:p-10 flex flex-col gap-8"
        >
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-app-border/10 pb-8">
            <div className="flex items-center gap-6">
              <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-[20px] bg-app-surface shadow-xl border border-app-border/40">
                <img src={RiversideJustLogo} alt="Riverside" className="h-full w-full object-contain" />
              </div>
              <div>
                <p className="text-[11px] font-black uppercase tracking-[0.2em] text-app-accent">
                  POS Terminal Authorization
                </p>
                <h2
                  id={titleId}
                  className="mt-1 text-3xl font-black tracking-tighter uppercase italic text-app-text"
                >
                  Register Access
                </h2>
              </div>
            </div>
            <div className="hidden md:block text-right">
              <p className="text-[10px] font-bold text-app-text-muted uppercase tracking-widest opacity-60">
                Session Initialization
              </p>
            </div>
          </div>

          {error ? (
            <div className="rounded-2xl border border-app-danger/20 bg-app-danger/5 p-4 text-center text-xs font-bold text-app-danger animate-in fade-in slide-in-from-top-1">
              {error}
            </div>
          ) : null}

          <div className="ui-panel ui-tint-neutral p-5">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                  Station Readiness
                </p>
                <h3 className="mt-1 text-lg font-black tracking-tight text-app-text">
                  {readinessBusy
                    ? "Checking this register station…"
                    : hasBlockingReadinessIssue
                      ? "Not ready for customer checkout"
                      : "Ready for register work"}
                </h3>
                <p className="mt-2 text-xs leading-relaxed text-app-text-muted">
                  Confirm API, receipt printer, and scanner/search focus before opening the terminal for customer work.
                </p>
              </div>
              <button
                type="button"
                onClick={() => void runReadinessChecks()}
                disabled={readinessBusy}
                className="ui-btn-secondary h-11 shrink-0 rounded-xl px-4 text-[10px] font-black uppercase tracking-widest"
              >
                {readinessBusy ? "Checking…" : "Run Readiness Check"}
              </button>
            </div>

            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <div className={`rounded-2xl border p-4 ${readinessTone(apiReadiness.status)}`}>
                <div className="flex items-center gap-2">
                  <Wifi size={16} aria-hidden />
                  <p className="text-[10px] font-black uppercase tracking-widest">
                    API Reachability
                  </p>
                </div>
                <div className="mt-3 flex items-start gap-2">
                  <ReadinessIcon status={apiReadiness.status} />
                  <p className="text-xs font-semibold leading-relaxed">
                    {apiReadiness.detail}
                  </p>
                </div>
              </div>

              <div
                className={`rounded-2xl border p-4 ${readinessTone(printerReadiness.status)}`}
              >
                <div className="flex items-center gap-2">
                  <Printer size={16} aria-hidden />
                  <p className="text-[10px] font-black uppercase tracking-widest">
                    Receipt Printer
                  </p>
                </div>
                <div className="mt-3 flex items-start gap-2">
                  <ReadinessIcon status={printerReadiness.status} />
                  <p className="text-xs font-semibold leading-relaxed">
                    {printerReadiness.detail}
                  </p>
                </div>
              </div>

              <div className={`rounded-2xl border p-4 ${readinessTone(focusReadiness.status)}`}>
                <div className="flex items-center gap-2">
                  <Search size={16} aria-hidden />
                  <p className="text-[10px] font-black uppercase tracking-widest">
                    Scanner / Search Focus
                  </p>
                </div>
                <div className="mt-3 flex items-start gap-2">
                  <ReadinessIcon status={focusReadiness.status} />
                  <p className="text-xs font-semibold leading-relaxed">
                    {focusReadiness.detail}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
            {/* Left Column: Staff Auth */}
            <div className="space-y-6">
              <div className="space-y-1 text-center lg:text-left">
                <h3 className="text-sm font-black uppercase tracking-wider text-app-text">
                  1. Staff Identity
                </h3>
                <p className="text-[11px] leading-relaxed text-app-text-muted">
                  Choose your name and enter your 4-digit PIN.
                </p>
              </div>

              <div className="ui-panel ui-tint-neutral p-6 space-y-6 rounded-[24px] border-app-border/20 shadow-inner">
                <div className="space-y-2">
                  <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted block text-center">
                    Staff Member
                  </label>
                  <select
                    className="ui-input w-full text-center font-bold"
                    value={localStorage.getItem("ros_last_staff_id") || ""}
                    onChange={(e) =>
                      localStorage.setItem("ros_last_staff_id", e.target.value)
                    }
                  >
                    <option value="">-- Choose Name --</option>
                    {/* Note: Roster is loaded into a local state here too */}
                    {roster.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.full_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-4">
                  <p className="text-[9px] font-black uppercase tracking-widest text-app-text-muted text-center">
                    Enter PIN
                  </p>
                  <PinDots length={credential.length} className="py-2" />
                  <NumericPinKeypad
                    value={credential}
                    onChange={setCredential}
                    onEnter={() => void onSubmit()}
                    disabled={busy}
                  />
                </div>
              </div>
            </div>

            {/* Right Column: Lane Config */}
            <div className="flex flex-col gap-8">
              <div className="space-y-6 flex-1">
                <div className="space-y-1">
                  <h3 className="text-sm font-black uppercase tracking-wider text-app-text">
                    2. Terminal Configuration
                  </h3>
                  <p className="text-[11px] leading-relaxed text-app-text-muted">
                    Satellite terminals (#2 and #3) share the cash turnover of
                    Register #1 and open automatically with it.
                  </p>
                </div>

                <div className="space-y-4">
                  {/* Register Selection */}
                  <div className="ui-panel ui-tint-neutral p-5 rounded-[20px] border-app-border/20 shadow-sm">
                    <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-3 block">
                      Physical Register Number
                    </label>
                    {staffRole === "admin" ? (
                      <p className="mb-3 text-[9px] font-medium leading-tight text-app-text-muted bg-app-accent/5 p-2 rounded-lg border border-app-accent/10">
                        Admin Note: Register #3 is reserved for Back Office
                        activities. Z-close runs on Register #1 only.
                      </p>
                    ) : null}
                    <select
                      value={registerLane}
                      onChange={(e) => {
                        registerLaneUserChosenRef.current = true;
                        setRegisterLane(Number(e.target.value));
                      }}
                      disabled={busy}
                      className="ui-input w-full p-4 text-center font-mono text-xl font-black bg-app-bg/60 border-transparent focus:border-app-accent/50 transition-all rounded-xl cursor-pointer"
                      aria-label="Physical register number"
                    >
                      <option value={1}>Register #1 (Main Drawer)</option>
                      <option value={2}>Register #2 (iPad Satellite)</option>
                      <option value={3}>Register #3 (Back Office Hub)</option>
                    </select>
                    {registerLane > 1 && linkStatus ? (
                      <p className="mt-3 text-center text-[10px] font-bold leading-snug text-app-accent animate-pulse">
                        {linkStatus}
                      </p>
                    ) : null}
                  </div>

                  {/* Opening Float */}
                  <div className="ui-panel ui-tint-neutral p-5 rounded-[20px] border-app-border/20 shadow-sm">
                    <label className="text-[9px] font-black uppercase tracking-widest text-app-text-muted mb-3 block">
                      Opening Cash Float ($)
                    </label>
                    {registerLane <= 1 ? (
                      <div className="relative group">
                        <span className="absolute left-6 top-1/2 -translate-y-1/2 text-xl font-black text-app-text-muted/40 transition-colors group-focus-within:text-app-accent">
                          $
                        </span>
                        <input
                          type="number"
                          step="0.01"
                          required
                          value={openingFloat}
                          onChange={(e) => setOpeningFloat(e.target.value)}
                          className="ui-input w-full rounded-xl border-transparent bg-app-bg/60 p-4 pl-11 text-center font-mono text-2xl font-black transition-all focus:border-app-accent/50 sm:p-5 sm:pl-12 sm:text-3xl"
                        />
                      </div>
                    ) : (
                      <div className="flex flex-col items-center py-4 space-y-2">
                        <p className="font-mono text-4xl font-black text-app-text-muted/30 tracking-tight">
                          $0.00
                        </p>
                        <p className="max-w-[220px] text-center text-[10px] leading-relaxed text-app-text-muted opacity-80">
                          Satellite lane: float is managed through the primary
                          drawer on Register #1.
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Action Button */}
              <div className="pt-4 mt-auto">
                <button
                  type="submit"
                  disabled={
                    busy ||
                    hasBlockingReadinessIssue ||
                    credential.length !== 4 ||
                    (registerLane > 1 && !primarySessionId)
                  }
                  className="ui-btn-primary group relative h-16 w-full overflow-hidden rounded-2xl text-sm font-black shadow-xl shadow-app-accent/20 transition-all hover:shadow-app-accent/30 sm:h-20 sm:text-base"
                >
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent -translate-x-full group-hover:animate-shimmer" />
                  <span className="relative flex items-center justify-center gap-3">
                    {busy ? (
                      <>
                        <div className="h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
                        Opening Terminal...
                      </>
                    ) : (
                      <>
                        Open Terminal Session
                        <span className="text-xs opacity-70 font-mono px-2 py-0.5 rounded-lg bg-app-surface-3">
                          Lane {registerLane}
                        </span>
                      </>
                    )}
                  </span>
                </button>
                <div className="mt-4 flex items-center justify-center gap-2 opacity-40">
                  <div className="h-px w-8 bg-app-text-muted" />
                  <p className="text-[9px] text-app-text-muted uppercase tracking-widest font-black">
                    Secure POS Handshake Protocol
                  </p>
                  <div className="h-px w-8 bg-app-text-muted" />
                </div>
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
