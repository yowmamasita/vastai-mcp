import pc from 'picocolors';

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function usd(n: number | null | undefined, digits = 4): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '?';
  return `$${n.toFixed(digits)}`;
}

export function gb(mb: number | null | undefined): string {
  if (!mb) return '?';
  return `${Math.round(mb / 1024)} GB`;
}

export function mbps(n: number | null | undefined): string {
  if (!n) return '?';
  return n >= 1000 ? `${(n / 1000).toFixed(1)} Gb/s` : `${Math.round(n)} Mb/s`;
}

export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '?';
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, '0')}m`;
}

export function table(headers: string[], rows: string[][]): string {
  const strip = (s: string) => s.replace(ANSI, '');
  const widths = headers.map((h, i) => Math.max(strip(h).length, ...rows.map((r) => strip(r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => c + ' '.repeat(Math.max(0, widths[i] - strip(c).length))).join('  ').trimEnd();
  return [pc.bold(line(headers)), ...rows.map(line)].join('\n');
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface RetryOptions {
  attempts?: number;
  baseDelayMs?: number;
  /** Return false to fail immediately instead of retrying. */
  retryable?: (error: unknown) => boolean;
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? 4;
  const base = options.baseDelayMs ?? 500;
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (options.retryable && !options.retryable(error)) throw error;
      if (i === attempts - 1) break;
      await sleep(base * 2 ** i + Math.random() * 200);
    }
  }
  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

export function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
