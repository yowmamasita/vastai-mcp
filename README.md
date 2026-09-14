# Vast.ai MCP

**Let your AI agent rent the cheapest GPU on [Vast.ai](https://vast.ai) that can actually run the job, render, and then make sure the thing dies.**

Vast.ai MCP is a [Model Context Protocol](https://modelcontextprotocol.io) server that gives Claude Code, Claude Desktop, Cursor, Codex and any other MCP client the tools to search the Vast marketplace, deploy open-weight video models (MiniMax H3, LTX-2.5) or bare ComfyUI, hand back a working URL, and tear the instance down the moment the work is finished.

A companion CLI, `vast-deploy`, ships in the same package for humans, scripts and CI.

> "Rent the cheapest 5090 that can run MiniMax H3, give me the ComfyUI link, and kill it when I'm done."
> The agent ranks offers by what the session *really* costs, shows you the estimate, waits for your yes, rents, polls while 44 GB of weights land, returns the URL, and registers a watchdog that destroys the instance 15 minutes after your render queue goes quiet, whether or not you remember to say so.

It is built on the same shape as [nosana-mcp](https://github.com/SohniSwatantra/nosana-mcp) but the marketplace underneath is different in two ways that change the design: Vast rents you a specific machine with a specific network link rather than a pooled market, and Vast instances bill until *you* destroy them. So this server ranks hosts by effective cost, and treats teardown as a guarantee rather than a reminder.

## Two things this does that a naive port would not

### 1. It ranks by what the session costs, not by $/hour

MiniMax H3 pulls 44 GB of weights plus a 14 GB container image before it renders a single frame, and that download is billed at the GPU rate. Sticker price is therefore not cost:

```
Offer     GPU       VRAM   $/h      Down      Setup  Session $  Rel    Location
50556737  RTX 5090  32 GB  $0.4363  843 Mb/s  15m    $0.44      96.4%  Sichuan, CN     <- picked
51010683  RTX 5090  32 GB  $0.3356  125 Mb/s  1.7h   $0.83      69.0%  Poland, PL      <- "cheapest"
```

The $0.3356/hour host is 23% cheaper per hour and **89% more expensive** for the actual job, because it spends 1.7 paid hours downloading. When the cheapest-per-hour host is a trap, `recommend_plan` returns a `sticker_price_trap` field naming it and the difference, so the agent can tell you what it avoided.

### 2. Nothing runs forever

Vast has no job timeout: an instance bills until it is destroyed, and a forgotten RTX 5090 is $10 a day. So:

- Every instance is created with a **hard deadline**. There is no argument that disables it.
- By default it is also destroyed **15 minutes after the ComfyUI queue goes quiet**, which is what you actually want after a render finishes.
- Both are enforced by a **detached watchdog process** that outlives the MCP client, the terminal and the laptop lid. It polls every 30 seconds, destroys what is overdue, and exits once nothing is left to watch.
- `teardown_status` proves the state: what is scheduled, whether the watchdog is alive, and whether any running instance is *not* being watched. It restarts the watchdog if it died.
- `destroy_instance` verifies the instance is really gone rather than trusting the API's acknowledgement.

## Quick start

### 1. An API key and some credit

1. Sign in at [cloud.vast.ai](https://cloud.vast.ai).
2. **Billing**: add credit with a card or crypto.
3. **Account > [Keys](https://cloud.vast.ai/manage-keys/)**: create a key and copy it.

### 2. Add the server to your client

Claude Code:

```bash
claude mcp add vastai --env VAST_API_KEY=your_key -- npx -y vastai-mcp
```

Claude Desktop, Cursor, Windsurf and most other clients take the same JSON:

```json
{
  "mcpServers": {
    "vastai": {
      "command": "npx",
      "args": ["-y", "vastai-mcp"],
      "env": { "VAST_API_KEY": "your_key" }
    }
  }
}
```

Running from a clone instead of npm:

```bash
git clone <this repo> vastai-mcp && cd vastai-mcp
npm install && npm run build
# then point your client at:  node /absolute/path/to/vastai-mcp/dist/mcp/index.js
```

Instead of the environment variable you can run `vast-deploy login` once; the server also reads the key that command stores in `~/.config/vast-deploy/config.json` (mode 0600).

### 3. Ask

- "Deploy MiniMax H3 image-to-video on the cheapest offer that can really run it."
- "What is running right now and what is it costing me per hour?"
- "Render this, then kill the box."

The agent must show you the estimate and get a yes before `create_instance` will do anything.

## Tools

Every tool returns one JSON object, as text and as MCP `structuredContent`: `{ok, message, next_tool, next_args, ...}`.

| Tool | What it does | Spends money |
|---|---|---|
| `doctor` | Key, funds, API reachability and whether the teardown watchdog is alive. | no |
| `get_balance` | Credit, balance, and how many GPU-hours that buys. | no |
| `list_templates` / `get_template` | Workload catalog with real VRAM, architecture gates, and download size per weight file. | no |
| `list_gpus` | Live offers bucketed into `ready_now`, `risky_host`, `unverified`, `slow_link`, `no_ports`, `too_small`, `unsupported`, each with its true session cost. | no |
| `recommend_plan` | One call from a workload to the offer to rent, the cost, the sticker-price trap it avoided, and exact `create_instance` arguments. | no |
| `estimate_deployment` | Dry run: expected cost, worst case if it runs to the deadline, and whether the account can afford it. | no |
| `create_instance` | Rents, starts, downloads weights, registers teardown. Needs `confirm=true`. Refuses to start what the account cannot pay for. | **yes** |
| `wait_for_instance` | Polls up to 45 s (MCP clients time out at 60). Returns `creating`, `loading`, `downloading_weights`, `online`, `stopped` or `failed`. | no |
| `get_instance` / `list_instances` | Status, endpoint, spend so far, teardown schedule. Flags anything unwatched. | no |
| `get_endpoint_usage` | ComfyUI URL, the `/prompt` and `/history` API, the SSH command, and how to copy renders off before the disk is deleted. | no |
| `get_logs` | Container log tail including weight-download progress. | no |
| `extend_teardown` | Push the deadline back. Cannot remove it. | yes |
| `destroy_instance` | Destroys now, then verifies it is gone. | ends spending |
| `destroy_all` | Panic button. Needs `confirm=true`. | ends spending |
| `teardown_status` | The ledger, the watchdog, and any running instance nobody is watching. Restarts the watchdog. | no |

Resources: `vastai://templates`, `vastai://instances`. Prompts: `generate_and_teardown`, `deploy_minimax_h3`, `stop_everything`.

### The happy path

```
recommend_plan("minimax-h3/i2v-32gb")      -> offer, real cost, create args
create_instance(..., confirm=true)          after the user says yes
wait_for_instance(id) x N                   -> creating ... downloading_weights ... online
get_endpoint_usage(id)                      -> ComfyUI URL, /prompt API, how to fetch renders
destroy_instance(id)                        -> verified_gone: true
```

## Workloads

| Template | GPU it needs | Download | Boot | Notes |
|---|---|---|---|---|
| `minimax-h3/i2v-32gb` | Blackwell, 30 GB | 58 GB | ~18 min | First/last frame or text to video, native audio, 8-step turbo LoRA |
| `minimax-h3/ref2v-32gb` | Blackwell, 30 GB | 58 GB | ~18 min | Reference images drive identity and style |
| `minimax-h3/i2v-80gb-int8` | Ada or newer, 44 GB | 83 GB | ~28 min | The escape hatch when Blackwell is scarce: int8 instead of nvfp4 |
| `ltx-2.5/t2v-32gb` | Blackwell, 30 GB | 51 GB | ~12 min | Roughly 7x faster per clip than H3, lower motion quality |
| `ltx-2.5/t2v-48gb-int8` | Ada or newer, 44 GB | 53 GB | ~14 min | LTX-2.5 without the Blackwell requirement |
| `comfyui/bare` | anything with 16 GB | 14 GB | ~5 min | Plain ComfyUI, bring your own models |

**The architecture gate is not advisory.** MiniMax H3's 32 GB variants use an nvfp4 text encoder that only loads on Blackwell (compute capability 12.0: RTX 5090, RTX PRO 4000/4500/5000/6000) with an r580+ driver. An Ada or Hopper host will download 44 GB and then fail, having billed you for the privilege. Those offers go in the `unsupported` bucket and the planner will not pick them.

Inside ComfyUI, build the graph described in `get_template`: `UNETLoader -> LoraLoaderModelOnly -> ModelSamplingMiniMaxH3 -> KSampler -> VAEDecode + VAEDecodeAudio -> CreateVideo`. Do not use the bundled `api_minimax_h3_*` nodes; those call MiniMax's cloud API rather than the weights you just paid to download.

## CLI

```bash
vast-deploy login                                   # store the key once
vast-deploy doctor                                  # key, funds, watchdog
vast-deploy templates                               # what can be run
vast-deploy gpus -t minimax-h3/i2v-32gb             # offers ranked by real cost
vast-deploy run -t minimax-h3/i2v-32gb --idle-minutes 15
vast-deploy ps                                      # what is running, what it costs
vast-deploy logs <id>                               # weight-download progress
vast-deploy reap                                    # teardown ledger and watchdog
vast-deploy destroy <id>                            # and verify
vast-deploy destroy-all
```

## Costs to expect

Prices come from the live marketplace, so they move hour to hour. As of September 2026 a verified RTX 5090 on a fast link runs about $0.40 to $0.55 per hour, which puts a MiniMax H3 session at roughly:

| | |
|---|---|
| Ingress, 58 GB | $0 to $2.27 depending entirely on the host |
| Weight download time (58 GB at ~800 Mb/s) | ~15 min, about $0.12 |
| 45 min of rendering | about $0.33 |
| **Total on a well-chosen host** | **about $0.45** |

Two costs never appear in the hourly rate and both have dominated a real bill here:

- **Ingress bandwidth**, billed per GB when the weights land. Across Blackwell offers this ranges from free to $0.04/GB, so pulling H3's 58 GB costs anywhere from $0 to $2.27 — more than ten hours of the GPU. It is charged once per instance, so a stopped instance you restart does not pay it again.
- **Disk**, quoted as `storage_cost` in **$ per GB per month** and charged for as long as the instance exists, stopped included. Hosts range from $0.133 to $0.867 per GB/month; a 120 GB volume on the expensive end is $0.14/hour.

The same measured 15-second clip cost **$0.16** on a free-ingress host and **$1.87** on a host that was cheaper per hour but charged $0.039/GB. Rank on total cost, which `recommend_plan` now does, and read the `Data $` column before the `$/h` one.

## Notes on safety

- The API key never reaches the rented host. The onstart script contains only public Hugging Face URLs, and errors are redacted before they are logged or returned.
- `create_instance` refuses to start an instance whose full teardown window costs more than the account has, unless you pass `force`.
- Destroying an instance deletes its disk irreversibly. `get_endpoint_usage` tells you how to copy renders off first, and the tool descriptions push the agent to remind you.
- Interruptible (`bid`) offers are supported but flagged: the host can reclaim the machine mid-render.

## Development

```bash
npm install
npm run build
npm run typecheck
npm run dev:cli -- gpus -t minimax-h3/i2v-32gb   # run from source
npm run inspect                                   # MCP Inspector against the built server
```

Layout: `src/core` (client, offer search and cost model, workload catalog, deploy, teardown watchdog), `src/mcp` (server and tools), `src/cli` (the `vast-deploy` command). Both surfaces share the core.

## License

MIT. Not affiliated with Vast.ai, MiniMax or Lightricks. Built on the public Vast.ai REST API.
