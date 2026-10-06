import { randomUUID } from 'node:crypto';

export type MemoryKind = 'fact' | 'decision' | 'error' | 'plan' | 'observation' | 'note';

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  tags: string[];
  /** Plan step id or phase name that produced it. */
  source?: string;
  ts: number;
  /** 0–1, how important. Used for pruning and ranking. */
  weight: number;
}

export interface RecallQuery {
  /** Free text — matched case-insensitively across text + tags. */
  text?: string;
  kinds?: MemoryKind[];
  tags?: string[];
  /** Only entries newer than this epoch ms. */
  since?: number;
  /** Max entries to return. */
  limit?: number;
  /** Order: 'recent' (default) or 'weight'. */
  order?: 'recent' | 'weight';
}

/**
 * A small, in-process memory store. Backed by an array, ranked by
 * recency + weight + tag overlap. Nothing fancy — no embeddings,
 * no vector DB, no network. The whole point is that it's inspectable.
 */
export class MemoryStore {
  private entries: MemoryEntry[] = [];
  private readonly maxEntries: number;

  constructor(opts: { maxEntries?: number } = {}) {
    this.maxEntries = opts.maxEntries ?? 500;
  }

  add(input: Omit<MemoryEntry, 'id' | 'ts' | 'weight'> & { weight?: number }): MemoryEntry {
    const entry: MemoryEntry = {
      id: randomUUID(),
      ts: Date.now(),
      weight: input.weight ?? defaultWeight(input.kind),
      ...input,
    };
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      // Drop the lowest-weight, oldest entries first.
      this.entries.sort((a, b) => score(b) - score(a));
      this.entries = this.entries.slice(0, this.maxEntries);
    }
    return entry;
  }

  recall(q: RecallQuery = {}): MemoryEntry[] {
    const now = Date.now();
    let pool = this.entries;

    if (q.kinds?.length) pool = pool.filter(e => q.kinds!.includes(e.kind));
    if (q.tags?.length)  pool = pool.filter(e => q.tags!.some(t => e.tags.includes(t)));
    if (q.since)         pool = pool.filter(e => e.ts >= q.since!);
    if (q.text) {
      const needle = q.text.toLowerCase();
      pool = pool.filter(e =>
        e.text.toLowerCase().includes(needle) ||
        e.tags.some(t => t.toLowerCase().includes(needle)));
    }

    const ranked = pool.slice().sort((a, b) => {
      if (q.order === 'weight') return b.weight - a.weight || b.ts - a.ts;
      // recent
      return b.ts - a.ts;
    });

    return ranked.slice(0, q.limit ?? 20);
  }

  /** Compact rendering for prompt injection. */
  digest(q: RecallQuery = {}, header = 'Session memory'): string {
    const entries = this.recall({ limit: 12, ...q });
    if (!entries.length) return '';
    return [
      `# ${header}`,
      ...entries.map(e => `[${e.kind}] ${truncate(e.text, 240)}${e.source ? ` (${e.source})` : ''}`),
    ].join('\n');
  }

  all(): MemoryEntry[] { return this.entries.slice(); }
  size(): number { return this.entries.length; }
  clear(): void { this.entries = []; }

  /** Serialize for persistence or checkpointing. */
  toJSON(): { entries: MemoryEntry[] } { return { entries: this.entries }; }
  static fromJSON(j: { entries: MemoryEntry[] }): MemoryStore {
    const m = new MemoryStore();
    m.entries = j.entries ?? [];
    return m;
  }
}

function defaultWeight(kind: MemoryKind): number {
  switch (kind) {
    case 'decision':    return 0.9;
    case 'error':       return 0.8;
    case 'plan':        return 0.7;
    case 'fact':        return 0.6;
    case 'observation': return 0.3;
    case 'note':        return 0.4;
  }
}
function score(e: MemoryEntry) { return e.weight * 1e12 + e.ts; }
function truncate(s: string, n: number) { return s.length <= n ? s : s.slice(0, n) + '…'; }