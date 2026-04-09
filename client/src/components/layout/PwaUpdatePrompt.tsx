import { useRegisterSW } from "virtual:pwa-register/react";

/**
 * Shown after a production deploy when a new service worker is waiting.
 * Staff choose when to reload so the PWA shell matches the server bundle.
 */
function PwaUpdatePromptInner() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!needRefresh) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 z-[200] flex max-w-lg -translate-x-1/2 flex-col gap-3 rounded-2xl border border-app-border bg-app-surface px-4 py-3 shadow-xl sm:flex-row sm:items-center sm:justify-between"
      role="status"
    >
      <p className="text-sm font-semibold text-app-text">
        A new version of Riverside is ready. Reload to finish updating.
      </p>
      <div className="flex shrink-0 gap-2">
        <button
          type="button"
          className="ui-btn-secondary h-9 px-4 text-xs font-bold uppercase tracking-wide"
          onClick={() => setNeedRefresh(false)}
        >
          Later
        </button>
        <button
          type="button"
          className="h-9 rounded-xl bg-emerald-600 px-4 text-xs font-bold uppercase tracking-wide text-white shadow border-b-4 border-emerald-800 hover:bg-emerald-500"
          onClick={() => void updateServiceWorker(true)}
        >
          Reload now
        </button>
      </div>
    </div>
  );
}

export default function PwaUpdatePrompt() {
  if (!import.meta.env.PROD) return null;
  return <PwaUpdatePromptInner />;
}
