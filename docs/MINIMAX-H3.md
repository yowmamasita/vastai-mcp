# Run MiniMax H3 on Vast.ai from the terminal

MiniMax H3 is the best open-weight video model as of September 2026: it tops every open-weight entry on the Artificial Analysis text-to-video, image-to-video and video-editing arenas, and only closed models sit above it. Renting an RTX 5090 by the hour is much cheaper than paying per second of video through a hosted API, provided you do two things right: pick a host whose *link* is fast, and destroy the instance when you are done.

## 1. Credit and a key

1. Sign in at [cloud.vast.ai](https://cloud.vast.ai), add credit under **Billing**.
2. **Account > [Keys](https://cloud.vast.ai/manage-keys/)**, create a key.
3. `vast-deploy login` and paste it. It is stored 0600 in `~/.config/vast-deploy/config.json`.

Add your SSH public key in the Vast console too (Account > SSH Keys) if you want to copy renders off the box.

## 2. Pick a variant

```bash
vast-deploy templates
vast-deploy gpus -t minimax-h3/i2v-32gb
```

| Variant | Use it for | Needs | Download |
|---|---|---|---|
| `minimax-h3/i2v-32gb` | First/last frame or text to video, 8-step turbo LoRA | RTX 5090 (32 GB), Blackwell | 58 GB |
| `minimax-h3/ref2v-32gb` | Reference images drive identity and style, 4-step turbo | RTX 5090 (32 GB), Blackwell | 58 GB |
| `minimax-h3/i2v-80gb-int8` | Same thing on Ada or Hopper when Blackwell is scarce | 44 GB+ VRAM | 83 GB |

**The Blackwell requirement is real.** The 32 GB variants use `qwen3vl_32b_minimax_h3_nvfp4_awq`, an nvfp4 text encoder that only loads on compute capability 12.0 (RTX 5090, RTX PRO 4000/4500/5000/6000) with an r580+ driver. On an RTX 6000 Ada or an H100 it will download 44 GB of weights and then fail to load them. `vast-deploy gpus` puts those offers in an `unsupported` bucket and the planner will not choose one.

## 3. Read the offer table properly

```
Offer     GPU       VRAM   $/h      Down      Setup  Session $  Rel    Location
50556737  RTX 5090  32 GB  $0.4363  843 Mb/s  15m    $0.44      96.4%  Sichuan, CN
51010683  RTX 5090  32 GB  $0.3356  125 Mb/s  1.7h   $0.83      69.0%  Poland, PL
```

The second row is cheaper per hour and nearly twice the price for the job. 58 GB has to reach the host before the first frame renders, and you pay the GPU rate while it arrives. Sort by the **Session $** column, which is what `vast-deploy` and `recommend_plan` already do.

Worth checking beyond price: `Rel` below about 95% means the host drops instances, and a render that dies at minute 40 costs you the whole 40 minutes.

## 4. Deploy

```bash
vast-deploy run -t minimax-h3/i2v-32gb --work-minutes 45 --idle-minutes 15
```

The CLI prints the plan, asks for confirmation, rents the offer, and follows it:

```
     1m  creating  loading: 7ac0dc6bdf63: Pull complete
     5m  creating  loading: #7 47.61 invoke-rc.d: could not determine current runlevel
     8m  downloading_weights  ComfyUI answers but the weights are still downloading (58 GB).
    19m  online    Service is up and the weights are in place.

  http://203.0.113.9:35864
  ssh -p 11568 root@ssh4.vast.ai
```

`vast-deploy logs <id>` shows the per-file download progress written by the setup script.

## 5. Build the graph

Open the URL: it is ComfyUI with the weights already in `models/`. Wire up:

```
UNETLoader (minimax_h3_fl2va_pruned_int8_convrot)
  -> LoraLoaderModelOnly (minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16)
  -> ModelSamplingMiniMaxH3
  -> KSampler
  -> VAEDecode      (minimax_h3_video_vae_fp16)
  +  VAEDecodeAudio (minimax_h3_audio_vae_fp32)
  -> CreateVideo
```

Do **not** use ComfyUI's bundled `api_minimax_h3_*` nodes. Those call MiniMax's hosted API and will bill you separately, ignoring the 58 GB you just paid to download.

You can also drive it over HTTP without the UI:

```bash
curl -s -X POST http://203.0.113.9:35864/prompt -d @workflow_api.json
curl -s http://203.0.113.9:35864/queue
curl -s "http://203.0.113.9:35864/view?filename=out_00001.mp4&type=output" -o out.mp4
```

## 6. Get the file off, then kill it

Destroying an instance deletes its disk. Download first:

```bash
scp -P 11568 -r root@ssh4.vast.ai:/workspace/ComfyUI/output ./renders
vast-deploy destroy <id>
```

If you forget, the watchdog handles it: every instance is created with a hard deadline, and by default it is also destroyed 15 minutes after the ComfyUI queue goes quiet. `vast-deploy reap` shows what is scheduled and restarts the watchdog if it died.

## Things that trip people up

- **The cheapest host is usually the wrong host.** See section 3.
- **Blackwell only** for the 32 GB variants. The `unsupported` bucket exists for a reason.
- **Boot is slow.** 15 to 30 minutes, nearly all of it the weight download. That is normal, and `phase: downloading_weights` is not an error.
- **The ComfyUI port is unauthenticated** on a public IP, which is how Vast works. Keep the teardown window short.
- **The disk is not a backup.** Nothing survives `destroy`.
- **Offers expire in minutes.** If `create_instance` says the offer is gone, re-plan; someone else rented it.
