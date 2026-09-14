import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StoredConfig {
  apiKey?: string;
  /** Hard ceiling the agent may never cross per instance without force. */
  maxUsdPerHour?: number;
  /** Default auto-teardown window, in minutes. */
  defaultTeardownMinutes?: number;
}

export const CONFIG_DIR =
  process.env.VAST_DEPLOY_CONFIG_DIR ?? path.join(os.homedir(), '.config', 'vast-deploy');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
/** Where the reaper keeps its ledger of instances that must die. */
export const STATE_FILE = path.join(CONFIG_DIR, 'teardown.json');
export const REAPER_LOG = path.join(CONFIG_DIR, 'reaper.log');

export function readConfig(): StoredConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as StoredConfig) : {};
  } catch {
    return {};
  }
}

export function writeConfig(config: StoredConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

export function clearConfig(): boolean {
  try {
    fs.unlinkSync(CONFIG_FILE);
    return true;
  } catch {
    return false;
  }
}

export type ApiKeySource = 'flag' | 'env' | 'config';

export function resolveApiKey(explicit?: string): { key: string; source: ApiKeySource } | undefined {
  if (explicit) return { key: explicit, source: 'flag' };
  if (process.env.VAST_API_KEY) return { key: process.env.VAST_API_KEY, source: 'env' };
  const stored = readConfig().apiKey;
  if (stored) return { key: stored, source: 'config' };
  return undefined;
}

export function maskKey(key: string): string {
  if (key.length <= 12) return '****';
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}

/** Never let a key reach a log line, an error message or a rented host by accident. */
export function redact(text: string, key?: string): string {
  const secret = key ?? resolveApiKey()?.key;
  if (!secret) return text;
  return text.split(secret).join(maskKey(secret));
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export const DEFAULT_TEARDOWN_MINUTES = 120;
export const DEFAULT_MAX_USD_PER_HOUR = 2.5;
