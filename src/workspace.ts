import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './types.js';

const IGNORE = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.turbo']);

export class FsWorkspace implements Workspace {
  constructor(public readonly root: string) {}
  
  private abs(p: string): string {
    const full = path.resolve(this.root, p);
    const base = path.resolve(this.root);
    if (full !== base && !full.startsWith(base + path.sep)) {
      throw new Error(`Refusing path outside workspace: ${p}`);
    }
    return full;
  }
  
  read(p: string) { return fs.readFile(this.abs(p), 'utf8'); }
  async exists(p: string) { try { await fs.access(this.abs(p)); return true; } catch { return false; } }
  
  async write(p: string, content: string) {
    const full = this.abs(p);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content, 'utf8');
  }
  
  async list(): Promise < string[] > {
    const out: string[] = [];
    const walk = async (dir: string) => {
      for (const e of await fs.readdir(dir, { withFileTypes: true })) {
        if (IGNORE.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) await walk(full);
        else if (/\.(ts|tsx|js|mjs|cjs|json)$/.test(e.name)) {
          out.push(path.relative(this.root, full).split(path.sep).join('/'));
        }
      }
    };
    await walk(this.root);
    return out.sort();
  }
  
  async snapshot(): Promise < Record < string, string >> {
    const files = await this.list();
    const snap: Record < string, string > = {};
    for (const f of files) {
      try { snap[f] = await this.read(f); } catch { /* skip */ }
    }
    return snap;
  }
}