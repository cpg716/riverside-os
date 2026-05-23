import { useState, useEffect, useRef, useCallback } from 'react';
import { Settings, Server, Play, CheckCircle, ChevronRight, Terminal, Cpu, Wrench, RefreshCw, Trash2, Key, Power, RotateCw, FolderOpen, SearchCheck, Database, ArrowDownToLine, Link, Download, Monitor, Square, AlertTriangle, Activity, HardDrive, XCircle } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface LogMessage {
  level: string;
  text: string;
}

interface PgStatus {
  service_status: string;
  service_name: string;
  connectable: boolean;
  version: string;
  db_exists: boolean;
  db_size: string;
  psql_found: boolean;
  migration_count?: string;
  table_count?: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'wizard' | 'maintenance'>('maintenance');
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<'main-hub' | 'standalone-backoffice' | 'standalone-register'>('main-hub');

  const [isElevated, setIsElevated] = useState<boolean | null>(null);

  // Config state
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [config, setConfig] = useState<any>({});
  const [serverIp, setServerIp] = useState('127.0.0.1');
  const [dbPassword, setDbPassword] = useState('');

  // Execution state
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // PostgreSQL status
  const [pgStatus, setPgStatus] = useState<PgStatus | null>(null);
  const [pgLoading, setPgLoading] = useState(false);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const refreshPgStatus = useCallback(async () => {
    setPgLoading(true);
    try {
      const result = await invoke<PgStatus>('get_postgres_status');
      setPgStatus(result);
    } catch {
      setPgStatus(null);
    } finally {
      setPgLoading(false);
    }
  }, []);

  // Load config on mount
  useEffect(() => {
    invoke<string>('read_deployment_config').then((json) => {
      try {
        const parsed = JSON.parse(json);
        setConfig(parsed);
        if (parsed?.server?.database?.adminPassword) {
          setDbPassword(parsed.server.database.adminPassword);
        }
      } catch (e) {
        console.error("Failed to parse config:", e);
      }
    });

    invoke<boolean>('is_elevated')
      .then((res) => setIsElevated(res))
      .catch(() => setIsElevated(true));

    refreshPgStatus();
  }, [refreshPgStatus]);

  const handleContinueToExec = async () => {
    const newConfig = { ...config };
    if (!newConfig.server) newConfig.server = {};
    if (!newConfig.server.database) newConfig.server.database = {};
    if (!newConfig.server.installRoot) newConfig.server.installRoot = 'C:\\RiversideOS';
    if (!newConfig.server.httpBind) newConfig.server.httpBind = '0.0.0.0:3000';
    if (!newConfig.server.firewallRuleName) newConfig.server.firewallRuleName = 'Riverside OS Server';
    if (!newConfig.server.corsOrigins || !newConfig.server.corsOrigins.length) {
      newConfig.server.corsOrigins = ['http://tauri.localhost', 'https://tauri.localhost'];
    }
    if (!newConfig.server.environment) {
      newConfig.server.environment = {
        RIVERSIDE_BACKUP_DIR: 'C:\\RiversideOS\\backups',
        RIVERSIDE_REPO_ROOT: 'C:\\RiversideOS\\release',
      };
    }
    newConfig.server.database.adminPassword = dbPassword;
    if (!newConfig.server.database.host) newConfig.server.database.host = serverIp;
    if (!newConfig.server.database.port) newConfig.server.database.port = 5432;
    if (!newConfig.server.database.databaseName) newConfig.server.database.databaseName = 'riverside_os';
    if (!newConfig.server.database.appUser) newConfig.server.database.appUser = 'riverside_app';
    if (!newConfig.server.database.adminUser) newConfig.server.database.adminUser = 'postgres';
    if (!newConfig.server.database.psqlPath) newConfig.server.database.psqlPath = '';

    await invoke('write_deployment_config', { config: JSON.stringify(newConfig) });
    setStep(3);
    if (role === 'main-hub') {
      executeScript('install-server.ps1');
    } else if (role === 'standalone-backoffice') {
      executeScript('install-register.ps1', ['-StationMode', 'backoffice']);
    } else {
      executeScript('install-register.ps1', ['-StationMode', 'register1']);
    }
  };

  const requireElevation = (actionLabel: string): boolean => {
    if (isElevated !== false) return true;
    setLogs([{
      level: 'error',
      text: `${actionLabel} requires Administrator privileges. Use "Relaunch as Administrator" above, or run Start-RiversideDeployment.cmd.`,
    }]);
    return false;
  };

