import { relations } from 'drizzle-orm';
import { jsonb, pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core';

// --- AUTH TABLES ---
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  uid: text('uid').notNull().unique(), // Firebase Auth UID
  email: text('email').notNull(),
  createdAt: timestamp('created_at').defaultNow(),
});

// --- WHATSAPP AUTH TABLES (Baileys) ---
export const baileysAuthCreds = pgTable('baileys_auth_creds', {
  id: text('id').primaryKey(), // Usually "main" or similar
  creds: jsonb('creds').notNull(),
});

export const baileysAuthKeys = pgTable('baileys_auth_keys', {
  id: text('id').primaryKey(), // Key ID (e.g. "session:...")
  value: jsonb('value').notNull(),
});

// --- BOT CONFIG & LOGS ---
export const botConfig = pgTable('bot_config', {
  id: serial('id').primaryKey(),
  config: jsonb('config').notNull(),
});

export const botLogs = pgTable('bot_logs', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  message: text('message').notNull(),
  type: text('type').notNull(), // 'info' | 'error' | 'in' | 'out'
});

// --- VOICEMAIL SYSTEM ---
export const voicemails = pgTable('voicemails', {
  id: serial('id').primaryKey(),
  callerNumber: text('caller_number').notNull(),
  callerName: text('caller_name'),
  callId: text('call_id').notNull(),
  callType: text('call_type').default('voice').notNull(), // 'voice' | 'video'
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  status: text('status').default('missed').notNull(), // 'missed' | 'left_message' | 'listened'
  messageText: text('message_text'),
  isVoiceNote: text('is_voice_note').default('false'),
  audioUrl: text('audio_url'),
});

// --- RELATIONSHIPS ---
export const usersRelations = relations(users, ({ many }) => ({
  // Add relations here as needed
}));
