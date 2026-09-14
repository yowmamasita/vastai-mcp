import { z } from 'zod';
import { CliError, VastClient, getUser, spendableUsd, type VastUser } from '../core/client.js';
import { DEFAULT_TEARDOWN_MINUTES, maskKey, resolveApiKey } from '../core/config.js';
import {
  createInstance,
  destroyAndForget,
  endpointFor,
  fetchLogs,
  getInstance,
  listInstances,
  planDeployment,
  sshCommand,
  verifyNothingRunning,
  waitForInstance,
  type Instance,
  type Plan,
} from '../core/deploy.js';
import { duration, formatError, gb, mbps, usd } from '../core/format.js';
import { type BucketedOffer, type OfferBuckets } from '../core/offers.js';
import { TEMPLATES, downloadGb, findTemplate, weightsGb, type Template } from '../core/templates.js';
import { activeEntries, ensureReaper, readLedger, reaperRunning, upsertEntry, type TeardownEntry } from '../core/reaper.js';

export const WAIT_DEFAULT_SECONDS = 30;
/** MCP clients time out requests after 60 s by default; stay well under it. */
export const WAIT_MAX_SECONDS = 45;

export const NO_KEY_MESSAGE =
  'No Vast.ai API key. Add VAST_API_KEY to the MCP server environment (create one at https://cloud.vast.ai/manage-keys/), or run `vast-deploy login` once on this machine.';

export interface Envelope {
  ok: boolean;
  message: string;
  next_tool?: string | null;
  next_args?: Record<string, unknown>;
  [key: string]: unknown;
}

export class ToolContext {
  private client?: VastClient;

  hasKey(): boolean {
    return Boolean(resolveApiKey());
  }

  get(): VastClient {
    if (!this.client) {
      const key = resolveApiKey();
      if (!key) throw new CliError(NO_KEY_MESSAGE, 2);
      this.client = new VastClient(key.key);
    }
    return this.client;
  }
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  shape: z.ZodRawShape;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<Envelope>;
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: true };
const WRITES = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

function offerSummary(row: BucketedOffer): Record<string, unknown> {
  const { offer, cost, risks } = row;
  return {
    offer_id: offer.id,
    gpu: offer.numGpus > 1 ? `${offer.numGpus}x ${offer.gpuName}` : offer.gpuName,
    vram_gb: Math.round(offer.vramMbPerGpu / 1024),
    compute_capability: offer.computeCap ? offer.computeCap / 100 : null,
    usd_per_hour: Number(offer.usdPerHour.toFixed(4)),
    inet_down_mbps: offer.inetDownMbps,
    setup_minutes: Math.round(cost.setupHours * 60),
    session_usd: Number(cost.totalUsd.toFixed(2)),
    usd_per_useful_hour: Number(cost.usdPerUsefulHour.toFixed(3)),
    reliability: offer.reliability ? Number((offer.reliability * 100).toFixed(1)) : null,
    verified: offer.verified,
    location: offer.geolocation,
    risks,
  };
}

function bucketCounts(buckets: OfferBuckets): Record<string, number> {
  return Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length]));
}

function templateSummary(t: Template): Record<string, unknown> {
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    summary: t.summary,
    min_vram_gb: t.fit.minVramGbPerGpu ?? null,
    requires_compute_capability: t.fit.minComputeCap ? t.fit.minComputeCap / 100 : null,
    weights_gb: Number(weightsGb(t).toFixed(1)),
    download_gb: Number(downloadGb(t).toFixed(1)),
    disk_gb: t.diskGb,
    boot_minutes_typical: t.bootMinutesTypical,
    hardware_notes: t.hardwareNotes,
  };
}

