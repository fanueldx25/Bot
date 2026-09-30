import { 
  proto, 
  WASocket, 
  downloadContentFromMessage, 
  MediaType 
} from '@whiskeysockets/baileys';
import fs from 'fs';
import path from 'path';
import { addLog } from './config.ts';

export interface CommandContext {
  sock: WASocket;
  from: string;
  mek: any;
  command: string;
  args: string[];
  q: string;
  prefix: string;
  sender: string;
  isOwner: boolean;
  pushName: string;
}

export interface Command {
  name: string;
  aliases?: string[];
  category: 'general' | 'ai' | 'download' | 'group' | 'status' | 'media' | 'utility' | 'owner';
  description: string;
  execute: (ctx: CommandContext) => Promise<void>;
}

const commands = new Map<string, Command>();

export const registerCommand = (cmd: Command) => {
  commands.set(cmd.name, cmd);
  if (cmd.aliases) {
    for (const alias of cmd.aliases) {
      commands.set(alias, cmd);
    }
  }
};

export const getCommand = (name: string) => commands.get(name);
export const getAllCommands = () => {
  const unique = new Map<string, Command>();
  for (const cmd of commands.values()) {
    if (!unique.has(cmd.name)) {
      unique.set(cmd.name, cmd);
    }
  }
  return Array.from(unique.values());
};

export const downloadMedia = async (message: any, pathFile: string) => {
  const type = Object.keys(message)[0] as MediaType;
  const msg = message[type];
  const stream = await downloadContentFromMessage(msg, type);
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  fs.writeFileSync(pathFile, buffer);
  return pathFile;
};

export const reply = async (sock: WASocket, from: string, text: string, quoted?: any) => {
  return await sock.sendMessage(from, { text }, { quoted });
};
