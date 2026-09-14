#!/usr/bin/env node
import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CliError } from '../core/client.js';
import { formatError, stripAnsi } from '../core/format.js';
import {
  ToolContext,
  WAIT_MAX_SECONDS,
  instancesResource,
  prompts,
  templatesResource,
  tools,
  type Envelope,
} from './tools.js';

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string };
const ctx = new ToolContext();

const server = new McpServer(
  { name: 'vastai', version },
  {
    instructions: [
      'Vast.ai MCP rents GPUs on the Vast.ai marketplace and runs open-weight video and image workloads on them: MiniMax H3 (the best open-weight video model), LTX-2.5 (much faster per clip), or bare ComfyUI.',
      'Start with recommend_plan(template). It ranks offers by what the session really costs, not by $/hour: a $0.26/h host on a 48 Mb/s link bills over two paid hours pulling 44 GB of MiniMax H3 weights, while a $0.40/h host on gigabit is warm in six minutes and finishes cheaper. Relay the sticker_price_trap field when it is present.',
      'Hardware gates are real, not advisory. MiniMax H3 32gb variants need a Blackwell card (compute capability 12.0) for the nvfp4 text encoder; offers in the unsupported bucket will download 44 GB and then fail. Never force one.',
      'Always show the user the cost estimate before create_instance and pass confirm=true only after they agree.',
      'Every instance is created with a hard teardown deadline and, by default, idle teardown 15 minutes after the render queue goes quiet. A detached watchdog enforces both even if this session ends. Tell the user the deadline when you create an instance.',
      `Poll wait_for_instance with max_seconds <= ${WAIT_MAX_SECONDS}. MiniMax H3 takes 15 to 30 minutes to boot because of the weight download; phase "downloading_weights" is normal, not an error.`,
      'Destroying an instance deletes its disk. Remind the user to download renders (get_endpoint_usage shows how) before destroy_instance. When the work is done, call destroy_instance and confirm verified_gone is true.',
      'Every response is a JSON object with ok, message, and next_tool/next_args suggesting the next call.',
    ].join(' '),
  },
);

const envelopeShape = {
  ok: z.boolean().describe('false only when the tool itself failed (bad input, missing key, API error).'),
  message: z.string().describe('Human-readable summary to relay to the user.'),
  next_tool: z.string().nullable().optional().describe('Suggested next tool, or null when nothing else is needed.'),
  next_args: z.record(z.string(), z.unknown()).optional().describe('Suggested arguments for next_tool.'),
};
const envelopeSchema = z.looseObject(envelopeShape);

const toResult = (envelope: Envelope, isError = false) => ({
  isError,
  content: [{ type: 'text' as const, text: stripAnsi(JSON.stringify(envelope, null, 2)) }],
  structuredContent: envelope as unknown as Record<string, unknown>,
});

for (const definition of tools) {
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: `${definition.description} Returns JSON: {ok, message, next_tool, next_args, ...tool-specific fields}.`,
      inputSchema: definition.shape,
      outputSchema: envelopeSchema,
      annotations: definition.annotations,
    },
    async (args) => {
      try {
        return toResult(await definition.run(ctx, args as Record<string, unknown>));
      } catch (error) {
        const message = stripAnsi(formatError(error));
        const noKey = /No Vast\.ai API key/.test(message);
        const hint =
          error instanceof CliError && error.exitCode === 2
            ? 'Fix the arguments and call again.'
            : noKey
              ? 'Call doctor for the exact configuration fix.'
              : /fetch failed|ENOTFOUND|timed out|50[234]/.test(message)
                ? 'Transient network problem talking to Vast; retry in a few seconds.'
                : /no longer available|does not fit/i.test(message)
                  ? 'Vast offers expire within minutes. Call recommend_plan again for a fresh one.'
                  : undefined;
        return toResult({ ok: false, message, error: message, hint, next_tool: noKey ? 'doctor' : null }, true);
      }
    },
  );
}

server.registerResource(
  'templates',
  'vastai://templates',
  { title: 'Workload catalog', description: 'Runnable workloads with VRAM, architecture and download requirements.', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: await templatesResource() }] }),
);

server.registerResource(
  'instances',
  'vastai://instances',
  { title: 'Running instances', description: 'Live instances with spend and teardown schedule.', mimeType: 'application/json' },
  async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: await instancesResource(ctx) }] }),
);

const message = (text: string) => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text } }] });

server.registerPrompt(
  'generate_and_teardown',
  {
    title: 'Generate, then decommission',
    description: 'Rent, render, hand back the file, destroy the instance and prove it is gone.',
    argsSchema: {
      workload: z.string().optional().describe('Template id, default minimax-h3/i2v-32gb'),
      what: z.string().optional().describe('What to generate'),
    },
  },
  ({ workload, what }) => message(prompts.generate_and_teardown(workload, what)),
);

server.registerPrompt(
  'deploy_minimax_h3',
  {
    title: 'Deploy MiniMax H3',
    description: 'MiniMax H3 in ComfyUI on the cheapest Blackwell offer that really fits.',
    argsSchema: { variant: z.string().optional().describe('i2v-32gb, ref2v-32gb or i2v-80gb-int8') },
  },
  ({ variant }) => message(prompts.deploy_minimax_h3(variant)),
);

server.registerPrompt(
  'stop_everything',
  { title: 'Stop everything', description: 'List what is running, destroy it, verify nothing is billing.', argsSchema: {} },
  () => message(prompts.stop_everything()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[vastai-mcp] v${version} ready on stdio; ${tools.length} tools\n`);
