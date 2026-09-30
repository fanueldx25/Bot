import {
  AuthenticationCreds,
  AuthenticationState,
  BufferJSON,
  initAuthCreds,
  proto,
  SignalDataTypeMap
} from '@whiskeysockets/baileys';
import { db } from '../db/index.ts';
import { baileysAuthCreds, baileysAuthKeys } from '../db/schema.ts';
import { eq } from 'drizzle-orm';

export const usePostgresAuthState = async (sessionId: string = 'main'): Promise<{ state: AuthenticationState, saveCreds: () => Promise<void> }> => {
  const writeData = async (data: any, id: string) => {
    const value = JSON.stringify(data, BufferJSON.replacer);
    await db.insert(baileysAuthKeys)
      .values({ id, value: JSON.parse(value) })
      .onConflictDoUpdate({
        target: baileysAuthKeys.id,
        set: { value: JSON.parse(value) }
      });
  };

  const readData = async (id: string) => {
    try {
      const res = await db.select().from(baileysAuthKeys).where(eq(baileysAuthKeys.id, id));
      if (res.length > 0) {
        return JSON.parse(JSON.stringify(res[0].value), BufferJSON.reviver);
      }
      return null;
    } catch (error) {
      return null;
    }
  };

  const removeData = async (id: string) => {
    await db.delete(baileysAuthKeys).where(eq(baileysAuthKeys.id, id));
  };

  const credsRes = await db.select().from(baileysAuthCreds).where(eq(baileysAuthCreds.id, sessionId));
  let creds: AuthenticationCreds = credsRes.length > 0 
    ? JSON.parse(JSON.stringify(credsRes[0].creds), BufferJSON.reviver)
    : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: { [key: string]: any } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}:${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks: Promise<void>[] = [];
          for (const category in data) {
            for (const id in data[category as keyof SignalDataTypeMap]) {
              const value = data[category as keyof SignalDataTypeMap]![id];
              const key = `${category}:${id}`;
              if (value) {
                tasks.push(writeData(value, key));
              } else {
                tasks.push(removeData(key));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      const value = JSON.stringify(creds, BufferJSON.replacer);
      await db.insert(baileysAuthCreds)
        .values({ id: sessionId, creds: JSON.parse(value) })
        .onConflictDoUpdate({
          target: baileysAuthCreds.id,
          set: { creds: JSON.parse(value) }
        });
    }
  };
};
