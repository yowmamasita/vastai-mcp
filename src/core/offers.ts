import pc from 'picocolors';
import type { VastClient } from './client.js';
import { gb, mbps, table, usd, withRetry } from './format.js';

/** Vast reports compute capability as an integer: 8.9 -> 890, 12.0 -> 1200. */
export const BLACKWELL_MIN_CAP = 1000;
export const CONSUMER_BLACKWELL_CAP = 1200;

export interface RawOffer {
  id: number;
  ask_contract_id?: number;
  machine_id?: number;
  host_id?: number;
  gpu_name: string;
  num_gpus: number;
  gpu_ram: number;
  gpu_total_ram?: number;
  compute_cap?: number;
  cuda_max_good?: number;
  driver_version?: string;
  dph_total: number;
  dph_base?: number;
  storage_cost?: number;
  inet_down?: number;
  inet_up?: number;
  inet_down_cost?: number;
  disk_space?: number;
  disk_bw?: number;
  cpu_ram?: number;
  cpu_cores_effective?: number;
  reliability2?: number;
  verification?: string;
  rentable?: boolean;
  rented?: boolean;
  direct_port_count?: number;
  geolocation?: string;
  dlperf?: number;
  is_bid?: boolean;
  min_bid?: number;
  static_ip?: boolean;
  [key: string]: unknown;
}

export interface Offer {
  id: number;
  gpuName: string;
  numGpus: number;
  vramMbPerGpu: number;
  vramMbTotal: number;
  computeCap: number | null;
  cudaMaxGood: number | null;
  driverVersion: string | null;
  usdPerHour: number;
  /** Vast quotes storage in $ per GB per month. A 120 GB H3 disk is ~$0.14/hour. */
  storageCostPerGbMonth: number | null;
  /**
   * $ per GB of ingress. Billed separately from the hourly rate and routinely the single
   * largest line on a short session: at $0.039/GB the 58 GB MiniMax H3 needs costs $2.27,
   * more than ten hours of the GPU itself. Ranges from free to $0.04/GB across hosts.
   */
  inetDownCostPerGb: number | null;
  inetDownMbps: number | null;
  inetUpMbps: number | null;
  diskGb: number | null;
  cpuRamMb: number | null;
  cpuCores: number | null;
  reliability: number | null;
  verified: boolean;
  rentable: boolean;
  directPorts: number;
  geolocation: string | null;
  dlperf: number | null;
  isBid: boolean;
  minBid: number | null;
}

export function normalizeOffer(raw: RawOffer): Offer {
  return {
    id: raw.id,
    gpuName: raw.gpu_name,
    numGpus: raw.num_gpus,
    vramMbPerGpu: raw.gpu_ram,
    vramMbTotal: raw.gpu_ram * (raw.num_gpus || 1),
    computeCap: typeof raw.compute_cap === 'number' ? raw.compute_cap : null,
    cudaMaxGood: typeof raw.cuda_max_good === 'number' ? raw.cuda_max_good : null,
    driverVersion: raw.driver_version ?? null,
    usdPerHour: raw.dph_total,
    storageCostPerGbMonth: typeof raw.storage_cost === 'number' ? raw.storage_cost : null,
    inetDownCostPerGb: typeof raw.inet_down_cost === 'number' ? raw.inet_down_cost : null,
    inetDownMbps: typeof raw.inet_down === 'number' ? raw.inet_down : null,
    inetUpMbps: typeof raw.inet_up === 'number' ? raw.inet_up : null,
    diskGb: typeof raw.disk_space === 'number' ? raw.disk_space : null,
    cpuRamMb: typeof raw.cpu_ram === 'number' ? raw.cpu_ram : null,
    cpuCores: typeof raw.cpu_cores_effective === 'number' ? raw.cpu_cores_effective : null,
    reliability: typeof raw.reliability2 === 'number' ? raw.reliability2 : null,
    verified: raw.verification === 'verified',
    rentable: raw.rentable !== false,
    directPorts: typeof raw.direct_port_count === 'number' ? raw.direct_port_count : 0,
    geolocation: raw.geolocation ?? null,
    dlperf: typeof raw.dlperf === 'number' ? raw.dlperf : null,
    isBid: Boolean(raw.is_bid),
    minBid: typeof raw.min_bid === 'number' ? raw.min_bid : null,
  };
}

export interface SearchQuery {
  minVramGbPerGpu?: number;
  minVramGbTotal?: number;
  numGpus?: number;
  gpuNames?: string[];
  maxUsdPerHour?: number;
  minDiskGb?: number;
  minInetDownMbps?: number;
  minReliability?: number;
  verifiedOnly?: boolean;
  /** "ondemand" is the stable price; "bid" is interruptible and can be taken away mid-run. */
  type?: 'ondemand' | 'bid';
  limit?: number;
  minComputeCap?: number;
}