  const executeScript = async (scriptName: string, args?: string[], options?: { requireAdmin?: boolean }) => {
    if (isExecuting) return;
    if (options?.requireAdmin !== false && !requireElevation(`Running ${scriptName}`)) return;
    setIsExecuting(true);
    setLogs([{ level: 'info', text: `Executing ${scriptName}${args ? ' ' + args.join(' ') : ''}...` }]);

    const unlisten = await listen<LogMessage>('deployment-log', (event) => {
      setLogs(prev => [...prev, event.payload]);
    });

    try {
      await invoke('run_deployment_script', { scriptName, args });

      // For a full Server install/update (run from the wizard), run the full sequence
      // matching the old Start-RiversideDeployment.ps1 Invoke-SelectedLifecycleAction:
      //   1. install-server.ps1  ← done above
      //   2. repair-bootstrap-admin.ps1
      //   3. install-register.ps1  (installs the BO desktop Tauri app on this PC)
      if (scriptName === 'install-server.ps1' && step === 3) {
        setLogs(prev => [...prev, { level: 'info', text: 'Verifying bootstrap admin account...' }]);
        await invoke('run_deployment_script', { scriptName: 'repair-bootstrap-admin.ps1', args: undefined });
        setLogs(prev => [...prev, { level: 'info', text: 'Installing Backoffice desktop app...' }]);
        await invoke('run_deployment_script', { scriptName: 'install-register.ps1', args: undefined });
      }
    } catch (e) {
      setLogs(prev => [...prev, { level: 'error', text: `Failed: ${e}` }]);
    } finally {
      setIsExecuting(false);
      unlisten();
    }
  };

  // Full server update sequence matching old PS manager:
  // install-server.ps1 → repair-bootstrap-admin.ps1 → install-register.ps1
  const executeServerUpdate = async () => {
    if (isExecuting) return;
    if (!requireElevation('Update This Server PC')) return;
    setIsExecuting(true);
    setLogs([{ level: 'info', text: 'Updating Backoffice / Server PC...' }]);

    const unlisten = await listen<LogMessage>('deployment-log', (event) => {
      setLogs(prev => [...prev, event.payload]);
    });

    try {
      setLogs(prev => [...prev, { level: 'info', text: 'Executing install-server.ps1...' }]);
      await invoke('run_deployment_script', { scriptName: 'install-server.ps1', args: undefined });
      setLogs(prev => [...prev, { level: 'info', text: 'Verifying bootstrap admin account...' }]);
      await invoke('run_deployment_script', { scriptName: 'repair-bootstrap-admin.ps1', args: undefined });
      setLogs(prev => [...prev, { level: 'info', text: 'Updating Backoffice desktop app...' }]);
      await invoke('run_deployment_script', { scriptName: 'install-register.ps1', args: undefined });
      setLogs(prev => [...prev, { level: 'success', text: 'Server update complete.' }]);
    } catch (e) {
      setLogs(prev => [...prev, { level: 'error', text: `Failed: ${e}` }]);
    } finally {
      setIsExecuting(false);
      unlisten();
    }
  };

  // Workstation repair matching old PS manager:
  // install-register.ps1 -SkipAppInstall -NoLaunch
  const executeWorkstationRepair = async () => {
    if (isExecuting) return;
    if (!requireElevation('Repair Workstation')) return;
    setIsExecuting(true);
    setLogs([{ level: 'info', text: 'Repairing workstation settings...' }]);

    const unlisten = await listen<LogMessage>('deployment-log', (event) => {
      setLogs(prev => [...prev, event.payload]);
    });

    try {
      await invoke('run_deployment_script', { scriptName: 'install-register.ps1', args: ['-SkipAppInstall', '-NoLaunch'] });
      setLogs(prev => [...prev, { level: 'success', text: 'Workstation settings repair complete.' }]);
    } catch (e) {
      setLogs(prev => [...prev, { level: 'error', text: `Failed: ${e}` }]);
    } finally {
      setIsExecuting(false);
      unlisten();
    }
  };


