import { useEffect, useState, useRef } from 'react';
import { 
  RefreshCcw, 
  Terminal, 
  QrCode, 
  Smartphone, 
  Clock, 
  Shield, 
  ShieldCheck,
  Download, 
  PowerOff, 
  AlertCircle, 
  Lock, 
  Key, 
  Check, 
  Copy, 
  Search, 
  Sliders, 
  Activity, 
  Eye, 
  EyeOff, 
  Database, 
  Radio, 
  Sparkles, 
  ChevronRight,
  LogOut,
  Trash2,
  Zap,
  Info,
  Unlock,
  X,
  Mic,
  PhoneCall,
  PhoneMissed,
  Play,
  Pause,
  Volume2
} from 'lucide-react';

interface BotConfig {
  owner: string;
  prefix: string;
  mode: 'public' | 'private';
  botName: string;
  autoRead: boolean;
  alwaysTyping: boolean;
  alwaysRecording: boolean;
  shortDelay: boolean;
  bannerUrl?: string;
  antiLink?: boolean;
  antiDelete?: boolean;
  autoStatusReact?: boolean;
  stealthMode?: boolean;
  antiCall?: boolean;
  dnd?: boolean;
  voicemailEnabled?: boolean;
  voicemailGreeting?: string;
  voicemailLang?: string;
  voicemailAutoForward?: boolean;
}

interface VoicemailItem {
  id: number;
  callerNumber: string;
  callerName: string | null;
  callId: string;
  callType: string;
  timestamp: string;
  status: 'missed' | 'left_message' | 'listened';
  messageText: string | null;
  isVoiceNote: string;
  audioUrl: string | null;
}

interface LogEntry {
  id: number;
  timestamp: string;
  message: string;
  type: 'info' | 'error' | 'in' | 'out';
}

interface BotStatus {
  status: 'connecting' | 'open' | 'close' | 'qr';
  qr: string | null;
  pairingCode: string | null;
  logs: LogEntry[];
  uptime: number;
  config: BotConfig;
  isRegistered: boolean;
  lastError: string | null;
}

interface CommandItem {
  name: string;
  aliases: string[];
  category: string;
  description: string;
}

type TabType = 'home' | 'pairing' | 'voicemail' | 'commands' | 'logs' | 'settings';

const defaultData: BotStatus = {
  status: 'close',
  qr: null,
  pairingCode: null,
  logs: [],
  uptime: 0,
  config: {
    owner: '',
    prefix: '.',
    mode: 'public',
    botName: 'Fanuel Bot',
    autoRead: true,
    alwaysTyping: false,
    alwaysRecording: false,
    shortDelay: true,
    bannerUrl: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1000&auto=format&fit=crop',
    antiLink: false,
    antiDelete: false,
    autoStatusReact: true,
    stealthMode: false,
    antiCall: false,
    dnd: false,
    voicemailEnabled: true,
    voicemailGreeting: 'Hello! You have reached my automated voicemail. I am unable to answer your call right now. Please leave your name and message right after this tone, and I will get back to you shortly.',
    voicemailLang: 'en',
    voicemailAutoForward: true
  },
  isRegistered: false,
  lastError: null
};

const getStoredToken = (): string => {
  try {
    const val = localStorage.getItem('dashboard_token') || '';
    return typeof val === 'string' ? val.trim().replace(/[^\x21-\x7E]/g, '') : '';
  } catch {
    return '';
  }
};

const setStoredToken = (tok: string) => {
  try {
    const clean = typeof tok === 'string' ? tok.trim().replace(/[^\x21-\x7E]/g, '') : '';
    if (clean) localStorage.setItem('dashboard_token', clean);
    else localStorage.removeItem('dashboard_token');
  } catch {}
};

