import { VastApiError, type VastClient, getUser, spendableUsd } from './client.js';
import { DEFAULT_MAX_USD_PER_HOUR, DEFAULT_TEARDOWN_MINUTES, readConfig } from './config.js';
import { sleep } from './format.js';
import {
  type BucketedOffer,
  type CostBreakdown,
  type CostModel,
  type Offer,
  type OfferBuckets,
  autoPickOffer,
  bucketOffers,
  estimateCost,
  searchOffers,
} from './offers.js';
import { READY_MARKER, type Template, buildEnv, buildOnstart, downloadGb, findTemplate } from './templates.js';
import { armIdleNow, ensureReaper, markDestroyed, rememberEndpoint, upsertEntry } from './reaper.js';

export interface RawInstance {
  id: number;
  machine_id?: number;
  actual_status?: string;
  cur_state?: string;
  next_state?: string;
  intent?: string;
  status_msg?: string | null;
  gpu_name?: string;
  num_gpus?: number;
  dph_total?: number;
  dph_base?: number;
  storage_cost?: number;
  start_date?: number;
  image_uuid?: string;
  label?: string | null;
  public_ipaddr?: string;
  ssh_host?: string;
  ssh_port?: number;
  ports?: Record<string, { HostIp: string; HostPort: string }[]> | null;
  inet_down?: number;
  gpu_util?: number | null;
  [key: string]: unknown;
}

export interface Instance {
  id: number;
  /** Container status: created, loading, offline, running, exited. */
  status: string;
  /** What the rental contract wants: running or stopped. */
  contractState: string;
  statusMessage: string | null;
  gpuName: string | null;
  numGpus: number;
  usdPerHour: number;
  startedAt: number | null;
  label: string | null;
  publicIp: string | null;
  sshHost: string | null;
  sshPort: number | null;
  ports: Record<string, { HostIp: string; HostPort: string }[]>;
  raw: RawInstance;
}

export function normalizeInstance(raw: RawInstance): Instance {
  return {
    id: raw.id,
    status: raw.actual_status ?? raw.cur_state ?? 'unknown',
    contractState: raw.cur_state ?? 'unknown',
    statusMessage: raw.status_msg ? String(raw.status_msg).trim() : null,
    gpuName: raw.gpu_name ?? null,
    numGpus: raw.num_gpus ?? 1,
    usdPerHour: raw.dph_total ?? 0,
    startedAt: raw.start_date ? raw.start_date * 1000 : null,
    label: raw.label ?? null,
    publicIp: raw.public_ipaddr ?? null,
    sshHost: raw.ssh_host ?? null,
    sshPort: raw.ssh_port ?? null,
    ports: raw.ports ?? {},
    raw,
  };
}

export async function listInstances(client: VastClient): Promise<Instance[]> {
  const response = await client.request<{ instances?: RawInstance[] }>('/instances/', { version: 'v1' });
  return (response?.instances ?? []).map(normalizeInstance);
}

export async function getInstance(client: VastClient, id: number): Promise<Instance | null> {
  const all = await listInstances(client);
  return all.find((i) => i.id === id) ?? null;
}

/** Vast maps each container port to a random external port on the host's shared IP. */
export function endpointFor(instance: Instance, port: number): string | null {
  const mapping = instance.ports?.[`${port}/tcp`]?.[0];
  const ip = instance.publicIp ?? mapping?.HostIp;
  if (!mapping?.HostPort || !ip || ip === '0.0.0.0') {
    if (!mapping?.HostPort || !instance.publicIp) return null;
  }
  return `http://${instance.publicIp}:${mapping.HostPort}`;
}

export function sshCommand(instance: Instance): string | null {
  if (!instance.sshHost || !instance.sshPort) return null;
  return `ssh -p ${instance.sshPort} root@${instance.sshHost}`;
}

export interface PlanOptions {
  templateId: string;
  /** Minutes of actual GPU work you expect to do once the model is loaded. */
  workMinutes?: number;
  maxUsdPerHour?: number;
  /** Consider hosts Vast has not verified. Cheaper, measurably flakier. */
  allowUnverified?: boolean;
  /** Restrict to these exact Vast gpu_name values. */
  gpuNames?: string[];
  numGpus?: number;
  /** Interruptible bidding. The host can take the machine back mid-render. */
  interruptible?: boolean;
}

export interface Plan {
  template: Template;
  offer: Offer;
  cost: CostBreakdown;
  model: CostModel;
  buckets: OfferBuckets;
  chosenFrom: 'ready_now' | 'unverified';
  alternatives: BucketedOffer[];
  /** What the cheapest sticker price would really have cost, when it differs. */
  cheapestStickerTrap: { offer: Offer; cost: CostBreakdown; extraUsd: number } | null;
  warnings: string[];
}

