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
  ArrowLeft,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Wifi,
  X,
} from "lucide-react";
import { centsToFixed2, parseMoney, parseMoneyToCents } from "../../lib/money";
import {
  getPosRegisterAuth,
  mergedPosStaffHeaders,
  posRegisterAuthHeaders,
} from "../../lib/posRegisterAuth";
import NumericPinKeypad, { PinDots } from "../ui/NumericPinKeypad";
import { useShellBackdropLayer } from "../layout/ShellBackdropContextLogic";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";
import { useBackofficeAuth } from "../../context/BackofficeAuthContextLogic";
import {
  checkReceiptPrinterConnection,
  describePrinterTarget,
  resolvePrinterTarget,
  hydratePrinterConfigFromServer,
  syncPrinterConfigToServer,
} from "../../lib/printerBridge";
import RiversideJustLogo from "../../assets/images/logo1.png";
import { CLIENT_SEMVER } from "../../clientBuildMeta";
import {
  getStableStationKey,
  stationKeyHeader,
} from "../../lib/stationIdentity";

export interface SessionOpenedPayload {
  cashierName: string;
  cashierCode: string;
  cashierAvatarKey: string;
  cashierAvatarPhotoUrl: string | null;
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
  onCancel?: () => void;
}

type CurrentSessionJson = {
  cashier_name: string;
  cashier_avatar_key?: string;
  cashier_avatar_photo_url?: string | null;
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
const PRIMARY_OPENING_FLOAT_DEFAULT = "300.00";
const SATELLITE_OPENING_FLOAT = "0.00";
const MAIN_HUB_UNAVAILABLE_MESSAGE =
  "Main Hub is unavailable. Keep this register screen open and check again after the server connection returns.";

interface ReadinessCheck {
  status: ReadinessStatus;
  detail: string;
}

function installedRegisterLane(): number | null {
  if (typeof window === "undefined") return null;
  const label = window.localStorage.getItem("ros.station.label")?.trim() ?? "";
  const registerMatch = label.match(/^Register\s*#?\s*(\d+)$/i);
  if (registerMatch) {
    const lane = Number(registerMatch[1]);
    return Number.isInteger(lane) && lane > 0 ? lane : null;
  }
  return /back\s*office|backoffice/i.test(label) ? 3 : null;
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

function isTransientMainHubStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function ReadinessIcon({ status }: { status: ReadinessStatus }) {
  if (status === "ready") {
    return <CheckCircle2 size={16} className="shrink-0" aria-hidden />;
  }
  if (status === "warning" || status === "error") {
    return <AlertTriangle size={16} className="shrink-0" aria-hidden />;
  }
  return <RefreshCw size={16} className="shrink-0 animate-spin" aria-hidden />;
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
    cashierAvatarPhotoUrl: data.cashier_avatar_photo_url ?? null,
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
  onCancel,
}: RegisterOverlayProps) {
  const { backofficeHeaders, staffRole, permissionsLoaded } =
    useBackofficeAuth();
  const [credential, setCredential] = useState("");
  const stationRegisterLane = useMemo(() => installedRegisterLane(), []);
  const stationLocksRegisterLane = stationRegisterLane != null;

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

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(
          `${baseUrl}/api/settings/pos-station-config/public`,
        );
        if (res.ok) {
          const data = (await res.json()) as { max_register_lanes?: number };
          if (
            typeof data.max_register_lanes === "number" &&
            data.max_register_lanes > 0
          ) {
            setMaxRegisterLanes(
              Math.max(data.max_register_lanes, stationRegisterLane ?? 1),
            );
          }
        }
      } catch (e) {
        console.error("Failed to load station config", e);
      }
    })();
  }, [baseUrl, stationRegisterLane]);

  const [registerLane, setRegisterLane] = useState(
    () => stationRegisterLane ?? 1,
  );
  /** After the user picks a lane, do not auto-switch (e.g. admin default to #2). */
  const registerLaneUserChosenRef = useRef(false);
  const [maxRegisterLanes, setMaxRegisterLanes] = useState(4);
  const [openingFloat, setOpeningFloat] = useState(
    PRIMARY_OPENING_FLOAT_DEFAULT,
  );
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
    if (
      permissionsLoaded &&
      staffRole === "admin" &&
      !stationLocksRegisterLane &&
      !registerLaneUserChosenRef.current &&
      register1OpenForAdmin === true &&
      adminPrimaryPath !== "opening_lane1"
    ) {
      setRegisterLane(3); // Default BO activity to Register 3 (Back Office)
    }
  }, [
    permissionsLoaded,
    staffRole,
    stationLocksRegisterLane,
    register1OpenForAdmin,
    adminPrimaryPath,
  ]);

  useEffect(() => {
    if (registerLane <= 1) {
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
      setOpeningFloat(SATELLITE_OPENING_FLOAT);
    } else {
      setOpeningFloat(PRIMARY_OPENING_FLOAT_DEFAULT);
    }
    // Hydrate printer config for this lane from server
    void hydratePrinterConfigFromServer(baseUrl, registerLane);
  }, [registerLane, baseUrl]);

  const attachOpenLane = useCallback(async (lane: number): Promise<boolean> => {
    let listRes: Response;
    try {
      listRes = await fetch(`${baseUrl}/api/sessions/list-open`, {
        headers: mergedPosStaffHeaders(backofficeHeaders),
      });
    } catch {
      throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
    }
    if (!listRes.ok) {
      if (isTransientMainHubStatus(listRes.status)) {
        throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
      }
      return false;
    }

    const rows = (await listRes.json()) as OpenSessionSummaryJson[];
    const existing = rows.find((row) => row.register_lane === lane);
    if (!existing?.session_id) {
      return false;
    }

    let attachRes: Response;
    try {
      attachRes = await fetch(
        `${baseUrl}/api/sessions/${encodeURIComponent(existing.session_id)}/attach`,
        {
          method: "POST",
          headers: jsonAuthHeaders(),
          body: "{}",
        },
      );
    } catch {
      throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
    }
    if (!attachRes.ok) {
      if (isTransientMainHubStatus(attachRes.status)) {
        throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
      }
      return false;
    }

    const attachJson = (await attachRes.json()) as { pos_api_token?: string };
    const token = attachJson.pos_api_token?.trim();
    if (!token) {
      return false;
    }

    let cur: Response;
    try {
      cur = await fetch(`${baseUrl}/api/sessions/current`, {
        headers: {
          "x-riverside-pos-session-id": existing.session_id,
          "x-riverside-pos-session-token": token,
          ...stationKeyHeader(),
        },
      });
    } catch {
      throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
    }
    if (!cur.ok) {
      if (isTransientMainHubStatus(cur.status)) {
        throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
      }
      return false;
    }

    const data = (await cur.json()) as CurrentSessionJson;
    onOpenedRef.current(payloadFromSessionJson(data, token));
    void syncPrinterConfigToServer(
      baseUrl,
      mergedPosStaffHeaders(backofficeHeaders),
      lane,
    );
    return true;
  }, [baseUrl, backofficeHeaders, jsonAuthHeaders]);

  const tryResumeOrBypass = useCallback(async () => {
    setBooting(true);
    setError(null);
    try {
      const posHeaders = posRegisterAuthHeaders();
      if (posHeaders["x-riverside-pos-session-id"]) {
        let cur: Response;
        try {
          cur = await fetch(`${baseUrl}/api/sessions/current`, {
            headers: posHeaders,
          });
        } catch {
          setError(MAIN_HUB_UNAVAILABLE_MESSAGE);
          return;
        }
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
        if (isTransientMainHubStatus(cur.status)) {
          setError(MAIN_HUB_UNAVAILABLE_MESSAGE);
          return;
        }
      }
      if (await attachOpenLane(registerLaneRef.current)) {
        return;
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
  }, [baseUrl, attachOpenLane]);

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
    if (stationLocksRegisterLane && (await attachOpenLane(lane))) {
      return;
    }
    const floatStr = centsToFixed2(parseMoneyToCents(openingFloatRef.current));
    const body: Record<string, unknown> = {
      cashier_code: code,
      pin: code,
      opening_float: floatStr,
      register_lane: lane,
      station_key: getStableStationKey(),
    };
    if (lane > 1 && primarySessionId) {
      body.primary_session_id = primarySessionId;
    }
    let res: Response;
    try {
      res = await fetch(`${baseUrl}/api/sessions/open`, {
        method: "POST",
        headers: jsonAuthHeaders(),
        body: JSON.stringify(body),
      });
    } catch {
      throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
    }

    if (res.status === 409) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        session_id?: string;
        register_lane?: number;
      };
      if (body.error === "register_lane_in_use") {
        const laneInUse = body.register_lane ?? registerLaneRef.current;
        if (await attachOpenLane(laneInUse)) {
          return;
        }
        throw new Error(
          `Register #${laneInUse} already has an open session. Pick another register number or join that session from Back Office.`,
        );
      }
      const sid = body.session_id?.trim();
      if (sid) {
        let tokRes: Response;
        try {
          tokRes = await fetch(
            `${baseUrl}/api/sessions/${encodeURIComponent(sid)}/pos-api-token`,
            {
              method: "POST",
              headers: jsonAuthHeaders(),
              body: JSON.stringify({
                cashier_code: code,
                pin: code,
                station_key: getStableStationKey(),
              }),
            },
          );
        } catch {
          throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
        }
        if (!tokRes.ok && isTransientMainHubStatus(tokRes.status)) {
          throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
        }
        if (tokRes.ok) {
          const tokJson = (await tokRes.json()) as {
            pos_api_token?: string;
          };
          const token = tokJson.pos_api_token;
          if (token) {
            let cur: Response;
            try {
              cur = await fetch(`${baseUrl}/api/sessions/current`, {
                headers: {
                  "x-riverside-pos-session-id": sid,
                  "x-riverside-pos-session-token": token,
                  ...stationKeyHeader(),
                },
              });
            } catch {
              throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
            }
            if (!cur.ok && isTransientMainHubStatus(cur.status)) {
              throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
            }
            if (cur.ok) {
              const data = (await cur.json()) as CurrentSessionJson;
              onOpenedRef.current(payloadFromSessionJson(data, token));
              void syncPrinterConfigToServer(
                baseUrl,
                mergedPosStaffHeaders(backofficeHeaders),
                registerLaneRef.current,
              );
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
      if (isTransientMainHubStatus(res.status)) {
        throw new Error(MAIN_HUB_UNAVAILABLE_MESSAGE);
      }
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
    void syncPrinterConfigToServer(
      baseUrl,
      mergedPosStaffHeaders(backofficeHeaders),
      registerLaneRef.current,
    );
  };

  const onSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
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
    () => booting || Boolean(error),
    [booting, error],
  );
  useShellBackdropLayer(overlayVisible);
  const canCancel = Boolean(onCancel) && !submitting;
  const { dialogRef, titleId } = useDialogAccessibility(overlayVisible, {
    onEscape: canCancel ? onCancel : undefined,
  });

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
              Array.isArray(data)
                ? ` (${data.length} staff records loaded).`
                : "."
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

      const receiptPrinter = resolvePrinterTarget("receipt");
      if (!isTauri() && registerLane <= 1) {
        setPrinterReadiness({
          status: "error",
          detail:
            "Register #1 must use the Riverside desktop app to print receipts. Install and open the RiversideOS register application.",
        });
      } else if (!isTauri()) {
        setPrinterReadiness({
          status: "warning",
          detail:
            "Printer diagnostics run only in the Riverside desktop app. Use the Windows register app for live receipt readiness.",
        });
      } else if (
        receiptPrinter.mode === "system" &&
        !receiptPrinter.printerName.trim()
      ) {
        setPrinterReadiness({
          status: "warning",
          detail:
            "Receipt printer is not selected for this station. Set it in Printers & Scanners before customer checkout.",
        });
      } else if (
        receiptPrinter.mode === "network" &&
        !receiptPrinter.ip.trim()
      ) {
        setPrinterReadiness({
          status: "warning",
          detail:
            "Receipt printer address is not configured for this station. Set it in Printers & Scanners before customer checkout.",
        });
      } else if (
        receiptPrinter.mode === "network" &&
        (!Number.isFinite(receiptPrinter.port) || receiptPrinter.port <= 0)
      ) {
        setPrinterReadiness({
          status: "warning",
          detail:
            "Receipt printer port is invalid for this station. Correct the station printer settings before customer checkout.",
        });
      } else {
        try {
          await checkReceiptPrinterConnection(receiptPrinter);
          setPrinterReadiness({
            status: "ready",
            detail: `Receipt printer responded at ${describePrinterTarget(receiptPrinter)}.`,
          });
        } catch (err) {
          const detail =
            err instanceof Error ? err.message : "Printer connection failed.";
          setPrinterReadiness({
            status: "warning",
            detail: `${detail} Check printer power, IP, and cable/network path before customer checkout.`,
          });
        }
      }
    } finally {
      setReadinessBusy(false);
    }
  }, [baseUrl, registerLane]);

  useEffect(() => {
    if (booting) return;
    void runReadinessChecks();
  }, [booting, registerLane, runReadinessChecks]);

  const hasBlockingReadinessIssue = apiReadiness.status === "error";

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  const cancelControl = canCancel ? (
    <button
      type="button"
      onClick={onCancel}
      aria-label="Back to Back Office"
      className="absolute right-4 top-4 z-10 flex h-9 w-9 items-center justify-center rounded-full border border-app-border/50 bg-app-surface/90 text-app-text-muted shadow-sm transition hover:border-app-input-border hover:text-app-text"
    >
      <X size={16} aria-hidden />
    </button>
  ) : null;

  const adminGate =
    staffRole === "admin" &&
    permissionsLoaded &&
    !booting &&
    !stationLocksRegisterLane;
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
          className="ui-modal relative w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-md sm:rounded-[32px]"
        >
          {cancelControl}
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
      root,
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
          className="ui-modal relative w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 bg-app-bg-alt/95 shadow-2xl outline-none backdrop-blur-xl sm:max-w-[460px] sm:rounded-[28px]"
        >
          {cancelControl}
          <div className="ui-modal-body space-y-5 p-6 sm:p-7">
            <div className="text-center">
              <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                Terminal Requirement
              </p>
              <h2
                id={titleId}
                className="mt-2 text-xl font-black text-app-text tracking-tight"
              >
                Cash drawer not open yet
              </h2>
              <p className="mx-auto mt-3 max-w-[330px] text-xs font-medium leading-relaxed text-app-text-muted">
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
            <div className="grid gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  registerLaneUserChosenRef.current = true;
                  setRegisterLane(1);
                  setAdminPrimaryPath("opening_lane1");
                }}
                className="ui-btn-primary w-full rounded-2xl py-4 text-xs font-black shadow-lg shadow-app-accent/10 transition-all hover:scale-[1.01]"
              >
                Open Register #1 (I am at the main terminal)
              </button>
              <button
                type="button"
                onClick={() => setAdminPrimaryPath("waiting_lane1_elsewhere")}
                className="ui-btn-secondary w-full rounded-2xl border-app-border/40 py-4 text-xs font-bold"
              >
                Someone else is opening Register #1
              </button>
            </div>
            <div className="flex items-center justify-center gap-5">
              {canCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                >
                  <ArrowLeft size={12} aria-hidden />
                  Back
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void onAdminRecheck()}
                disabled={adminRecheckBusy}
                className="py-2 text-[10px] font-black uppercase tracking-widest text-app-accent"
              >
                {adminRecheckBusy ? "Checking…" : "Check again"}
              </button>
            </div>
          </div>
        </div>
      </div>,
      root,
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
          className="ui-modal relative w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 shadow-2xl outline-none sm:max-w-md sm:rounded-[32px]"
        >
          {cancelControl}
          <div className="ui-modal-body p-8 sm:p-10 text-center space-y-6">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-3xl bg-app-accent/10">
              <Wifi className="h-8 w-8 text-app-accent" />
            </div>
            <div>
              <h2 id={titleId} className="text-xl font-black text-app-text">
                Waiting for Register #1
              </h2>
              <p className="mt-3 text-xs font-medium text-app-text-muted leading-relaxed">
                Stay on this screen. This satellite lane will automatically
                enable the sign-in keypad as soon as the physical cash drawer is
                opened at the main terminal.
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
              {canCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="w-full py-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                >
                  Back to Back Office
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>,
      root,
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
        className="ui-modal relative w-full max-w-none animate-workspace-snap overflow-hidden rounded-t-3xl border border-app-border/40 bg-app-bg-alt/95 shadow-2xl outline-none backdrop-blur-xl sm:max-w-[980px] sm:rounded-[32px]"
      >
        {cancelControl}
        <div className="grid h-full grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)]">
          {/* Left Panel: Branding & Diagnostics */}
          <div className="relative hidden flex-col justify-between border-r border-app-border/40 bg-app-surface/30 p-6 lg:flex">
            <div>
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-app-surface p-2 shadow-sm">
                  <img
                    src={RiversideJustLogo}
                    alt="Riverside OS"
                    className="h-full w-full object-contain"
                  />
                </div>
                <div>
                  <h1 className="text-lg font-black tracking-tight text-app-text">
                    Riverside OS
                  </h1>
                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                    Station Terminal
                  </p>
                </div>
              </div>

              <div className="mt-8 space-y-4">
                <div>
                  <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-app-text-muted">
                    Diagnostics
                  </h3>
                  <div className="mt-3 space-y-2.5">
                    <div
                      className={`flex items-start gap-2.5 rounded-xl border border-app-border/40 p-2.5 transition-all ${readinessTone(
                        apiReadiness.status,
                      )}`}
                    >
                      <ReadinessIcon status={apiReadiness.status} />
                      <div className="space-y-1">
                        <p className="text-[9px] font-black uppercase tracking-widest">
                          Riverside API
                        </p>
                        <p className="text-[10px] font-medium leading-relaxed opacity-80">
                          {apiReadiness.detail}
                        </p>
                      </div>
                    </div>

                    <div
                      className={`flex items-start gap-2.5 rounded-xl border border-app-border/40 p-2.5 transition-all ${readinessTone(
                        printerReadiness.status,
                      )}`}
                    >
                      <ReadinessIcon status={printerReadiness.status} />
                      <div className="space-y-1">
                        <p className="text-[9px] font-black uppercase tracking-widest">
                          Receipt Printer
                        </p>
                        <p className="text-[10px] font-medium leading-relaxed opacity-80">
                          {printerReadiness.detail}
                        </p>
                      </div>
                    </div>

                    <div
                      className={`flex items-start gap-2.5 rounded-xl border border-app-border/40 p-2.5 transition-all ${readinessTone(
                        focusReadiness.status,
                      )}`}
                    >
                      <ReadinessIcon status={focusReadiness.status} />
                      <div className="space-y-1">
                        <p className="text-[9px] font-black uppercase tracking-widest">
                          Scanner Focus
                        </p>
                        <p className="text-[10px] font-medium leading-relaxed opacity-80">
                          {focusReadiness.detail}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted opacity-50">
              <span className="h-1.5 w-1.5 rounded-full bg-current" />v
              {CLIENT_SEMVER} Production Build
            </div>
          </div>

          {/* Right Panel: Keypad & Auth */}
          <div className="flex flex-col p-7 sm:p-10">
            <div className="mx-auto flex w-full max-w-[460px] flex-1 flex-col space-y-6">
              <div className="text-center lg:text-left">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-app-accent">
                  Secure Entry
                </p>
                <h2
                  id={titleId}
                  className="mt-2 text-3xl font-black text-app-text tracking-tight"
                >
                  {booting ? "Initializing…" : "Open Register"}
                </h2>
              </div>

              <div className="space-y-5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                  <div className="space-y-2">
                    <label className="px-1 text-[10px] font-black uppercase tracking-widest text-app-text-muted">
                      Terminal #
                    </label>
                    <select
                      value={registerLane}
                      onChange={(e) => {
                        if (stationLocksRegisterLane) return;
                        registerLaneUserChosenRef.current = true;
                        setRegisterLane(Number(e.target.value));
                      }}
                      disabled={stationLocksRegisterLane}
                      className="ui-input h-14 w-full bg-app-surface/50 text-center text-base font-black"
                    >
                      {Array.from({ length: maxRegisterLanes }, (_, i) => {
                        const lane = i + 1;
                        const labels: Record<number, string> = {
                          1: "Main",
                          2: "iPad",
                          3: "Back Office",
                          4: "Mobile",
                        };
                        const label = labels[lane] ?? `Station ${lane}`;
                        return (
                          <option key={lane} value={lane}>
                            Register #{lane} - {label}
                          </option>
                        );
                      })}
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
                        className="ui-input h-14 w-full bg-app-surface/50 pl-8 text-center font-mono text-base font-black disabled:opacity-50"
                      />
                    </div>
                  </div>
                </div>

                {linkStatus ? (
                  <div className="flex gap-3 rounded-2xl border border-app-border/40 bg-app-surface/30 p-3">
                    <Wifi size={14} className="mt-0.5 text-app-accent" />
                    <p className="text-[10px] font-bold leading-relaxed text-app-text-muted">
                      {linkStatus}
                    </p>
                  </div>
                ) : (
                  <div className="flex gap-3 rounded-2xl border border-app-accent/20 bg-app-accent/5 p-3">
                    <Wifi size={14} className="mt-0.5 text-app-accent" />
                    <p className="text-[10px] font-bold leading-relaxed text-app-text-muted">
                      Register #1 creates the shared cash drawer. All satellite
                      lanes reconcile against the main drawer.
                    </p>
                  </div>
                )}

                <div className="space-y-4 py-2">
                  <PinDots length={credential.length} className="gap-2" />
                  {error && (
                    <p className="text-center text-[10px] font-bold text-app-danger animate-shake">
                      {error}
                    </p>
                  )}
                  {hasBlockingReadinessIssue && (
                    <div className="rounded-xl border border-app-danger/20 bg-app-danger/5 p-3 flex gap-3">
                      <AlertTriangle
                        size={14}
                        className="shrink-0 text-app-danger"
                      />
                      <p className="text-[10px] font-bold leading-relaxed text-app-danger">
                        Cannot open register until diagnostics pass. Check API
                        connectivity.
                      </p>
                    </div>
                  )}
                </div>

                <div className="mx-auto w-full max-w-[360px]">
                  <NumericPinKeypad
                    value={credential}
                    onChange={(next) => {
                      setCredential(next);
                      setError(null);
                      if (next.length === 4) {
                        // Auto-submit
                        setTimeout(() => {
                          credentialRef.current = next;
                          void onSubmit();
                        }, 150);
                      }
                    }}
                    disabled={busy || hasBlockingReadinessIssue}
                  />
                </div>
              </div>
            </div>

            <div className="mx-auto mt-6 flex w-full max-w-[460px] flex-wrap items-center justify-center gap-5 lg:justify-start">
              {canCancel ? (
                <button
                  type="button"
                  onClick={onCancel}
                  className="flex items-center gap-2 text-[10px] font-black uppercase tracking-widest text-app-text-muted transition-colors hover:text-app-text"
                >
                  <ArrowLeft size={12} aria-hidden />
                  Back
                </button>
              ) : null}
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
    root,
  );
}
