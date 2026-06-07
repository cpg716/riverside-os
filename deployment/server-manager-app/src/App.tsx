import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  Download,
  FolderOpen,
  HardDrive,
  Power,
  RefreshCw,
  RotateCw,
  Server,
  ShieldAlert,
  Square,
  Terminal,
  Wrench,
  XCircle,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import RosieIcon from './RosieIcon';

type StatusCheck = {
  ok: boolean;
  status: number;
  error: string;
};

type ServerSnapshot = {
  generated_at: string;
  package_root: string;
  config_path: string;
  config_exists: boolean;
  install_root: string;
  api_base: string;
  elevated: boolean;
  server: {
    task_status: string;
    task_present: boolean;
    process_count: number;
    exe_present: boolean;
    exe_path: string;
  };
  api: {
    health: StatusCheck;
    ready: StatusCheck;
    live: StatusCheck;
    version: StatusCheck;
  };
  postgres: {
    service_name: string;
    service_status: string;
    psql_found: boolean;
    connectable: boolean;
    db_exists: boolean;
    db_size: string;
    table_count: string;
    migration_count: string;
  };
  rosie: {
    host: string;
    health: StatusCheck;
    process_count: number;
  };
  storage: {
    drive: string;
    free_gb: number;
    used_gb: number;
    logs: DirSummary;
    backups: DirSummary;
  };
  maintenance: {
    scripts_available: Record<string, boolean>;
  };
  issues: Issue[];
};

type DirSummary = {
  exists: boolean;
  file_count: number;
  size_mb: number;
  path: string;
};

type Issue = {
  severity: 'critical' | 'warning' | 'info';
  title: string;
  detail: string;
  action: string;
};

type LogMessage = {
  level: 'info' | 'success' | 'error';
  text: string;
};

type Action = {
  id: string;
  label: string;
  description: string;
  tone?: 'primary' | 'danger' | 'neutral';
  icon: ComponentType<{ size?: number; className?: string; alt?: string }>;
};

type UpdateCheckResult = {
  enabled: boolean;
  available: boolean;
  version: string | null;
  date: string | null;
  notes: string | null;
  message: string | null;
  current_build: string | null;
  available_build: string | null;
};

type InstallUpdateResult = {
  enabled: boolean;
  installed: boolean;
  version: string | null;
  message: string | null;
  current_build: string | null;
  installed_build: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  start_server: 'Start Server',
  stop_server: 'Stop Server',
  restart_server: 'Restart Server',
  run_audit: 'Run Audit',
  apply_migrations: 'Apply Migrations',
  repair_credentials: 'Repair Credentials',
  repair_admin: 'Repair Admin',
  update_server: 'Update Server',
  install_rosie: 'Repair ROSIE',
  start_rosie: 'Start ROSIE',
  reset_postgres_password: 'Reset PostgreSQL Password',
  open_logs: 'Open Logs',
  cleanup_logs: 'Clean Logs',
  cleanup_temp: 'Clean Temp Files',
  optimize_database: 'Optimize Database',
};

const PRIMARY_ACTIONS: Action[] = [
  {
    id: 'start_server',
    label: 'Start',
    description: 'Start the Windows server task.',
    icon: Power,
    tone: 'primary',
  },
  {
    id: 'restart_server',
    label: 'Restart',
    description: 'Restart the API process and scheduled task.',
    icon: RotateCw,
    tone: 'primary',
  },
  {
    id: 'stop_server',
    label: 'Stop',
    description: 'Stop the API process.',
    icon: Square,
    tone: 'danger',
  },
  {
    id: 'run_audit',
    label: 'Audit',
    description: 'Run the full local diagnostic script.',
    icon: Activity,
  },
];

const REPAIR_ACTIONS: Action[] = [
  {
    id: 'apply_migrations',
    label: 'Apply Migrations',
    description: 'Run pending database schema updates.',
    icon: Database,
    tone: 'primary',
  },
  {
    id: 'repair_credentials',
    label: 'Repair Credentials',
    description: 'Restore server credential keys and restart.',
    icon: Wrench,
  },
  {
    id: 'repair_admin',
    label: 'Repair Admin',
    description: 'Ensure a bootstrap administrator exists.',
    icon: ShieldAlert,
  },
  {
    id: 'update_server',
    label: 'Update Server',
    description: 'Reinstall/update server files from this package.',
    icon: Server,
    tone: 'primary',
  },
];