export async function planDeployment(client: VastClient, options: PlanOptions): Promise<Plan> {
  const template = findTemplate(options.templateId);
  if (!template) throw new Error(`Unknown template "${options.templateId}". Try list_templates.`);

  const workMinutes = options.workMinutes ?? 45;
  const maxUsdPerHour = options.maxUsdPerHour ?? readConfig().maxUsdPerHour ?? DEFAULT_MAX_USD_PER_HOUR;
  const model: CostModel = {
    downloadGb: downloadGb(template),
    workMinutes,
    diskGb: template.diskGb,
    referenceDlperf: template.referenceDlperf,
  };

  const offers = await searchOffers(client, {
    minVramGbPerGpu: template.fit.minVramGbPerGpu,
    minComputeCap: template.fit.minComputeCap,
    minDiskGb: template.fit.minDiskGb,
    maxUsdPerHour,
    numGpus: options.numGpus ?? 1,
    gpuNames: options.gpuNames,
    type: options.interruptible ? 'bid' : 'ondemand',
    limit: 600,
  });

  const buckets = bucketOffers(offers, template.fit, model);
  const warnings: string[] = [];

  let picked = autoPickOffer(buckets);
  let chosenFrom: 'ready_now' | 'unverified' = 'ready_now';
  if (!picked && options.allowUnverified && buckets.unverified.length) {
    picked = buckets.unverified[0];
    chosenFrom = 'unverified';
    warnings.push('No verified host fit; using an unverified one because allow_unverified was set.');
  }
  if (!picked) {
    const why = [
      buckets.risky_host.length ? `${buckets.risky_host.length} fit but have a poor reliability record` : null,
      buckets.unverified.length ? `${buckets.unverified.length} unverified hosts fit (set allow_unverified)` : null,
      buckets.slow_link.length ? `${buckets.slow_link.length} rejected for a slow link` : null,
      buckets.unsupported.length ? `${buckets.unsupported.length} rejected on GPU architecture` : null,
      buckets.too_small.length ? `${buckets.too_small.length} rejected on VRAM or disk` : null,
    ].filter(Boolean);
    throw new Error(`No offer fits ${template.id} under $${maxUsdPerHour}/h. ${why.join('; ') || 'Nothing matched at all.'}`);
  }

  // What a naive "filter on fit, sort by $/hour" tool would have rented: same hard gates,
  // same verification bar, but blind to how long the weights take to arrive.
  const naiveCandidates = [...buckets.ready_now, ...buckets.risky_host, ...buckets.slow_link].filter(
    (row) => row.offer.verified,
  );
  const cheapestSticker = naiveCandidates.reduce<BucketedOffer | null>(
    (best, cur) => (!best || cur.offer.usdPerHour < best.offer.usdPerHour ? cur : best),
    null,
  );
  let cheapestStickerTrap: Plan['cheapestStickerTrap'] = null;
  if (cheapestSticker && cheapestSticker.offer.id !== picked.offer.id) {
    const extra = cheapestSticker.cost.totalUsd - picked.cost.totalUsd;
    if (extra > 0) {
      cheapestStickerTrap = { offer: cheapestSticker.offer, cost: cheapestSticker.cost, extraUsd: extra };
    }
  }

  // An unverified host is sometimes genuinely cheaper. Offer it rather than hide it.
  const cheaperUnverified =
    buckets.unverified.length && buckets.unverified[0].cost.totalUsd < picked.cost.totalUsd && !options.allowUnverified
      ? buckets.unverified[0]
      : null;
  if (cheaperUnverified) {
    warnings.push(
      `Offer ${cheaperUnverified.offer.id} would cost ${(picked.cost.totalUsd - cheaperUnverified.cost.totalUsd).toFixed(2)} less but the host is unverified; pass allow_unverified to use it.`,
    );
  }

  if (picked.risks.length) warnings.push(...picked.risks);
  if (options.interruptible) {
    warnings.push('Interruptible offer: the host can reclaim this machine mid-render and you lose the work in progress.');
  }

  return {
    template,
    offer: picked.offer,
    cost: picked.cost,
    model,
    buckets,
    chosenFrom,
    alternatives: buckets.ready_now.slice(1, 6),
    cheapestStickerTrap,
    warnings,
  };
}

export interface CreateOptions {
  /** Hard wall. The reaper destroys the instance at this age no matter what. */
  teardownMinutes?: number;
  /** Destroy this long after the render queue goes quiet. */
  idleMinutes?: number | null;
  label?: string;
  diskGb?: number;
  /** Bid price for interruptible offers. */
  bidUsdPerHour?: number;
  confirm: boolean;
  /** Skip the affordability check. */
  force?: boolean;
}

