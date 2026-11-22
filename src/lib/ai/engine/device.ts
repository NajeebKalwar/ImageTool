/**
 * Hardware Acceleration Detector for Worker and Main Thread.
 *
 * Safe for execution inside Web Workers, browsers, and Node.js test runners.
 */

export type WorkerExecutionBackend = 'webgpu' | 'wasm';

export interface WorkerDeviceCapabilities {
  backend: WorkerExecutionBackend;
  hasWebGPU: boolean;
  hasWasm: boolean;
}

/**
 * Detects whether WebGPU is available in the current context (Window or DedicatedWorker).
 * Falls back to WebAssembly (WASM).
 */
export async function detectWorkerBackend(): Promise<WorkerDeviceCapabilities> {
  let hasWebGPU = false;

  if (typeof navigator !== 'undefined' && 'gpu' in navigator && navigator.gpu) {
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) {
        hasWebGPU = true;
      }
    } catch {
      hasWebGPU = false;
    }
  }

  const hasWasm = typeof WebAssembly !== 'undefined';

  return {
    backend: hasWebGPU ? 'webgpu' : 'wasm',
    hasWebGPU,
    hasWasm,
  };
}