  const executeInline = async (command: string, description: string) => {
    if (isExecuting) return;
    if (!requireElevation(description)) return;
    setIsExecuting(true);
    setLogs([{ level: 'info', text: `Executing: ${description}...` }]);

    const unlisten = await listen<LogMessage>('deployment-log', (event) => {
      setLogs(prev => [...prev, event.payload]);
    });

    try {
      await invoke('run_inline_powershell', { scriptContent: command });
    } catch (e) {
      setLogs(prev => [...prev, { level: 'error', text: `Failed: ${e}` }]);
    } finally {
      setIsExecuting(false);
      unlisten();
    }
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-12 px-4">
      {/* Header & Tabs */}
      <div className="w-full max-w-4xl flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div className="w-12 h-12 bg-brand-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-brand-500/20">
            <Server className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Riverside OS Deployment</h1>
            <p className="text-zinc-500 text-sm font-medium">Install or update this station</p>
          </div>
        </div>
        <div className="flex bg-zinc-200 p-1 rounded-lg">
          <button
            onClick={() => setActiveTab('wizard')}
            className={`px-4 py-2 text-sm font-semibold rounded-md transition-all ${activeTab === 'wizard' ? 'bg-white shadow-sm text-brand-700' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            Installation Wizard
          </button>
          <button
            onClick={() => setActiveTab('maintenance')}
            className={`px-4 py-2 text-sm font-semibold rounded-md transition-all ${activeTab === 'maintenance' ? 'bg-white shadow-sm text-brand-700' : 'text-zinc-500 hover:text-zinc-700'}`}
          >
            Maintenance & Repair
          </button>
        </div>
      </div>

      {isElevated === false && (
        <div className="w-full max-w-4xl mb-6 p-4 bg-amber-50 border-l-4 border-amber-500 rounded-r-xl shadow-sm flex items-start gap-3">
          <div className="w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center text-amber-700 font-bold mt-0.5 text-xs">!</div>
          <div className="flex-1">
            <h4 className="text-sm font-bold text-amber-800">Not Running as Administrator</h4>
            <p className="text-xs text-amber-700 mt-1">
              Install, migrations, server start/restart, and audit require elevation. Launch via <strong>Start-RiversideDeployment.cmd</strong> (recommended) or relaunch this app as Administrator.
            </p>
            <button
              type="button"
              onClick={() => invoke('relaunch_elevated').catch((e) => setLogs([{ level: 'error', text: String(e) }]))}
              className="mt-3 px-3 py-1.5 text-xs font-semibold rounded-md bg-amber-600 text-white hover:bg-amber-700"
            >
              Relaunch as Administrator
            </button>
          </div>
        </div>
      )}

      {activeTab === 'wizard' ? (
        /* WIZARD TAB */
        <div className="w-full max-w-4xl grid grid-cols-12 gap-8">
          {/* Sidebar steps */}
          <div className="col-span-4 space-y-2">
            {[
              { num: 1, title: 'Station Role', desc: 'Choose server or register', icon: Server },
              { num: 2, title: 'Configuration', desc: 'Network and database', icon: Settings },
              { num: 3, title: 'Execution', desc: 'Apply changes', icon: Play },
              { num: 4, title: 'Complete', desc: 'Ready to run', icon: CheckCircle },
            ].map((s) => {
              const active = step === s.num;
              const past = step > s.num;
              return (
                <div
                  key={s.num}
                  className={`p-4 rounded-xl border transition-all ${active ? 'bg-white border-brand-500 shadow-sm' : past ? 'bg-transparent border-transparent opacity-60' : 'bg-transparent border-transparent opacity-40'}`}
                >
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold ${active ? 'bg-brand-100 text-brand-700' : past ? 'bg-zinc-200 text-zinc-700' : 'bg-zinc-100 text-zinc-400'}`}>
                      {past ? <CheckCircle className="w-4 h-4" /> : s.num}
                    </div>
                    <div>
                      <h3 className={`font-semibold text-sm ${active ? 'text-zinc-900' : 'text-zinc-600'}`}>{s.title}</h3>
                      <p className="text-xs text-zinc-500">{s.desc}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Workspace */}
          <div className="col-span-8 glass-panel p-8 min-h-[500px] flex flex-col">
            {step === 1 && (
              <div className="flex-1">
                <h2 className="text-xl font-bold mb-6">What is the role of this PC?</h2>
                <div className="space-y-4">
                  <button
                    onClick={() => setRole('main-hub')}
                    className={`w-full text-left p-6 rounded-xl border-2 transition-all ${role === 'main-hub' ? 'border-brand-500 bg-brand-50' : 'border-zinc-200 hover:border-zinc-300'}`}
                  >
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <Server className="w-5 h-5" /> Main Hub (Backoffice / Server)
                    </h3>
                    <p className="text-zinc-500 text-sm mt-1">The ONE server PC per store. Installs PostgreSQL, API server, ROSIE AI, and the Backoffice desktop app.</p>
                  </button>
                  <button
                    onClick={() => setRole('standalone-backoffice')}
                    className={`w-full text-left p-6 rounded-xl border-2 transition-all ${role === 'standalone-backoffice' ? 'border-brand-500 bg-brand-50' : 'border-zinc-200 hover:border-zinc-300'}`}
                  >
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <Monitor className="w-5 h-5" /> Standalone App — Back Office
                    </h3>
                    <p className="text-zinc-500 text-sm mt-1">Just the desktop Back Office app. Connects to the Main Hub server over the network. No server or database.</p>
                  </button>
                  <button
                    onClick={() => setRole('standalone-register')}
                    className={`w-full text-left p-6 rounded-xl border-2 transition-all ${role === 'standalone-register' ? 'border-brand-500 bg-brand-50' : 'border-zinc-200 hover:border-zinc-300'}`}
                  >
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <Settings className="w-5 h-5" /> Standalone App — Register #1
                    </h3>
                    <p className="text-zinc-500 text-sm mt-1">Just the desktop POS app. Connects to the Main Hub server over the network. No server or database.</p>
                  </button>
                </div>
              </div>
            )}