export async function searchOffers(client: VastClient, query: SearchQuery = {}): Promise<Offer[]> {
  const body: Record<string, unknown> = {
    limit: query.limit ?? 600,
    type: query.type ?? 'ondemand',
    rentable: { eq: true },
    order: [['dph_total', 'asc']],
  };
  if (query.verifiedOnly) body.verified = { eq: true };
  if (query.numGpus) body.num_gpus = { eq: query.numGpus };
  if (query.minVramGbPerGpu) body.gpu_ram = { gte: Math.round(query.minVramGbPerGpu * 1024 * 0.97) };
  if (query.gpuNames?.length) body.gpu_name = { in: query.gpuNames };
  if (query.maxUsdPerHour) body.dph_total = { lte: query.maxUsdPerHour };
  if (query.minDiskGb) body.disk_space = { gte: query.minDiskGb };
  if (query.minInetDownMbps) body.inet_down = { gte: query.minInetDownMbps };
  if (query.minReliability) body.reliability2 = { gte: query.minReliability };

  const response = await withRetry(() =>
    client.request<{ offers?: RawOffer[] }>('/bundles', { method: 'POST', body }),
  );
  const offers = (response?.offers ?? []).map(normalizeOffer);
  const minCap = query.minComputeCap;
  const minTotal = query.minVramGbTotal;
  return offers.filter(
    (o) =>
      (!minCap || (o.computeCap ?? 0) >= minCap) &&
      (!minTotal || o.vramMbTotal >= minTotal * 1024 * 0.97),
  );
}

export interface CostModel {
  /** Gigabytes the host must pull before the workload can start (image + weights). */
  downloadGb: number;
  /** How long you actually intend to use the GPU once it is warm. */
  workMinutes: number;
  /** Disk to provision, in GB. */
  diskGb: number;
  /** Hosts never sustain their advertised link speed; 0.6 is a realistic haircut. */
  linkEfficiency?: number;
  /**
   * The dlperf of the card the workMinutes figure was measured on. Given this, a faster
   * card is credited with finishing sooner, so ranking stops preferring a cheap slow card
   * over a slightly dearer fast one. Render time dominates any session that does real work.
   */
  referenceDlperf?: number;
}

export interface CostBreakdown {
  setupHours: number;
  workHours: number;
  totalHours: number;
  gpuUsd: number;
  diskUsd: number;
  /** One-off charge for pulling the image and weights onto the host. */
  bandwidthUsd: number;
  totalUsd: number;
  /** What one hour of useful work really costs once setup is amortised. */
  usdPerUsefulHour: number;
}

/**
 * Sticker price is not cost. A $0.26/h RTX 5090 on a 48 Mb/s link spends two paid hours
 * pulling 45 GB of MiniMax H3 weights before it renders a single frame; a $0.40/h host on
 * a gigabit link is warm in six minutes and finishes cheaper. Rank on this, not on dph.
 */
export function estimateCost(offer: Offer, model: CostModel): CostBreakdown {
  const efficiency = model.linkEfficiency ?? 0.6;
  const link = Math.max(1, (offer.inetDownMbps ?? 100) * efficiency);
  // GB * 8000 = megabits; / Mb/s = seconds.
  const setupHours = (model.downloadGb * 8000) / link / 3600;
  const speedRatio =
    model.referenceDlperf && offer.dlperf ? model.referenceDlperf / offer.dlperf : 1;
  const workHours = (model.workMinutes / 60) * speedRatio;
  const totalHours = setupHours + workHours;
  const gpuUsd = totalHours * offer.usdPerHour;
  // storage_cost is $/GB/month, charged for as long as the instance exists. At 120 GB
  // for MiniMax H3 this is a quarter of the bill, not a rounding error.
  const diskUsd = offer.storageCostPerGbMonth
    ? (offer.storageCostPerGbMonth / 730) * model.diskGb * totalHours
    : 0;
  // Charged once, when the bytes land. It does not scale with session length, which is
  // exactly why it is invisible in a $/hour comparison and still dominates a short job.
  const bandwidthUsd = (offer.inetDownCostPerGb ?? 0) * model.downloadGb;
  const totalUsd = gpuUsd + diskUsd + bandwidthUsd;
  return {
    setupHours,
    workHours,
    totalHours,
    gpuUsd,
    diskUsd,
    bandwidthUsd,
    totalUsd,
    usdPerUsefulHour: workHours > 0 ? totalUsd / workHours : totalUsd,
  };
}

export type OfferBucketName =
  | 'ready_now'
  | 'risky_host'
  | 'unverified'
  | 'slow_link'
  | 'too_small'
  | 'unsupported'
  | 'no_ports';

export interface WorkloadFit {
  minVramGbPerGpu?: number;
  minVramGbTotal?: number;
  minComputeCap?: number;
  /** Human words for why the architecture gate exists, shown when a card is rejected. */
  archReason?: string;
  minDiskGb?: number;
  minDriverVersion?: number;
  exposedPorts?: number;
  minReliability?: number;
  /** Below this, setup time dominates and the cheap sticker price is a lie. */
  minInetDownMbps?: number;
}

export interface BucketedOffer {
  offer: Offer;
  bucket: OfferBucketName;
  cost: CostBreakdown;
  risks: string[];
}