function planEnvelopeFields(plan: Plan): Record<string, unknown> {
  return {
    template: plan.template.id,
    offer: offerSummary({ offer: plan.offer, cost: plan.cost, bucket: 'ready_now', risks: plan.warnings }),
    cost: {
      setup_minutes: Math.round(plan.cost.setupHours * 60),
      work_minutes: Math.round(plan.cost.workHours * 60),
      gpu_usd: Number(plan.cost.gpuUsd.toFixed(2)),
      disk_usd: Number(plan.cost.diskUsd.toFixed(2)),
      bandwidth_usd: Number(plan.cost.bandwidthUsd.toFixed(2)),
      total_usd: Number(plan.cost.totalUsd.toFixed(2)),
      note: `${downloadGb(plan.template).toFixed(0)} GB must land on the host before the first frame; that download is billed at the GPU rate.`,
    },
    sticker_price_trap: plan.cheapestStickerTrap
      ? {
          offer_id: plan.cheapestStickerTrap.offer.id,
          usd_per_hour: Number(plan.cheapestStickerTrap.offer.usdPerHour.toFixed(4)),
          inet_down_mbps: plan.cheapestStickerTrap.offer.inetDownMbps,
          session_usd: Number(plan.cheapestStickerTrap.cost.totalUsd.toFixed(2)),
          costs_more_by_usd: Number(plan.cheapestStickerTrap.extraUsd.toFixed(2)),
          explanation:
            'This host has the lowest $/hour but a slow link, so it bills more hours pulling weights than it saves on rate.',
        }
      : null,
    alternatives: plan.alternatives.map(offerSummary),
    buckets: bucketCounts(plan.buckets),
    warnings: plan.warnings,
  };
}

function instanceSummary(instance: Instance, template?: Template): Record<string, unknown> {
  const entry = readLedger().entries.find((e) => e.instanceId === instance.id && !e.destroyedAt);
  const ageHours = instance.startedAt ? (Date.now() - instance.startedAt) / 3_600_000 : 0;
  return {
    instance_id: instance.id,
    status: instance.status,
    status_message: instance.statusMessage,
    gpu: instance.gpuName,
    usd_per_hour: Number(instance.usdPerHour.toFixed(4)),
    running_for: instance.startedAt ? duration((Date.now() - instance.startedAt) / 1000) : null,
    spent_so_far_usd: Number((ageHours * instance.usdPerHour).toFixed(2)),
    endpoint: template ? endpointFor(instance, template.port) : null,
    ssh: sshCommand(instance),
    label: instance.label,
    teardown: entry
      ? {
          deadline: new Date(entry.deadlineAt).toISOString(),
          minutes_left: Math.round((entry.deadlineAt - Date.now()) / 60_000),
          idle_minutes: entry.idleMinutes,
          watched_by_reaper: Boolean(reaperRunning()),
        }
      : { watched_by_reaper: false, warning: 'NOT in the teardown ledger: nothing will destroy this automatically.' },
  };
}