            {step === 2 && (
              <div className="flex-1">
                <h2 className="text-xl font-bold mb-6">Network & Database Configuration</h2>
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-semibold text-zinc-700 mb-1">Server IP Address</label>
                    <input
                      type="text"
                      value={serverIp}
                      onChange={(e) => setServerIp(e.target.value)}
                      className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 outline-none"
                    />
                  </div>
                  {role === 'main-hub' && (
                    <div>
                      <label className="block text-sm font-semibold text-zinc-700 mb-1">PostgreSQL Admin Password</label>
                      <input
                        type="password"
                        value={dbPassword}
                        onChange={(e) => setDbPassword(e.target.value)}
                        placeholder="Leave blank to auto-generate"
                        className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 outline-none"
                      />
                    </div>
                  )}
                </div>
              </div>
            )}

            {step === 3 && (
              <div className="flex-1 flex flex-col">
                <h2 className="text-xl font-bold mb-6">Installing Updates...</h2>
                <div className="flex-1 bg-zinc-900 rounded-xl p-4 font-mono text-sm text-zinc-300 overflow-y-auto max-h-[350px]">
                  <div className="flex items-center gap-2 mb-2 text-zinc-500">
                    <Terminal className="w-4 h-4" /> Live Execution Logs
                  </div>
                  <div className="space-y-1 pb-4">
                    {logs.map((log, i) => (
                      <p key={i} className={`whitespace-pre-wrap ${
                        log.level === 'error' ? 'text-red-400' :
                        log.level === 'success' ? 'text-green-400' :
                        'text-zinc-300'
                      }`}>
                        {log.text}
                      </p>
                    ))}
                    {isExecuting && <p className="text-brand-400 animate-pulse">_</p>}
                    <div ref={logsEndRef} />
                  </div>
                </div>
              </div>
            )}

            {step === 4 && (
              <div className="flex-1 flex flex-col items-center justify-center text-center">
                <div className="w-20 h-20 bg-green-100 text-green-600 rounded-full flex items-center justify-center mb-6">
                  <CheckCircle className="w-10 h-10" />
                </div>
                <h2 className="text-2xl font-bold mb-2">Deployment Complete!</h2>
                <p className="text-zinc-500 max-w-md">The Riverside OS {role} has been successfully installed and configured. You may now close this window.</p>
              </div>
            )}