const MAINTENANCE_ACTIONS: Action[] = [
  {
    id: 'optimize_database',
    label: 'Optimize Database',
    description: 'Run VACUUM ANALYZE.',
    icon: Database,
  },
  {
    id: 'cleanup_logs',
    label: 'Clean Logs',
    description: 'Remove server logs older than 30 days.',
    icon: HardDrive,
  },
  {
    id: 'cleanup_temp',
    label: 'Clean Temp',
    description: 'Remove temporary ROS installer files.',
    icon: HardDrive,
  },
  {
    id: 'open_logs',
    label: 'Open Logs',
    description: 'Open local server logs.',
    icon: FolderOpen,
  },
  {
    id: 'install_rosie',
    label: 'Repair ROSIE',
    description: 'Install/update local AI and voice tools.',
    icon: RosieIcon,
  },
  {
    id: 'start_rosie',
    label: 'Start ROSIE',
    description: 'Start the local LLM host.',
    icon: RosieIcon,
  },
];

function isOk(check?: StatusCheck) {
  return Boolean(check?.ok);
}

function statusTone(ok: boolean, warn = false) {
  if (ok) return 'ok';
  if (warn) return 'warn';
  return 'bad';
}

export default function App() {
  const [snapshot, setSnapshot] = useState<ServerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningAction, setRunningAction] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selfUpdateCheck, setSelfUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [selfUpdateBusy, setSelfUpdateBusy] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await invoke<ServerSnapshot>('get_server_snapshot');
      setSnapshot(next);
    } catch (error) {
      setLoadError(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  const runAction = useCallback(
    async (actionId: string) => {
      if (runningAction) return;
      setRunningAction(actionId);
      setLogs([{ level: 'info', text: `${ACTION_LABELS[actionId] ?? actionId} started...` }]);
      const unlisten = await listen<LogMessage>('server-manager-log', (event) => {
        setLogs((current) => [...current, event.payload]);
      });
      try {
        await invoke('run_server_action', { actionId });
        await refresh();
      } catch (error) {
        setLogs((current) => [...current, { level: 'error', text: `Failed: ${String(error)}` }]);
      } finally {
        setRunningAction(null);
        unlisten();
      }
    },
    [refresh, runningAction],
  );

  const checkSelfUpdate = useCallback(async () => {
    if (selfUpdateBusy) return;
    setSelfUpdateBusy(true);
    try {
      const result = await invoke<UpdateCheckResult>('check_app_update');
      setSelfUpdateCheck(result);
      setLogs((current) => [
        ...current,
        {
          level: result.available ? 'success' : result.enabled ? 'info' : 'error',
          text: result.available
            ? `Server Manager update available: ${result.version}${result.available_build ? ` (${result.available_build})` : ''}`
            : result.message ?? 'No Server Manager update available.',
        },
      ]);
    } catch (error) {
      setLogs((current) => [...current, { level: 'error', text: `Server Manager update check failed: ${String(error)}` }]);
    } finally {
      setSelfUpdateBusy(false);
    }
  }, [selfUpdateBusy]);

  const installSelfUpdate = useCallback(async () => {
    if (selfUpdateBusy) return;
    setSelfUpdateBusy(true);
    try {
      const result = await invoke<InstallUpdateResult>('install_app_update');
      setLogs((current) => [
        ...current,
        {
          level: result.installed ? 'success' : result.enabled ? 'info' : 'error',
          text: result.installed
            ? result.message ?? `Server Manager updated to ${result.version}.`
            : result.message ?? 'No Server Manager update available.',
        },
      ]);
    } catch (error) {
      setLogs((current) => [...current, { level: 'error', text: `Server Manager install failed: ${String(error)}` }]);
    } finally {
      setSelfUpdateBusy(false);
    }
  }, [selfUpdateBusy]);

  const overall = useMemo(() => {
    if (!snapshot) return { label: 'Checking', tone: 'warn' };
    const critical = snapshot.issues.filter((issue) => issue.severity === 'critical').length;
    const warnings = snapshot.issues.filter((issue) => issue.severity === 'warning').length;
    if (critical > 0) return { label: `${critical} critical`, tone: 'bad' };
    if (warnings > 0) return { label: `${warnings} warning${warnings === 1 ? '' : 's'}`, tone: 'warn' };
    return { label: 'Healthy', tone: 'ok' };
  }, [snapshot]);

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-mark">
          <Server size={26} />
        </div>
        <div>
          <h1>ROS Server Manager</h1>
          <p>Local server health, repair, updates, cleanup, and recovery</p>
        </div>
        <div className="topbar-actions">
          <span className={`status-pill ${overall.tone}`}>{overall.label}</span>
          <button className="icon-button" type="button" onClick={refresh} disabled={loading}>
            <RefreshCw size={18} className={loading ? 'spin' : ''} />
            Refresh
          </button>
        </div>
      </header>

      {loadError && (
        <section className="notice bad">
          <AlertTriangle size={18} />
          <span>{loadError}</span>
        </section>
      )}

      {snapshot && !snapshot.elevated && (
        <section className="notice warn">
          <AlertTriangle size={18} />
          <span>Run as Administrator to start, repair, update, or clean server services.</span>
          <button type="button" onClick={() => invoke('relaunch_elevated')}>
            Relaunch as Administrator
          </button>
        </section>
      )}

      {snapshot && (
        <>
          <section className="overview-grid">
            <StatusCard
              title="Server Task"
              value={snapshot.server.task_status}
              detail={`${snapshot.server.process_count} process${snapshot.server.process_count === 1 ? '' : 'es'} running`}
              tone={statusTone(snapshot.server.task_present && snapshot.server.process_count > 0)}
              icon={Server}
            />
            <StatusCard
              title="API Health"
              value={isOk(snapshot.api.health) ? 'Online' : 'Offline'}
              detail={snapshot.api_base}
              tone={statusTone(isOk(snapshot.api.health))}
              icon={Activity}
            />
            <StatusCard
              title="PostgreSQL"
              value={snapshot.postgres.connectable ? 'Connected' : snapshot.postgres.service_status}
              detail={snapshot.postgres.db_exists ? `${snapshot.postgres.db_size} database` : 'Database not confirmed'}
              tone={statusTone(snapshot.postgres.connectable && snapshot.postgres.db_exists)}
              icon={Database}
            />
            <StatusCard
              title="ROSIE"
              value={isOk(snapshot.rosie.health) ? 'Online' : 'Offline'}
              detail={snapshot.rosie.host}
              tone={statusTone(isOk(snapshot.rosie.health), true)}
              icon={RosieIcon}
            />
          </section>

          <section className="workspace-grid">
            <div className="left-stack">
              <Panel title="Issues To Fix">
                {snapshot.issues.length === 0 ? (
                  <EmptyState text="No server issues found by the local probe." />
                ) : (
                  <div className="issue-list">
                    {snapshot.issues.map((issue) => (
                      <article className={`issue ${issue.severity}`} key={`${issue.title}-${issue.action}`}>
                        <div>
                          <h3>{issue.title}</h3>
                          <p>{issue.detail}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => runAction(issue.action)}
                          disabled={Boolean(runningAction)}
                        >
                          {ACTION_LABELS[issue.action] ?? 'Fix'}
                        </button>
                      </article>
                    ))}
                  </div>
                )}
              </Panel>

              <Panel title="Server Controls">
                <ActionGrid actions={PRIMARY_ACTIONS} runningAction={runningAction} onRun={runAction} />
              </Panel>

              <Panel title="Repairs & Updates">
                <ActionGrid actions={REPAIR_ACTIONS} runningAction={runningAction} onRun={runAction} />
              </Panel>

              <Panel title="Server Manager App Update">
                <div className="action-grid">
                  <button
                    className="action-button primary"
                    type="button"
                    onClick={() => void checkSelfUpdate()}
                    disabled={selfUpdateBusy || Boolean(runningAction)}
                  >
                    {selfUpdateBusy ? <RefreshCw size={18} className="spin" /> : <Download size={18} />}
                    <span>Check App</span>
                    <small>
                      {selfUpdateCheck?.available
                        ? `Ready: ${selfUpdateCheck.version}${selfUpdateCheck.available_build ? ` (${selfUpdateCheck.available_build})` : ''}`
                        : selfUpdateCheck?.message ?? 'Check the signed Server Manager channel.'}
                    </small>
                  </button>
                  <button
                    className="action-button neutral"
                    type="button"
                    onClick={() => void installSelfUpdate()}
                    disabled={selfUpdateBusy || Boolean(runningAction)}
                  >
                    {selfUpdateBusy ? <RefreshCw size={18} className="spin" /> : <Download size={18} />}
                    <span>Install App</span>
                    <small>Updates this console only; server, ROSIE, and database repairs stay separate.</small>
                  </button>
                </div>
              </Panel>

              <Panel title="Optimization & Cleanup">
                <ActionGrid actions={MAINTENANCE_ACTIONS} runningAction={runningAction} onRun={runAction} />
              </Panel>
            </div>

            <div className="right-stack">
              <Panel title="Local Detail">
                <dl className="details">
                  <div><dt>Install Root</dt><dd>{snapshot.install_root}</dd></div>
                  <div><dt>Package Root</dt><dd>{snapshot.package_root}</dd></div>
                  <div><dt>Config</dt><dd>{snapshot.config_exists ? snapshot.config_path : 'Missing'}</dd></div>
                  <div><dt>Server Binary</dt><dd>{snapshot.server.exe_present ? snapshot.server.exe_path : 'Missing'}</dd></div>
                  <div><dt>Drive Free</dt><dd>{snapshot.storage.free_gb} GB free on {snapshot.storage.drive}:</dd></div>
                  <div><dt>Logs</dt><dd>{snapshot.storage.logs.file_count} files, {snapshot.storage.logs.size_mb} MB</dd></div>
                  <div><dt>Backups</dt><dd>{snapshot.storage.backups.file_count} files, {snapshot.storage.backups.size_mb} MB</dd></div>
                  <div><dt>Tables</dt><dd>{snapshot.postgres.table_count || 'Not available'}</dd></div>
                  <div><dt>Migrations</dt><dd>{snapshot.postgres.migration_count || 'Not available'}</dd></div>
                  <div><dt>Checked</dt><dd>{snapshot.generated_at}</dd></div>
                </dl>
              </Panel>

              <Panel title="Execution Output">
                <div className="terminal">
                  {logs.length === 0 ? (
                    <div className="terminal-empty">
                      <Terminal size={22} />
                      <span>Select a server action to view live output.</span>
                    </div>
                  ) : (
                    logs.map((log, index) => (
                      <p className={log.level} key={`${log.text}-${index}`}>{log.text}</p>
                    ))
                  )}
                  <div ref={logsEndRef} />
                </div>
              </Panel>
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function StatusCard({
  title,
  value,
  detail,
  tone,
  icon: Icon,
}: {
  title: string;
  value: string;
  detail: string;
  tone: string;
  icon: ComponentType<{ size?: number; className?: string; alt?: string }>;
}) {
  return (
    <article className="status-card">
      <div className={`status-icon ${tone}`}>
        {tone === 'ok' ? <CheckCircle2 size={20} /> : tone === 'bad' ? <XCircle size={20} /> : <Icon size={20} />}
      </div>
      <div>
        <p>{title}</p>
        <h2>{value}</h2>
        <span>{detail}</span>
      </div>
    </article>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

function ActionGrid({
  actions,
  runningAction,
  onRun,
}: {
  actions: Action[];
  runningAction: string | null;
  onRun: (id: string) => void;
}) {
  return (
    <div className="action-grid">
      {actions.map((action) => {
        const Icon = action.icon;
        const isRunning = runningAction === action.id;
        return (
          <button
            className={`action-button ${action.tone ?? 'neutral'}`}
            type="button"
            key={action.id}
            onClick={() => onRun(action.id)}
            disabled={Boolean(runningAction)}
          >
            {isRunning ? <RefreshCw size={18} className="spin" /> : <Icon size={18} />}
            <span>{action.label}</span>
            <small>{action.description}</small>
          </button>
        );
      })}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="empty-state">
      <CheckCircle2 size={22} />
      <span>{text}</span>
    </div>
  );
}
