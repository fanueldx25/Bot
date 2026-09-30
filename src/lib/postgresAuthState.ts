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
import { encryptData, decryptData } from './encryption.ts';

export const usePostgresAuthState = async (sessionId: string = 'main'): Promise < { state: AuthenticationState, saveCreds: () => Promise < void > } > => {
  const writeData = async (data: any, id: string) => {
    const jsonStr = JSON.stringify(data, BufferJSON.replacer);
    const encryptedValue = encryptData(jsonStr);
    await db.insert(baileysAuthKeys)
      .values({ id, value: { encrypted: encryptedValue } })
      .onConflictDoUpdate({
        target: baileysAuthKeys.id,
        set: { value: { encrypted: encryptedValue } }
      });
  };
  
  const readData = async (id: string) => {
    try {
      const res = await db.select().from(baileysAuthKeys).where(eq(baileysAuthKeys.id, id));
      if (res.length > 0) {
        const valObj = res[0].value as any;
        const rawJson = valObj?.encrypted ? decryptData(valObj.encrypted) : JSON.stringify(valObj);
        return JSON.parse(rawJson, BufferJSON.reviver);
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
  let creds: AuthenticationCreds = initAuthCreds();
  if (credsRes.length > 0) {
    try {
      const credObj = credsRes[0].creds as any;
      const rawCredsJson = credObj?.encrypted ? decryptData(credObj.encrypted) : JSON.stringify(credObj);
      creds = JSON.parse(rawCredsJson, BufferJSON.reviver);
    } catch (e) {
      creds = initAuthCreds();
    }
  }
  
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data: {
            [key: string]: any } = {};
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
          const tasks: Promise < void > [] = [];
          for (const category in data) {
            for (const id in data[category as keyof SignalDataTypeMap]) {
              const value = data[category as keyof SignalDataTypeMap] ![id];
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
      const jsonStr = JSON.stringify(creds, BufferJSON.replacer);
      const encryptedValue = encryptData(jsonStr);
      await db.insert(baileysAuthCreds)
        .values({ id: sessionId, creds: { encrypted: encryptedValue } })
        .onConflictDoUpdate({
          target: baileysAuthCreds.id,
          set: { creds: { encrypted: encryptedValue } }
        });
    }
  };
};