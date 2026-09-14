import { CONSUMER_BLACKWELL_CAP, type WorkloadFit } from './offers.js';

export type TemplateKind = 'comfyui' | 'llm' | 'notebook';

export interface WeightFile {
  repo: string;
  file: string;
  /** Sub-directory under ComfyUI/models. */
  target: string;
  sizeGb: number;
}

export interface Template {
  id: string;
  name: string;
  kind: TemplateKind;
  summary: string;
  /** Docker image; @vastai-automatic-tag lets Vast pick the tag matching the host driver. */
  image: string;
  /**
   * Port the service itself listens on, mapped straight through. This is what the agent
   * probes and posts workflows to. ComfyUI in the vastai image defaults to 18188.
   */
  port: number;
  /** Port the instance portal serves the same app on, behind its token. For humans. */
  portalPort: number;
  /** Path that returns 200 once the service is actually up. */
  readyPath: string;
  fit: WorkloadFit;
  weights: WeightFile[];
  /** Container image size; it is downloaded before the weights and is billed too. */
  imageGb: number;
  diskGb: number;
  bootMinutesTypical: number;
  /** dlperf of the GPU the render-speed expectation was measured on. */
  referenceDlperf?: number;
  hardwareNotes: string[];
  /** Extra shell run after the weights land, before the ready marker. */
  postSetup?: string;
}

const COMFY_IMAGE = 'vastai/comfy:@vastai-automatic-tag';
/** ComfyUI's own listener inside the vastai image. Mapped straight through for the API. */
const COMFY_API_PORT = 18188;
/** The instance portal proxies the same app here, behind its token, for humans. */
const COMFY_PORTAL_PORT = 8188;
const H3 = 'Comfy-Org/MiniMax-H3';
const LTX = 'Lightricks/LTX-2.5';

/** MiniMax H3's nvfp4 text encoder only runs on Blackwell with an r580+ driver. */
const BLACKWELL_FIT: WorkloadFit = {
  minComputeCap: CONSUMER_BLACKWELL_CAP,
  archReason: 'the nvfp4 text encoder needs a Blackwell card (RTX 5090, RTX PRO 4000/4500/5000/6000)',
  minDriverVersion: 580,
};

