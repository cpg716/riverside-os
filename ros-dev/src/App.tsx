import { useState, useEffect } from "react";
import { LogIn } from "lucide-react";
import { getStaffCode, setServerConfig, getServerUrl } from "./lib/api";
import DevOpsDashboard from "./components/DevOpsDashboard";

function LoginScreen({ onLogin }: { onLogin: () => void }) {
  const [url, setUrl] = useState(getServerUrl());
  const [code, setCode] = useState(getStaffCode());
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setChecking(true);
    try {
      setServerConfig({ url, staffCode: code });
      const res = await fetch(`${url.replace(/\/$/, "")}/api/ops/overview`, {
        headers: { "x-riverside-staff-code": code },
      });
      if (!res.ok) throw new Error("Invalid credentials or server unreachable");
      onLogin();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Connection failed");
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md ui-card p-8">
        <div className="mb-6 flex items-center gap-3">
          <img src="/logo1.png" alt="Riverside" className="h-10 w-10" />
          <div>
            <h1 className="text-lg font-black tracking-wide">ROS Dev Center</h1>
            <p className="text-xs text-app-text-muted">Standalone DevOps Manager</p>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-app-text-muted">
              Server URL
            </label>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://localhost:3000"
              className="ui-input"
              required
            />
            <p className="mt-1 text-[10px] text-app-text-muted">
              Local: http://localhost:3000 · Tailscale: http://riverside-server:3000
            </p>
          </div>

          <div>
            <label className="mb-1 block text-xs font-bold uppercase tracking-wider text-app-text-muted">
              Staff PIN
            </label>
            <input
              type="password"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Your staff PIN"
              className="ui-input"
              required
            />
          </div>

          {error && (
            <p className="rounded-lg bg-app-danger/12 px-3 py-2 text-xs text-app-danger">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={checking}
            className="ui-btn ui-btn-primary w-full justify-center gap-2"
          >
            <LogIn className="h-4 w-4" />
            {checking ? "Connecting..." : "Connect"}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    if (getStaffCode()) {
      setLoggedIn(true);
    }
  }, []);

  if (!loggedIn) {
    return <LoginScreen onLogin={() => setLoggedIn(true)} />;
  }

  return <DevOpsDashboard />;
}
