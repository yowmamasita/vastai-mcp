import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR, REAPER_LOG, STATE_FILE, resolveApiKey } from './config.js';
import { VastClient } from './client.js';
import { sleep } from './format.js';

export interface TeardownEntry {
  instanceId: number;
  label: string;
  templateId: string;
  createdAt: number;
  /** Hard wall: the instance dies at this timestamp no matter what. */
  deadlineAt: number;
  /** Destroy this many minutes after the workload goes quiet. Null disables idle teardown. */
  idleMinutes: number | null;
  /**
   * No idle teardown before this timestamp. A ComfyUI that answers with an empty queue
   * looks exactly like a finished one, so without this the watchdog destroys the box
   * while it is still pulling 44 GB of weights. Measured the hard way.
   */
  idleGraceUntil: number;
  /** Idle countdown only starts once the service has actually done something. */
  armedAt: number | null;
  lastActivityAt: number | null;
  endpoint: string | null;
  usdPerHour: number;
  destroyedAt?: number;
  destroyedReason?: string;
}

export interface Ledger {
  entries: TeardownEntry[];
  reaperPid?: number;
}

const PID_FILE = path.join(CONFIG_DIR, 'reaper.pid');

export function readLedger(): Ledger {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Ledger;
    if (!parsed || !Array.isArray(parsed.entries)) return { entries: [] };
    return parsed;
  } catch {
    return { entries: [] };
  }
}

export function writeLedger(ledger: Ledger): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
}

export function upsertEntry(entry: TeardownEntry): void {
  const ledger = readLedger();
  const index = ledger.entries.findIndex((e) => e.instanceId === entry.instanceId);
  if (index >= 0) ledger.entries[index] = { ...ledger.entries[index], ...entry };
  else ledger.entries.push(entry);
  writeLedger(ledger);
}

/** Setup finished: let the idle countdown start now rather than at the grace deadline. */
export function armIdleNow(instanceId: number): void {
  const ledger = readLedger();
  const entry = ledger.entries.find((e) => e.instanceId === instanceId && !e.destroyedAt);
  if (entry && entry.idleGraceUntil > Date.now()) {
    entry.idleGraceUntil = Date.now();
    entry.lastActivityAt = Date.now();
    writeLedger(ledger);
  }
}

/** Record where the service answers, so idle teardown has something to poll. */
export function rememberEndpoint(instanceId: number, endpoint: string): void {
  const ledger = readLedger();
  const entry = ledger.entries.find((e) => e.instanceId === instanceId && !e.destroyedAt);
  if (entry && entry.endpoint !== endpoint) {
    entry.endpoint = endpoint;
    writeLedger(ledger);
  }
}

export function markDestroyed(instanceId: number, reason: string): void {
  const ledger = readLedger();
  const entry = ledger.entries.find((e) => e.instanceId === instanceId);
  if (entry) {
    entry.destroyedAt = Date.now();
    entry.destroyedReason = reason;
    writeLedger(ledger);
  }
}

export function activeEntries(ledger = readLedger()): TeardownEntry[] {
  return ledger.entries.filter((e) => !e.destroyedAt);
}

/** Entries older than a day that are already dead just make the file noisy. */
function prune(ledger: Ledger): Ledger {
  const cutoff = Date.now() - 24 * 3600 * 1000;
  ledger.entries = ledger.entries.filter((e) => !e.destroyedAt || e.destroyedAt > cutoff);
  return ledger;
}

function log(message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.appendFileSync(REAPER_LOG, line);
  } catch {
    /* best effort */
  }
}

export function reaperRunning(): number | null {
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
    if (!pid) return null;
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    return null;
  }
}

/**
 * Start the watchdog if it is not already running. It is detached on purpose: the whole
 * point is that it outlives the MCP client, the terminal and the laptop lid.
 */