            <div className="mt-8 pt-6 border-t flex justify-end">
              {step === 1 && (
                <button onClick={() => setStep(2)} className="px-6 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 flex items-center gap-2 shadow-sm">
                  Continue <ChevronRight className="w-4 h-4" />
                </button>
              )}
              {step === 2 && (
                <button onClick={handleContinueToExec} className="px-6 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 flex items-center gap-2 shadow-sm">
                  Apply & Install <ChevronRight className="w-4 h-4" />
                </button>
              )}
              {step === 3 && !isExecuting && (
                <button onClick={() => setStep(4)} className="px-6 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 flex items-center gap-2 shadow-sm">
                  Finish <ChevronRight className="w-4 h-4" />
                </button>
              )}
              {step === 4 && (
                <button onClick={() => window.close()} className="px-6 py-2.5 bg-zinc-200 text-zinc-800 font-semibold rounded-lg hover:bg-zinc-300 flex items-center gap-2">
                  Close
                </button>
              )}
            </div>
          </div>
        </div>
      ) : (
        /* MAINTENANCE TAB */
        <div className="w-full max-w-5xl glass-panel p-8 grid grid-cols-12 gap-8">
          <div className="col-span-5 space-y-4 border-r pr-8 max-h-[700px] overflow-y-auto">
            {/* Quick Update Actions */}
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900">
              <Download className="w-5 h-5 text-brand-600" /> Quick Update
            </h2>
            <button
              onClick={() => executeServerUpdate()}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border-2 border-brand-500 bg-brand-50 hover:bg-brand-100 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm flex items-center gap-2"><Server className="w-4 h-4" /> Update This Server PC</h3>
                <p className="text-xs text-zinc-500 mt-1">Copies new server binary, client files, runs migrations, and restarts the service.</p>
              </div>
              <Play className="w-4 h-4 text-brand-500" />
            </button>
            <button
              onClick={() => executeScript('install-register.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm flex items-center gap-2"><Monitor className="w-4 h-4" /> Update Register / Workstation</h3>
                <p className="text-xs text-zinc-500 mt-1">Installs or updates the desktop POS app on this PC.</p>
              </div>
              <Play className="w-4 h-4 text-zinc-400 group-hover:text-brand-500" />
            </button>
            <button
              onClick={() => executeWorkstationRepair()}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-amber-500 hover:bg-amber-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm flex items-center gap-2"><Wrench className="w-4 h-4" /> Repair Workstation Settings</h3>
                <p className="text-xs text-zinc-500 mt-1">Re-applies station config without reinstalling the app (SkipAppInstall).</p>
              </div>
              <Wrench className="w-4 h-4 text-zinc-400 group-hover:text-amber-500" />
            </button>

            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900 mt-6 border-t pt-6">
              <Power className="w-5 h-5 text-brand-600" /> Server Control
            </h2>
            <div className="grid grid-cols-3 gap-2 mb-6">
              <button
                onClick={() => executeInline('Start-ScheduledTask -TaskName "Riverside OS Server"', 'Start Server')}
                disabled={isExecuting}
                className="p-3 rounded-lg border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1 group"
              >
                <Power className="w-5 h-5 text-zinc-400 group-hover:text-brand-500" />
                <span className="text-xs font-semibold">Start</span>
              </button>
              <button
                onClick={() => executeInline('Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue; Stop-Process -Name "riverside-server" -Force -ErrorAction SilentlyContinue', 'Stop Server')}
                disabled={isExecuting}
                className="p-3 rounded-lg border border-zinc-200 hover:border-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1 group"
              >
                <Square className="w-5 h-5 text-zinc-400 group-hover:text-red-500" />
                <span className="text-xs font-semibold">Stop</span>
              </button>
              <button
                onClick={() => executeInline('Stop-ScheduledTask -TaskName "Riverside OS Server" -ErrorAction SilentlyContinue; Stop-Process -Name "riverside-server" -Force -ErrorAction SilentlyContinue; Start-ScheduledTask -TaskName "Riverside OS Server"', 'Restart Server')}
                disabled={isExecuting}
                className="p-3 rounded-lg border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1 group"
              >
                <RotateCw className="w-5 h-5 text-zinc-400 group-hover:text-brand-500" />
                <span className="text-xs font-semibold">Restart</span>
              </button>
              <button
                onClick={() => invoke('open_logs')}
                className="p-3 rounded-lg border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all flex flex-col items-center justify-center gap-1 group"
              >
                <FolderOpen className="w-5 h-5 text-zinc-400 group-hover:text-brand-500" />
                <span className="text-xs font-semibold">Logs</span>
              </button>
              <button
                onClick={() => executeScript('audit-system.ps1', undefined, { requireAdmin: true })}
                disabled={isExecuting}
                className="p-3 rounded-lg border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1 group"
              >
                <SearchCheck className="w-5 h-5 text-zinc-400 group-hover:text-brand-500" />
                <span className="text-xs font-semibold">Audit</span>
              </button>
            </div>

            {/* ---- PostgreSQL Status Panel ---- */}
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900 mt-6 border-t pt-6">
              <Activity className="w-5 h-5 text-brand-600" /> PostgreSQL Status
            </h2>
            <div className="p-4 rounded-xl border border-zinc-200 bg-white space-y-3 mb-4">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Database Health</span>
                <button
                  onClick={refreshPgStatus}
                  disabled={pgLoading}
                  className="text-xs text-brand-600 hover:text-brand-700 font-semibold flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw className={`w-3 h-3 ${pgLoading ? 'animate-spin' : ''}`} /> Refresh
                </button>
              </div>
              {pgStatus === null ? (
                <p className="text-xs text-zinc-400 italic">Loading...</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <HardDrive className="w-3.5 h-3.5 text-zinc-400" />
                      <span className="text-zinc-500">Service:</span>
                      <span className={`font-bold ${
                        pgStatus.service_status === 'running' ? 'text-green-600' :
                        pgStatus.service_status === 'stopped' ? 'text-red-500' :
                        pgStatus.service_status === 'not_found' ? 'text-zinc-400' :
                        'text-amber-500'
                      }`}>
                        {pgStatus.service_status === 'not_found' ? 'Not Found' : pgStatus.service_status}
                        {pgStatus.service_name ? ` (${pgStatus.service_name})` : ''}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {pgStatus.connectable ? (
                        <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                      ) : (
                        <XCircle className="w-3.5 h-3.5 text-red-500" />
                      )}
                      <span className="text-zinc-500">Connection:</span>
                      <span className={`font-bold ${pgStatus.connectable ? 'text-green-600' : 'text-red-500'}`}>
                        {pgStatus.connectable ? 'OK' : 'Failed'}
                      </span>
                    </div>
                    {pgStatus.version && (
                      <div className="col-span-2 flex items-center gap-2 truncate" title={pgStatus.version}>
                        <Database className="w-3.5 h-3.5 text-zinc-400 shrink-0" />
                        <span className="text-zinc-500 shrink-0">Version:</span>
                        <span className="font-mono text-zinc-700 truncate">{pgStatus.version.split(',')[0]}</span>
                      </div>
                    )}
                    {pgStatus.db_exists && (
                      <>
                        <div className="flex items-center gap-2">
                          <span className="text-zinc-500 ml-5">DB Size:</span>
                          <span className="font-bold text-zinc-700">{pgStatus.db_size || '—'}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-zinc-500">Tables:</span>
                          <span className="font-bold text-zinc-700">{pgStatus.table_count ?? '—'}</span>
                          <span className="text-zinc-400 mx-1">|</span>
                          <span className="text-zinc-500">Migrations:</span>
                          <span className="font-bold text-zinc-700">{pgStatus.migration_count ?? '—'}</span>
                        </div>
                      </>
                    )}
                    {!pgStatus.db_exists && pgStatus.connectable && (
                      <div className="col-span-2 flex items-center gap-2 text-amber-600">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="font-semibold">Database 'riverside_os' does not exist — run Install or Start Fresh.</span>
                      </div>
                    )}
                    {!pgStatus.psql_found && (
                      <div className="col-span-2 flex items-center gap-2 text-amber-600">
                        <AlertTriangle className="w-3.5 h-3.5" />
                        <span className="font-semibold">psql.exe not found — install PostgreSQL or set psqlPath in config.</span>
                      </div>
                    )}
                  </div>
                  {/* PG Service control buttons */}
                  {pgStatus.service_name && (
                    <div className="flex gap-2 pt-2 border-t border-zinc-100">
                      <button
                        onClick={() => { executeInline(`Start-Service -Name '${pgStatus.service_name}'`, 'Start PostgreSQL'); setTimeout(refreshPgStatus, 3000); }}
                        disabled={isExecuting || pgStatus.service_status === 'running'}
                        className="flex-1 text-xs font-semibold py-1.5 rounded-md border border-zinc-200 hover:border-green-500 hover:bg-green-50 disabled:opacity-40 transition-all"
                      >
                        Start PG
                      </button>
                      <button
                        onClick={() => { executeInline(`Restart-Service -Name '${pgStatus.service_name}' -Force`, 'Restart PostgreSQL'); setTimeout(refreshPgStatus, 5000); }}
                        disabled={isExecuting}
                        className="flex-1 text-xs font-semibold py-1.5 rounded-md border border-zinc-200 hover:border-amber-500 hover:bg-amber-50 disabled:opacity-40 transition-all"
                      >
                        Restart PG
                      </button>
                      <button
                        onClick={() => { executeInline(`Stop-Service -Name '${pgStatus.service_name}' -Force`, 'Stop PostgreSQL'); setTimeout(refreshPgStatus, 3000); }}
                        disabled={isExecuting || pgStatus.service_status === 'stopped'}
                        className="flex-1 text-xs font-semibold py-1.5 rounded-md border border-zinc-200 hover:border-red-500 hover:bg-red-50 disabled:opacity-40 transition-all"
                      >
                        Stop PG
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900 mt-2">
              <Database className="w-5 h-5 text-brand-600" /> Database & Migrations
            </h2>
            <button
              onClick={() => executeScript('apply-riverside-migrations.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Apply Migrations</h3>
                <p className="text-xs text-zinc-500 mt-1">Runs any pending PostgreSQL schema updates safely.</p>
              </div>
              <Play className="w-4 h-4 text-zinc-400 group-hover:text-brand-500" />
            </button>
             <button
              onClick={() => executeInline('$psql = Get-Command psql.exe -ErrorAction SilentlyContinue; $psqlPath = if ($psql) { $psql.Source } else { \'psql.exe\' }; if (Test-Path \'seeds\') { & $psqlPath -U postgres -d riverside_os -f \'seeds/seed_core_required.sql\'; & $psqlPath -U postgres -d riverside_os -f \'seeds/seed_rbac.sql\'; Write-Host \'Database seeded successfully.\' } else { Write-Host \'No seeds directory found.\' }', 'Seed Database')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Seed Database</h3>
                <p className="text-xs text-zinc-500 mt-1">Injects initial test or production baseline data.</p>
              </div>
              <ArrowDownToLine className="w-4 h-4 text-zinc-400 group-hover:text-brand-500" />
            </button>
            <button
              onClick={() => {
                if(confirm('Are you sure you want to completely START FRESH? This will clear the DB, seed the proper start data, and set it up like new. This cannot be undone.')) {
                  executeScript('reset-riverside-database.ps1', ['-StartFresh']);
                }
              }}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm text-red-600">Start Fresh (Factory Reset)</h3>
                <p className="text-xs text-red-400/80 mt-1">Clears the DB, runs migrations, seeds core data, and sets it up like new.</p>
              </div>
              <Trash2 className="w-4 h-4 text-zinc-400 group-hover:text-red-500" />
            </button>

            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900 mt-6 border-t pt-6">
              <Cpu className="w-5 h-5 text-brand-600" /> Utility Scripts
            </h2>
            <button
              onClick={() => {
                if (confirm('This will stop the database, force a password reset, and start it again. Your new password will be auto-saved to the config file. Proceed?')) {
                  executeScript('reset-postgres-password.ps1');
                }
              }}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm text-red-600">Reset Postgres Admin Password</h3>
                <p className="text-xs text-red-400 mt-1">Forces a database password reset if you forgot it.</p>
              </div>
              <Key className="w-4 h-4 text-zinc-400 group-hover:text-red-500" />
            </button>
            <button
              onClick={() => executeScript('Install-RosieAiStack.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Force ROSIE AI Update</h3>
                <p className="text-xs text-zinc-500 mt-1">Re-downloads Gemma LLM and updates Voice dependencies.</p>
              </div>
              <Play className="w-4 h-4 text-zinc-400 group-hover:text-brand-500" />
            </button>
            <button
              onClick={() => executeScript('start-riverside-llama.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Start ROSIE LLM Host</h3>
                <p className="text-xs text-zinc-500 mt-1">Registers and starts llama-server on port 8080 for in-store chat.</p>
              </div>
              <Play className="w-4 h-4 text-zinc-400 group-hover:text-brand-500" />
            </button>
            <button
              onClick={() => executeScript('set-counterpoint-bridge-token.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-amber-500 hover:bg-amber-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Sync Counterpoint Bridge</h3>
                <p className="text-xs text-zinc-500 mt-1">Regenerate and map the CP Bridge sync tokens.</p>
              </div>
              <Link className="w-4 h-4 text-zinc-400 group-hover:text-amber-500" />
            </button>
            <button
              onClick={() => executeScript('repair-server-credentials-key.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-amber-500 hover:bg-amber-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Repair Server Credentials</h3>
                <p className="text-xs text-zinc-500 mt-1">Regenerate and sync missing JWT signing keys.</p>
              </div>
              <Wrench className="w-4 h-4 text-zinc-400 group-hover:text-amber-500" />
            </button>
            <button
              onClick={() => executeScript('repair-bootstrap-admin.ps1')}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-amber-500 hover:bg-amber-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm">Repair Admin Account</h3>
                <p className="text-xs text-zinc-500 mt-1">Ensures a master administrator account exists.</p>
              </div>
              <Key className="w-4 h-4 text-zinc-400 group-hover:text-amber-500" />
            </button>

            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900 mt-6 border-t pt-6">
              <Trash2 className="w-5 h-5 text-red-500" /> Uninstall
            </h2>
            <button
              onClick={() => {
                if(confirm('REMOVE MAIN HUB: This stops the Riverside OS Server, removes scheduled tasks, deletes server/client/release subdirectories, removes the firewall rule, and DROPS the PostgreSQL database. Proceed?')) {
                  executeScript('remove-main-hub.ps1', ['-Force']);
                }
              }}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm text-red-600">Uninstall Server</h3>
                <p className="text-xs text-red-400/80 mt-1">Removes server binary, client bundle, scheduled task, and firewall rule. Keeps the database, backups, and logs.</p>
              </div>
              <Trash2 className="w-4 h-4 text-zinc-400 group-hover:text-red-500" />
            </button>
            <button
              onClick={() => {
                if(confirm('UNINSTALL REGISTER: This will stop the Riverside OS desktop app, run its uninstaller, and remove station config. Proceed?')) {
                  executeInline(
                    `$ErrorActionPreference = 'SilentlyContinue';
                     foreach ($name in @('Riverside POS','Riverside.POS','RiversideOS','riverside-pos')) { Stop-Process -Name $name -Force -ErrorAction SilentlyContinue };
                     $regPaths = @('HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');
                     $apps = foreach ($p in $regPaths) { Get-ItemProperty $p -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'Riverside' -and ($_.DisplayName -match 'POS|OS') } };
                     foreach ($app in $apps) { if ($app.PSChildName -match '^\\{.*\\}$') { Start-Process msiexec.exe -Wait -ArgumentList @('/x',$app.PSChildName,'/qn','/norestart') } elseif ($app.UninstallString) { Start-Process cmd.exe -Wait -ArgumentList @('/c',$app.UninstallString) } };
                     $stationDir = Join-Path $env:PROGRAMDATA 'RiversideOS';
                     Remove-Item (Join-Path $stationDir 'station-config.json') -Force -ErrorAction SilentlyContinue;
                     Remove-Item (Join-Path $stationDir 'register-deployment-summary.txt') -Force -ErrorAction SilentlyContinue;
                     Write-Host 'Register uninstall complete.'`,
                    'Uninstall Register'
                  );
                }
              }}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm text-red-600">Uninstall Register</h3>
                <p className="text-xs text-red-400/80 mt-1">Stops the desktop app, runs its Windows uninstaller, and removes station config.</p>
              </div>
              <Trash2 className="w-4 h-4 text-zinc-400 group-hover:text-red-500" />
            </button>
          </div>
          <div className="col-span-7 flex flex-col min-h-[400px]">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-bold text-zinc-800">Execution Output</h3>
              {isExecuting && <span className="flex items-center gap-2 text-xs font-semibold text-brand-600 bg-brand-50 px-2 py-1 rounded-md animate-pulse"><RefreshCw className="w-3 h-3" /> Running</span>}
            </div>
            <div className="flex-1 bg-zinc-900 rounded-xl p-4 font-mono text-xs text-zinc-300 overflow-y-auto max-h-[500px]">
              {logs.length === 0 ? (
                <div className="h-full flex items-center justify-center text-zinc-600">
                  Select a script on the left to begin...
                </div>
              ) : (
                <div className="space-y-1 pb-4">
                  {logs.map((log, i) => (
                    <p key={i} className={`whitespace-pre-wrap ${
                      log.level === 'error' ? 'text-red-400' :
                      log.level === 'success' ? 'text-green-400' :
                      'text-zinc-300'
                    }`}>
                      {log.text}
                    </p>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              )}
            </div>
            {logs.length > 0 && !isExecuting && (
              <div className="mt-4 flex justify-end">
                <button onClick={() => setLogs([])} className="px-4 py-2 text-sm bg-zinc-200 text-zinc-700 font-semibold rounded-lg hover:bg-zinc-300">
                  Clear Logs
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
