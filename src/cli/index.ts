#!/usr/bin/env node
import { createRequire } from 'node:module';
import readline from 'node:readline/promises';
import { Command } from 'commander';
import pc from 'picocolors';
import { CliError, VastClient, getUser, spendableUsd } from '../core/client.js';
import { maskKey, readConfig, resolveApiKey, writeConfig } from '../core/config.js';
import {
  createInstance,
  destroyAndForget,
  endpointFor,
  fetchLogs,
  listInstances,
  planDeployment,
  sshCommand,
  waitForInstance,
} from '../core/deploy.js';
import { duration, formatError, mbps, sleep, table, usd } from '../core/format.js';
import { offerTable } from '../core/offers.js';
import { TEMPLATES, downloadGb, findTemplate } from '../core/templates.js';
import { activeEntries, ensureReaper, reaperRunning } from '../core/reaper.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
const program = new Command();

program
  .name('vast-deploy')
  .description('Rent the cheapest Vast.ai GPU that can really run a workload, then make sure it dies.')
  .version(version)
  .option('--api-key <key>', 'Vast.ai API key (overrides env and stored config)')
  .option('--json', 'machine-readable output');

const client = () => VastClient.from({ apiKey: program.opts().apiKey as string | undefined });

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} ${pc.dim('[y/N]')} `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

program
  .command('login')
  .description('Store a Vast.ai API key in ~/.config/vast-deploy/config.json')
  .argument('[key]', 'the key; omit to be prompted')
  .action(async (key?: string) => {
    let value = key;
    if (!value) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      value = (await rl.question('Vast.ai API key: ')).trim();
      rl.close();
    }
    const user = await getUser(new VastClient(value));
    writeConfig({ ...readConfig(), apiKey: value });
    console.log(pc.green(`Stored ${maskKey(value)} for ${user.username}. $${spendableUsd(user).toFixed(2)} available.`));
  });

program
  .command('doctor')
  .description('Check key, funds and the teardown watchdog')
  .action(async () => {
    const key = resolveApiKey(program.opts().apiKey as string | undefined);
    console.log(`API key      ${key ? pc.green(`${maskKey(key.key)} (${key.source})`) : pc.red('missing')}`);
    if (!key) throw new CliError('Run `vast-deploy login`, or set VAST_API_KEY.');
    const user = await getUser(client());
    console.log(`Account      ${pc.green(user.username)}`);
    console.log(`Available    ${spendableUsd(user) > 0.5 ? pc.green(usd(spendableUsd(user), 2)) : pc.red(usd(spendableUsd(user), 2))}`);
    const pid = reaperRunning();
    const watching = activeEntries().length;
    console.log(`Watchdog     ${pid ? pc.green(`running (pid ${pid}), watching ${watching}`) : watching ? pc.red(`NOT running, ${watching} scheduled`) : pc.dim('idle, starts with the first instance')}`);
  });

program
  .command('templates')
  .description('List runnable workloads')
  .action(() => {
    console.log(
      table(
        ['Id', 'VRAM', 'Arch', 'Download', 'Boot', 'What it is'],
        TEMPLATES.map((t) => [
          t.id,
          t.fit.minVramGbPerGpu ? `${t.fit.minVramGbPerGpu} GB` : '-',
          t.fit.minComputeCap ? `sm_${t.fit.minComputeCap / 10}+` : 'any',
          `${downloadGb(t).toFixed(0)} GB`,
          `${t.bootMinutesTypical}m`,
          t.name,
        ]),
      ),
    );
  });

program
  .command('gpus')
  .description('Offers that can run a workload, ranked by real session cost')
  .requiredOption('-t, --template <id>', 'template id')
  .option('-w, --work-minutes <n>', 'minutes of real GPU work planned', '45')
  .option('--max-usd-per-hour <n>')
  .option('--unverified', 'include hosts Vast has not verified')
  .action(async (options) => {
    const plan = await planDeployment(client(), {
      templateId: options.template,
      workMinutes: Number(options.workMinutes),
      maxUsdPerHour: options.maxUsdPerHour ? Number(options.maxUsdPerHour) : undefined,
      allowUnverified: Boolean(options.unverified),
    });
    console.log(pc.bold(`\nReady now (${plan.buckets.ready_now.length})`));
    console.log(offerTable(plan.buckets.ready_now));
    if (plan.buckets.risky_host.length) {
      console.log(pc.bold(`\nFits but the host record is poor (${plan.buckets.risky_host.length})`));
      console.log(offerTable(plan.buckets.risky_host, 4));
    }
    if (plan.buckets.slow_link.length) {
      console.log(pc.bold(`\nRejected for a slow link (${plan.buckets.slow_link.length}) ${pc.dim('cheap per hour, expensive per render')}`));
      console.log(offerTable(plan.buckets.slow_link, 4));
    }
    if (plan.buckets.unsupported.length) {
      console.log(pc.dim(`\n${plan.buckets.unsupported.length} offers rejected on GPU architecture: ${plan.template.fit.archReason ?? ''}`));
    }
    if (plan.cheapestStickerTrap) {
      const trap = plan.cheapestStickerTrap;
      console.log(
        pc.yellow(
          `\nCheapest sticker price is offer ${trap.offer.id} at ${usd(trap.offer.usdPerHour)}/h on ${mbps(trap.offer.inetDownMbps)}: it would cost ${usd(trap.extraUsd, 2)} MORE for this session.`,
        ),
      );
    }
  });

program
  .command('run')
  .description('Plan, confirm, rent, wait, and hand back the URL')
  .requiredOption('-t, --template <id>', 'template id')
  .option('-w, --work-minutes <n>', 'minutes of real GPU work planned', '45')
  .option('--teardown-minutes <n>', 'hard deadline', '120')
  .option('--idle-minutes <n>', 'destroy this long after the queue goes quiet; 0 disables', '15')
  .option('--max-usd-per-hour <n>')
  .option('--unverified', 'allow hosts Vast has not verified')
  .option('--interruptible', 'bid for an interruptible instance: far cheaper, but the host can reclaim it mid-render')
  .option('--bid <usd>', 'bid price per hour; defaults to just above the offer minimum')
  .option('--gpu <name...>', 'restrict to these exact Vast gpu_name values, e.g. --gpu "RTX PRO 6000 Max-Q"')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (options) => {
    const api = client();
    const interruptible = Boolean(options.interruptible || options.bid);
    const plan = await planDeployment(api, {
      templateId: options.template,
      workMinutes: Number(options.workMinutes),
      maxUsdPerHour: options.maxUsdPerHour ? Number(options.maxUsdPerHour) : undefined,
      allowUnverified: Boolean(options.unverified),
      gpuNames: options.gpu,
      interruptible,
    });

    console.log(pc.bold(`\n${plan.template.name}`));
    console.log(offerTable([{ offer: plan.offer, cost: plan.cost, bucket: 'ready_now', risks: [] }], 1));
    console.log(
      `\n  ${downloadGb(plan.template).toFixed(0)} GB to download at ${mbps(plan.offer.inetDownMbps)} -> about ${Math.round(plan.cost.setupHours * 60)} minutes of paid setup`,
    );
    console.log(`  ${Math.round(plan.cost.workHours * 60)} minutes of work -> ${pc.bold(usd(plan.cost.totalUsd, 2))} total`);
    console.log(`  hard teardown after ${options.teardownMinutes} minutes, idle teardown after ${options.idleMinutes} minutes`);
    if (plan.cheapestStickerTrap) {
      console.log(pc.yellow(`  avoided offer ${plan.cheapestStickerTrap.offer.id}: cheaper per hour, ${usd(plan.cheapestStickerTrap.extraUsd, 2)} more per session`));
    }
    for (const warning of plan.warnings) console.log(pc.yellow(`  ! ${warning}`));

    if (!options.yes && !(await confirm('\nRent it?'))) {
      console.log('Cancelled. Nothing was created.');
      return;
    }

    const idle = Number(options.idleMinutes);
    // Bidding below the offer's minimum is simply never scheduled, so float just above it.
    const bid = interruptible
      ? Number(options.bid ?? Math.max(plan.offer.minBid ?? 0, plan.offer.usdPerHour) * 1.05)
      : undefined;
    if (bid) console.log(pc.dim(`  bidding ${usd(bid)}/h (offer minimum ${usd(plan.offer.minBid ?? 0)})`));
    const result = await createInstance(api, plan, {
      teardownMinutes: Number(options.teardownMinutes),
      idleMinutes: idle > 0 ? idle : null,
      bidUsdPerHour: bid,
      confirm: true,
    });
    console.log(pc.green(`\nInstance ${result.instanceId} created.`));
    console.log(`Watchdog pid ${result.reaper.pid}; hard deadline ${new Date(result.deadlineAt).toLocaleString()}`);

    const started = Date.now();
    for (;;) {
      const status = await waitForInstance(api, result.instanceId, plan.template, 30_000);
      const elapsed = duration((Date.now() - started) / 1000);
      console.log(`${elapsed.padStart(7)}  ${status.phase}  ${pc.dim(status.message)}`);
      if (status.phase === 'online') {
        console.log(pc.green(`\n  ${status.endpoint}`));
        if (status.ssh) console.log(pc.dim(`  ${status.ssh}`));
        console.log(pc.dim(`\n  Download your renders before it dies: vast-deploy destroy ${result.instanceId}`));
        return;
      }
      if (status.phase === 'failed' || status.phase === 'stopped') {
        console.log(pc.red(`\n  ${status.message}`));
        return;
      }
      await sleep(10_000);
    }
  });

program
  .command('instances')
  .alias('ps')
  .description('What is running and what it is costing')
  .action(async () => {
    const instances = await listInstances(client());
    if (!instances.length) {
      console.log('Nothing running. Nothing being billed.');
      return;
    }
    const scheduled = activeEntries();
    console.log(
      table(
        ['Id', 'Status', 'GPU', '$/h', 'Age', 'Spent', 'Teardown'],
        instances.map((i) => {
          const entry = scheduled.find((e) => e.instanceId === i.id);
          const ageHours = i.startedAt ? (Date.now() - i.startedAt) / 3_600_000 : 0;
          return [
            String(i.id),
            i.status,
            i.gpuName ?? '?',
            usd(i.usdPerHour),
            i.startedAt ? duration((Date.now() - i.startedAt) / 1000) : '?',
            usd(ageHours * i.usdPerHour, 2),
            entry ? `in ${Math.round((entry.deadlineAt - Date.now()) / 60_000)}m` : pc.red('UNWATCHED'),
          ];
        }),
      ),
    );
    const burn = instances.reduce((s, i) => s + i.usdPerHour, 0);
    console.log(`\nBurning ${pc.bold(usd(burn, 3))}/hour.`);
  });

program
  .command('logs')
  .description('Container log tail, including weight-download progress')
  .argument('<instance_id>')
  .option('-n, --tail <n>', 'lines', '200')
  .action(async (id: string, options) => {
    const text = await fetchLogs(client(), Number(id), Number(options.tail));
    console.log(text || 'No logs yet.');
  });

program
  .command('destroy')
  .description('Destroy an instance now and verify it is gone')
  .argument('<instance_id>')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (id: string, options) => {
    if (!options.yes && !(await confirm(`Destroy instance ${id}? This deletes its disk.`))) {
      console.log('Cancelled.');
      return;
    }
    const api = client();
    const result = await destroyAndForget(api, Number(id), 'cli');
    console.log(result.ok ? pc.green(result.message) : pc.red(result.message));
    await sleep(3000);
    const left = (await listInstances(api)).find((i) => i.id === Number(id));
    console.log(left ? pc.yellow(`Still listed as ${left.status}; run again in a moment.`) : pc.green('Verified gone.'));
  });

program
  .command('destroy-all')
  .description('Destroy every instance on the account')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (options) => {
    const api = client();
    const instances = await listInstances(api);
    if (!instances.length) {
      console.log('Nothing running.');
      return;
    }
    console.log(instances.map((i) => `  ${i.id}  ${i.gpuName}  ${usd(i.usdPerHour)}/h`).join('\n'));
    if (!options.yes && !(await confirm(`Destroy all ${instances.length}?`))) {
      console.log('Cancelled.');
      return;
    }
    for (const instance of instances) {
      const result = await destroyAndForget(api, instance.id, 'cli destroy-all');
      console.log(result.ok ? pc.green(`  ${instance.id} destroyed`) : pc.red(`  ${instance.id}: ${result.message}`));
    }
  });

program
  .command('reap')
  .description('Teardown ledger and watchdog state; restarts the watchdog if it died')
  .action(async () => {
    const active = activeEntries();
    let pid = reaperRunning();
    if (!pid && active.length) {
      pid = ensureReaper().pid;
      console.log(pc.yellow(`Watchdog was dead; restarted as pid ${pid}.`));
    }
    console.log(`Watchdog: ${pid ? pc.green(`pid ${pid}`) : pc.dim('not running')}`);
    if (!active.length) {
      console.log('Nothing scheduled for teardown.');
      return;
    }
    console.log(
      table(
        ['Instance', 'Template', 'Deadline in', 'Idle', '$/h'],
        active.map((e) => [
          String(e.instanceId),
          e.templateId,
          `${Math.round((e.deadlineAt - Date.now()) / 60_000)}m`,
          e.idleMinutes ? `${e.idleMinutes}m` : 'off',
          usd(e.usdPerHour),
        ]),
      ),
    );
  });

program
  .command('endpoint')
  .description('Print the service URL and SSH command for an instance')
  .argument('<instance_id>')
  .option('-t, --template <id>', 'template id', 'minimax-h3/i2v-32gb')
  .action(async (id: string, options) => {
    const template = findTemplate(options.template);
    if (!template) throw new CliError(`Unknown template ${options.template}`);
    const instance = (await listInstances(client())).find((i) => i.id === Number(id));
    if (!instance) throw new CliError(`Instance ${id} not found.`);
    console.log(endpointFor(instance, template.port) ?? 'no port mapping yet');
    console.log(pc.dim(sshCommand(instance) ?? 'no ssh yet'));
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  const exitCode = error instanceof CliError ? error.exitCode : 1;
  console.error(pc.red(formatError(error)));
  process.exit(exitCode);
}
