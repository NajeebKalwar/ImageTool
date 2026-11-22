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

// Determine active origin in browser / worker / fallback
const activeOrigin =
  typeof self !== 'undefined' && self.location && self.location.origin
    ? self.location.origin
    : typeof window !== 'undefined' && window.location && window.location.origin
    ? window.location.origin
    : 'https://imagetool.example';

// Read public environment variables exposed by Astro/Vite, falling back to same-origin /models/
const modelHost =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PUBLIC_MODEL_HOST
    ? normalizeHost(import.meta.env.PUBLIC_MODEL_HOST)
    : undefined) ?? `${activeOrigin}/models/`;

const wasmHost =
  (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.PUBLIC_WASM_HOST
    ? normalizeHost(import.meta.env.PUBLIC_WASM_HOST)
    : undefined) ?? `${activeOrigin}/models/wasm/`;

// Use custom Cloudflare R2 / same-origin routing: {origin}/models/{model}/{file}
env.remoteHost = modelHost;
env.remotePathTemplate = '{model}/';

// Self-hosted ONNX Runtime Web WebAssembly binaries on Cloudflare R2 / same-origin /models/wasm/
const onnxBackend = env.backends.onnx as { wasm?: { numThreads?: number; wasmPaths?: string } };
if (!onnxBackend.wasm) {
  onnxBackend.wasm = {};
}
onnxBackend.wasm.wasmPaths = wasmHost;

// Optimize WASM multi-threading when cross-origin isolated
if (
  typeof crossOriginIsolated !== 'undefined' &&
  crossOriginIsolated &&
  typeof SharedArrayBuffer !== 'undefined'
) {
  const threads =
    typeof navigator !== 'undefined' && navigator.hardwareConcurrency
      ? Math.max(1, Math.min(navigator.hardwareConcurrency - 1, 4))
      : 2;
  const onnxBackend = env.backends.onnx as { wasm?: { numThreads?: number; wasmPaths?: string } };
  if (!onnxBackend.wasm) {
    onnxBackend.wasm = {};
  }
  onnxBackend.wasm.numThreads = threads;
}

export { env };