export default function App() {
  // Authentication State
  const [token, setToken] = useState<string>(getStoredToken);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [showUnlockModal, setShowUnlockModal] = useState<boolean>(false);
  const [passwordInput, setPasswordInput] = useState<string>('');
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string>('');
  const [loginLoading, setLoginLoading] = useState<boolean>(false);

  // App Navigation
  const [activeTab, setActiveTab] = useState<TabType>('home');

  // Bot Status Data
  const [data, setData] = useState<BotStatus>(defaultData);
  const [refreshing, setRefreshing] = useState<boolean>(false);

  // Pairing State
  const [pairingMethod, setPairingMethod] = useState<'pairing' | 'qr'>('pairing');
  const [phoneNumber, setPhoneNumber] = useState<string>('');
  const [pairingLoading, setPairingLoading] = useState<boolean>(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<boolean>(false);

  // Commands Directory
  const [commandsList, setCommandsList] = useState<CommandItem[]>([]);
  const [commandCategory, setCommandCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [copiedCmd, setCopiedCmd] = useState<string | null>(null);

  // Logs Filter
  const [logFilter, setLogFilter] = useState<'all' | 'in' | 'out' | 'info' | 'error'>('all');
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Settings Draft State
  const [settingsDraft, setSettingsDraft] = useState<Partial<BotConfig>>(defaultData.config);
  const [savingSettings, setSavingSettings] = useState<boolean>(false);
  const [settingsSaved, setSettingsSaved] = useState<boolean>(false);

  // Voicemail System State
  const [voicemailsList, setVoicemailsList] = useState<VoicemailItem[]>([]);
  const [loadingVoicemails, setLoadingVoicemails] = useState<boolean>(false);
  const [previewLoading, setPreviewLoading] = useState<boolean>(false);
  const [isPlayingPreview, setIsPlayingPreview] = useState<boolean>(false);
  const [voicemailNotice, setVoicemailNotice] = useState<string>('');
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);

  // Helper: Authorized Fetch with safe header formatting
  const authFetch = async (url: string, options: RequestInit = {}) => {
    const reqHeaders: Record<string, string> = {};
    if (options.headers) {
      if (options.headers instanceof Headers) {
        options.headers.forEach((v, k) => { reqHeaders[k] = v; });
      } else if (Array.isArray(options.headers)) {
        options.headers.forEach(([k, v]) => { reqHeaders[k] = v; });
      } else {
        Object.assign(reqHeaders, options.headers);
      }
    }
    const rawToken = token || getStoredToken();
    const curToken = typeof rawToken === 'string' ? rawToken.trim().replace(/[^\x21-\x7E]/g, '') : '';
    if (curToken) {
      reqHeaders['Authorization'] = `Bearer ${curToken}`;
    }
    
    let res: Response;
    try {
      res = await fetch(url, { ...options, headers: reqHeaders });
    } catch (e: any) {
      // In case of any network glitch or fetch error, rethrow or return synthetic response
      throw e;
    }

    if (res.status === 401) {
      setIsAuthenticated(false);
      setStoredToken('');
      setToken('');
    }
    return res;
  };

  // Check initial authentication
  useEffect(() => {
    let isMounted = true;
    const verifyAuth = async () => {
      try {
        const res = await authFetch('/api/auth/check');
        if (res.ok) {
          const contentType = res.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            const text = await res.text();
            if (text) {
              const json = JSON.parse(text);
              if (isMounted) {
                setIsAuthenticated(!!json.authenticated);
              }
            }
          }
        }
      } catch {
        if (isMounted) {
          setIsAuthenticated(false);
        }
      }
    };
    verifyAuth();
    return () => { isMounted = false; };
  }, [token]);

  // Fetch bot status safely
  const fetchStatus = async (showSpinner = false) => {
    if (showSpinner) setRefreshing(true);
    try {
      const res = await authFetch('/api/status');
      if (res && res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const text = await res.text();
          if (text && text.trim().length > 0) {
            let json: BotStatus;
            try {
              json = JSON.parse(text);
            } catch {
              return;
            }
            if (json && typeof json === 'object') {
              setData(json);
              if ((json as any).isAuthenticated !== undefined) {
                setIsAuthenticated(!!(json as any).isAuthenticated);
              }
              if (json.pairingCode && !generatedCode) {
                setGeneratedCode(json.pairingCode);
              }
            }
          }
        }
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') {
        console.warn('Status poll notice:', err?.message || 'Network delay');
      }
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  };

  // Fetch registered commands safely
  const fetchCommands = async () => {
    try {
      const res = await fetch('/api/commands');
      if (res && res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const text = await res.text();
          if (text) {
            const json = JSON.parse(text);
            const unique = new Map<string, CommandItem>();
            for (const c of (json.commands || [])) {
              if (!unique.has(c.name)) {
                unique.set(c.name, c);
              }
            }
            setCommandsList(Array.from(unique.values()));
          }
        }
      }
    } catch (err: any) {
      console.warn('Commands fetch notice:', err?.message || err);
    }
  };

  // Fetch Voicemails from DB
  const fetchVoicemails = async () => {
    setLoadingVoicemails(true);
    try {
      const res = await authFetch('/api/voicemails');
      if (res && res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          const text = await res.text();
          if (text) {
            const json = JSON.parse(text);
            if (Array.isArray(json.voicemails)) {
              setVoicemailsList(json.voicemails);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load voicemails:', e);
    } finally {
      setLoadingVoicemails(false);
    }
  };

  // Polling loop - Always runs to keep UI live
  useEffect(() => {
    fetchStatus();
    fetchCommands();
    fetchVoicemails();
    const interval = setInterval(() => {
      fetchStatus();
      if (activeTab === 'voicemail') fetchVoicemails();
    }, 3000);
    return () => clearInterval(interval);
  }, [activeTab]);

  // Handle Play Greeting Preview Audio
  const handlePlayGreetingPreview = async () => {
    if (isPlayingPreview && audioPlayerRef.current) {
      audioPlayerRef.current.pause();
      setIsPlayingPreview(false);
      return;
    }

    try {
      setPreviewLoading(true);
      const text =
        settingsDraft.voicemailGreeting ||
        data?.config?.voicemailGreeting ||
        'Hello! You have reached my automated voicemail. I am unable to answer your call right now. Please leave your name and message right after this tone, and I will get back to you shortly.';
      const lang = settingsDraft.voicemailLang || data?.config?.voicemailLang || 'en';

      const res = await authFetch('/api/voicemails/preview-greeting', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, lang }),
      });
      if (res && res.ok) {
        const json = await res.json();
        if (json.audioBase64) {
          if (!audioPlayerRef.current) {
            audioPlayerRef.current = new Audio();
          }
          audioPlayerRef.current.src = json.audioBase64;
          audioPlayerRef.current.onended = () => setIsPlayingPreview(false);
          audioPlayerRef.current.onerror = () => setIsPlayingPreview(false);
          await audioPlayerRef.current.play();
          setIsPlayingPreview(true);
        }
      }
    } catch (err: any) {
      console.warn('Preview audio failed:', err.message);
    } finally {
      setPreviewLoading(false);
    }
  };

  // Delete a voicemail item
  const handleDeleteVoicemail = async (id: number) => {
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    try {
      const res = await authFetch(`/api/voicemails/${id}`, { method: 'DELETE' });
      if (res && res.ok) {
        setVoicemailsList(prev => prev.filter(v => v.id !== id));
      }
    } catch (e) {
      console.error('Failed to delete voicemail:', e);
    }
  };

  // Clear all voicemails
  const handleClearVoicemails = async () => {
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    try {
      const res = await authFetch('/api/voicemails/clear', { method: 'POST' });
      if (res && res.ok) {
        setVoicemailsList([]);
        setVoicemailNotice('Voicemail inbox cleared');
        setTimeout(() => setVoicemailNotice(''), 3000);
      }
    } catch (e) {
      console.error('Failed to clear voicemails:', e);
    }
  };

  // Sync settings draft when data loads
  useEffect(() => {
    if (data?.config) {
      setSettingsDraft(data.config);
    }
  }, [data?.config]);

  // Handle Login
  const handleLogin = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!passwordInput.trim()) return;
    setLoginLoading(true);
    setAuthError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: passwordInput.trim() }),
      });
      const json = await res.json();
      if (res.ok && json.token) {
        setStoredToken(json.token);
        setToken(json.token);
        setIsAuthenticated(true);
        setPasswordInput('');
        setShowUnlockModal(false);
        fetchStatus(true);
      } else {
        setAuthError(json.error || 'Invalid master passkey');
      }
    } catch (err: any) {
      setAuthError('Connection error. Please try again.');
    } finally {
      setLoginLoading(false);
    }
  };

  // Handle Logout / Lock
  const handleLock = async () => {
    try {
      await authFetch('/api/auth/logout', { method: 'POST' });
    } catch {}
    setStoredToken('');
    setToken('');
    setIsAuthenticated(false);
    fetchStatus(true);
  };

  // Handle Request Pairing Code
  const handleRequestPairing = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    if (!phoneNumber) return;
    setPairingLoading(true);
    setGeneratedCode(null);
    try {
      const res = await authFetch('/api/request-pairing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: phoneNumber.trim() }),
      });
      const json = await res.json();
      if (res.ok && json.code) {
        setGeneratedCode(json.code);
      } else {
        alert(json.error || 'Failed to request pairing code');
      }
    } catch (err: any) {
      alert(err.message || 'Network error');
    } finally {
      setPairingLoading(false);
    }
  };

  // Quick Toggle Config Option
  const handleToggleSetting = async (key: keyof BotConfig, currentValue: boolean) => {
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    try {
      const update = { [key]: !currentValue };
      const res = await authFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      if (res.ok) {
        fetchStatus();
      }
    } catch (e) {
      console.error(e);
    }
  };

  // Save Full Settings Form
  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    setSavingSettings(true);
    setSettingsSaved(false);
    try {
      const res = await authFetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsDraft),
      });
      if (res.ok) {
        setSettingsSaved(true);
        setTimeout(() => setSettingsSaved(false), 3000);
        fetchStatus();
      }
    } catch (e) {
      alert('Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  // Copy code to clipboard
  const handleCopyCode = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2500);
  };

  // Copy command to clipboard
  const handleCopyCommand = (cmdText: string) => {
    navigator.clipboard.writeText(cmdText);
    setCopiedCmd(cmdText);
    setTimeout(() => setCopiedCmd(null), 2000);
  };

  // Clear server logs
  const handleClearLogs = async () => {
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    if (!confirm('Are you sure you want to clear all system logs?')) return;
    try {
      await authFetch('/api/clear-logs', { method: 'POST' });
      fetchStatus();
    } catch (e) {
      console.error(e);
    }
  };

  // Disconnect bot
  const handleDisconnect = async () => {
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    if (!confirm('Disconnect WhatsApp connection?')) return;
    try {
      await authFetch('/api/disconnect', { method: 'POST' });
      fetchStatus();
    } catch (e) {
      console.error(e);
    }
  };

  // Reconnect bot
  const handleReconnect = async () => {
    if (!isAuthenticated) {
      setShowUnlockModal(true);
      return;
    }
    try {
      await authFetch('/api/reconnect', { method: 'POST' });
      fetchStatus();
    } catch (e) {
      console.error(e);
    }
  };

  const formatUptime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };

  const isConnected = data?.status === 'open';
  const isConnecting = data?.status === 'connecting';
  const hasError = !!data?.lastError;

  // Filtered commands list
  const filteredCommands = commandsList.filter((cmd) => {
    const matchesCategory = commandCategory === 'all' || cmd.category === commandCategory;
    const matchesSearch = !searchQuery || 
      cmd.name.toLowerCase().includes(searchQuery.toLowerCase()) || 
      cmd.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
      cmd.aliases.some(a => a.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCategory && matchesSearch;
  });

  // Filtered logs
  const filteredLogs = (data?.logs || []).filter((log) => {
    if (logFilter === 'all') return true;
    return log.type === logFilter;
  });

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-[#05070A] text-[#FFFFFF] font-sans flex items-center justify-center p-4 selection:bg-[#00FF88]/30">
        <div className="w-full max-w-md bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[24px] p-8 relative overflow-hidden shadow-2xl">
          <div className="absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#00FF88] to-transparent"></div>
          
          <div className="flex flex-col items-center text-center mb-8">
            <div className="w-16 h-16 rounded-[20px] bg-[#05070A] border-[1.5px] border-[#1E293B] flex items-center justify-center text-[#00FF88] mb-4 shadow-inner relative">
              <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
              <ShieldCheck className="w-8 h-8 text-[#00FF88]" />
            </div>
            <h1 className="text-[22px] font-bold text-[#FFFFFF] tracking-tight">Fanuel Bot Admin</h1>
            <p className="text-[12px] text-[#64748B] mt-1">Enter your master passkey to access the control panel</p>
          </div>

          {authError && (
            <div className="mb-6 p-3.5 bg-[#1F0A0A] border border-[#531414] rounded-[12px] flex items-center space-x-3 text-[#FF4D4D] text-[13px]">
              <AlertCircle className="w-5 h-5 shrink-0" />
              <span>{authError}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-[1px] text-[#64748B] block mb-2">
                Master Passkey
              </label>
              <div className="relative">
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={passwordInput}
                  onChange={(e) => setPasswordInput(e.target.value)}
                  placeholder="Enter secure passkey..."
                  autoFocus
                  className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[14px] px-4 py-3.5 pr-12 text-[#FFFFFF] text-[15px] font-mono placeholder-[#4B5563] outline-none transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-4 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#FFFFFF]"
                >
                  {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <button
              type="submit"
              disabled={loginLoading || !passwordInput.trim()}
              className="w-full py-3.5 rounded-[14px] bg-[#00FF88] hover:bg-[#00FF88]/90 text-[#000000] font-bold text-[13px] uppercase tracking-[1.5px] transition-all flex items-center justify-center space-x-2 disabled:opacity-50 cursor-pointer shadow-lg shadow-[#00FF88]/10"
            >
              {loginLoading ? (
                <RefreshCcw className="w-5 h-5 animate-spin text-[#000000]" />
              ) : (
                <>
                  <span>Authenticate Dashboard</span>
                  <ChevronRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 text-center">
            <span className="text-[11px] text-[#4B5563]">Fanuel WhatsApp Bot Secure Management Suite</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#05070A] text-[#FFFFFF] font-sans selection:bg-[#00FF88]/30 flex flex-col items-center">
      {/* Mobile Shell Wrapper */}
      <div className="w-full max-w-lg min-h-screen flex flex-col bg-[#05070A] relative pb-24">
        
        {/* TOP MOBILE APP BAR */}
        <header className="sticky top-0 z-30 bg-[#05070A]/95 backdrop-blur-md border-b-[1.5px] border-[#1E293B] px-4 py-3.5 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-9 h-9 rounded-[10px] bg-[#0A101A] border-[1.5px] border-[#1E293B] flex items-center justify-center relative">
              <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
              <span className="text-[#00FF88] font-bold text-sm">F</span>
            </div>
            <div>
              <div className="flex items-center space-x-2">
                <h1 className="font-bold text-[15px] text-[#FFFFFF] tracking-tight leading-none">
                  {data?.config?.botName || 'Fanuel Bot'}
                </h1>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-[#111A28] border border-[#1E293B] text-[#94A3B8] font-mono">
                  v2.5
                </span>
              </div>
              <div className="flex items-center space-x-1.5 mt-1">
                <span className={`w-2 h-2 rounded-full ${
                  isConnected ? 'bg-[#00FF88] animate-pulse' : 
                  isConnecting ? 'bg-amber-400 animate-pulse' : 'bg-[#FF4D4D]'
                }`}></span>
                <span className={`text-[11px] font-medium leading-none ${
                  isConnected ? 'text-[#00FF88]' : 
                  isConnecting ? 'text-amber-400' : 'text-[#FF4D4D]'
                }`}>
                  {isConnected ? 'Online & Linked' : isConnecting ? 'Connecting...' : 'Offline'}
                </span>
              </div>
            </div>
          </div>

          {/* Top Actions */}
          <div className="flex items-center space-x-2">
            <button
              onClick={() => fetchStatus(true)}
              title="Refresh Status"
              className="w-9 h-9 rounded-[10px] bg-[#0A101A] border-[1.5px] border-[#1E293B] hover:border-[#00FF88] text-[#94A3B8] hover:text-[#FFFFFF] flex items-center justify-center transition-colors relative"
            >
              <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
              <RefreshCcw className={`w-4 h-4 ${refreshing ? 'animate-spin text-[#00FF88]' : ''}`} />
            </button>

            {isAuthenticated ? (
              <button
                onClick={handleLock}
                title="Lock Dashboard (Passkey Protected)"
                className="flex items-center space-x-1.5 px-3 py-2 rounded-[10px] bg-[#0A1F14] border border-[#14532D] hover:border-[#FF4D4D] text-[#00FF88] hover:text-[#FF4D4D] text-[11px] font-bold transition-colors cursor-pointer"
              >
                <Unlock className="w-3.5 h-3.5" />
                <span>Admin</span>
              </button>
            ) : (
              <button
                onClick={() => {
                  setAuthError('');
                  setShowUnlockModal(true);
                }}
                title="Enter passkey to unlock admin controls"
                className="flex items-center space-x-1.5 px-3 py-2 rounded-[10px] bg-[#1A1408] border border-[#78350F] hover:border-amber-400 text-amber-400 text-[11px] font-bold transition-colors cursor-pointer"
              >
                <Lock className="w-3.5 h-3.5" />
                <span>Unlock</span>
              </button>
            )}
          </div>
        </header>

        {/* MAIN BODY CONTENT BASED ON ACTIVE TAB */}
        <main className="flex-1 p-4 space-y-4">
          
          {/* TAB 1: HOME (DASHBOARD & QUICK CONTROLS) */}
          {activeTab === 'home' && (
            <div className="space-y-4">
              {/* Status Hero Card */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B]">System Status</span>
                  <div className={`px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-[1px] flex items-center space-x-1.5 border ${
                    isConnected ? 'bg-[#0A1F14] text-[#00FF88] border-[#14532D]' : 'bg-[#1F0A0A] text-[#FF4D4D] border-[#531414]'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? 'bg-[#00FF88]' : 'bg-[#FF4D4D]'}`}></span>
                    <span>{isConnected ? 'Active & Ready' : 'Disconnected'}</span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-3 pt-2">
                  <div className="bg-[#05070A] border-[1.5px] border-[#1E293B] rounded-[12px] p-3">
                    <span className="text-[11px] text-[#64748B] block">Uptime</span>
                    <span className="text-[15px] font-bold font-mono text-[#FFFFFF] mt-0.5 block">
                      {formatUptime(data?.uptime || 0)}
                    </span>
                  </div>
                  <div className="bg-[#05070A] border-[1.5px] border-[#1E293B] rounded-[12px] p-3">
                    <span className="text-[11px] text-[#64748B] block">Command Mode</span>
                    <span className="text-[15px] font-bold uppercase text-[#00FF88] mt-0.5 block">
                      {data?.config?.mode || 'PUBLIC'}
                    </span>
                  </div>
                </div>

                {/* Session JID info */}
                <div className="mt-3 pt-3 border-t border-[#111827] flex items-center justify-between text-[12px]">
                  <span className="text-[#64748B]">Linked Phone:</span>
                  <span className="font-mono text-[#FFFFFF] font-medium">
                    {data?.config?.owner ? `+${data.config.owner}` : 'Not registered yet'}
                  </span>
                </div>
              </div>

              {/* Voicemail Status Banner */}
              <div 
                onClick={() => setActiveTab('voicemail')}
                className="bg-gradient-to-r from-[#0C1E14] via-[#0A161A] to-[#0A101A] border-[1.5px] border-[#14532D] hover:border-[#00FF88] rounded-[16px] p-4 relative overflow-hidden transition-all cursor-pointer group shadow-lg"
              >
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#00FF88]/40"></div>
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    <div className="w-10 h-10 rounded-[12px] bg-[#00FF88]/10 border border-[#00FF88]/30 flex items-center justify-center text-[#00FF88] group-hover:scale-105 transition-transform">
                      <Mic className="w-5 h-5 animate-pulse" />
                    </div>
                    <div>
                      <div className="flex items-center space-x-2">
                        <span className="text-[14px] font-bold text-[#FFFFFF]">Voicemail Answering Machine</span>
                        <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider ${
                          data?.config?.voicemailEnabled !== false 
                            ? 'bg-[#00FF88]/20 text-[#00FF88] border border-[#00FF88]/40' 
                            : 'bg-zinc-800 text-zinc-400 border border-zinc-700'
                        }`}>
                          {data?.config?.voicemailEnabled !== false ? 'Active' : 'Disabled'}
                        </span>
                      </div>
                      <p className="text-[12px] text-[#94A3B8] mt-0.5">
                        {voicemailsList.length} caller messages in inbox • Auto-plays voice note on calls
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-[#64748B] group-hover:text-[#00FF88] transition-colors" />
                </div>
              </div>

              {/* Quick Feature Toggles */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                <h3 className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] mb-3">Live Automations</h3>

                <div className="space-y-2.5">
                  {[
                    { key: 'voicemailEnabled', label: '🎙️ Voicemail Answering Machine', desc: 'Answers calls automatically and plays voice greeting', val: data?.config?.voicemailEnabled !== false },
                    { key: 'stealthMode', label: '👻 Stealth / Ghost Mode', desc: 'Invisible operation: no blue ticks, hides typing status', val: !!data?.config?.stealthMode },
                    { key: 'antiCall', label: '📵 Anti-Call Shield', desc: 'Auto-declines WhatsApp voice and video calls', val: !!data?.config?.antiCall },
                    { key: 'dnd', label: '🔕 Do Not Disturb (DND)', desc: 'Silently ignores commands from non-owner users', val: !!data?.config?.dnd },
                    { key: 'antiDelete', label: '🕵️ Anti-Delete Guard', desc: 'Logs deleted messages sent in chats', val: !!data?.config?.antiDelete },
                    { key: 'autoRead', label: 'Auto Mark as Read', desc: 'Instantly reads incoming user messages', val: !!data?.config?.autoRead },
                    { key: 'autoStatusReact', label: 'Auto Status Reaction', desc: 'Reacts automatically to WhatsApp status updates', val: !!data?.config?.autoStatusReact },
                    { key: 'antiLink', label: 'Anti-Link Protection', desc: 'Deletes unauthorized invitation links in groups', val: !!data?.config?.antiLink },
                    { key: 'shortDelay', label: 'Human Delay Mode', desc: 'Simulates natural typing & reading delays', val: !!data?.config?.shortDelay },
                  ].map((item) => (
                    <div 
                      key={item.key}
                      onClick={() => handleToggleSetting(item.key as keyof BotConfig, item.val)}
                      className="flex items-center justify-between p-3 rounded-[12px] bg-[#05070A] border-[1.5px] border-[#1E293B] hover:border-[#2A3A52] transition-colors cursor-pointer group"
                    >
                      <div className="pr-3">
                        <span className="text-[13px] font-bold text-[#FFFFFF] block">{item.label}</span>
                        <span className="text-[11px] text-[#64748B] block mt-0.5">{item.desc}</span>
                      </div>
                      <div className={`w-11 h-6 rounded-full transition-colors relative flex items-center p-0.5 shrink-0 ${
                        item.val ? 'bg-[#00FF88]' : 'bg-[#1E293B]'
                      }`}>
                        <div className={`w-5 h-5 rounded-full bg-[#05070A] transition-transform ${
                          item.val ? 'translate-x-5' : 'translate-x-0'
                        }`}></div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Bot Control Operations */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                <h3 className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] mb-3">System Actions</h3>

                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={handleReconnect}
                    className="p-3 rounded-[12px] bg-[#05070A] border-[1.5px] border-[#1E293B] hover:border-[#00FF88] text-left transition-colors group cursor-pointer"
                  >
                    <RefreshCcw className="w-4 h-4 text-[#00FF88] mb-1.5" />
                    <span className="text-[13px] font-bold text-[#FFFFFF] block">Reconnect</span>
                    <span className="text-[10px] text-[#64748B] block">Restart Baileys socket</span>
                  </button>

                  <button
                    onClick={handleDisconnect}
                    className="p-3 rounded-[12px] bg-[#05070A] border-[1.5px] border-[#531414] hover:bg-[#1F0A0A] text-left transition-colors group cursor-pointer"
                  >
                    <PowerOff className="w-4 h-4 text-[#FF4D4D] mb-1.5" />
                    <span className="text-[13px] font-bold text-[#FF4D4D] block">Disconnect</span>
                    <span className="text-[10px] text-[#64748B] block">Unlink active device</span>
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: PAIRING (DEVICE LINKING) */}
          {activeTab === 'pairing' && (
            <div className="space-y-4">
              {!isAuthenticated ? (
                <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-6 text-center space-y-4 relative overflow-hidden">
                  <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                  <div className="w-12 h-12 rounded-[14px] bg-[#05070A] border border-[#1E293B] mx-auto flex items-center justify-center text-amber-400">
                    <Lock className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="text-[16px] font-bold text-[#FFFFFF]">Admin Authentication Required</h3>
                    <p className="text-[12px] text-[#94A3B8] mt-1 max-w-xs mx-auto">
                      Device linking and pairing codes are restricted to protect your WhatsApp credentials from unauthorized access.
                    </p>
                  </div>
                  <button
                    onClick={() => setShowUnlockModal(true)}
                    className="px-5 py-2.5 rounded-[10px] bg-[#00FF88] text-[#000000] text-[13px] font-bold uppercase tracking-[1px] hover:bg-[#00FF88]/90 transition-all cursor-pointer active:scale-95"
                  >
                    Unlock Admin Access
                  </button>
                </div>
              ) : (
                <>
                  {/* Method Switcher */}
                  <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[14px] p-1 flex space-x-1 relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                <button
                  onClick={() => setPairingMethod('pairing')}
                  className={`flex-1 py-2.5 rounded-[10px] text-[12px] font-bold uppercase tracking-[1px] transition-all flex items-center justify-center space-x-2 ${
                    pairingMethod === 'pairing'
                      ? 'bg-[#111A28] text-[#00FF88] border border-[#1E293B]'
                      : 'text-[#64748B] hover:text-[#FFFFFF]'
                  }`}
                >
                  <Smartphone className="w-4 h-4" />
                  <span>Pairing Code</span>
                </button>
                <button
                  onClick={() => setPairingMethod('qr')}
                  className={`flex-1 py-2.5 rounded-[10px] text-[12px] font-bold uppercase tracking-[1px] transition-all flex items-center justify-center space-x-2 ${
                    pairingMethod === 'qr'
                      ? 'bg-[#111A28] text-[#00FF88] border border-[#1E293B]'
                      : 'text-[#64748B] hover:text-[#FFFFFF]'
                  }`}
                >
                  <QrCode className="w-4 h-4" />
                  <span>Scan QR</span>
                </button>
              </div>

              {/* Pairing Code Card */}
              {pairingMethod === 'pairing' && (
                <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden">
                  <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

                  <div className="mb-4">
                    <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#00FF88] block">Step 1</span>
                    <h2 className="text-[18px] font-bold text-[#FFFFFF] mt-0.5">Request 8-Digit Token</h2>
                    <p className="text-[12px] text-[#94A3B8] mt-1 leading-relaxed">
                      Enter your phone number with country code. No QR scanner needed.
                    </p>
                  </div>

                  <form onSubmit={handleRequestPairing} className="space-y-4">
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-2">
                        WhatsApp Number
                      </label>
                      <div className="relative">
                        <span className="absolute left-4 top-1/2 -translate-y-1/2 text-[#4B5563] font-mono font-bold">+</span>
                        <input
                          type="text"
                          value={phoneNumber}
                          onChange={(e) => setPhoneNumber(e.target.value)}
                          placeholder="237651858408"
                          className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[12px] px-4 py-3 pl-8 text-[#FFFFFF] font-mono text-[15px] placeholder-[#4B5563] outline-none transition-colors"
                        />
                      </div>
                      <p className="text-[11px] text-[#64748B] mt-1.5">Include country code without + or leading 0.</p>
                    </div>

                    <button
                      type="submit"
                      disabled={pairingLoading || !phoneNumber.trim()}
                      className="w-full py-3.5 rounded-[12px] bg-[#00FF88] hover:bg-[#00FF88]/90 text-[#000000] font-bold text-[13px] uppercase tracking-[1.5px] transition-all flex items-center justify-center space-x-2 disabled:opacity-50 cursor-pointer active:scale-[0.98]"
                    >
                      {pairingLoading ? (
                        <RefreshCcw className="w-4 h-4 animate-spin text-[#000000]" />
                      ) : (
                        <>
                          <span>Generate Pairing Code</span>
                          <ChevronRight className="w-4 h-4" />
                        </>
                      )}
                    </button>
                  </form>

                  {/* Generated Code Display Card */}
                  {generatedCode && (
                    <div className="mt-5 p-4 rounded-[14px] bg-[#05070A] border-[1.5px] border-[#00FF88]/40 relative">
                      <div className="flex items-center justify-between mb-2">
                        <span className="text-[10px] font-bold uppercase tracking-[1.5px] text-[#00FF88]">Your Pairing Code</span>
                        <button
                          onClick={() => handleCopyCode(generatedCode)}
                          className="flex items-center space-x-1 text-[11px] font-bold text-[#00FF88] hover:underline"
                        >
                          {copiedCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                          <span>{copiedCode ? 'Copied' : 'Copy'}</span>
                        </button>
                      </div>

                      <div className="text-center py-3 bg-[#0A101A] rounded-[10px] border border-[#1E293B]">
                        <span className="text-[28px] font-mono font-bold tracking-[6px] text-[#00FF88]">
                          {generatedCode}
                        </span>
                      </div>

                      <div className="mt-3 text-[11px] text-[#94A3B8] space-y-1">
                        <p className="font-semibold text-[#FFFFFF]">How to link on your phone:</p>
                        <p>1. Open WhatsApp &gt; 3 dots (or Settings) &gt; <span className="text-[#FFFFFF]">Linked Devices</span></p>
                        <p>2. Tap <span className="text-[#FFFFFF]">Link a device</span> &gt; Choose <span className="text-[#00FF88]">Link with phone number instead</span></p>
                        <p>3. Enter the 8-digit code shown above</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* QR Code Card */}
              {pairingMethod === 'qr' && (
                <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 text-center relative overflow-hidden">
                  <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

                  <span className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#00FF88] block mb-1">Instant Pairing</span>
                  <h2 className="text-[18px] font-bold text-[#FFFFFF]">Scan WhatsApp QR</h2>
                  <p className="text-[12px] text-[#94A3B8] mt-1 mb-5">
                    Scan with your phone's camera in WhatsApp Linked Devices.
                  </p>

                  {data?.qr ? (
                    <div className="inline-block p-3 bg-[#FFFFFF] rounded-[16px] border border-[#1E293B]">
                      <img
                        src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(data.qr)}`}
                        alt="QR Code"
                        className="w-48 h-48 mx-auto"
                      />
                    </div>
                  ) : (
                    <div className="p-8 bg-[#05070A] rounded-[12px] border border-[#1E293B] text-center space-y-3">
                      <p className="text-[13px] text-[#94A3B8]">
                        {isConnected ? 'Device is already connected!' : 'QR code will appear when requested.'}
                      </p>
                      <button
                        onClick={handleReconnect}
                        className="px-4 py-2 rounded-[10px] bg-[#111A28] border border-[#1E293B] text-[#00FF88] text-[12px] font-bold uppercase tracking-[1px] hover:bg-[#1E293B] transition-colors"
                      >
                        Request New QR
                      </button>
                    </div>
                  )}
                </div>
              )}
                </>
              )}
            </div>
          )}

          {/* TAB 3: COMMANDS DIRECTORY */}
          {activeTab === 'commands' && (
            <div className="space-y-3">
              {/* Search & Filter Header */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-4 relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                
                {/* Search Bar */}
                <div className="relative mb-3">
                  <Search className="w-4 h-4 text-[#64748B] absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search bot commands..."
                    className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] py-2 pl-9 pr-3 text-[13px] text-[#FFFFFF] placeholder-[#64748B] outline-none"
                  />
                </div>

                {/* Category Chips Scroll */}
                <div className="flex space-x-1.5 overflow-x-auto pb-1 scrollbar-none">
                  {['all', 'general', 'download', 'group', 'utility', 'owner', 'protection', 'ai'].map((cat) => (
                    <button
                      key={cat}
                      onClick={() => setCommandCategory(cat)}
                      className={`px-3 py-1 rounded-[8px] text-[11px] font-bold uppercase tracking-[1px] shrink-0 transition-colors ${
                        commandCategory === cat
                          ? 'bg-[#00FF88] text-[#000000]'
                          : 'bg-[#05070A] border border-[#1E293B] text-[#64748B] hover:text-[#FFFFFF]'
                      }`}
                    >
                      {cat}
                    </button>
                  ))}
                </div>
              </div>

              {/* Commands List Cards */}
              <div className="space-y-2">
                {filteredCommands.length === 0 ? (
                  <div className="p-8 text-center text-[#64748B] text-[13px] bg-[#0A101A] rounded-[16px] border border-[#1E293B]">
                    No matching commands found.
                  </div>
                ) : (
                  filteredCommands.map((cmd) => {
                    const fullCmd = `${data?.config?.prefix || '.'}${cmd.name}`;
                    const isCopied = copiedCmd === fullCmd;
                    return (
                      <div
                        key={`${cmd.category}-${cmd.name}`}
                        onClick={() => handleCopyCommand(fullCmd)}
                        className="p-3.5 bg-[#0A101A] border-[1.5px] border-[#1E293B] hover:border-[#00FF88] rounded-[12px] flex items-center justify-between transition-colors cursor-pointer group relative"
                      >
                        <div className="pr-3">
                          <div className="flex items-center space-x-2">
                            <span className="font-mono font-bold text-[14px] text-[#00FF88]">
                              {fullCmd}
                            </span>
                            <span className="text-[9px] uppercase tracking-[1px] px-1.5 py-0.5 rounded bg-[#111A28] border border-[#1E293B] text-[#94A3B8]">
                              {cmd.category}
                            </span>
                          </div>
                          <p className="text-[12px] text-[#94A3B8] mt-1 leading-snug">
                            {cmd.description}
                          </p>
                          {cmd.aliases.length > 0 && (
                            <span className="text-[10px] text-[#64748B] block mt-1">
                              Aliases: {cmd.aliases.join(', ')}
                            </span>
                          )}
                        </div>

                        <div className="shrink-0 text-[#64748B] group-hover:text-[#00FF88] transition-colors">
                          {isCopied ? <Check className="w-4 h-4 text-[#00FF88]" /> : <Copy className="w-4 h-4" />}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}

          {/* TAB 4: CONSOLE LOGS */}
          {activeTab === 'logs' && (
            <div className="space-y-3">
              {/* Logs Controls */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[14px] p-2.5 flex items-center justify-between relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                
                {/* Filter Pills */}
                <div className="flex space-x-1">
                  {(['all', 'in', 'out', 'info', 'error'] as const).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setLogFilter(filter)}
                      className={`px-2.5 py-1 rounded-[6px] text-[10px] font-bold uppercase tracking-[1px] transition-colors ${
                        logFilter === filter
                          ? 'bg-[#00FF88] text-[#000000]'
                          : 'bg-[#05070A] text-[#64748B] hover:text-[#FFFFFF]'
                      }`}
                    >
                      {filter}
                    </button>
                  ))}
                </div>

                <button
                  onClick={handleClearLogs}
                  title="Clear Console"
                  className="px-2 py-1 rounded-[6px] bg-[#05070A] border border-[#1E293B] hover:border-[#FF4D4D] text-[#FF4D4D] text-[11px] font-medium flex items-center space-x-1 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Clear</span>
                </button>
              </div>

              {/* Terminal Screen */}
              <div className="bg-[#05070A] border-[1.5px] border-[#1E293B] rounded-[16px] p-4 font-mono text-[12px] min-h-[380px] max-h-[500px] overflow-y-auto space-y-2 relative">
                {filteredLogs.length === 0 ? (
                  <p className="text-[#4B5563] text-center pt-16">No logs recorded for this filter.</p>
                ) : (
                  filteredLogs.map((log) => {
                    const time = new Date(log.timestamp).toLocaleTimeString();
                    const color = 
                      log.type === 'error' ? 'text-[#FF4D4D]' :
                      log.type === 'in' ? 'text-[#00D1FF]' :
                      log.type === 'out' ? 'text-[#00FF88]' : 'text-[#94A3B8]';
                    return (
                      <div key={log.id} className="leading-relaxed flex items-start space-x-2">
                        <span className="text-[#4B5563] select-none shrink-0">{time}</span>
                        <span className={`px-1 rounded text-[10px] uppercase shrink-0 ${
                          log.type === 'error' ? 'bg-[#FF4D4D]/20 text-[#FF4D4D]' :
                          log.type === 'in' ? 'bg-[#00D1FF]/20 text-[#00D1FF]' :
                          log.type === 'out' ? 'bg-[#00FF88]/20 text-[#00FF88]' : 'bg-[#1E293B] text-[#94A3B8]'
                        }`}>
                          {log.type}
                        </span>
                        <span className={`${color} break-all flex-1`}>{log.message}</span>
                      </div>
                    );
                  })
                )}
                <div ref={logsEndRef}></div>
              </div>
            </div>
          )}

          {/* TAB 5: SETTINGS */}
          {activeTab === 'settings' && (
            <div className="space-y-4">
              <form onSubmit={handleSaveSettings} className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden space-y-4">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

                <div className="flex items-center justify-between mb-1">
                  <h2 className="text-[16px] font-bold text-[#FFFFFF]">Configuration</h2>
                  <span className="text-[11px] text-[#00FF88] font-mono">live sync</span>
                </div>

                {settingsSaved && (
                  <div className="p-3 bg-[#0A1F14] border border-[#14532D] rounded-[10px] text-[#00FF88] text-[12px] flex items-center space-x-2">
                    <Check className="w-4 h-4 shrink-0" />
                    <span>Configuration successfully updated and active!</span>
                  </div>
                )}

                {!isAuthenticated && (
                  <div className="p-3.5 rounded-[12px] bg-[#1F1707] border border-[#78350F] flex items-center justify-between text-[12px] text-amber-300">
                    <div className="flex items-center space-x-2">
                      <Lock className="w-4 h-4 shrink-0 text-amber-400" />
                      <span>Protected Mode: Passkey required to modify settings</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowUnlockModal(true)}
                      className="px-2.5 py-1 rounded-[8px] bg-amber-400/20 text-amber-300 font-bold hover:bg-amber-400/30 cursor-pointer"
                    >
                      Unlock
                    </button>
                  </div>
                )}

                {/* Bot Name */}
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-1.5">
                    Bot Display Name
                  </label>
                  <input
                    type="text"
                    value={settingsDraft.botName || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, botName: e.target.value })}
                    className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] px-3.5 py-2.5 text-[14px] text-[#FFFFFF] outline-none"
                  />
                </div>

                {/* Prefix & Mode */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-1.5">
                      Command Prefix
                    </label>
                    <input
                      type="text"
                      value={settingsDraft.prefix || ''}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, prefix: e.target.value })}
                      className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] px-3.5 py-2.5 font-mono text-[14px] text-[#FFFFFF] outline-none"
                    />
                  </div>

                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-1.5">
                      Access Mode
                    </label>
                    <select
                      value={settingsDraft.mode || 'public'}
                      onChange={(e) => setSettingsDraft({ ...settingsDraft, mode: e.target.value as 'public' | 'private' })}
                      className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] px-3.5 py-2.5 text-[14px] text-[#FFFFFF] outline-none cursor-pointer"
                    >
                      <option value="public">Public (Everyone)</option>
                      <option value="private">Private (Owner)</option>
                    </select>
                  </div>
                </div>

                {/* Owner Number */}
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-1.5">
                    Owner Phone JID
                  </label>
                  <input
                    type="text"
                    value={settingsDraft.owner || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, owner: e.target.value })}
                    placeholder="237651858408"
                    className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] px-3.5 py-2.5 font-mono text-[14px] text-[#FFFFFF] outline-none"
                  />
                </div>

                {/* Banner Image URL */}
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-1.5">
                    Menu Banner Image URL
                  </label>
                  <input
                    type="text"
                    value={settingsDraft.bannerUrl || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, bannerUrl: e.target.value })}
                    placeholder="https://..."
                    className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] px-3.5 py-2.5 text-[13px] text-[#FFFFFF] font-mono outline-none"
                  />
                </div>

                <button
                  type="submit"
                  disabled={savingSettings}
                  className="w-full py-3.5 rounded-[12px] bg-[#00FF88] hover:bg-[#00FF88]/90 text-[#000000] font-bold text-[13px] uppercase tracking-[1.5px] transition-all flex items-center justify-center space-x-2 cursor-pointer active:scale-[0.98]"
                >
                  {savingSettings ? (
                    <RefreshCcw className="w-4 h-4 animate-spin text-[#000000]" />
                  ) : (
                    <>
                      <span>Save Bot Settings</span>
                      <Check className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>

              {/* Environment Info */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden space-y-3">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>
                <h3 className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B]">Cloud Environment</h3>
                
                <div className="space-y-2 text-[12px]">
                  <div className="flex justify-between items-center py-1 border-b border-[#111827]">
                    <span className="text-[#64748B]">Database</span>
                    <span className="text-[#00FF88] font-mono font-medium">PostgreSQL (SSL Enabled)</span>
                  </div>
                  <div className="flex justify-between items-center py-1 border-b border-[#111827]">
                    <span className="text-[#64748B]">Engine</span>
                    <span className="text-[#FFFFFF] font-mono">Baileys Multi-Device v7.0</span>
                  </div>
                  <div className="flex justify-between items-center py-1">
                    <span className="text-[#64748B]">Auth Password Gate</span>
                    <span className="text-[#00FF88] font-mono">Active (process.env.DASHBOARD_PASSWORD)</span>
                  </div>
                </div>

                <button
                  onClick={handleLock}
                  className="w-full mt-2 py-3 rounded-[10px] bg-[#1F0A0A] border border-[#531414] hover:bg-[#2A0E0E] text-[#FF4D4D] text-[12px] font-bold uppercase tracking-[1px] transition-colors flex items-center justify-center space-x-2"
                >
                  <LogOut className="w-4 h-4" />
                  <span>Lock Out & Exit Session</span>
                </button>
              </div>
            </div>
          )}

          {/* TAB: VOICEMAIL ANSWERING MACHINE */}
          {activeTab === 'voicemail' && (
            <div className="space-y-4">
              {/* Voicemail Header & Live Status */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

                <div className="flex items-start justify-between mb-4">
                  <div>
                    <div className="flex items-center space-x-2">
                      <h2 className="text-[17px] font-bold text-[#FFFFFF]">Voicemail Answering Machine</h2>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-bold uppercase tracking-wider border ${
                        data?.config?.voicemailEnabled !== false
                          ? 'bg-[#0A1F14] text-[#00FF88] border-[#14532D]'
                          : 'bg-[#1F0A0A] text-[#FF4D4D] border-[#531414]'
                      }`}>
                        {data?.config?.voicemailEnabled !== false ? '● ACTIVE' : '● DISABLED'}
                      </span>
                    </div>
                    <p className="text-[12px] text-[#64748B] mt-1">
                      Intercepts incoming WhatsApp calls and delivers your voice greeting.
                    </p>
                  </div>

                  <button
                    onClick={() => handleToggleSetting('voicemailEnabled', data?.config?.voicemailEnabled !== false)}
                    className={`px-3 py-1.5 rounded-[10px] text-[12px] font-bold transition-all flex items-center space-x-1.5 cursor-pointer ${
                      data?.config?.voicemailEnabled !== false
                        ? 'bg-[#00FF88] text-[#000000] hover:bg-[#00FF88]/90'
                        : 'bg-[#1E293B] text-[#94A3B8] hover:text-[#FFFFFF]'
                    }`}
                  >
                    <PowerOff className="w-3.5 h-3.5" />
                    <span>{data?.config?.voicemailEnabled !== false ? 'Turn Off' : 'Turn On'}</span>
                  </button>
                </div>

                {/* Quick Settings Toggles */}
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <div 
                    onClick={() => handleToggleSetting('voicemailAutoForward', data?.config?.voicemailAutoForward !== false)}
                    className="bg-[#05070A] border-[1.5px] border-[#1E293B] hover:border-[#2A3A52] rounded-[12px] p-3 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-bold uppercase text-[#64748B]">Auto-Forward</span>
                      <div className={`w-3 h-3 rounded-full ${data?.config?.voicemailAutoForward !== false ? 'bg-[#00FF88]' : 'bg-[#334155]'}`} />
                    </div>
                    <span className="text-[13px] font-semibold text-[#FFFFFF] block">Owner WhatsApp Alert</span>
                    <span className="text-[10px] text-[#64748B] block mt-0.5">
                      {data?.config?.voicemailAutoForward !== false ? 'Sends audio & text to owner' : 'Disabled'}
                    </span>
                  </div>

                  <div 
                    onClick={() => handleToggleSetting('antiCall', !!data?.config?.antiCall)}
                    className="bg-[#05070A] border-[1.5px] border-[#1E293B] hover:border-[#2A3A52] rounded-[12px] p-3 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-[11px] font-bold uppercase text-[#64748B]">Ringing Mode</span>
                      <div className={`w-3 h-3 rounded-full ${data?.config?.antiCall ? 'bg-amber-400' : 'bg-[#00FF88]'}`} />
                    </div>
                    <span className="text-[13px] font-semibold text-[#FFFFFF] block">Answering Pickup</span>
                    <span className="text-[10px] text-[#64748B] block mt-0.5">
                      {data?.config?.antiCall ? 'Strict silent reject' : 'Simulate 1-2 rings & greet'}
                    </span>
                  </div>
                </div>
              </div>

              {/* Voice Greeting Studio */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden space-y-4">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-bold text-[#FFFFFF] flex items-center space-x-2">
                      <Volume2 className="w-4 h-4 text-[#00FF88]" />
                      <span>Voice Greeting Studio</span>
                    </h3>
                    <p className="text-[12px] text-[#64748B] mt-0.5">
                      Customize the audio message played to callers when they ring.
                    </p>
                  </div>

                  {/* Voice Language Selector */}
                  <select
                    value={settingsDraft.voicemailLang || 'en'}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, voicemailLang: e.target.value })}
                    className="bg-[#05070A] border-[1.5px] border-[#1E293B] rounded-[10px] px-3 py-1.5 text-[12px] text-[#00FF88] font-bold font-mono outline-none"
                  >
                    <option value="en">English (US/UK)</option>
                    <option value="es">Spanish (Español)</option>
                    <option value="fr">French (Français)</option>
                    <option value="pt">Portuguese (Português)</option>
                    <option value="de">German (Deutsch)</option>
                    <option value="sw">Swahili (Kiswahili)</option>
                    <option value="hi">Hindi (हिन्दी)</option>
                    <option value="id">Indonesian (Bahasa)</option>
                  </select>
                </div>

                {/* Preset Suggestions */}
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-2">
                    Quick Preset Greetings
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {[
                      {
                        label: 'Standard',
                        text: 'Hello! You have reached my automated voicemail. I am unable to answer your call right now. Please leave your name and message right after this tone, and I will get back to you shortly.'
                      },
                      {
                        label: 'Professional',
                        text: 'Thank you for calling. I am currently attending to business matters and cannot take your call. Please leave a detailed message and your callback number, and I will reach out as soon as possible.'
                      },
                      {
                        label: 'Casual',
                        text: 'Hey there! Sorry I missed your call. Leave me a quick voice note or text message right here and I will get back to you as soon as I can!'
                      },
                      {
                        label: 'In a Meeting',
                        text: 'Hi, I am currently in an important meeting and have silenced my phone. Please drop your message below and I will check it right after my meeting.'
                      }
                    ].map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        onClick={() => setSettingsDraft({ ...settingsDraft, voicemailGreeting: preset.text })}
                        className="px-2.5 py-1 rounded-[8px] bg-[#05070A] border border-[#1E293B] hover:border-[#00FF88] text-[11px] text-[#94A3B8] hover:text-[#FFFFFF] transition-colors cursor-pointer"
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Greeting Textarea */}
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-[1.5px] text-[#64748B] block mb-1.5">
                    Spoken Greeting Message
                  </label>
                  <textarea
                    rows={3}
                    value={settingsDraft.voicemailGreeting || ''}
                    onChange={(e) => setSettingsDraft({ ...settingsDraft, voicemailGreeting: e.target.value })}
                    placeholder="Enter the voice greeting you want the bot to say..."
                    className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] p-3 text-[13px] text-[#FFFFFF] outline-none resize-none leading-relaxed"
                  />
                  <div className="flex justify-between items-center mt-1 text-[11px] text-[#64748B]">
                    <span>Synthesized via WhatsApp Voice Note PTT Engine</span>
                    <span>{(settingsDraft.voicemailGreeting || '').length} characters</span>
                  </div>
                </div>

                {/* Audio Preview & Save Controls */}
                <div className="flex items-center space-x-3 pt-1">
                  <button
                    type="button"
                    onClick={handlePlayGreetingPreview}
                    disabled={previewLoading}
                    className="flex-1 py-3 rounded-[12px] bg-[#0E1A29] border border-[#1E3A5F] hover:border-[#00FF88] text-[#FFFFFF] text-[13px] font-bold flex items-center justify-center space-x-2 transition-all cursor-pointer group"
                  >
                    {previewLoading ? (
                      <RefreshCcw className="w-4 h-4 animate-spin text-[#00FF88]" />
                    ) : isPlayingPreview ? (
                      <>
                        <Pause className="w-4 h-4 text-[#00FF88]" />
                        <span className="text-[#00FF88]">Playing Voice Note...</span>
                        <div className="flex items-center space-x-0.5 ml-2">
                          <span className="w-1 h-3 bg-[#00FF88] animate-pulse"></span>
                          <span className="w-1 h-4 bg-[#00FF88] animate-pulse delay-75"></span>
                          <span className="w-1 h-2 bg-[#00FF88] animate-pulse delay-150"></span>
                        </div>
                      </>
                    ) : (
                      <>
                        <Play className="w-4 h-4 text-[#00FF88] fill-[#00FF88]" />
                        <span>Listen to Voice Greeting</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleSaveSettings}
                    disabled={savingSettings}
                    className="px-5 py-3 rounded-[12px] bg-[#00FF88] hover:bg-[#00FF88]/90 text-[#000000] font-bold text-[13px] uppercase tracking-wider flex items-center space-x-2 transition-all cursor-pointer active:scale-95"
                  >
                    {savingSettings ? (
                      <RefreshCcw className="w-4 h-4 animate-spin text-[#000000]" />
                    ) : (
                      <>
                        <Check className="w-4 h-4" />
                        <span>Save</span>
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Voicemail Inbox */}
              <div className="bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[16px] p-5 relative overflow-hidden space-y-4">
                <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-[15px] font-bold text-[#FFFFFF] flex items-center space-x-2">
                      <Mic className="w-4 h-4 text-[#00FF88]" />
                      <span>Voicemail Inbox ({voicemailsList.length})</span>
                    </h3>
                    <p className="text-[12px] text-[#64748B] mt-0.5">
                      Log of incoming calls, voice notes, and messages left by callers.
                    </p>
                  </div>

                  <div className="flex items-center space-x-2">
                    <button
                      onClick={fetchVoicemails}
                      title="Refresh Inbox"
                      className="w-8 h-8 rounded-[8px] bg-[#05070A] border border-[#1E293B] hover:border-[#00FF88] text-[#94A3B8] hover:text-[#FFFFFF] flex items-center justify-center transition-colors"
                    >
                      <RefreshCcw className={`w-3.5 h-3.5 ${loadingVoicemails ? 'animate-spin text-[#00FF88]' : ''}`} />
                    </button>

                    {voicemailsList.length > 0 && (
                      <button
                        onClick={handleClearVoicemails}
                        title="Clear Voicemail Inbox"
                        className="px-2.5 py-1.5 rounded-[8px] bg-[#1F0A0A] border border-[#531414] hover:bg-[#2A0E0E] text-[#FF4D4D] text-[11px] font-bold flex items-center space-x-1"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Clear</span>
                      </button>
                    )}
                  </div>
                </div>

                {voicemailNotice && (
                  <div className="p-3 bg-[#0A1F14] border border-[#14532D] rounded-[10px] text-[#00FF88] text-[12px]">
                    {voicemailNotice}
                  </div>
                )}

                {/* Inbox List */}
                <div className="space-y-2.5">
                  {voicemailsList.length === 0 ? (
                    <div className="text-center py-8 px-4 bg-[#05070A] border-[1.5px] border-[#1E293B] rounded-[12px]">
                      <PhoneMissed className="w-8 h-8 text-[#64748B] mx-auto mb-2 opacity-50" />
                      <p className="text-[13px] font-bold text-[#FFFFFF]">No Voicemails Recorded Yet</p>
                      <p className="text-[11px] text-[#64748B] mt-1 max-w-xs mx-auto">
                        When anyone calls your WhatsApp number, the answering machine will pick up, play your greeting, and record their message here!
                      </p>
                    </div>
                  ) : (
                    voicemailsList.map((vm) => {
                      const hasLeftMessage = vm.status === 'left_message';
                      return (
                        <div
                          key={vm.id}
                          className={`p-3.5 rounded-[12px] bg-[#05070A] border-[1.5px] transition-colors ${
                            hasLeftMessage ? 'border-[#14532D] hover:border-[#00FF88]' : 'border-[#1E293B] hover:border-[#2A3A52]'
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex items-center space-x-2.5">
                              <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                                hasLeftMessage ? 'bg-[#0A1F14] text-[#00FF88]' : 'bg-[#1F1707] text-amber-400'
                              }`}>
                                {hasLeftMessage ? <Mic className="w-4 h-4" /> : <PhoneMissed className="w-4 h-4" />}
                              </div>
                              <div>
                                <div className="flex items-center space-x-2">
                                  <span className="text-[13px] font-bold text-[#FFFFFF]">+{vm.callerNumber}</span>
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                                    hasLeftMessage ? 'bg-[#00FF88]/20 text-[#00FF88]' : 'bg-amber-400/20 text-amber-400'
                                  }`}>
                                    {hasLeftMessage ? 'Message Left' : 'Missed Call'}
                                  </span>
                                </div>
                                <span className="text-[11px] text-[#64748B] block mt-0.5">
                                  {new Date(vm.timestamp).toLocaleString()} • {vm.callType || 'voice'} call
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center space-x-1">
                              <a
                                href={`https://wa.me/${vm.callerNumber}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-2 py-1 rounded-[6px] bg-[#111A28] border border-[#1E293B] text-[11px] text-[#00FF88] font-bold hover:bg-[#1E293B] transition-colors"
                              >
                                Reply
                              </a>
                              <button
                                onClick={() => handleDeleteVoicemail(vm.id)}
                                className="w-7 h-7 rounded-[6px] text-[#64748B] hover:text-[#FF4D4D] flex items-center justify-center transition-colors"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>

                          {vm.messageText && (
                            <div className="mt-2.5 p-2.5 rounded-[8px] bg-[#0A101A] border border-[#1E293B] text-[12px] text-[#E2E8F0]">
                              <span className="text-[#64748B] text-[10px] uppercase font-bold tracking-wider block mb-0.5">
                                Caller Voicemail:
                              </span>
                              <p className="italic text-[#00FF88]">"{vm.messageText}"</p>
                            </div>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}
        </main>

        {/* NATIVE MOBILE BOTTOM NAVIGATION BAR */}
        <nav className="fixed bottom-0 inset-x-0 max-w-lg mx-auto z-40 bg-[#0A101A]/95 backdrop-blur-lg border-t-[1.5px] border-[#1E293B] px-1 py-2 flex items-center justify-around">
          <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

          {[
            { id: 'home', label: 'Home', icon: Radio },
            { id: 'pairing', label: 'Pair', icon: Smartphone },
            { id: 'voicemail', label: 'VoiceMail', icon: Mic },
            { id: 'commands', label: 'Cmds', icon: Zap },
            { id: 'logs', label: 'Logs', icon: Activity },
            { id: 'settings', label: 'Settings', icon: Sliders },
          ].map((item) => {
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveTab(item.id as TabType)}
                className={`flex-1 py-1 flex flex-col items-center justify-center relative transition-all group ${
                  isActive ? 'text-[#00FF88]' : 'text-[#64748B] hover:text-[#94A3B8]'
                }`}
              >
                {isActive && (
                  <div className="absolute -top-2 w-8 h-[2px] rounded-full bg-[#00FF88]"></div>
                )}
                <item.icon className={`w-4 h-4 mb-1 transition-transform ${isActive ? 'scale-110' : ''}`} />
                <span className={`text-[9px] font-bold uppercase tracking-[0.5px] ${isActive ? 'text-[#00FF88]' : 'text-[#64748B]'}`}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </nav>

        {/* ADMIN PASSKEY UNLOCK MODAL */}
        {showUnlockModal && (
          <div className="fixed inset-0 z-50 bg-[#000000]/80 backdrop-blur-sm flex items-center justify-center p-4">
            <div className="w-full max-w-sm bg-[#0A101A] border-[1.5px] border-[#1E293B] rounded-[24px] p-6 relative overflow-hidden shadow-2xl">
              <div className="absolute inset-x-0 top-0 h-[1px] bg-[#2A3A52]"></div>

              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-2.5">
                  <div className="w-9 h-9 rounded-[10px] bg-[#05070A] border border-[#1E293B] flex items-center justify-center text-[#00FF88]">
                    <Lock className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 className="text-[15px] font-bold text-[#FFFFFF]">Admin Passkey</h3>
                    <p className="text-[11px] text-[#64748B]">Unlock management actions</p>
                  </div>
                </div>
                <button
                  onClick={() => setShowUnlockModal(false)}
                  className="w-8 h-8 rounded-full bg-[#111A28] border border-[#1E293B] text-[#94A3B8] hover:text-[#FFFFFF] flex items-center justify-center transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {authError && (
                <div className="mb-4 p-3 bg-[#1F0A0A] border border-[#531414] rounded-[10px] flex items-center space-x-2.5 text-[#FF4D4D] text-[12px]">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{authError}</span>
                </div>
              )}

              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-[1px] text-[#64748B] block mb-1.5">
                    Master Passkey
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={passwordInput}
                      onChange={(e) => setPasswordInput(e.target.value)}
                      placeholder="Enter passkey..."
                      autoFocus
                      className="w-full bg-[#05070A] border-[1.5px] border-[#1E293B] focus:border-[#00FF88] rounded-[10px] px-3.5 py-2.5 pr-10 text-[#FFFFFF] text-[14px] font-mono placeholder-[#4B5563] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#FFFFFF]"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div className="flex space-x-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setShowUnlockModal(false)}
                    className="flex-1 py-2.5 rounded-[10px] bg-[#111A28] border border-[#1E293B] text-[#94A3B8] hover:text-[#FFFFFF] text-[12px] font-bold uppercase tracking-[1px] transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={loginLoading || !passwordInput.trim()}
                    className="flex-1 py-2.5 rounded-[10px] bg-[#00FF88] hover:bg-[#00FF88]/90 text-[#000000] font-bold text-[12px] uppercase tracking-[1px] transition-all flex items-center justify-center space-x-1.5 disabled:opacity-50 cursor-pointer"
                  >
                    {loginLoading ? (
                      <RefreshCcw className="w-4 h-4 animate-spin text-[#000000]" />
                    ) : (
                      <>
                        <span>Unlock</span>
                        <ChevronRight className="w-4 h-4" />
                      </>
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
