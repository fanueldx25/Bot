import { db } from '../db/index.ts';
import { botConfig, botLogs } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

export interface Config {
  owner: string;
  prefix: string;
  mode: 'public' | 'private';
  botName: string;
  autoRead: boolean;
  alwaysTyping: boolean;
  alwaysRecording: boolean;
  shortDelay: boolean;
  bannerUrl: string;
  antiLink: boolean;
  antiDelete: boolean;
  autoStatusReact: boolean;
  // Privacy & Security Suite
  stealthMode?: boolean;
  antiCall?: boolean;
  dnd?: boolean;
  antiViewOnce?: boolean;
  ephemeralDuration?: number;
  // Voicemail Answering Machine System
  voicemailEnabled?: boolean;
  voicemailGreeting?: string;
  voicemailLang?: string;
  voicemailAutoForward?: boolean;
}

export const DEFAULT_CONFIG: Config = {
  owner: "",
  prefix: ".",
  mode: "public",
  botName: "Fanuel Bot",
  autoRead: true,
  alwaysTyping: false,
  alwaysRecording: false,
  shortDelay: true,
  bannerUrl: "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?q=80&w=1000&auto=format&fit=crop",
  antiLink: false,
  antiDelete: false,
  autoStatusReact: true,
  stealthMode: false,
  antiCall: false,
  dnd: false,
  antiViewOnce: true,
  ephemeralDuration: 0,
  // Voicemail Answering Machine Defaults
  voicemailEnabled: true,
  voicemailGreeting: "Hello! You have reached my automated voicemail. I am unable to answer your call right now. Please leave your name and message right after this tone, and I will get back to you shortly.",
  voicemailLang: "en",
  voicemailAutoForward: true
};

let cachedConfig: Config | null = null;
let lastConfigFetch = 0;

export const getConfig = async (): Promise<Config> => {
  const now = Date.now();
  if (cachedConfig && now - lastConfigFetch < 10000) {
    return cachedConfig;
  }
  try {
    const res = await db.select().from(botConfig).where(eq(botConfig.id, 1));
    if (res.length > 0) {
      cachedConfig = { ...DEFAULT_CONFIG, ...(res[0].config as any) };
    } else {
      await db.insert(botConfig).values({ id: 1, config: DEFAULT_CONFIG });
      cachedConfig = DEFAULT_CONFIG;
    }
  } catch (error) {
    cachedConfig = cachedConfig || DEFAULT_CONFIG;
  }
  lastConfigFetch = now;
  return cachedConfig || DEFAULT_CONFIG;
};

export const updateConfig = async (newConfig: Partial<Config>): Promise<Config> => {
  const current = await getConfig();
  const updated = { ...current, ...newConfig };
  await db.insert(botConfig)
    .values({ id: 1, config: updated })
    .onConflictDoUpdate({
      target: botConfig.id,
      set: { config: updated }
    });
  cachedConfig = updated;
  lastConfigFetch = Date.now();
  return updated;
};

export const addLog = async (message: string, type: 'info' | 'error' | 'in' | 'out' = 'info') => {
  try {
    await db.insert(botLogs).values({ message, type });
  } catch (err) {
    console.error('Failed to save log to DB', err);
  }
};

export const getLogs = async (limit = 100) => {
  try {
    return await db.select().from(botLogs).orderBy(botLogs.timestamp).limit(limit);
  } catch (err) {
    console.error('Failed to get logs from DB:', err);
    return [];
  }
};