export function ensureReaper(): { started: boolean; pid: number | null } {
  const existing = reaperRunning();
  if (existing) return { started: false, pid: existing };

  const apiKey = resolveApiKey()?.key;
  if (!apiKey) return { started: false, pid: null };

  const self = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [self, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, VAST_API_KEY: apiKey },
  });
  child.unref();
  if (child.pid) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(PID_FILE, String(child.pid), { mode: 0o600 });
  }
  log(`reaper started pid=${child.pid}`);
  return { started: true, pid: child.pid ?? null };
}

export async function destroyInstance(client: VastClient, instanceId: number): Promise<void> {
  await client.request(`/instances/${instanceId}/`, { method: 'DELETE' });
}

/** Ask ComfyUI whether it is busy. Any answer at all counts as the service being alive. */
async function comfyBusy(endpoint: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${endpoint}/queue`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const body = (await response.json()) as { queue_running?: unknown[]; queue_pending?: unknown[] };
    const running = body.queue_running?.length ?? 0;
    const pending = body.queue_pending?.length ?? 0;
    return running + pending > 0;
  } catch {
    return null;
  }
}

async function tick(client: VastClient): Promise<void> {
  const ledger = prune(readLedger());
  const now = Date.now();
  let dirty = false;

  for (const entry of ledger.entries) {
    if (entry.destroyedAt) continue;

    let reason: string | null = null;
    if (now >= entry.deadlineAt) {
      reason = `deadline reached (${new Date(entry.deadlineAt).toISOString()})`;
    } else if (entry.idleMinutes && entry.endpoint && now >= (entry.idleGraceUntil ?? 0)) {
      const busy = await comfyBusy(entry.endpoint);
      if (busy === true) {
        entry.armedAt = entry.armedAt ?? now;
        entry.lastActivityAt = now;
        dirty = true;
      } else if (busy === false) {
        // Service answers but has nothing queued. Arm on first sight, then count down.
        entry.armedAt = entry.armedAt ?? now;
        entry.lastActivityAt = entry.lastActivityAt ?? now;
        const idleMs = now - entry.lastActivityAt;
        if (idleMs >= entry.idleMinutes * 60_000) {
          reason = `idle for ${Math.round(idleMs / 60_000)} minutes with an empty queue`;
        }
        dirty = true;
      }
    }

    if (!reason) continue;
    try {
      await destroyInstance(client, entry.instanceId);
      entry.destroyedAt = Date.now();
      entry.destroyedReason = reason;
      dirty = true;
      log(`destroyed instance ${entry.instanceId} (${entry.label}): ${reason}`);
    } catch (error) {
      const message = String((error as Error).message);
      // A instance that is already gone is a success, not a failure.
      if (/not found|no such|404/i.test(message)) {
        entry.destroyedAt = Date.now();
        entry.destroyedReason = 'already gone';
        dirty = true;
        log(`instance ${entry.instanceId} already gone`);
      } else {
        log(`FAILED to destroy ${entry.instanceId}: ${message}`);
      }
    }
  }

  if (dirty) writeLedger(ledger);
}

async function daemon(): Promise<void> {
  const apiKey = resolveApiKey()?.key;
  if (!apiKey) {
    log('no API key; reaper exiting');
    return;
  }
  const client = new VastClient(apiKey);
  log('reaper loop online');
  let idleRounds = 0;
  for (;;) {
    try {
      await tick(client);
    } catch (error) {
      log(`tick error: ${String((error as Error).message)}`);
    }
    // Nothing left to watch: exit rather than linger forever.
    if (activeEntries().length === 0) {
      idleRounds += 1;
      if (idleRounds >= 10) {
        log('nothing left to watch; reaper exiting');
        try {
          fs.unlinkSync(PID_FILE);
        } catch {
          /* best effort */
        }
        return;
      }
    } else {
      idleRounds = 0;
    }
    await sleep(30_000);
  }
}

if (process.argv.includes('--daemon')) {
  void daemon();
}
