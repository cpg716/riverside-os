import React, { useEffect, useState } from "react";
import Icon from "./Icon";
import { api } from "../lib/api";
import ImportDataModal from "./ImportDataModal";
import UserGuideTab from "./UserGuideTab";
import { useModal } from "../hooks/useModal";

const SettingsModal = ({ isOpen, onClose, onImport }) => {
  const { showAlert } = useModal();
  const [activeTab, setActiveTab] = useState("general");
  const [systemInfo, setSystemInfo] = useState(null);
  const [salespeople, setSalespeople] = useState([]);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const run = async () => {
      try {
        const [sys, team] = await Promise.all([
          api.getSystemInfo(),
          api.getSalespeople(),
        ]);
        setSystemInfo(sys);
        setSalespeople(Array.isArray(team) ? team : []);
      } catch (err) {
        console.error("Failed to load settings data:", err);
      }
    };
    void run();
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-app-text/40 p-4 backdrop-blur-[2px] animate-fade-in">
      <div className="flex h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-lg bg-app-surface shadow-2xl">
        <div className="flex items-center justify-between border-b border-app-border/80 bg-app-surface p-4 text-app-text">
          <h2 className="flex items-center gap-2 text-xl font-extrabold uppercase tracking-tight">
            <Icon name="Settings" className="text-gold-500" /> App Settings
          </h2>
          <button type="button"
            onClick={onClose}
            className="rounded-full p-2 text-app-text-muted transition-colors hover:bg-app-surface-2 hover:text-app-text"
          >
            <Icon name="X" size={24} />
          </button>
        </div>

        <div className="flex shrink-0 border-b border-app-border bg-app-surface-2">
          {["guide", "general", "team"].map((tab) => (
            <button type="button"
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`border-b-2 px-6 py-4 text-xs font-black uppercase tracking-widest transition-all ${
                activeTab === tab
                  ? "border-navy-900 bg-app-surface text-app-text shadow-sm"
                  : "border-transparent text-app-text-muted hover:bg-app-surface-2 hover:text-app-text"
              }`}
            >
              {tab === "guide" ? "User Guide" : tab}
            </button>
          ))}
        </div>

        <div className={`flex-1 overflow-y-auto bg-app-surface-2/50 ${activeTab === "guide" ? "p-0" : "p-6"}`}>
          {activeTab === "guide" && <UserGuideTab />}

          {activeTab === "general" && (
            <div className="space-y-6">
              <div className="rounded-lg border border-app-border bg-app-surface p-6 shadow-sm">
                <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-app-text">
                  <Icon name="Monitor" /> Connectivity
                </h3>
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="rounded border border-app-border bg-app-surface-2 p-4">
                    <div className="text-xs font-bold uppercase text-app-text-muted">Server IP</div>
                    <div className="mt-1 space-y-1">
                      {(systemInfo?.ips || [systemInfo?.ip || "Loading..."]).map((ip, idx) => (
                        <div key={idx} className="flex items-center justify-between gap-2">
                          <code className="text-lg font-bold text-app-text">{ip}</code>
                          <button type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(`http://${ip}:3000`);
                              showAlert(`Link copied: http://${ip}:3000`, "Copied");
                            }}
                            className="rounded border border-app-border bg-app-surface p-1 text-app-text-muted transition-colors hover:text-app-text"
                            title="Copy link"
                          >
                            <Icon name="Copy" size={14} />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded border border-app-border bg-app-surface-2 p-4">
                    <div className="text-xs font-bold uppercase text-app-text-muted">Connected Clients</div>
                    <div className="mt-1 text-xl font-mono text-app-text">{systemInfo?.connectedClients ?? "-"}</div>
                  </div>
                  <div className="rounded border border-app-border bg-app-surface-2 p-4">
                    <div className="text-xs font-bold uppercase text-app-text-muted">Server Uptime</div>
                    <div className="mt-1 text-xl font-mono text-app-text">
                      {systemInfo ? `${Math.floor((systemInfo.uptime || 0) / 60)} min` : "-"}
                    </div>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-app-border bg-app-surface p-6 shadow-sm">
                <h3 className="mb-4 flex items-center gap-2 text-lg font-bold text-app-text">
                  <Icon name="Upload" /> Data Import
                </h3>
                <p className="mb-4 text-sm text-app-text">
                  Import wedding parties and members into ROS.
                </p>
                <button type="button"
                  onClick={() => setIsImportModalOpen(true)}
                  className="flex items-center gap-2 rounded bg-navy-900 px-4 py-2 text-sm font-bold text-white transition-colors hover:bg-navy-800"
                >
                  <Icon name="Upload" size={16} /> Open Import Tool
                </button>
              </div>
            </div>
          )}

          {activeTab === "team" && (
            <div className="rounded-lg border border-app-border bg-app-surface p-6 shadow-sm">
              <h3 className="mb-2 flex items-center gap-2 text-lg font-bold text-app-text">
                <Icon name="User" /> Salespeople (ROS SSOT)
              </h3>
              <p className="mb-4 text-sm text-app-text-muted">
                Team records are managed in ROS. This list is read-only in Wedding Manager.
              </p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3">
                {salespeople.map((sp) => (
                  <div
                    key={sp}
                    className="rounded border border-app-border bg-app-surface-2 p-3 font-bold text-app-text"
                  >
                    {sp}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <ImportDataModal
        isOpen={isImportModalOpen}
        onClose={() => setIsImportModalOpen(false)}
        onImport={onImport}
      />
    </div>
  );
};

export default SettingsModal;
