import { env } from '@huggingface/transformers';

/**
 * Configure Transformers.js execution environment for the Web Worker.
 *
 * Configures Cloudflare R2 custom domain hosting for model weights and
 * self-hosted ONNX Runtime WebAssembly binaries, with graceful dev fallback.
 */

// Disallow local filesystem access in browser and worker scopes
env.allowLocalModels = false;
env.useBrowserCache = true;

/**
 * Normalizes host URL to ensure a single trailing slash.
 */
function normalizeHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed) return undefined;
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

// Read public environment variables exposed by Astro/Vite
const modelHost = typeof import.meta !== 'undefined' && import.meta.env
  ? normalizeHost(import.meta.env.PUBLIC_MODEL_HOST)
  : undefined;

const wasmHost = typeof import.meta !== 'undefined' && import.meta.env
  ? normalizeHost(import.meta.env.PUBLIC_WASM_HOST)
  : undefined;

if (modelHost) {
  // Use custom Cloudflare R2 domain: https://models.<domain>/<org>/<repo>/...
  env.remoteHost = modelHost;
  env.remotePathTemplate = '{model}/';
} else {
  // Development fallback to Hugging Face Hub if R2 host is not configured
  env.remoteHost = 'https://huggingface.co/';
  env.remotePathTemplate = '{model}/resolve/main/';
}

if (wasmHost) {
  // Self-hosted ONNX Runtime Web WebAssembly binaries on Cloudflare R2
  const onnxBackend = env.backends.onnx as { wasm?: { wasmPaths?: string } };
  if (!onnxBackend.wasm) {
    onnxBackend.wasm = {};
  }
  onnxBackend.wasm.wasmPaths = wasmHost;
}

export { env };
