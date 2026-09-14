# What this actually costs

Numbers measured against the live Vast.ai marketplace on 14 September 2026. Marketplace prices move hour to hour, so treat the shape as durable and the digits as a snapshot.

## The cost model

`recommend_plan` does not rank on `$/hour`. It ranks on what a session costs end to end:

```
session      = (setup_hours + work_hours) * $/hour  +  disk  +  bandwidth
setup_hours  = download_gb * 8000 / (inet_down_mbps * 0.6) / 3600
work_hours   = work_minutes / 60 * (reference_dlperf / offer_dlperf)
disk         = storage_cost / 730 * disk_gb * total_hours      # storage_cost is $/GB/MONTH
bandwidth    = inet_down_cost * download_gb                     # charged once, when bytes land
```

Four things in there were learned the expensive way:

- The `0.6` is a haircut on advertised link speed, which is a ceiling the Hub rarely saturates.
- `storage_cost` is **$ per GB per month**, not per TB. Getting this wrong understates disk by 1000x; at 120 GB it is $0.14/hour, a quarter of the bill.
- **Bandwidth is the big one.** It is invisible in any $/hour comparison because it does not scale with time, and on a short job it is routinely the largest single line.
- Work time is scaled by `dlperf`, so a faster card is credited with finishing sooner. Without this the ranker prefers a cheap slow card over a dearer fast one, which is wrong for any session that does real work.

## Why sticker price misleads

MiniMax H3 `i2v-32gb` pulls 44 GB of weights plus a 14 GB container image. At the observed spread of link speeds, that alone ranges from 6 minutes to over 2 hours of billed time:

| Link | Setup time | Setup cost at $0.50/h |
|---|---|---|
| 2.0 Gb/s | 6 min | $0.05 |
| 850 Mb/s | 15 min | $0.12 |
| 400 Mb/s | 32 min | $0.27 |
| 125 Mb/s | 1.7 h | $0.86 |

A real pair of offers from the same search:

| | Offer 50556737 | Offer 51010683 |
|---|---|---|
| $/hour | $0.4363 | **$0.3356** |
| Link | 843 Mb/s | 125 Mb/s |
| Setup | 15 min | 1.7 h |
| 45 min of rendering | $0.33 | $0.25 |
| **Session total** | **$0.44** | **$0.83** |

The "cheapest" offer costs 89% more. When this happens, `recommend_plan` returns a `sticker_price_trap` field naming the offer it declined and the difference.

## Typical sessions

At September 2026 prices, verified hosts on fast links:

| Workload | GPU | $/hour | Setup | 45 min of work | Session |
|---|---|---|---|---|---|
| `minimax-h3/i2v-32gb` | RTX 5090 | $0.44 | 15 min | $0.33 | **~$0.44** |
| `minimax-h3/i2v-32gb`, 15 s shot | RTX PRO 6000, 96 GB | varies | 2 min | $0.12 | **~$0.16 cold, $0.04 warm** |
| `minimax-h3/i2v-80gb-int8` | RTX PRO 5000 / L40S | $0.74 | 25 min | $0.56 | **~$0.87** |
| `ltx-2.5/t2v-32gb` | RTX 5090 | $0.44 | 13 min | $0.33 | **~$0.42** |
| `comfyui/bare` | RTX A4000 | $0.09 | 1 min | $0.07 | **~$0.02** (measured) |

LTX-2.5 is the interesting line: nearly the same session cost as H3, but it renders a 10-second clip in about 2.5 minutes against roughly 17 for H3. If you are iterating rather than finishing, you get far more attempts per dollar.

## Measured: one real `comfyui/bare` run

| | |
|---|---|
| Offer | RTX A4000, 16 GB, 4.2 Gb/s, Japan, $0.0921/h |
| Predicted setup | 1 min |
| Actual time to `online` | 6 min (image pull and a host-side image build dominate) |
| Billed | $0.01 |

The gap is worth knowing: the cost model accounts for *download* time, but the vastai images also build a derived image on first boot, which the marketplace data cannot predict. Budget about 5 extra minutes on top of the download estimate for any `vastai/*` image.

## Where money leaks

0. **Renting the cheapest host per hour.** Measured: the same 15-second clip cost $0.16 on a 96 GB card with free ingress and $1.87 on a card that was a quarter the hourly rate but charged $0.039/GB for the 58 GB of weights. Host choice matters about 10x more than provider choice.
1. **Forgetting to destroy.** An RTX 5090 left running is about $10/day. This is why every instance gets a hard deadline and idle teardown, enforced by a detached watchdog. There is no argument that turns the deadline off.
2. **Destroying an instance you will need again.** Stopping does *not* free the disk and does *not* re-download: a stopped instance keeps its weights and restarted in 29 seconds with all 42 GB intact, measured. Since ingress is charged once per instance, keeping one stopped (about $0.013/hour for 70 GB on a cheap-storage host) beats paying $0.59-$2.27 to pull the weights again. Destroy only when you are done for good.
3. **Idle time between renders.** Billing is wall-clock, not GPU-utilisation. Thinking time at the ComfyUI tab costs exactly as much as rendering.
4. **Unverified hosts.** Real savings, roughly 10 to 30%, and a real failure rate. The planner keeps them out of `ready_now` but reports when one would have been cheaper, so it is your call rather than a silent downgrade.

## Measured, 14-15 September 2026

Four real sessions on this account, $2.57 total:

| Run | Outcome | Cost |
|---|---|---|
| Two `comfyui/bare` smoke tests | validated the lifecycle | $0.02 |
| H3 on an 843 Mb/s host, no `hf_transfer` | download stalled at 0 bytes, watchdog killed it at 21 min | $0.56 |
| H3 5.2 s clip, 7.1 Gb/s host | 42 GB in **71 seconds**, rendered in 169 s | $0.12 |
| H3 15.1 s clip, 96 GB card, $0.039/GB ingress | outbid mid-render, restarted in 29 s, rendered in 668 s | $1.87 |

What the numbers say:

- **Link speed decides setup cost.** The same 42 GB took 21+ minutes (and failed) on one host and 71 seconds on another.
- **Ingress decides everything else.** $1.55 of that last run was bandwidth; $0.27 was GPU.
- **Render time is superlinear in frames.** 169 s for 124 frames, 668 s for 362 frames: 2.9x the frames, 3.9x the time.
- **VRAM scales hard too.** 362 frames peaked at 40.4 GB, so full-length 15 s shots need a 48 GB+ card even though 5 s shots fit 32 GB comfortably.
