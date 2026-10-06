/** Every failure in the engine gets classified into one of these. */
export type ErrorKind =
  | 'network'         // transient fetch failure
  | 'rate-limit'      // 429, retry after backoff
  | 'auth'            // 401/403, do not retry
  | 'server'          // 5xx from provider, retry with backoff
  | 'timeout'         // request or tool timed out
  | 'tool'            // tool returned ok:false, deterministic
  | 'validation'      // bad shape from model or args, retry once
  | 'budget'          // ran out of turns/attempts
  | 'internal'        // unexpected, treat as fatal
  | 'unknown';

export interface ClassifiedError {
  kind: ErrorKind;
  retryable: boolean;
  fatal: boolean;
  /** Backoff hint in ms; undefined means no delay. */
  backoffMs?: number;
  message: string;
  cause?: unknown;
}

export function classify(err: unknown): ClassifiedError {
  const message = err instanceof Error ? err.message : String(err);
  const anyErr = err as any;

  // Fetch / network
  if (anyErr?.name === 'AbortError') {
    return { kind: 'timeout', retryable: true, fatal: false, backoffMs: 400, message };
  }
  if (anyErr?.name === 'TypeError' && /fetch|network/i.test(message)) {
    return { kind: 'network', retryable: true, fatal: false, backoffMs: 800, message };
  }

  // HTTP status sniffing (our AIClient throws "AI 429: ..." etc.)
  const httpMatch = /^AI (\d{3})/.exec(message);
  if (httpMatch) {
    const code = Number(httpMatch[1]);
    if (code === 401 || code === 403) return { kind: 'auth', retryable: false, fatal: true, message };
    if (code === 429) return { kind: 'rate-limit', retryable: true, fatal: false, backoffMs: 2000, message };
    if (code >= 500)  return { kind: 'server', retryable: true, fatal: false, backoffMs: 1500, message };
    if (code === 400) return { kind: 'validation', retryable: true, fatal: false, backoffMs: 200, message };
  }

  if (/timeout|timed out|ETIMEDOUT/i.test(message)) {
    return { kind: 'timeout', retryable: true, fatal: false, backoffMs: 800, message };
  }
  if (/non-json|json/i.test(message) && /model|parse/i.test(message)) {
    return { kind: 'validation', retryable: true, fatal: false, backoffMs: 200, message };
  }
  if (/budget|exhausted/i.test(message)) {
    return { kind: 'budget', retryable: false, fatal: false, message };
  }

  return { kind: 'unknown', retryable: false, fatal: true, message, cause: err };
}

/** Retry with exponential backoff, honoring classify(). */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    baseMs?: number;
    maxMs?: number;
    onRetry?: (attempt: number, err: ClassifiedError) => void;
  } = {},
): Promise<T> {
  const max = opts.maxAttempts ?? 4;
  const base = opts.baseMs ?? 500;
  const cap = opts.maxMs ?? 8000;

  let last: ClassifiedError | null = null;

  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const c = classify(err);
      last = c;
      if (!c.retryable || attempt === max) throw err;
      opts.onRetry?.(attempt, c);
      const delay = Math.min(cap, c.backoffMs ?? base) * Math.pow(2, attempt - 1);
      // jitter
      const jitter = delay * (0.7 + Math.random() * 0.6);
      await sleep(jitter);
    }
  }
  throw last?.cause ?? new Error(last?.message ?? 'retry exhausted');
}

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));