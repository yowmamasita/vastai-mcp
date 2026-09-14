#!/usr/bin/env node
/**
 * Read-only smoke test against the live Vast.ai API. Spends nothing: it never calls
 * create_instance. Needs VAST_API_KEY in the environment or a stored vast-deploy login.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const server = path.join(root, 'dist', 'mcp', 'index.js');

let failures = 0;
const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  ok    ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
};

const transport = new StdioClientTransport({ command: process.execPath, args: [server] });
const client = new Client({ name: 'smoke', version: '0.0.0' });
await client.connect(transport);

const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const payload = result.structuredContent ?? JSON.parse(result.content[0].text);
  return payload;
};

console.log('\ntools');
const { tools } = await client.listTools();
const names = tools.map((t) => t.name);
check(`${tools.length} tools registered`, tools.length >= 15, names.join(', '));
for (const required of ['doctor', 'recommend_plan', 'create_instance', 'destroy_instance', 'teardown_status']) {
  check(`${required} present`, names.includes(required));
}
const create = tools.find((t) => t.name === 'create_instance');
check('create_instance is marked destructive', create?.annotations?.readOnlyHint === false);
check('create_instance requires confirm', Object.keys(create.inputSchema.properties ?? {}).includes('confirm'));

console.log('\ndoctor');
const doctor = await call('doctor');
check('doctor ok', doctor.ok === true, doctor.message);
check('doctor checked the key', doctor.checks?.some((c) => c.check === 'api_key' && c.ok));
check('doctor checked the watchdog', doctor.checks?.some((c) => c.check === 'teardown_reaper'));

console.log('\ncatalog');
const templates = await call('list_templates');
check('templates returned', templates.templates?.length >= 5);
const h3 = templates.templates.find((t) => t.id === 'minimax-h3/i2v-32gb');
check('h3 requires Blackwell', h3?.requires_compute_capability === 12);
check('h3 download is realistic', h3?.download_gb > 50 && h3?.download_gb < 80, String(h3?.download_gb));

console.log('\nplanning (live marketplace)');
const plan = await call('recommend_plan', { template: 'minimax-h3/i2v-32gb', work_minutes: 45 });
check('plan ok', plan.ok === true, plan.message);
check('plan picked an offer', Number.isFinite(plan.offer?.offer_id));
check('picked GPU is Blackwell', plan.offer?.compute_capability >= 12, String(plan.offer?.compute_capability));
check('plan has a session cost', plan.cost?.total_usd > 0);
check('plan accounts for setup time', plan.cost?.setup_minutes >= 0);
check('no unsupported GPU was offered', (plan.buckets?.unsupported ?? 0) >= 0);
check('next step is create_instance', plan.next_tool === 'create_instance');
check('create args carry a teardown deadline', plan.next_args?.teardown_minutes > 0);

console.log('\nrefusals');
const unconfirmed = await call('create_instance', { template: 'comfyui/bare', confirm: false });
check('create_instance refuses without confirm', unconfirmed.ok === false, unconfirmed.message);
const badTemplate = await call('recommend_plan', { template: 'no-such-template' });
check('unknown template is rejected', badTemplate.ok === false);

console.log('\nteardown');
const teardown = await call('teardown_status', { restart_reaper: false });
check('teardown_status answers', typeof teardown.message === 'string', teardown.message);
check('teardown_status lists scheduled instances', Array.isArray(teardown.scheduled));
const instances = await call('list_instances');
check('list_instances answers', Array.isArray(instances.instances), instances.message);

await client.close();
console.log(`\n${failures ? `${failures} FAILURE(S)` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