export const tools: ToolDefinition[] = [
  {
    name: 'doctor',
    title: 'Check the setup',
    description:
      'Verifies the API key, the account balance, Vast API reachability, and whether the auto-teardown reaper is running. Call this first when anything misbehaves.',
    shape: {},
    annotations: READ_ONLY,
    run: async (ctx) => {
      const checks: Record<string, unknown>[] = [];
      const key = resolveApiKey();
      checks.push({
        check: 'api_key',
        ok: Boolean(key),
        detail: key ? `${maskKey(key.key)} (from ${key.source})` : NO_KEY_MESSAGE,
      });
      if (!key) {
        return { ok: false, message: NO_KEY_MESSAGE, checks, next_tool: null };
      }

      let user: VastUser | null = null;
      try {
        user = await getUser(ctx.get());
        checks.push({ check: 'vast_api', ok: true, detail: `authenticated as ${user.username}` });
        checks.push({
          check: 'funds',
          ok: spendableUsd(user) > 0.5,
          detail: `$${spendableUsd(user).toFixed(2)} available (credit $${user.credit.toFixed(2)}, balance $${user.balance.toFixed(2)})`,
        });
      } catch (error) {
        checks.push({ check: 'vast_api', ok: false, detail: formatError(error) });
      }

      const pid = reaperRunning();
      const watching = activeEntries().length;
      checks.push({
        check: 'teardown_reaper',
        ok: watching === 0 || Boolean(pid),
        detail: pid
          ? `running (pid ${pid}), watching ${watching} instance(s)`
          : watching === 0
            ? 'not running, nothing to watch (it starts with the first instance)'
            : `NOT RUNNING but ${watching} instance(s) are in the ledger. Call teardown_status to restart it.`,
      });

      const failed = checks.filter((c) => c.ok === false);
      return {
        ok: failed.length === 0,
        message: failed.length === 0 ? 'Everything checks out.' : `${failed.length} check(s) need attention.`,
        checks,
        next_tool: failed.length === 0 ? 'recommend_plan' : null,
      };
    },
  },

  {
    name: 'get_balance',
    title: 'Account balance',
    description: 'Prepaid credit, cash balance, lifetime spend, and how many GPU-hours that buys at a given rate.',
    shape: { usd_per_hour: z.number().optional().describe('Rate to convert the balance into hours, default 0.40') },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const user = await getUser(ctx.get());
      const rate = (args.usd_per_hour as number) ?? 0.4;
      const available = spendableUsd(user);
      return {
        ok: true,
        message: `$${available.toFixed(2)} available: about ${(available / rate).toFixed(1)} hours at ${usd(rate, 2)}/h.`,
        username: user.username,
        credit_usd: user.credit,
        balance_usd: user.balance,
        available_usd: available,
        total_spend_usd: user.total_spend,
        hours_at_rate: Number((available / rate).toFixed(1)),
      };
    },
  },

  {
    name: 'list_templates',
    title: 'Workload catalog',
    description:
      'Ready-to-run workloads with their real VRAM, architecture and download requirements. MiniMax H3 is the best open-weight video model; LTX-2.5 is much faster and cheaper per clip.',
    shape: {},
    annotations: READ_ONLY,
    run: async () => ({
      ok: true,
      message: `${TEMPLATES.length} templates.`,
      templates: TEMPLATES.map(templateSummary),
      next_tool: 'recommend_plan',
    }),
  },

  {
    name: 'get_template',
    title: 'Template detail',
    description: 'Full detail for one workload: every weight file it downloads, hardware gates, and how to drive it once online.',
    shape: { template: z.string().describe('Template id, e.g. minimax-h3/i2v-32gb') },
    annotations: READ_ONLY,
    run: async (_ctx, args) => {
      const template = findTemplate(String(args.template));
      if (!template) throw new CliError(`Unknown template "${args.template}". Call list_templates.`, 2);
      return {
        ok: true,
        message: template.name,
        ...templateSummary(template),
        image: template.image,
        port: template.port,
        weights: template.weights.map((w) => ({ repo: w.repo, file: w.file, size_gb: w.sizeGb })),
      };
    },
  },

  {
    name: 'list_gpus',
    title: 'Offers ranked by real cost',
    description:
      'Live Vast offers for a workload, bucketed: ready_now, unverified, slow_link, no_ports, too_small, unsupported. Ranked by what the session actually costs (weight download time included), not by sticker $/hour.',
    shape: {
      template: z.string().describe('Template id the offers must be able to run'),
      work_minutes: z.number().optional().describe('Minutes of real GPU work planned, default 45'),
      max_usd_per_hour: z.number().optional(),
      limit: z.number().optional().describe('Rows per bucket, default 8'),
    },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const plan = await planDeployment(ctx.get(), {
        templateId: String(args.template),
        workMinutes: args.work_minutes as number | undefined,
        maxUsdPerHour: args.max_usd_per_hour as number | undefined,
        allowUnverified: true,
      }).catch(async (error) => {
        throw error;
      });
      const limit = (args.limit as number) ?? 8;
      const shown = Object.fromEntries(
        Object.entries(plan.buckets).map(([name, rows]) => [name, rows.slice(0, limit).map(offerSummary)]),
      );
      return {
        ok: true,
        message: `${plan.buckets.ready_now.length} verified offers fit ${plan.template.id}; cheapest real cost ${usd(plan.cost.totalUsd, 2)} for the session.`,
        counts: bucketCounts(plan.buckets),
        offers: shown,
        next_tool: 'recommend_plan',
        next_args: { template: plan.template.id },
      };
    },
  },

  {
    name: 'recommend_plan',
    title: 'Pick the cheapest offer that really fits',
    description:
      'One call from a workload to a concrete plan: the offer to rent, what the session will cost including weight download, the sticker-price trap it avoided, and the exact create_instance arguments. Never picks hardware the workload cannot run on.',
    shape: {
      template: z.string().describe('Template id, e.g. minimax-h3/i2v-32gb'),
      work_minutes: z.number().optional().describe('Minutes of real GPU work planned, default 45'),
      max_usd_per_hour: z.number().optional(),
      allow_unverified: z.boolean().optional().describe('Consider hosts Vast has not verified: cheaper, flakier'),
      gpu_names: z.array(z.string()).optional().describe('Restrict to exact Vast gpu_name values, e.g. ["RTX 5090"]'),
      interruptible: z.boolean().optional().describe('Bid for an interruptible instance; it can be reclaimed mid-render'),
    },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const plan = await planDeployment(ctx.get(), {
        templateId: String(args.template),
        workMinutes: args.work_minutes as number | undefined,
        maxUsdPerHour: args.max_usd_per_hour as number | undefined,
        allowUnverified: args.allow_unverified as boolean | undefined,
        gpuNames: args.gpu_names as string[] | undefined,
        interruptible: args.interruptible as boolean | undefined,
      });
      const teardownMinutes = Math.max(
        60,
        Math.ceil(((plan.cost.setupHours + plan.cost.workHours) * 60 + 30) / 15) * 15,
      );
      return {
        ok: true,
        message: `${plan.offer.gpuName} at ${usd(plan.offer.usdPerHour)}/h on a ${mbps(plan.offer.inetDownMbps)} link: about ${usd(plan.cost.totalUsd, 2)} for ${Math.round(plan.cost.workHours * 60)} minutes of work, including ${Math.round(plan.cost.setupHours * 60)} minutes of weight download.`,
        ...planEnvelopeFields(plan),
        next_tool: 'create_instance',
        next_args: {
          template: plan.template.id,
          offer_id: plan.offer.id,
          teardown_minutes: teardownMinutes,
          idle_minutes: 15,
          confirm: true,
        },
      };
    },
  },

  {
    name: 'estimate_deployment',
    title: 'Dry run',
    description: 'Exactly what create_instance would do with these arguments, including the teardown deadline and the worst-case bill. Spends nothing.',
    shape: {
      template: z.string(),
      offer_id: z.number().optional().describe('Omit to let the planner pick'),
      work_minutes: z.number().optional(),
      teardown_minutes: z.number().optional(),
      idle_minutes: z.number().nullable().optional(),
    },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const plan = await planDeployment(ctx.get(), {
        templateId: String(args.template),
        workMinutes: args.work_minutes as number | undefined,
      });
      const teardownMinutes = (args.teardown_minutes as number) ?? DEFAULT_TEARDOWN_MINUTES;
      const worstCase = (teardownMinutes / 60) * plan.offer.usdPerHour;
      const user = await getUser(ctx.get());
      return {
        ok: true,
        message: `Expected ${usd(plan.cost.totalUsd, 2)}; worst case ${usd(worstCase, 2)} if it runs the full ${teardownMinutes} minutes. Available: $${spendableUsd(user).toFixed(2)}.`,
        ...planEnvelopeFields(plan),
        teardown_minutes: teardownMinutes,
        idle_minutes: args.idle_minutes === undefined ? 15 : args.idle_minutes,
        worst_case_usd: Number(worstCase.toFixed(2)),
        available_usd: Number(spendableUsd(user).toFixed(2)),
        affordable: worstCase <= spendableUsd(user),
        next_tool: 'create_instance',
      };
    },
  },

  {
    name: 'create_instance',
    title: 'Rent the GPU and start the workload',
    description:
      'Rents the offer, starts the container, downloads the weights, and registers the instance for automatic teardown. Requires confirm=true, and you must show the user the cost estimate first. Every instance gets a hard deadline; there is no way to create one that runs forever.',
    shape: {
      template: z.string(),
      offer_id: z.number().optional().describe('From recommend_plan; omitted means plan again and take the best'),
      teardown_minutes: z
        .number()
        .optional()
        .describe('Hard wall: the reaper destroys the instance at this age no matter what. Default 120.'),
      idle_minutes: z
        .number()
        .nullable()
        .optional()
        .describe('Destroy this long after the render queue goes quiet. Default 15. null disables it.'),
      work_minutes: z.number().optional(),
      disk_gb: z.number().optional(),
      label: z.string().optional(),
      interruptible: z
        .boolean()
        .optional()
        .describe('Bid for an interruptible instance. Roughly 3-5x cheaper, but the host can reclaim it mid-render; the instance is then stopped (not destroyed) and its disk survives.'),
      bid_usd_per_hour: z.number().optional().describe('Bid price; defaults to just above the offer minimum.'),
      confirm: z.boolean().describe('Must be true. The user has seen the estimate and agreed.'),
      force: z.boolean().optional().describe('Skip the affordability check'),
      allow_unverified: z.boolean().optional(),
    },
    annotations: WRITES,
    run: async (ctx, args) => {
      if (args.confirm !== true) {
        return {
          ok: false,
          message: 'create_instance needs confirm=true. Show the user estimate_deployment or recommend_plan output and get a yes first.',
          next_tool: 'recommend_plan',
        };
      }
      const client = ctx.get();
      const interruptible = Boolean(args.interruptible || args.bid_usd_per_hour);
      const plan = await planDeployment(client, {
        templateId: String(args.template),
        workMinutes: args.work_minutes as number | undefined,
        allowUnverified: args.allow_unverified as boolean | undefined,
        interruptible,
      });

      // Honour an explicit offer id by re-pointing the plan at it.
      if (args.offer_id) {
        const wanted = Number(args.offer_id);
        const all = [...plan.buckets.ready_now, ...plan.buckets.risky_host, ...plan.buckets.unverified, ...plan.buckets.slow_link];
        const match = all.find((row) => row.offer.id === wanted);
        if (!match) {
          return {
            ok: false,
            message: `Offer ${wanted} is no longer available or does not fit ${plan.template.id}. Vast offers expire in minutes. Call recommend_plan again.`,
            next_tool: 'recommend_plan',
            next_args: { template: plan.template.id },
          };
        }
        plan.offer = match.offer;
        plan.cost = match.cost;
      }

      const bid = interruptible
        ? Number(args.bid_usd_per_hour ?? Math.max(plan.offer.minBid ?? 0, plan.offer.usdPerHour) * 1.05)
        : undefined;
      const result = await createInstance(client, plan, {
        bidUsdPerHour: bid,
        teardownMinutes: args.teardown_minutes as number | undefined,
        idleMinutes: args.idle_minutes as number | null | undefined,
        diskGb: args.disk_gb as number | undefined,
        label: args.label as string | undefined,
        confirm: true,
        force: args.force as boolean | undefined,
      });

      return {
        ok: true,
        message: `Instance ${result.instanceId} created on ${plan.offer.gpuName} (${usd(plan.offer.usdPerHour)}/h). It will be destroyed automatically at ${new Date(result.deadlineAt).toISOString()}${result.idleMinutes ? `, or ${result.idleMinutes} minutes after the queue goes quiet` : ''}. Expect ${plan.template.bootMinutesTypical} minutes before it is usable.`,
        instance_id: result.instanceId,
        label: result.label,
        teardown: {
          deadline: new Date(result.deadlineAt).toISOString(),
          idle_minutes: result.idleMinutes,
          reaper_pid: result.reaper.pid,
          reaper_started_now: result.reaper.started,
        },
        estimated_usd: Number(result.estimatedUsd.toFixed(2)),
        next_tool: 'wait_for_instance',
        next_args: { instance_id: result.instanceId, template: plan.template.id },
      };
    },
  },

  {
    name: 'wait_for_instance',
    title: 'Watch it come up',
    description:
      'Polls for up to 45 seconds and returns the phase: creating, loading, downloading_weights, online, stopped or failed. Call repeatedly until online. Weight downloads take most of the boot time.',
    shape: {
      instance_id: z.number(),
      template: z.string(),
      max_seconds: z.number().optional().describe(`Up to ${WAIT_MAX_SECONDS}`),
    },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const template = findTemplate(String(args.template));
      if (!template) throw new CliError(`Unknown template "${args.template}".`, 2);
      const maxSeconds = Math.min((args.max_seconds as number) ?? WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS);
      const result = await waitForInstance(ctx.get(), Number(args.instance_id), template, maxSeconds * 1000);

      // Keep the reaper's endpoint fresh so idle teardown can actually probe the queue.
      if (result.endpoint) {
        const ledger = readLedger();
        const entry = ledger.entries.find((e) => e.instanceId === Number(args.instance_id) && !e.destroyedAt);
        if (entry && entry.endpoint !== result.endpoint) {
          upsertEntry({ ...entry, endpoint: result.endpoint });
        }
      }

      return {
        ok: true,
        message: result.message,
        phase: result.phase,
        endpoint: result.endpoint,
        ssh: result.ssh,
        elapsed_seconds: result.elapsedSeconds,
        poll_after_seconds: result.pollAfterSeconds,
        instance: result.instance ? instanceSummary(result.instance, template) : null,
        next_tool:
          result.phase === 'online'
            ? 'get_endpoint_usage'
            : result.phase === 'failed' || result.phase === 'stopped'
              ? 'get_logs'
              : 'wait_for_instance',
        next_args:
          result.phase === 'online'
            ? { instance_id: Number(args.instance_id), template: template.id }
            : { instance_id: Number(args.instance_id), template: template.id },
      };
    },
  },

  {
    name: 'list_instances',
    title: 'What is running',
    description: 'Every instance on the account with what it costs per hour, what it has spent so far, and when it is scheduled to die. Anything without a teardown entry is flagged.',
    shape: {},
    annotations: READ_ONLY,
    run: async (ctx) => {
      const instances = await listInstances(ctx.get());
      const burn = instances.reduce((sum, i) => sum + i.usdPerHour, 0);
      const unwatched = instances.filter(
        (i) => !readLedger().entries.some((e) => e.instanceId === i.id && !e.destroyedAt),
      );
      return {
        ok: true,
        message: instances.length
          ? `${instances.length} instance(s), burning ${usd(burn, 3)}/hour.${unwatched.length ? ` ${unwatched.length} have NO automatic teardown.` : ''}`
          : 'Nothing is running. Nothing is being billed.',
        instances: instances.map((i) => instanceSummary(i)),
        total_usd_per_hour: Number(burn.toFixed(4)),
        unwatched_instance_ids: unwatched.map((i) => i.id),
        next_tool: instances.length ? 'destroy_instance' : null,
      };
    },
  },

  {
    name: 'get_instance',
    title: 'One instance in detail',
    description: 'Status, endpoint, SSH command, spend so far and teardown schedule for a single instance.',
    shape: { instance_id: z.number(), template: z.string().optional() },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const instance = await getInstance(ctx.get(), Number(args.instance_id));
      if (!instance) {
        return {
          ok: true,
          message: `Instance ${args.instance_id} does not exist any more. It has been destroyed and is not being billed.`,
          instance: null,
          next_tool: null,
        };
      }
      const template = args.template ? findTemplate(String(args.template)) : undefined;
      return { ok: true, message: `Instance ${instance.id} is ${instance.status}.`, instance: instanceSummary(instance, template) };
    },
  },

  {
    name: 'get_endpoint_usage',
    title: 'How to use the running service',
    description: 'The ComfyUI URL, the SSH command, how to POST a workflow to /prompt, and how to pull finished renders off the box before it is destroyed.',
    shape: { instance_id: z.number(), template: z.string() },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const template = findTemplate(String(args.template));
      if (!template) throw new CliError(`Unknown template "${args.template}".`, 2);
      const instance = await getInstance(ctx.get(), Number(args.instance_id));
      if (!instance) return { ok: false, message: `Instance ${args.instance_id} is gone.`, next_tool: null };
      const endpoint = endpointFor(instance, template.port);
      const portal = endpointFor(instance, template.portalPort);
      const ssh = sshCommand(instance);
      return {
        ok: true,
        message: endpoint ? `ComfyUI at ${endpoint}` : 'No port mapping yet; the instance is still starting.',
        endpoint,
        portal,
        ssh,
        usage: {
          comfyui_api: endpoint,
          portal_ui: portal,
          queue_api: endpoint ? `POST ${endpoint}/prompt with {"prompt": <workflow api json>}` : null,
          queue_status: endpoint ? `GET ${endpoint}/queue` : null,
          history: endpoint ? `GET ${endpoint}/history/<prompt_id>` : null,
          fetch_output: endpoint ? `GET ${endpoint}/view?filename=<name>&subfolder=&type=output` : null,
          copy_off_the_box: ssh
            ? `${ssh.replace('ssh ', 'scp -r ').replace('root@', '')}:/workspace/ComfyUI/output ./renders  (adjust the path to the ComfyUI dir the logs report)`
            : null,
        },
        hardware_notes: template.hardwareNotes,
        reminder:
          'Download your renders before the instance is destroyed: destroying deletes the disk, and there is no way to get it back.',
        exposure_warning:
          'The ComfyUI port is open on the host\u2019s public IP with no authentication, as is normal for Vast. Anyone who scans that port can queue jobs on your GPU while the instance lives, which is one more reason to keep the teardown window short.',
        next_tool: 'destroy_instance',
        next_args: { instance_id: instance.id },
      };
    },
  },

  {
    name: 'get_logs',
    title: 'Container logs',
    description: 'Tail of the container log, including the weight-download progress written by the setup script.',
    shape: { instance_id: z.number(), tail: z.number().optional().describe('Lines, default 200') },
    annotations: READ_ONLY,
    run: async (ctx, args) => {
      const text = await fetchLogs(ctx.get(), Number(args.instance_id), (args.tail as number) ?? 200);
      const setupLines = text
        .split('\n')
        .filter((l) => l.includes('[vastai-mcp]'))
        .slice(-25);
      return {
        ok: true,
        message: text ? `${text.split('\n').length} lines.` : 'No logs available yet; the container may still be starting.',
        setup_progress: setupLines,
        logs: text.slice(-8000),
      };
    },
  },

  {
    name: 'extend_teardown',
    title: 'Push the deadline back',
    description: 'Moves an instance’s hard teardown deadline. Use when a render needs longer than planned; it never removes the deadline entirely.',
    shape: {
      instance_id: z.number(),
      additional_minutes: z.number().describe('Minutes to add to the current deadline'),
      idle_minutes: z.number().nullable().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (_ctx, args) => {
      const ledger = readLedger();
      const entry = ledger.entries.find((e) => e.instanceId === Number(args.instance_id) && !e.destroyedAt);
      if (!entry) {
        return {
          ok: false,
          message: `Instance ${args.instance_id} is not in the teardown ledger. Nothing is scheduled to destroy it, which is worse than a short deadline. Use destroy_instance when you are done.`,
          next_tool: 'list_instances',
        };
      }
      const add = Math.max(1, Number(args.additional_minutes));
      const deadlineAt = Math.max(Date.now(), entry.deadlineAt) + add * 60_000;
      upsertEntry({
        ...entry,
        deadlineAt,
        idleMinutes: args.idle_minutes === undefined ? entry.idleMinutes : (args.idle_minutes as number | null),
      });
      ensureReaper();
      return {
        ok: true,
        message: `Deadline moved to ${new Date(deadlineAt).toISOString()} (${Math.round((deadlineAt - Date.now()) / 60_000)} minutes from now).`,
        deadline: new Date(deadlineAt).toISOString(),
      };
    },
  },

  {
    name: 'destroy_instance',
    title: 'Destroy it now',
    description:
      'Destroys the instance immediately and stops all billing, then verifies it is really gone. This deletes the disk: make sure the renders have been downloaded first.',
    shape: { instance_id: z.number(), reason: z.string().optional() },
    annotations: WRITES,
    run: async (ctx, args) => {
      const client = ctx.get();
      const result = await destroyAndForget(client, Number(args.instance_id), String(args.reason ?? 'requested by the user'));
      const still = await getInstance(client, Number(args.instance_id)).catch(() => null);
      return {
        ok: result.ok && !still,
        message: still
          ? `Vast accepted the destroy but instance ${args.instance_id} is still listed as ${still.status}. Call again in a few seconds.`
          : result.message,
        verified_gone: !still,
        next_tool: still ? 'destroy_instance' : 'list_instances',
      };
    },
  },

  {
    name: 'destroy_all',
    title: 'Panic button',
    description: 'Destroys every instance on the account and confirms nothing is left billing. Requires confirm=true.',
    shape: { confirm: z.boolean().describe('Must be true') },
    annotations: WRITES,
    run: async (ctx, args) => {
      if (args.confirm !== true) {
        return { ok: false, message: 'destroy_all needs confirm=true.', next_tool: 'list_instances' };
      }
      const client = ctx.get();
      const instances = await listInstances(client);
      const results = [];
      for (const instance of instances) {
        results.push({ instance_id: instance.id, ...(await destroyAndForget(client, instance.id, 'destroy_all')) });
      }
      const check = await verifyNothingRunning(client);
      return {
        ok: check.clean,
        message: check.clean
          ? `${results.length} instance(s) destroyed. Nothing is running and nothing is being billed.`
          : `${check.running.length} instance(s) are still listed. Call destroy_all again.`,
        destroyed: results,
        still_running: check.running.map((i) => i.id),
      };
    },
  },

  {
    name: 'teardown_status',
    title: 'What is scheduled to die, and is the watchdog alive',
    description:
      'The teardown ledger plus the reaper process state. Restarts the reaper if it died while instances are still scheduled. Call this whenever you want proof that nothing will be left running.',
    shape: { restart_reaper: z.boolean().optional().describe('Restart the watchdog if it is not running, default true') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (ctx, args) => {
      const active = activeEntries();
      let pid = reaperRunning();
      let restarted = false;
      if (!pid && active.length && args.restart_reaper !== false) {
        const started = ensureReaper();
        pid = started.pid;
        restarted = started.started;
      }
      const live = await listInstances(ctx.get()).catch(() => [] as Instance[]);
      const unwatched = live.filter((i) => !active.some((e) => e.instanceId === i.id));
      return {
        ok: !unwatched.length,
        message: active.length
          ? `${active.length} instance(s) scheduled for teardown; watchdog ${pid ? `alive (pid ${pid})` : 'NOT running'}.${unwatched.length ? ` ${unwatched.length} running instance(s) are NOT watched.` : ''}`
          : live.length
            ? `Nothing in the ledger but ${live.length} instance(s) are running unwatched.`
            : 'Nothing scheduled, nothing running.',
        reaper_pid: pid,
        reaper_restarted: restarted,
        scheduled: active.map((e: TeardownEntry) => ({
          instance_id: e.instanceId,
          template: e.templateId,
          deadline: new Date(e.deadlineAt).toISOString(),
          minutes_left: Math.round((e.deadlineAt - Date.now()) / 60_000),
          idle_minutes: e.idleMinutes,
          usd_per_hour: e.usdPerHour,
        })),
        unwatched_instance_ids: unwatched.map((i) => i.id),
        next_tool: unwatched.length ? 'destroy_instance' : null,
      };
    },
  },
];

export const prompts = {
  generate_and_teardown: (workload?: string, what?: string) =>
    [
      `Rent a GPU on Vast.ai, run ${workload ?? 'minimax-h3/i2v-32gb'}, ${what ?? 'generate the video I describe'}, then tear the instance down.`,
      'Steps: recommend_plan for the workload, show me the cost including weight-download time and wait for my yes,',
      'create_instance with idle_minutes set so it cannot idle for long, poll wait_for_instance until phase is online,',
      'give me the ComfyUI URL, and once I confirm the render is downloaded call destroy_instance and verify it is gone.',
      'If I go quiet, the reaper destroys it at the deadline anyway. Tell me the deadline when you create it.',
    ].join(' '),
  deploy_minimax_h3: (variant?: string) =>
    [
      `Deploy ${variant ?? 'minimax-h3/i2v-32gb'} on the cheapest Vast.ai offer that can actually run it.`,
      'MiniMax H3 needs a Blackwell card for its nvfp4 text encoder, so never accept an Ada or Hopper host for the 32gb variants.',
      'Rank offers by real session cost, not by $/hour: a cheap host on a slow link bills more hours downloading 44 GB of weights than it saves.',
      'Show me the estimate first, then create, then poll, then hand me the URL.',
    ].join(' '),
  stop_everything: () =>
    'Call list_instances, tell me what is running and what it is costing per hour, then destroy everything with destroy_all(confirm=true) and verify nothing is left.',
};

export async function templatesResource(): Promise<string> {
  return JSON.stringify(TEMPLATES.map(templateSummary), null, 2);
}

export async function instancesResource(ctx: ToolContext): Promise<string> {
  const instances = await listInstances(ctx.get());
  return JSON.stringify(instances.map((i) => instanceSummary(i)), null, 2);
}

export { gb, duration };