export interface CreateResult {
  instanceId: number;
  label: string;
  deadlineAt: number;
  idleMinutes: number | null;
  reaper: { started: boolean; pid: number | null };
  estimatedUsd: number;
}

export async function createInstance(client: VastClient, plan: Plan, options: CreateOptions): Promise<CreateResult> {
  if (!options.confirm) throw new Error('createInstance requires confirm=true. Show the user the estimate first.');

  const teardownMinutes = options.teardownMinutes ?? readConfig().defaultTeardownMinutes ?? DEFAULT_TEARDOWN_MINUTES;
  const idleMinutes = options.idleMinutes === undefined ? 15 : options.idleMinutes;
  const diskGb = options.diskGb ?? plan.template.diskGb;
  const label = options.label ?? `vastai-mcp ${plan.template.id} ${new Date().toISOString().slice(0, 16)}`;

  // Never start something the account cannot pay for the full teardown window.
  const worstCaseUsd = (teardownMinutes / 60) * plan.offer.usdPerHour;
  if (!options.force) {
    const user = await getUser(client);
    const available = spendableUsd(user);
    if (worstCaseUsd > available) {
      throw new Error(
        `Refusing to start: the ${teardownMinutes}-minute window could cost $${worstCaseUsd.toFixed(2)} but only $${available.toFixed(2)} is available. Lower teardown_minutes, pick a cheaper offer, or pass force.`,
      );
    }
  }

  const body: Record<string, unknown> = {
    image: plan.template.image,
    disk: diskGb,
    label,
    runtype: 'ssh_direct',
    target_state: 'running',
    env: buildEnv(plan.template),
    onstart: buildOnstart(plan.template),
    cancel_unavail: true,
  };
  if (options.bidUsdPerHour) body.price = options.bidUsdPerHour;

  const response = await client.request<{ new_contract?: number; success?: boolean }>(
    `/asks/${plan.offer.id}`,
    { method: 'PUT', body, retry: false },
  );
  const instanceId = response?.new_contract;
  if (!instanceId) throw new Error(`Vast accepted the request but returned no instance id: ${JSON.stringify(response)}`);

  const now = Date.now();
  // Downloading weights looks identical to being idle from the outside, so hold the
  // idle countdown off until the workload has had a generous chance to finish setting up.
  const graceMinutes = Math.max(30, plan.template.bootMinutesTypical * 2);
  upsertEntry({
    instanceId,
    label,
    templateId: plan.template.id,
    createdAt: now,
    deadlineAt: now + teardownMinutes * 60_000,
    idleMinutes,
    idleGraceUntil: now + graceMinutes * 60_000,
    armedAt: null,
    lastActivityAt: null,
    endpoint: null,
    usdPerHour: plan.offer.usdPerHour,
  });
  const reaper = ensureReaper();

  return {
    instanceId,
    label,
    deadlineAt: now + teardownMinutes * 60_000,
    idleMinutes,
    reaper,
    estimatedUsd: plan.cost.totalUsd,
  };
}

export type Phase = 'creating' | 'loading' | 'downloading_weights' | 'online' | 'stopped' | 'failed';

export interface WaitResult {
  phase: Phase;
  instance: Instance | null;
  endpoint: string | null;
  ssh: string | null;
  message: string;
  elapsedSeconds: number;
  pollAfterSeconds: number;
  /** True once the service answered a real HTTP request. */
  serviceAnswered: boolean;
  setupComplete: boolean;
}

async function probe(url: string, path = '/'): Promise<boolean> {
  try {
    const response = await fetch(`${url}${path}`, { signal: AbortSignal.timeout(6000), redirect: 'follow' });
    return response.status < 500;
  } catch {
    return false;
  }
}

/** ComfyUI answers long before the weights finish landing; ask the marker file instead. */
async function setupDone(client: VastClient, instanceId: number): Promise<boolean> {
  try {
    const logs = await fetchLogs(client, instanceId, 200);
    return logs.includes('[vastai-mcp] setup finished');
  } catch {
    return false;
  }
}

