import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

interface TempFile {
  filePath: string;
  fileName: string;
  expires: number;
}

const tempFiles = new Map<string, TempFile>();

// Auto-cleanup every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, file] of tempFiles.entries()) {
    if (now > file.expires) {
      try {
        if (fs.existsSync(file.filePath)) fs.unlinkSync(file.filePath);
      } catch {}
      tempFiles.delete(id);
    }
  }
}, 10 * 60 * 1000);

export function saveTempDownload(filePath: string, fileName: string) {
  const id = crypto.randomBytes(8).toString('hex');
  const expires = Date.now() + 20 * 60 * 1000; // 20 minutes
  
  tempFiles.set(id, { filePath, fileName, expires });
  
  const baseUrl = process.env.APP_URL || '';
  return {
    id,
    url: `${baseUrl}/api/download/${id}`
  };
}

export function getTempFile(id: string) {
  return tempFiles.get(id);
}