export interface OfferBuckets {
  ready_now: BucketedOffer[];
  risky_host: BucketedOffer[];
  unverified: BucketedOffer[];
  slow_link: BucketedOffer[];
  no_ports: BucketedOffer[];
  too_small: BucketedOffer[];
  unsupported: BucketedOffer[];
}

export function bucketOffers(offers: Offer[], fit: WorkloadFit, model: CostModel): OfferBuckets {
  const buckets: OfferBuckets = {
    ready_now: [],
    risky_host: [],
    unverified: [],
    slow_link: [],
    no_ports: [],
    too_small: [],
    unsupported: [],
  };

  for (const offer of offers) {
    const cost = estimateCost(offer, model);
    const push = (bucket: OfferBucketName, risks: string[]) => buckets[bucket].push({ offer, bucket, cost, risks });

    if (fit.minVramGbPerGpu && offer.vramMbPerGpu < fit.minVramGbPerGpu * 1024 * 0.97) {
      push('too_small', [`${gb(offer.vramMbPerGpu)} per GPU, workload needs ${fit.minVramGbPerGpu} GB`]);
      continue;
    }
    if (fit.minVramGbTotal && offer.vramMbTotal < fit.minVramGbTotal * 1024 * 0.97) {
      push('too_small', [`${gb(offer.vramMbTotal)} total, workload needs ${fit.minVramGbTotal} GB`]);
      continue;
    }
    if (fit.minComputeCap && (offer.computeCap ?? 0) < fit.minComputeCap) {
      const cap = offer.computeCap ? (offer.computeCap / 100).toFixed(1) : 'unknown';
      push('unsupported', [`compute capability ${cap}; ${fit.archReason ?? `needs ${(fit.minComputeCap / 100).toFixed(1)} or newer`}`]);
      continue;
    }
    if (fit.minDriverVersion && offer.driverVersion && parseFloat(offer.driverVersion) < fit.minDriverVersion) {
      push('unsupported', [`driver ${offer.driverVersion}, workload needs r${fit.minDriverVersion}+`]);
      continue;
    }
    if (fit.minDiskGb && offer.diskGb !== null && offer.diskGb < fit.minDiskGb) {
      push('too_small', [`${Math.round(offer.diskGb)} GB disk, workload needs ${fit.minDiskGb} GB`]);
      continue;
    }

    const risks: string[] = [];
    if (fit.exposedPorts && offer.directPorts < fit.exposedPorts) {
      push('no_ports', [`only ${offer.directPorts} direct ports; the web UI cannot be exposed`]);
      continue;
    }
    if (fit.minReliability && (offer.reliability ?? 0) < fit.minReliability) {
      risks.push(`reliability ${(100 * (offer.reliability ?? 0)).toFixed(1)}%`);
    }

    const slow = fit.minInetDownMbps && (offer.inetDownMbps ?? 0) < fit.minInetDownMbps;
    if (slow) {
      push('slow_link', [
        `${mbps(offer.inetDownMbps)} down: about ${cost.setupHours.toFixed(1)}h of paid setup to pull ${model.downloadGb} GB`,
        ...risks,
      ]);
      continue;
    }
    if (!offer.verified) {
      push('unverified', ['host is not Vast-verified; expect restarts and dead instances', ...risks]);
      continue;
    }
    // A host that drops one render in three is not "ready", however cheap the hour is.
    if (risks.length) {
      push('risky_host', risks);
      continue;
    }
    push('ready_now', risks);
  }

  for (const key of Object.keys(buckets) as OfferBucketName[]) {
    buckets[key].sort((a, b) => a.cost.totalUsd - b.cost.totalUsd);
  }
  return buckets;
}

/** Cheapest offer by real cost that fits and is verified, or null when nothing qualifies. */
export function autoPickOffer(buckets: OfferBuckets): BucketedOffer | null {
  return buckets.ready_now[0] ?? null;
}

export function offerTable(rows: BucketedOffer[], limit = 10): string {
  const headers = ['Offer', 'GPU', 'VRAM', '$/h', 'Down', 'Setup', 'Data $', 'Session $', 'Rel', 'Location'];
  const body = rows.slice(0, limit).map(({ offer, cost }) => [
    String(offer.id),
    offer.numGpus > 1 ? `${offer.numGpus}x ${offer.gpuName}` : offer.gpuName,
    gb(offer.vramMbPerGpu),
    usd(offer.usdPerHour),
    mbps(offer.inetDownMbps),
    cost.setupHours < 0.5 ? pc.green(`${Math.round(cost.setupHours * 60)}m`) : pc.yellow(`${cost.setupHours.toFixed(1)}h`),
    cost.bandwidthUsd > 0.5 ? pc.red(usd(cost.bandwidthUsd, 2)) : usd(cost.bandwidthUsd, 2),
    pc.bold(usd(cost.totalUsd, 2)),
    offer.reliability ? `${(offer.reliability * 100).toFixed(1)}%` : '?',
    offer.geolocation ?? '?',
  ]);
  return table(headers, body);
}
