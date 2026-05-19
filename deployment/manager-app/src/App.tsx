import { useState } from 'react';
import { Settings, Server, Play, CheckCircle, ChevronRight, Terminal } from 'lucide-react';

export default function App() {
  const [step, setStep] = useState(1);
  const [role, setRole] = useState<'server' | 'register'>('server');

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-12 px-4">
      {/* Header */}
      <div className="w-full max-w-4xl flex items-center gap-4 mb-8">
        <div className="w-12 h-12 bg-brand-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-brand-500/20">
          <Server className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900">Riverside OS Deployment</h1>
          <p className="text-zinc-500 text-sm font-medium">Install or update this station</p>
        </div>
      </div>

      {/* Main Content */}
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
              {/* Fake config inputs for the mockup */}
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-semibold text-zinc-700 mb-1">Server IP Address</label>
                  <input type="text" className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 outline-none" defaultValue="127.0.0.1" />
                </div>
                <div>
                  <label className="block text-sm font-semibold text-zinc-700 mb-1">PostgreSQL Admin Password</label>
                  <input type="password" className="w-full px-4 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 outline-none" defaultValue="***********" />
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="flex-1 flex flex-col">
              <h2 className="text-xl font-bold mb-6">Installing Updates...</h2>
              <div className="flex-1 bg-zinc-900 rounded-xl p-4 font-mono text-sm text-zinc-300 overflow-y-auto">
                <div className="flex items-center gap-2 mb-2 text-zinc-500">
                  <Terminal className="w-4 h-4" /> Live Execution Logs
                </div>
                <div className="space-y-1">
                  <p className="text-blue-400">[INFO] Starting Riverside Deployment Manager</p>
                  <p className="text-zinc-300">[1/4] Checking PostgreSQL installation...</p>
                  <p className="text-green-400">      PostgreSQL is installed.</p>
                  <p className="text-zinc-300">[2/4] Downloading ROSIE AI assets...</p>
                  <p className="text-yellow-400">      Model already present.</p>
                  <p className="text-zinc-300">[3/4] Copying server binaries...</p>
                  <p className="text-brand-400 animate-pulse">_</p>
                </div>
              </div>
            </div>
          )}

          <div className="mt-8 pt-6 border-t flex justify-end">
            <button 
              onClick={() => setStep(s => Math.min(4, s + 1))}
              className="px-6 py-2.5 bg-brand-600 text-white font-semibold rounded-lg hover:bg-brand-700 flex items-center gap-2 shadow-sm"
            >
              {step === 3 ? 'Finish' : 'Continue'} <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