export const TEMPLATES: Template[] = [
  {
    id: 'minimax-h3/i2v-32gb',
    name: 'MiniMax H3 image/text to video (32 GB)',
    kind: 'comfyui',
    summary:
      'Best open-weight video model as of September 2026. First/last frame or text to video with native stereo audio, 8-step turbo LoRA, 768p.',
    image: COMFY_IMAGE,
    port: COMFY_API_PORT,
    portalPort: COMFY_PORTAL_PORT,
    readyPath: '/',
    fit: {
      ...BLACKWELL_FIT,
      minVramGbPerGpu: 30,
      minDiskGb: 70,
      exposedPorts: 4,
      minReliability: 0.95,
      minInetDownMbps: 400,
    },
    weights: [
      { repo: H3, file: 'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors', target: 'diffusion_models', sizeGb: 20.97 },
      { repo: H3, file: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', target: 'text_encoders', sizeGb: 15.69 },
      { repo: H3, file: 'vae/minimax_h3_video_vae_fp16.safetensors', target: 'vae', sizeGb: 5.21 },
      { repo: H3, file: 'vae/minimax_h3_audio_vae_fp32.safetensors', target: 'vae', sizeGb: 0.61 },
      { repo: H3, file: 'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', target: 'loras', sizeGb: 1.96 },
    ],
    imageGb: 14,
    diskGb: 70,
    bootMinutesTypical: 18,
    referenceDlperf: 198.9,
    hardwareNotes: [
      'Blackwell only: the nvfp4 text encoder will not load on Ada or Hopper.',
      'RTX 5090 (32 GB) is the cheapest card that fits; RTX PRO 6000 also works and is faster.',
      'Graph: UNETLoader -> LoraLoaderModelOnly -> MiniMaxH3SigmaShift -> KSampler -> VAEDecode + VAEDecodeAudio -> CreateVideo. Text and the empty AV latent both come from MiniMaxH3ImageToVideo (clip, vae, prompt); CLIPLoader type is "minimax".',
      'Do not use ComfyUI’s bundled api_minimax_h3_* nodes: those call MiniMax’s cloud API, not these weights.',
    ],
  },
  {
    id: 'minimax-h3/ref2v-32gb',
    name: 'MiniMax H3 reference to video (32 GB)',
    kind: 'comfyui',
    summary: 'Reference images drive identity and style; 4-step turbo LoRA. Same hardware as i2v-32gb.',
    image: COMFY_IMAGE,
    port: COMFY_API_PORT,
    portalPort: COMFY_PORTAL_PORT,
    readyPath: '/',
    fit: {
      ...BLACKWELL_FIT,
      minVramGbPerGpu: 30,
      minDiskGb: 70,
      exposedPorts: 4,
      minReliability: 0.95,
      minInetDownMbps: 400,
    },
    weights: [
      { repo: H3, file: 'diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors', target: 'diffusion_models', sizeGb: 20.97 },
      { repo: H3, file: 'text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', target: 'text_encoders', sizeGb: 15.69 },
      { repo: H3, file: 'vae/minimax_h3_video_vae_fp16.safetensors', target: 'vae', sizeGb: 5.21 },
      { repo: H3, file: 'vae/minimax_h3_audio_vae_fp32.safetensors', target: 'vae', sizeGb: 0.61 },
      { repo: H3, file: 'loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors', target: 'loras', sizeGb: 1.96 },
    ],
    imageGb: 14,
    diskGb: 70,
    bootMinutesTypical: 18,
    referenceDlperf: 198.9,
    hardwareNotes: ['Blackwell only, same as i2v-32gb.'],
  },
  {
    id: 'minimax-h3/i2v-80gb-int8',
    name: 'MiniMax H3 image to video, int8 (80 GB, runs on Ada and Hopper)',
    kind: 'comfyui',
    summary:
      'The escape hatch when no Blackwell card is cheap: int8 weights and an int8 text encoder instead of nvfp4, so RTX 6000 Ada, A100 and H100 work. Bigger download, more VRAM.',
    image: COMFY_IMAGE,
    port: COMFY_API_PORT,
    portalPort: COMFY_PORTAL_PORT,
    readyPath: '/',
    fit: {
      minComputeCap: 890,
      archReason: 'int8 convrot kernels need Ada (8.9) or newer',
      minVramGbPerGpu: 44,
      minDiskGb: 160,
      exposedPorts: 4,
      minReliability: 0.95,
      minInetDownMbps: 500,
    },
    weights: [
      { repo: H3, file: 'diffusion_models/minimax_h3_fl2va_int8_convrot.safetensors', target: 'diffusion_models', sizeGb: 34.04 },
      { repo: H3, file: 'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors', target: 'text_encoders', sizeGb: 27.14 },
      { repo: H3, file: 'vae/minimax_h3_video_vae_fp16.safetensors', target: 'vae', sizeGb: 5.21 },
      { repo: H3, file: 'vae/minimax_h3_audio_vae_fp32.safetensors', target: 'vae', sizeGb: 0.61 },
      { repo: H3, file: 'loras/minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors', target: 'loras', sizeGb: 1.96 },
    ],
    imageGb: 14,
    diskGb: 160,
    bootMinutesTypical: 28,
    hardwareNotes: [
      '69 GB of weights: only worth it when Blackwell is scarce or expensive.',
      'Needs 44 GB+ VRAM: RTX 6000 Ada, L40S, A100 80GB, H100.',
    ],
  },
  {
    id: 'ltx-2.5/t2v-32gb',
    name: 'LTX-2.5 text/image to video, nvfp4 (32 GB)',
    kind: 'comfyui',
    summary:
      'Lightricks LTX-2.5 distilled. Far faster than H3 (a 10s clip in minutes, not tens of minutes), 4K capable, Apache-style commercial use under $10M revenue.',
    image: COMFY_IMAGE,
    port: COMFY_API_PORT,
    portalPort: COMFY_PORTAL_PORT,
    readyPath: '/',
    fit: {
      minComputeCap: CONSUMER_BLACKWELL_CAP,
      archReason: 'the nvfp4 transformer needs a Blackwell card',
      minVramGbPerGpu: 30,
      minDiskGb: 100,
      exposedPorts: 4,
      minReliability: 0.95,
      minInetDownMbps: 300,
    },
    weights: [
      { repo: LTX, file: 'diffusion_models/ltx-2.5-22b-distilled-transformer-nvfp4.safetensors', target: 'diffusion_models', sizeGb: 18.72 },
      { repo: LTX, file: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', target: 'text_encoders', sizeGb: 15.37 },
      { repo: LTX, file: 'vae/ltx-2.5-video-vae-bf16.safetensors', target: 'vae', sizeGb: 1.47 },
      { repo: LTX, file: 'vae/ltx-2.5-audio-vae-bf16.safetensors', target: 'vae', sizeGb: 0.36 },
      { repo: LTX, file: 'latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors', target: 'latent_upscale_models', sizeGb: 1.0 },
    ],
    imageGb: 14,
    diskGb: 100,
    bootMinutesTypical: 12,
    hardwareNotes: ['Lower quality than H3 on motion and physics, but roughly 7x faster per clip.'],
  },
  {
    id: 'ltx-2.5/t2v-48gb-int8',
    name: 'LTX-2.5 text/image to video, int8 (48 GB, runs on Ada and Hopper)',
    kind: 'comfyui',
    summary: 'LTX-2.5 without the Blackwell requirement.',
    image: COMFY_IMAGE,
    port: COMFY_API_PORT,
    portalPort: COMFY_PORTAL_PORT,
    readyPath: '/',
    fit: {
      minComputeCap: 890,
      archReason: 'int8 convrot kernels need Ada (8.9) or newer',
      minVramGbPerGpu: 44,
      minDiskGb: 70,
      exposedPorts: 4,
      minReliability: 0.95,
      minInetDownMbps: 300,
    },
    weights: [
      { repo: LTX, file: 'diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors', target: 'diffusion_models', sizeGb: 21.5 },
      { repo: LTX, file: 'text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors', target: 'text_encoders', sizeGb: 15.37 },
      { repo: LTX, file: 'vae/ltx-2.5-video-vae-bf16.safetensors', target: 'vae', sizeGb: 1.47 },
      { repo: LTX, file: 'vae/ltx-2.5-audio-vae-bf16.safetensors', target: 'vae', sizeGb: 0.36 },
    ],
    imageGb: 14,
    diskGb: 120,
    bootMinutesTypical: 14,
    hardwareNotes: ['RTX 6000 Ada, L40S, A100 80GB or H100.'],
  },
  {
    id: 'comfyui/bare',
    name: 'ComfyUI, no weights',
    kind: 'comfyui',
    summary: 'Plain ComfyUI on the cheapest card that fits. Bring your own models.',
    image: COMFY_IMAGE,
    port: COMFY_API_PORT,
    portalPort: COMFY_PORTAL_PORT,
    readyPath: '/',
    fit: { minVramGbPerGpu: 16, minDiskGb: 40, exposedPorts: 4, minReliability: 0.9 },
    weights: [],
    imageGb: 14,
    diskGb: 40,
    bootMinutesTypical: 5,
    hardwareNotes: [],
  },
];

export function findTemplate(id: string): Template | undefined {
  const q = id.trim().toLowerCase();
  return (
    TEMPLATES.find((t) => t.id.toLowerCase() === q) ??
    TEMPLATES.find((t) => t.id.toLowerCase().startsWith(q)) ??
    TEMPLATES.find((t) => t.id.toLowerCase().includes(q)) ??
    TEMPLATES.find((t) => t.name.toLowerCase().includes(q))
  );
}

export function weightsGb(template: Template): number {
  return template.weights.reduce((sum, w) => sum + w.sizeGb, 0);
}

/** Everything the host must pull before the first frame renders. */
export function downloadGb(template: Template): number {
  return weightsGb(template) + template.imageGb;
}

export const READY_MARKER = '/workspace/.vastai-mcp-ready';
/** /var/log exists from the first instant; /workspace does not. */
export const SETUP_LOG = '/var/log/vastai-mcp-setup.log';

/**
 * The onstart script. It must be idempotent and must never contain the API key:
 * the host is someone else's machine.
 */
export function buildOnstart(template: Template): string {
  const lines: string[] = [
    '#!/bin/bash',
    'set -o pipefail',
    // Everything goes to stdout on purpose: that is what Vast's log endpoint returns,
    // so get_logs can show download progress. A copy lands on disk for SSH debugging.
    `exec > >(tee -a ${SETUP_LOG}) 2>&1`,
    'echo "[vastai-mcp] setup starting at $(date -Is)"',
    // onstart replaces the image command, so the image entrypoint has to be started here.
    'entrypoint.sh &',
    // The image copies its pristine ComfyUI from /opt/workspace-internal into $WORKSPACE.
    // Downloading before that sync lands would put 44 GB in a directory that gets replaced.
    'for i in $(seq 1 360); do [ -f /.provisioning ] || break; sleep 5; done',
    'COMFY="${WORKSPACE:-/workspace}/ComfyUI"',
    'echo "[vastai-mcp] waiting for $COMFY/models to be populated"',
    // Do NOT gate on ${WORKSPACE}/.sync_ComfyUI.lock: the image leaves that file behind
    // permanently once the sync is done, so waiting for it to disappear waits forever.
    // The model tree existing plus ComfyUI answering is the real "sync finished" signal.
    'for i in $(seq 1 180); do',
    '  if [ -d "$COMFY/models/diffusion_models" ] && [ -d "$COMFY/models/text_encoders" ]; then',
    `    curl -fsS -o /dev/null --max-time 5 http://127.0.0.1:${COMFY_API_PORT}/queue && break`,
    '  fi',
    '  sleep 5',
    'done',
    'if [ ! -d "$COMFY/models" ]; then',
    '  echo "[vastai-mcp] FATAL: $COMFY/models never appeared"',
    '  wait',
    '  exit 1',
    'fi',
    'echo "[vastai-mcp] ComfyUI at $COMFY"',
    'df -h "$COMFY" | tail -1',
  ];

  if (template.weights.length) {
    lines.push(
      '. /venv/main/bin/activate 2>/dev/null || true',
      // hf_transfer is not optional. Without it the plain backend throttles to ~40 Mb/s
      // on anonymous Hub requests and stalls outright; with it the same host sustained
      // 435 Mb/s. Install it as its own package and only enable it if it really imports:
      // HF_HUB_ENABLE_HF_TRANSFER=1 with the module missing just warns and falls back.
      'pip install -q --no-input hf_transfer huggingface_hub 2>&1 | tail -2',
      'if python3 -c "import hf_transfer" 2>/dev/null; then',
      '  export HF_HUB_ENABLE_HF_TRANSFER=1',
      '  echo "[vastai-mcp] hf_transfer enabled"',
      'else',
      '  echo "[vastai-mcp] WARNING: hf_transfer unavailable, downloads will be slow"',
      'fi',
      'export HF_HUB_DOWNLOAD_TIMEOUT=30',
      'HF=$(command -v hf || command -v huggingface-cli)',
      'echo "[vastai-mcp] downloader: ${HF:-MISSING}"',
      'FAILED=0',
    );
    for (const w of template.weights) {
      // The repo paths already mirror ComfyUI's models/ layout, so --local-dir models
      // drops each file exactly where ComfyUI looks for it.
      lines.push(
        `echo "[vastai-mcp] fetching ${w.file} (${w.sizeGb.toFixed(2)} GB) at $(date -Is)"`,
        // Hub transfers stall often enough that a single attempt is not good enough:
        // a hung download bills the GPU at full rate while moving zero bytes.
        `for try in 1 2 3; do $HF download ${w.repo} ${w.file} --local-dir "$COMFY/models" && break; echo "[vastai-mcp] retry $try for ${w.file}"; sleep 5; done`,
        `[ -s "$COMFY/models/${w.file}" ] && echo "[vastai-mcp] OK ${w.file}" || { echo "[vastai-mcp] MISSING after download: ${w.file}"; FAILED=1; }`,
      );
    }
    lines.push(
      // The local-dir cache is a second copy of everything; on a 120 GB disk that matters.
      'rm -rf "$COMFY/models/.cache" 2>/dev/null || true',
      'echo "[vastai-mcp] weights on disk:"',
      `du -sh "$COMFY/models"/*/ 2>/dev/null | sort -h | tail -6`,
      'if [ "$FAILED" != "0" ]; then echo "[vastai-mcp] one or more weights failed; not marking ready"; wait; exit 1; fi',
    );
  }

  if (template.postSetup) lines.push(template.postSetup);

  lines.push(
    'echo "[vastai-mcp] setup finished at $(date -Is)"',
    `touch ${READY_MARKER}`,
    'wait',
  );
  return lines.join('\n');
}

/**
 * Docker run options Vast passes through: port maps and env.
 *
 * Two things here are load-bearing. The vastai images run each app from a supervisor
 * script that calls exit_portal.sh and quits for good unless the app is named in
 * /etc/portal.yaml, which is generated from PORTAL_CONFIG: leave it out and ComfyUI
 * silently never starts. And COMFYUI_ARGS has to bind 0.0.0.0, otherwise ComfyUI
 * listens on loopback and the mapped port refuses connections.
 */
export function buildEnv(template: Template, extra: Record<string, string> = {}): string {
  const portal = [
    'localhost:1111:11111:/:Instance Portal',
    `localhost:${template.portalPort}:${template.port}:/:ComfyUI`,
  ].join('|');
  const parts = [
    `-p ${template.port}:${template.port}`,
    `-p ${template.portalPort}:${template.portalPort}`,
    '-p 1111:1111',
    '-e OPEN_BUTTON_PORT=1111',
    '-e OPEN_BUTTON_TOKEN=1',
    '-e DATA_DIRECTORY=/workspace/',
    `-e PORTAL_CONFIG=${JSON.stringify(portal)}`,
    `-e COMFYUI_ARGS=${JSON.stringify(`--disable-auto-launch --port ${template.port} --listen 0.0.0.0 --enable-cors-header`)}`,
  ];
  for (const [k, v] of Object.entries(extra)) parts.push(`-e ${k}=${JSON.stringify(v)}`);
  return parts.join(' ');
}
