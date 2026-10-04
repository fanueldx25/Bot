import React, { useState, useEffect } from 'react';
import { Shield, Bot, QrCode, Phone, Settings, LogOut, RefreshCw, Terminal, CheckCircle2, AlertCircle, Play, Database, Download } from 'lucide-react';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState('');
  const [adminToken, setAdminToken] = useState(localStorage.getItem('panda_admin_token') || '');
  
  const [data, setData] = useState<any>({
    status: 'connecting',
    qr: null,
    pairingCode: null,
    logs: [],
    uptime: '0h 0m 0s',
    activeChatsCount: 0,
    config: { owner: '', prefix: '.', mode: 'public', botName: 'Panda Bot', autoRead: true, alwaysTyping: false, alwaysRecording: false }
  });

  const [statuses, setStatuses] = useState<any[]>([]);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [isRequestingPairing, setIsRequestingPairing] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [method, setMethod] = useState<'qr' | 'number'>('qr');
  const [activeTab, setActiveTab] = useState<'status' | 'statuses' | 'settings'>('status');

  const [settings, setSettings] = useState({
    owner: '',
    prefix: '.',
    mode: 'public',
    botName: 'Panda Bot',
    autoRead: true,
    alwaysTyping: false,
    alwaysRecording: false,
    bannerUrl: '',
    adminPassword: ''
  });

  useEffect(() => {
    if (adminToken) {
      setIsAuthenticated(true);
      fetchStatus();
      fetchStatuses();
      const interval = setInterval(() => {
        fetchStatus();
        fetchStatuses();
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [adminToken]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput })
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        json = { error: text || 'Invalid server response' };
      }
      if (res.ok && json.token) {
        setAdminToken(json.token);
        localStorage.setItem('panda_admin_token', json.token);
        setIsAuthenticated(true);
      } else {
        setLoginError(json.error || 'Incorrect admin password (default: panda123)');
      }
    } catch (err: any) {
      setLoginError(`Connection error: ${err.message || 'Unable to reach server'}`);
    }
  };

  const fetchStatus = async () => {
    try {
      const response = await fetch('/api/status', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      if (response.status === 401) {
        setIsAuthenticated(false);
        return;
      }
      const result = await response.json();
      setData(result);
      if (result.config) {
        setSettings(result.config);
      }
    } catch {}
  };

  const fetchStatuses = async () => {
    try {
      const response = await fetch('/api/statuses', {
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      if (response.ok) {
        const result = await response.json();
        setStatuses(result.statuses || []);
      }
    } catch {}
  };

  const reconnectWhatsApp = async () => {
    setIsReconnecting(true);
    try {
      const res = await fetch('/api/reconnect', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${adminToken}` }
      });
      const json = await res.json();
      if (res.ok) {
        alert(json.message || 'Reconnect triggered!');
      } else {
        alert(json.error || 'Failed to reconnect');
      }
      fetchStatus();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setIsReconnecting(false);
    }
  };

  const downloadStatus = async (statusId: string) => {
    try {
      const res = await fetch('/api/download-status', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({ statusId })
      });
      const json = await res.json();
      if (res.ok) {
        alert(json.message || 'Status sent to your WhatsApp DM!');
      } else {
        alert(json.error || 'Failed to download status');
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const requestPairingCode = async () => {
    if (!phoneNumber) return;
    setIsRequestingPairing(true);
    try {
      const res = await fetch('/api/request-pairing', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify({ phoneNumber })
      });
      const json = await res.json();
      if (!res.ok) alert(json.error || 'Failed to request pairing code');
      fetchStatus();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setIsRequestingPairing(false);
    }
  };

  const saveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${adminToken}`
        },
        body: JSON.stringify(settings)
      });
      if (res.ok) {
        alert('Settings saved successfully!');
      } else {
        alert('Failed to save settings');
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <div className="w-16 h-16 bg-emerald-500/10 rounded-2xl flex items-center justify-center mx-auto mb-4 border border-emerald-500/20">
              <Bot className="w-8 h-8 text-emerald-400" />
            </div>
            <h1 className="text-2xl font-bold text-white">Panda Bot Admin</h1>
            <p className="text-slate-400 text-sm mt-1">Enter your password to manage your WhatsApp bot</p>
            <p className="text-xs text-emerald-400 mt-2">Default Password: <code className="bg-slate-800 px-1.5 py-0.5 rounded text-emerald-300">panda123</code></p>
          </div>

          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-slate-400 mb-1">ADMIN PASSWORD</label>
              <input
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Enter password..."
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500 transition-colors"
                required
              />
            </div>

            {loginError && (
              <div className="flex items-center space-x-2 text-rose-400 text-xs bg-rose-500/10 border border-rose-500/20 p-3 rounded-xl">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition-colors shadow-lg shadow-emerald-600/20"
            >
              Access Dashboard
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col">
      <header className="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 bg-emerald-500/10 rounded-xl flex items-center justify-center border border-emerald-500/20">
              <Bot className="w-6 h-6 text-emerald-400" />
            </div>
            <div>
              <h1 className="font-bold text-white leading-tight">Panda Bot Dashboard</h1>
              <span className="text-xs text-emerald-400 flex items-center gap-1">
                <span className={`w-2 h-2 rounded-full ${data.status === 'open' ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                {data.status === 'open' ? 'Connected' : data.status.toUpperCase()}
              </span>
            </div>
          </div>

          <div className="flex items-center space-x-3">
            <button
              onClick={reconnectWhatsApp}
              disabled={isReconnecting}
              className="flex items-center space-x-1.5 px-3 py-2 rounded-xl bg-emerald-600/20 hover:bg-emerald-600/30 text-emerald-300 border border-emerald-500/30 text-sm transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isReconnecting ? 'animate-spin' : ''}`} />
              <span>{isReconnecting ? 'Reconnecting...' : 'Reconnect'}</span>
            </button>
            <button
              onClick={() => {
                setAdminToken('');
                localStorage.removeItem('panda_admin_token');
                setIsAuthenticated(false);
              }}
              className="flex items-center space-x-1.5 px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>Logout</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 flex-1 w-full space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <span className="text-slate-400 text-xs font-medium">BOT STATUS</span>
            <div className="text-2xl font-bold mt-1 uppercase text-emerald-400">{data.status}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <span className="text-slate-400 text-xs font-medium">UPTIME</span>
            <div className="text-2xl font-bold mt-1 text-white">{data.uptime}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <span className="text-slate-400 text-xs font-medium">ACTIVE CHATS</span>
            <div className="text-2xl font-bold mt-1 text-white">{data.activeChatsCount}</div>
          </div>
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5">
            <span className="text-slate-400 text-xs font-medium">CAPTURED STATUSES</span>
            <div className="text-2xl font-bold mt-1 text-emerald-400">{statuses.length}</div>
          </div>
        </div>

        <div className="flex space-x-2 border-b border-slate-800 pb-2">
          <button
            onClick={() => setActiveTab('status')}
            className={`px-4 py-2 rounded-xl font-medium text-sm transition-colors ${activeTab === 'status' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            Live Status & Linking
          </button>
          <button
            onClick={() => setActiveTab('statuses')}
            className={`px-4 py-2 rounded-xl font-medium text-sm transition-colors ${activeTab === 'statuses' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            Status Downloader ({statuses.length})
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`px-4 py-2 rounded-xl font-medium text-sm transition-colors ${activeTab === 'settings' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:bg-slate-900'}`}
          >
            Bot Settings
          </button>
        </div>

        {activeTab === 'status' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
              <h2 className="text-lg font-bold text-white flex items-center gap-2">
                <QrCode className="w-5 h-5 text-emerald-400" />
                <span>WhatsApp Connection</span>
              </h2>

              <div className="flex space-x-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800">
                <button
                  onClick={() => setMethod('qr')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${method === 'qr' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
                >
                  QR Code
                </button>
                <button
                  onClick={() => setMethod('number')}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${method === 'number' ? 'bg-slate-800 text-white' : 'text-slate-400'}`}
                >
                  Pairing Code
                </button>
              </div>

              {method === 'qr' ? (
                <div className="flex flex-col items-center justify-center p-6 bg-slate-950 rounded-2xl border border-slate-800">
                  {data.qr ? (
                    <div className="bg-white p-4 rounded-xl">
                      <img src={data.qr} alt="WhatsApp QR Code" className="w-64 h-64 object-contain" />
                    </div>
                  ) : (
                    <div className="text-center py-12 text-slate-400">
                      {data.status === 'open' ? (
                        <div className="flex flex-col items-center text-emerald-400 space-y-2">
                          <CheckCircle2 className="w-12 h-12" />
                          <p className="font-semibold">WhatsApp is connected!</p>
                        </div>
                      ) : (
                        <p>Generating QR Code...</p>
                      )}
                    </div>
                  )}
                  <p className="text-xs text-slate-400 mt-4 text-center">Scan with WhatsApp on your phone under Linked Devices</p>
                </div>
              ) : (
                <div className="space-y-4 p-6 bg-slate-950 rounded-2xl border border-slate-800">
                  <div>
                    <label className="block text-xs font-medium text-slate-400 mb-1">PHONE NUMBER (WITH COUNTRY CODE)</label>
                    <div className="flex space-x-2">
                      <input
                        type="text"
                        value={phoneNumber}
                        onChange={(e) => setPhoneNumber(e.target.value)}
                        placeholder="2376xxxxxxxx"
                        className="flex-1 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3 text-white focus:outline-none focus:border-emerald-500"
                      />
                      <button
                        onClick={requestPairingCode}
                        disabled={isRequestingPairing}
                        className="bg-emerald-600 hover:bg-emerald-500 text-white px-6 rounded-xl font-medium transition-colors disabled:opacity-50"
                      >
                        {isRequestingPairing ? 'Requesting...' : 'Get Code'}
                      </button>
                    </div>
                  </div>

                  {data.pairingCode && (
                    <div className="bg-emerald-500/10 border border-emerald-500/20 p-4 rounded-xl text-center">
                      <span className="text-xs text-emerald-400 font-medium">YOUR PAIRING CODE</span>
                      <div className="text-3xl font-mono font-bold text-white tracking-widest mt-1">{data.pairingCode}</div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 flex flex-col">
              <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-4">
                <Terminal className="w-5 h-5 text-emerald-400" />
                <span>Live Bot Activity Logs</span>
              </h2>

              <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl p-4 font-mono text-xs overflow-y-auto max-h-[400px] space-y-2">
                {data.logs.length === 0 ? (
                  <div className="text-slate-500 text-center py-8">No logs recorded yet.</div>
                ) : (
                  data.logs.map((log: any, idx: number) => (
                    <div key={idx} className="flex items-start space-x-2">
                      <span className="text-slate-500 shrink-0">[{log.timestamp}]</span>
                      <span className={log.type === 'error' ? 'text-rose-400' : log.type === 'in' ? 'text-emerald-400' : 'text-slate-300'}>
                        {log.message}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {activeTab === 'statuses' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold text-white flex items-center gap-2">
                  <Download className="w-5 h-5 text-emerald-400" />
                  <span>WhatsApp Status Downloader</span>
                </h2>
                <p className="text-xs text-slate-400 mt-1">View and download recent WhatsApp stories/statuses captured by your bot.</p>
              </div>
              <button
                onClick={fetchStatuses}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-medium transition-colors"
              >
                Refresh Statuses
              </button>
            </div>

            {statuses.length === 0 ? (
              <div className="text-center py-16 bg-slate-950 rounded-2xl border border-slate-800 text-slate-400">
                <Download className="w-12 h-12 text-slate-600 mx-auto mb-3" />
                <p className="font-medium">No statuses captured yet.</p>
                <p className="text-xs text-slate-500 mt-1">Statuses posted by your contacts will automatically appear here.</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {statuses.map((st) => (
                  <div key={st.id} className="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col justify-between space-y-3">
                    <div>
                      <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                        <span className="font-bold text-white">{st.sender}</span>
                        <span>{st.timestamp}</span>
                      </div>
                      <p className="text-sm text-slate-200 bg-slate-900 p-3 rounded-lg border border-slate-800/60 line-clamp-3">
                        {st.caption || `[${st.type}]`}
                      </p>
                    </div>
                    <button
                      onClick={() => downloadStatus(st.id)}
                      className="w-full bg-emerald-600 hover:bg-emerald-500 text-white py-2.5 rounded-lg text-xs font-medium transition-colors flex items-center justify-center space-x-2 shadow-lg shadow-emerald-600/20"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download / Send to DM</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {activeTab === 'settings' && (
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 max-w-2xl mx-auto w-full">
            <h2 className="text-lg font-bold text-white flex items-center gap-2 mb-6">
              <Settings className="w-5 h-5 text-emerald-400" />
              <span>Bot Settings</span>
            </h2>

            <form onSubmit={saveSettings} className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">BOT NAME</label>
                  <input
                    type="text"
                    value={settings.botName}
                    onChange={(e) => setSettings({ ...settings, botName: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">COMMAND PREFIX</label>
                  <input
                    type="text"
                    value={settings.prefix}
                    onChange={(e) => setSettings({ ...settings, prefix: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">OWNER NUMBER</label>
                  <input
                    type="text"
                    value={settings.owner}
                    onChange={(e) => setSettings({ ...settings, owner: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">BOT MODE</label>
                  <select
                    value={settings.mode}
                    onChange={(e) => setSettings({ ...settings, mode: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                  >
                    <option value="public">Public</option>
                    <option value="private">Private</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1">NEW ADMIN PASSWORD</label>
                <input
                  type="password"
                  value={settings.adminPassword}
                  onChange={(e) => setSettings({ ...settings, adminPassword: e.target.value })}
                  placeholder="Leave blank to keep current"
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-white focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="space-y-3 pt-2">
                <label className="flex items-center space-x-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.autoRead}
                    onChange={(e) => setSettings({ ...settings, autoRead: e.target.checked })}
                    className="w-4 h-4 rounded bg-slate-950 border-slate-800 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-slate-300">Auto Read Incoming Messages</span>
                </label>

                <label className="flex items-center space-x-3 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={settings.alwaysTyping}
                    onChange={(e) => setSettings({ ...settings, alwaysTyping: e.target.checked })}
                    className="w-4 h-4 rounded bg-slate-950 border-slate-800 text-emerald-600 focus:ring-emerald-500"
                  />
                  <span className="text-sm text-slate-300">Always Typing Presence</span>
                </label>
              </div>

              <button
                type="submit"
                className="w-full bg-emerald-600 hover:bg-emerald-500 text-white font-medium py-3 rounded-xl transition-colors shadow-lg shadow-emerald-600/20 mt-6"
              >
                Save Settings
              </button>
            </form>
          </div>
        )}
      </main>
    </div>
  );
}
