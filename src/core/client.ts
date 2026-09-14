import { redact, resolveApiKey } from './config.js';
import { withRetry, withTimeout } from './format.js';

export const API_BASE = process.env.VAST_API_BASE ?? 'https://console.vast.ai/api';

export interface GlobalOptions {
  apiKey?: string;
  json?: boolean;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class VastApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'VastApiError';
  }

  /** 5xx and 429 are worth another go; 4xx means we asked for something wrong. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 429 || this.status === 0;
  }
}

export const NO_KEY_MESSAGE = [
  'No Vast.ai API key found.',
  '  Run `vast-deploy login` to store one, set VAST_API_KEY, or pass --api-key.',
  '  Create a key at https://cloud.vast.ai/manage-keys/.',
].join('\n');

export function requireApiKey(options: GlobalOptions = {}): string {
  const resolved = resolveApiKey(options.apiKey);
  if (!resolved) throw new CliError(NO_KEY_MESSAGE);
  return resolved.key;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  /** Defaults to v0; the instances list only exists on v1. */
  version?: 'v0' | 'v1';
  timeoutMs?: number;
  retry?: boolean;
}

export class VastClient {
  constructor(readonly apiKey: string) {}

  static from(options: GlobalOptions = {}): VastClient {
    return new VastClient(requireApiKey(options));
  }

  async request<T = unknown>(path: string, options: RequestOptions = {}): Promise<T> {
    const { method = 'GET', body, version = 'v0', timeoutMs = 45_000, retry = true } = options;
    const url = `${API_BASE}/${version}${path}`;
    const call = async (): Promise<T> => {
      let response: Response;
      try {
        response = await withTimeout(
          fetch(url, {
            method,
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
          timeoutMs,
          `${method} ${path}`,
        );
      } catch (error) {
        throw new VastApiError(redact(String((error as Error).message), this.apiKey), 0, null);
      }

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        /* keep the raw text */
      }

      if (!response.ok) {
        const record = parsed as Record<string, unknown> | null;
        const detail = record?.msg ?? record?.error ?? record?.detail ?? text.slice(0, 300);
        throw new VastApiError(redact(`Vast API ${response.status}: ${String(detail)}`, this.apiKey), response.status, parsed);
      }

      // Vast answers 200 with {success: false} on some failures.
      const record = parsed as Record<string, unknown> | null;
      if (record && typeof record === 'object' && record.success === false) {
        const detail = record.msg ?? record.error ?? 'request rejected';
        throw new VastApiError(redact(`Vast API: ${String(detail)}`, this.apiKey), 400, parsed);
      }
      return parsed as T;
    };

    return retry ? withRetry(call, { retryable: (e) => e instanceof VastApiError && e.transient }) : call();
  }
}

export interface VastUser {
  id: number;
  username: string;
  email?: string;
  balance: number;
  credit: number;
  can_pay: boolean;
  total_spend: number;
  ssh_key?: string;
  balance_threshold?: number | null;
}

export async function getUser(client: VastClient): Promise<VastUser> {
  return client.request<VastUser>('/users/current/');
}

/** Money actually available to spend: prepaid credit plus any positive balance. */
export function spendableUsd(user: VastUser): number {
  return (Number(user.credit) || 0) + Math.max(0, Number(user.balance) || 0);
}
