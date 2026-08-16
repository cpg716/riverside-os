/**
 * CameraScanner — PWA camera-based barcode/QR scanner.
 * Uses html5-qrcode for iOS/Android Safari compatibility.
 * Renders as full-screen overlay on mobile, floating modal on desktop.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Html5Qrcode } from "html5-qrcode";
import { Camera, CameraOff, X } from "lucide-react";
import { playScanSuccess } from "../../lib/scanSounds";
import { useDialogAccessibility } from "../../hooks/useDialogAccessibility";

interface Props {
  /** Called with the decoded string on successful scan */
  onScan: (code: string) => void;
  /** Called when the user closes the scanner */
  onClose: () => void;
  /** Optional label displayed in the UI */
  label?: string;
}

const SCANNER_ELEMENT_ID = "ros-camera-scanner-region";

export default function CameraScanner({ onScan, onClose, label }: Props) {
  const scannerRef = useRef<Html5Qrcode | null>(null);
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCode, setLastCode] = useState<string | null>(null);
  const lastCodeRef = useRef<string | null>(null);
  const lastCodeResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onScanRef = useRef(onScan);
  const mountedRef = useRef(false);
  const disposedRef = useRef(false);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  const releaseScanner = useCallback(async (scanner: Html5Qrcode) => {
    try {
      if (scanner.isScanning) await scanner.stop();
    } catch {
      // A start/stop race can report that the camera is not running.
    }
    try {
      scanner.clear();
    } catch {
      // The scan region may already have unmounted.
    }
  }, []);

  const stopCamera = useCallback(async () => {
    const scanner = scannerRef.current;
    scannerRef.current = null;
    if (scanner) await releaseScanner(scanner);
    if (mountedRef.current) setStarted(false);
  }, [releaseScanner]);

  const startCamera = useCallback(async () => {
    await stopCamera();
    if (disposedRef.current) return;
    setError(null);
    const scanner = new Html5Qrcode(SCANNER_ELEMENT_ID, { verbose: false });
    scannerRef.current = scanner;
    try {

      await scanner.start(
        { facingMode: "environment" }, // rear camera preferred
        {
          fps: 12,
          qrbox: { width: 250, height: 180 },
        },
        (decodedText) => {
          // Debounce: ignore repeat scans of the same code within 800ms
          if (decodedText === lastCodeRef.current) return;
          lastCodeRef.current = decodedText;
          if (lastCodeResetRef.current) {
            clearTimeout(lastCodeResetRef.current);
          }
          lastCodeResetRef.current = setTimeout(() => {
            if (lastCodeRef.current === decodedText) {
              lastCodeRef.current = null;
            }
          }, 800);

          playScanSuccess();
          setLastCode(decodedText);
          onScanRef.current(decodedText);
        },
        () => {
          // Frame decode failure — expected, not an error
        },
      );
      if (disposedRef.current || scannerRef.current !== scanner) {
        if (scannerRef.current === scanner) scannerRef.current = null;
        await releaseScanner(scanner);
        return;
      }
      if (mountedRef.current) setStarted(true);
    } catch (err) {
      if (scannerRef.current === scanner) scannerRef.current = null;
      await releaseScanner(scanner);
      if (!mountedRef.current || disposedRef.current) return;
      const msg =
        err instanceof Error ? err.message : "Could not access camera";
      setError(
        msg.includes("Permission")
          ? "Camera permission denied. Please allow camera access in your browser settings."
          : `Camera error: ${msg}`,
      );
    }
  }, [releaseScanner, stopCamera]);

  // Start on mount, stop on unmount
  useEffect(() => {
    mountedRef.current = true;
    disposedRef.current = false;
    void startCamera();
    return () => {
      mountedRef.current = false;
      disposedRef.current = true;
      if (lastCodeResetRef.current) clearTimeout(lastCodeResetRef.current);
      void stopCamera();
    };
  }, [startCamera, stopCamera]);

  const handleClose = useCallback(async () => {
    await stopCamera();
    onClose();
  }, [onClose, stopCamera]);

  const { dialogRef, titleId } = useDialogAccessibility(true, {
    onEscape: () => void handleClose(),
  });

  const root = document.getElementById("drawer-root");
  if (!root) return null;

  return createPortal(
    // Full-screen on mobile, floating modal on md+
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm md:inset-auto md:bottom-6 md:right-6 md:w-[380px] md:rounded-3xl md:shadow-2xl"
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <div className="flex w-full flex-col overflow-hidden bg-app-text text-white md:rounded-3xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div className="flex items-center gap-3">
            <div
              className={`flex h-8 w-8 items-center justify-center rounded-full ${
                started ? "bg-emerald-500/20" : "bg-app-surface/15"
              }`}
            >
              {started ? (
                <Camera size={16} className="text-emerald-400" />
              ) : (
                <CameraOff size={16} className="text-white/50" />
              )}
            </div>
            <div>
              <h2
                id={titleId}
                className="text-xs font-black uppercase tracking-widest text-white/45"
              >
                {label ?? "Camera Scanner"}
              </h2>
              <p className="text-[10px] text-white/50">
                {started ? "Scanning…" : "Starting camera…"}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void handleClose()}
            className="rounded-xl border border-white/10 p-2 text-white/50 transition hover:bg-app-surface/10 hover:text-white"
            aria-label="Close scanner"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scan viewport */}
        <div className="relative flex items-center justify-center bg-black">
          {/* html5-qrcode mounts into this div */}
          <div
            id={SCANNER_ELEMENT_ID}
            className="w-full"
            style={{ minHeight: 260 }}
          />

          {/* Corner guides overlay */}
          {started && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <div className="relative h-44 w-64">
                {/* Four corner marks */}
                {(["tl", "tr", "bl", "br"] as const).map((corner) => (
                  <span
                    key={corner}
                    className={`absolute h-6 w-6 ${
                      corner === "tl"
                        ? "left-0 top-0 border-l-2 border-t-2"
                        : corner === "tr"
                          ? "right-0 top-0 border-r-2 border-t-2"
                          : corner === "bl"
                            ? "bottom-0 left-0 border-b-2 border-l-2"
                            : "bottom-0 right-0 border-b-2 border-r-2"
                    } border-emerald-400 rounded-sm`}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="px-5 py-3 border-t border-white/10">
          {error ? (
            <p className="text-xs font-bold text-red-400">{error}</p>
          ) : lastCode ? (
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              <p className="truncate font-mono text-xs text-emerald-300">
                {lastCode}
              </p>
            </div>
          ) : (
            <p className="text-xs text-white/50">
              Hold the camera steady over a barcode or QR code
            </p>
          )}
        </div>

        {/* Retry button if error */}
        {error && (
          <div className="px-5 pb-4">
            <button
              type="button"
              onClick={() => void startCamera()}
              className="w-full rounded-xl bg-black/40 py-2.5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-app-surface/15"
            >
              Retry Camera
            </button>
          </div>
        )}
      </div>
    </div>,
    root
  );
}
