import { useState, useEffect, useRef } from 'react';
import { Settings, Server, Play, CheckCircle, ChevronRight, Terminal, Tool, Wrench, RefreshCw, Trash2, Key, Power, RotateCw, FolderOpen, SearchCheck } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface LogMessage {
  level: string;
  text: string;
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'wizard' | 'maintenance'>('wizard');
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<'server' | 'register'>('server');
  
  // Config state
  const [config, setConfig] = useState<any>({});
  const [serverIp, setServerIp] = useState('127.0.0.1');
  const [dbPassword, setDbPassword] = useState('');
  
  // Execution state
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [isExecuting, setIsExecuting] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

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
  }, []);

  const handleContinueToExec = async () => {
    const newConfig = { ...config };
    if (!newConfig.server) newConfig.server = {};
    if (!newConfig.server.database) newConfig.server.database = {};
    newConfig.server.database.adminPassword = dbPassword;
    
    await invoke('write_deployment_config', { config: JSON.stringify(newConfig) });
    setStep(3);
    executeScript(role === 'server' ? 'install-server.ps1' : 'install-register.ps1');
  };

  const executeScript = async (scriptName: string) => {
    if (isExecuting) return;
    setIsExecuting(true);
    setLogs([{ level: 'info', text: `Executing ${scriptName}...` }]);

    const unlisten = await listen<LogMessage>('deployment-log', (event) => {
      setLogs(prev => [...prev, event.payload]);
    });
    
    try {
      await invoke('run_deployment_script', { scriptName });
    } catch (e) {
      setLogs(prev => [...prev, { level: 'error', text: `Failed: ${e}` }]);
    } finally {
      setIsExecuting(false);
      unlisten();
    }
  };

  const executeInline = async (command: string, description: string) => {
    if (isExecuting) return;
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
                    onClick={() => setRole('server')}
                    className={`w-full text-left p-6 rounded-xl border-2 transition-all ${role === 'server' ? 'border-brand-500 bg-brand-50' : 'border-zinc-200 hover:border-zinc-300'}`}
                  >
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <Server className="w-5 h-5" /> Backoffice / Server
                    </h3>
                    <p className="text-zinc-500 text-sm mt-1">Runs the core PostgreSQL database, API server, and ROSIE AI models. Only ONE computer per store should be the Server.</p>
                  </button>
                  <button 
                    onClick={() => setRole('register')}
                    className={`w-full text-left p-6 rounded-xl border-2 transition-all ${role === 'register' ? 'border-brand-500 bg-brand-50' : 'border-zinc-200 hover:border-zinc-300'}`}
                  >
                    <h3 className="font-semibold text-lg flex items-center gap-2">
                      <Settings className="w-5 h-5" /> Front Register
                    </h3>
                    <p className="text-zinc-500 text-sm mt-1">A lightweight POS terminal that connects to the Backoffice Server over the local network.</p>
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
                  {role === 'server' && (
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
          <div className="col-span-5 space-y-4 border-r pr-8 max-h-[500px] overflow-y-auto">
            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900">
              <Power className="w-5 h-5 text-brand-600" /> Server Control
            </h2>
            <div className="grid grid-cols-2 gap-2 mb-6">
              <button 
                onClick={() => executeInline('Start-ScheduledTask -TaskName "Riverside OS Server"', 'Start Server')}
                disabled={isExecuting}
                className="p-3 rounded-lg border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1 group"
              >
                <Power className="w-5 h-5 text-zinc-400 group-hover:text-brand-500" />
                <span className="text-xs font-semibold">Start</span>
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
                onClick={() => executeInline('Get-ChildItem -Path .', 'Check Package')}
                disabled={isExecuting}
                className="p-3 rounded-lg border border-zinc-200 hover:border-brand-500 hover:bg-brand-50 transition-all disabled:opacity-50 flex flex-col items-center justify-center gap-1 group"
              >
                <SearchCheck className="w-5 h-5 text-zinc-400 group-hover:text-brand-500" />
                <span className="text-xs font-semibold">Check</span>
              </button>
            </div>

            <h2 className="text-xl font-bold mb-4 flex items-center gap-2 text-zinc-900 mt-6 border-t pt-6">
              <Tool className="w-5 h-5 text-brand-600" /> Utility Scripts
            </h2>
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
            <button 
              onClick={() => {
                if(confirm('Are you sure you want to completely DESTROY the database? This cannot be undone.')) {
                  executeScript('reset-riverside-database.ps1');
                }
              }}
              disabled={isExecuting}
              className="w-full text-left p-4 rounded-xl border border-zinc-200 hover:border-red-500 hover:bg-red-50 transition-all disabled:opacity-50 flex items-center justify-between group"
            >
              <div>
                <h3 className="font-semibold text-sm text-red-600">Factory Reset Database</h3>
                <p className="text-xs text-red-400/80 mt-1">Destroys all data and applies clean migrations.</p>
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
