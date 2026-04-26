import { getBaseUrl } from "../../lib/apiConfig";
import { isTauri } from "@tauri-apps/api/core";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
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

  const baseUrl = getBaseUrl();

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/api/staff/list-for-pos`);
        if (res.ok) {
          await res.json();
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

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  if (BYPASS && booting) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
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
      </div>,
      root
    );
  }

  if (BYPASS && error) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
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
      </div>,
      root
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
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
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
      </div>,
      root
    );
  }

  if (adminChoosePrimaryPath) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
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
      </div>,
      root
    );
  }

  if (adminWaitingForElsewhere) {
    return createPortal(
      <div className="ui-overlay-backdrop !z-[200]">
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
          className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-md sm:rounded-[32px]"
        >
          <div className="ui-modal-body p-8 sm:p-10 text-center space-y-6">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-app-accent/10">
              <Wifi className="h-8 w-8 text-app-accent" />
            </div>
            <div>
              <h2 id={titleId} className="text-xl font-black text-app-text">
                Waiting for Register #1
              </h2>
              <p className="mt-3 text-xs font-medium text-app-text-muted leading-relaxed">
                Stay on this screen. This satellite lane will automatically enable the
                sign-in keypad as soon as the physical cash drawer is opened at
                the main terminal.
              </p>
            </div>
            <div className="grid gap-3 pt-4">
              <button
                type="button"
                onClick={() => void onAdminRecheck()}
                disabled={adminRecheckBusy}
                className="ui-btn-primary w-full py-4 text-xs font-black uppercase tracking-widest"
              >
                {adminRecheckBusy ? (
                  <RefreshCw className="h-4 w-4 animate-spin mx-auto" />
                ) : (
                  "Check status now"
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setAdminPrimaryPath(null);
                  registerLaneUserChosenRef.current = false;
                }}
                className="ui-btn-secondary w-full py-4 text-xs font-bold"
              >
                Go back
              </button>
            </div>
          </div>
        </div>
      </div>,
      root
    );
  }

  return createPortal(
    <div className="ui-overlay-backdrop !z-[200]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ui-modal w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 bg-app-bg-alt/95 shadow-2xl outline-none backdrop-blur-xl sm:max-w-5xl sm:rounded-[40px]"
      >
        <div className="grid h-full grid-cols-1 lg:grid-cols-[1fr_420px]">
          {/* Left Panel: Branding & Diagnostics */}
          <div className="relative hidden flex-col justify-between border-r border-app-border/40 bg-app-surface/30 p-10 lg:flex">
            <div>
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white p-2 shadow-sm">
                  <img
                    src={RiversideJustLogo}
                    alt="Riverside OS"
                    className="h-full w-full object-contain"
                  />
                </div>
                <div>
                  <h1 className="text-xl font-black tracking-tight text-app-text">
                    Riverside OS
                  </h1>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                    Station Terminal
                  </p>
                </div>
              </div>

              <div className="mt-16 space-y-8">
                <div>
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                    Station Diagnostics
                  </h3>
                  <div className="mt-6 space-y-4">
                    <div
                      className={`flex items-start gap-4 rounded-2xl border border-app-border/40 p-4 transition-all ${readinessTone(
                        apiReadiness.status,
                      )}`}
                    >
                      <ReadinessIcon status={apiReadiness.status} />
                      <div className="space-y-1">
                        <p className="text-[10px] font-black uppercase tracking-widest">
                          Riverside API
                        </p>
                        <p className="text-[11px] font-medium leading-relaxed opacity-80">
                          {apiReadiness.detail}
                        </p>
                      </div>
                    </div>

                    <div
                      className={`flex items-start gap-4 rounded-2xl border border-app-border/40 p-4 transition-all ${readinessTone(
                        printerReadiness.status,
                      )}`}
                    >
                      <ReadinessIcon status={printerReadiness.status} />
                      <div className="space-y-1">
                        <p className="text-[10px] font-black uppercase tracking-widest">
                          Receipt Printer
                        </p>
                        <p className="text-[11px] font-medium leading-relaxed opacity-80">
                          {printerReadiness.detail}
                        </p>
                      </div>
                    </div>

                    <div
                      className={`flex items-start gap-4 rounded-2xl border border-app-border/40 p-4 transition-all ${readinessTone(
                        focusReadiness.status,
                      )}`}
                    >
                      <ReadinessIcon status={focusReadiness.status} />
                      <div className="space-y-1">
                        <p className="text-[10px] font-black uppercase tracking-widest">
                          Scanner Focus
                        </p>
                        <p className="text-[11px] font-medium leading-relaxed opacity-80">
                          {focusReadiness.detail}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />
              v0.3.3 Production Build
            </div>
          </div>

          {/* Right Panel: Keypad & Auth */}
          <div className="flex flex-col p-8 sm:p-12">
            <div className="flex-1 space-y-8">
              <div className="text-center lg:text-left">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                  Secure Entry
                </p>
                <h2
                  id={titleId}
                  className="mt-2 text-2xl font-black text-app-text tracking-tight"
                >
                  {booting ? "Initializing…" : "Access Register"}
                </h2>
                <div className="mx-auto mt-4 h-1 w-12 rounded-full bg-app-accent/20 lg:mx-0" />
              </div>

              <div className="space-y-6">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Terminal #
                    </label>
                    <select
                      value={registerLane}
                      onChange={(e) => {
                        registerLaneUserChosenRef.current = true;
                        setRegisterLane(Number(e.target.value));
                      }}
                      className="ui-input h-14 w-full bg-app-surface/50 text-center font-black text-lg"
                    >
                      <option value={1}>Register #1 (Main)</option>
                      <option value={2}>Register #2 (Satellite)</option>
                      <option value={3}>Register #3 (Back Office)</option>
                      <option value={4}>Register #4 (Mobile)</option>
                    </select>
                  </div>
                  <div className="space-y-2">
                    <label className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      {registerLane === 1 ? "Opening Float" : "Satellite Mode"}
                    </label>
                    <div className="relative">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-sm font-bold text-app-text-muted">
                        $
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        disabled={registerLane > 1}
                        value={openingFloat}
                        onChange={(e) => setOpeningFloat(e.target.value)}
                        className="ui-input h-14 w-full bg-app-surface/50 pl-8 text-center font-mono text-lg font-black disabled:opacity-50"
                      />
                    </div>
                  </div>
                </div>

                {linkStatus ? (
                  <div className="flex gap-3 rounded-2xl border border-app-border/40 bg-app-surface/30 p-4">
                    <Wifi size={14} className="mt-0.5 text-app-accent" />
                    <p className="text-[10px] font-bold leading-relaxed text-app-text-muted">
                      {linkStatus}
                    </p>
                  </div>
                ) : (
                  <div className="flex gap-3 rounded-2xl border border-app-accent/20 bg-app-accent/5 p-4">
                    <Wifi size={14} className="mt-0.5 text-app-accent" />
                    <p className="text-[10px] font-bold leading-relaxed text-app-text-muted">
                      Register #1 creates the shared cash drawer. All satellite
                      lanes reconcile against the main drawer.
                    </p>
                  </div>
                )}

                <div className="space-y-4 py-4">
                  <PinDots
                    length={4}
                    activeCount={credential.length}
                    error={Boolean(error)}
                    busy={busy}
                  />
                  {error && (
                    <p className="text-center text-[10px] font-bold text-app-danger animate-shake">
                      {error}
                    </p>
                  )}
                  {hasBlockingReadinessIssue && (
                    <div className="rounded-xl border border-app-danger/20 bg-app-danger/5 p-3 flex gap-3">
                      <AlertTriangle size={14} className="shrink-0 text-app-danger" />
                      <p className="text-[10px] font-bold leading-relaxed text-app-danger">
                        Cannot open register until diagnostics pass. Check API connectivity and printer configuration.
                      </p>
                    </div>
                  )}
                </div>

                <div className="mx-auto max-w-[320px]">
                  <NumericPinKeypad
                    onInput={(val) => {
                      if (credential.length < 4) {
                        const next = credential + val;
                        setCredential(next);
                        if (next.length === 4) {
                          // Auto-submit
                          setTimeout(() => {
                            void onSubmit();
                          }, 150);
                        }
                      }
                    }}
                    onClear={() => {
                      setCredential("");
                      setError(null);
                    }}
                    onBackspace={() => {
                      setCredential((prev) => prev.slice(0, -1));
                      setError(null);
                    }}
                    disabled={busy || hasBlockingReadinessIssue}
                  />
                </div>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-center gap-6 lg:justify-start">
              <button
                type="button"
                onClick={() => void runReadinessChecks()}
                disabled={readinessBusy}
                className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
              >
                <RefreshCw
                  size={12}
                  className={readinessBusy ? "animate-spin" : ""}
                />
                Retry Diagnostics
              </button>
              <button
                type="button"
                onClick={() => {
                  /* maybe open help drawer */
                }}
                className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
              >
                <AlertTriangle size={12} />
                Emergency Help
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>,
    root
  );
}