/** Never blocks longer than maxMs; MCP clients give up at 60 seconds. */
export async function waitForInstance(
  client: VastClient,
  instanceId: number,
  template: Template,
  maxMs = 40_000,
): Promise<WaitResult> {
  const started = Date.now();
  let instance: Instance | null = null;

  for (;;) {
    instance = await getInstance(client, instanceId);
    const elapsedSeconds = Math.round((Date.now() - started) / 1000);

    if (!instance) {
      return {
        phase: 'stopped',
        instance: null,
        endpoint: null,
        ssh: null,
        message: `Instance ${instanceId} no longer exists. It was destroyed, by the reaper or by hand.`,
        elapsedSeconds,
        pollAfterSeconds: 0,
        serviceAnswered: false,
        setupComplete: false,
      };
    }

    const status = instance.status.toLowerCase();
    const contract = instance.contractState.toLowerCase();
    const endpoint = endpointFor(instance, template.port);
    const ssh = sshCommand(instance);

    // The reaper can only arm idle teardown once it knows where to probe the queue,
    // and the port mapping does not exist until the container is actually up.
    if (endpoint) rememberEndpoint(instanceId, endpoint);

    // "offline" is normal while the host pulls or builds the image; only the contract
    // going to stopped, or the container actually exiting, means it is over.
    const stoppedByContract = contract === 'stopped' || contract === 'exited';
    if (stoppedByContract || status === 'exited') {
      return {
        phase: stoppedByContract ? 'stopped' : 'failed',
        instance,
        endpoint,
        ssh,
        message:
          instance.statusMessage ??
          (stoppedByContract ? 'The rental contract is stopped; billing has ended.' : 'The container exited.'),
        elapsedSeconds,
        pollAfterSeconds: 0,
        serviceAnswered: false,
        setupComplete: false,
      };
    }

    if (status === 'running' && endpoint) {
      const answered = await probe(endpoint, template.readyPath);
      if (answered) {
        const complete = template.weights.length === 0 ? true : await setupDone(client, instanceId);
        if (complete) {
          armIdleNow(instanceId);
          return {
            phase: 'online',
            instance,
            endpoint,
            ssh,
            message: 'Service is up and the weights are in place.',
            elapsedSeconds,
            pollAfterSeconds: 0,
            serviceAnswered: true,
            setupComplete: true,
          };
        }
        if (Date.now() - started >= maxMs) {
          return {
            phase: 'downloading_weights',
            instance,
            endpoint,
            ssh,
            message: `ComfyUI answers but the weights are still downloading (${downloadGb(template).toFixed(0)} GB). Typical total boot: ${template.bootMinutesTypical} minutes.`,
            elapsedSeconds,
            pollAfterSeconds: 60,
            serviceAnswered: true,
            setupComplete: false,
          };
        }
      }
    }

    if (Date.now() - started >= maxMs) {
      // status_msg carries the docker pull/build log; one line of it is the useful part.
      const progress = instance.statusMessage
        ?.split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      return {
        phase: status === 'running' ? 'loading' : 'creating',
        instance,
        endpoint,
        ssh,
        message: progress ? `${status}: ${progress.slice(0, 120)}` : `Instance is ${status}.`,
        elapsedSeconds,
        pollAfterSeconds: 30,
        serviceAnswered: false,
        setupComplete: false,
      };
    }
    await sleep(5000);
  }
}

export async function fetchLogs(client: VastClient, instanceId: number, tail = 200): Promise<string> {
  const request = await client.request<{ result_url?: string; success?: boolean }>(
    `/instances/request_logs/${instanceId}/`,
    { method: 'PUT', body: { tail: String(tail) }, retry: false },
  );
  const url = request?.result_url;
  if (!url) return '';
  // The log blob shows up a moment after the request is accepted.
  for (let i = 0; i < 6; i++) {
    await sleep(1500);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return await response.text();
    } catch {
      /* keep waiting */
    }
  }
  return '';
}

export async function destroyAndForget(client: VastClient, instanceId: number, reason: string): Promise<{ ok: boolean; message: string }> {
  try {
    await client.request(`/instances/${instanceId}/`, { method: 'DELETE', retry: false });
    markDestroyed(instanceId, reason);
    return { ok: true, message: `Instance ${instanceId} destroyed. Billing has stopped.` };
  } catch (error) {
    const message = String((error as Error).message);
    if (error instanceof VastApiError && (error.status === 404 || /not found|no such/i.test(message))) {
      markDestroyed(instanceId, 'already gone');
      return { ok: true, message: `Instance ${instanceId} was already gone.` };
    }
    return { ok: false, message };
  }
}

/** Belt and braces: confirm with the API that nothing is left running. */
export async function verifyNothingRunning(client: VastClient): Promise<{ clean: boolean; running: Instance[] }> {
  const instances = await listInstances(client);
  const running = instances.filter((i) => !['exited', 'offline', 'destroyed'].includes(i.status.toLowerCase()));
  return { clean: running.length === 0, running };
}

export { estimateCost, READY_MARKER };
