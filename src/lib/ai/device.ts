/**
 * Hardware Acceleration and Execution Provider Detector.
 *
 * Inspects device capabilities to select between WebGPU and WASM execution
 * providers for local ONNX Runtime Web inference.
 */

import type { ExecutionBackend } from './model-registry';

export interface DeviceCapabilities {
  hasWebGPU: boolean;
  hasWasm: boolean;
  preferredBackend: ExecutionBackend;
  deviceMemoryGb?: number;
  hardwareConcurrency: number;
  webGpuAdapterInfo?: {
    vendor?: string;
    architecture?: string;
    description?: string;
  };
}

/**
 * Detects device hardware acceleration features.
 * Safe to call in Node.js or browser main/worker threads.
 */
export async function detectDeviceCapabilities(): Promise<DeviceCapabilities> {
  const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;

  const hardwareConcurrency = nav?.hardwareConcurrency ?? 4;
  const deviceMemoryGb = (nav as { deviceMemory?: number } | undefined)?.deviceMemory;

  let hasWebGPU = false;
  let webGpuAdapterInfo: DeviceCapabilities['webGpuAdapterInfo'] = undefined;

  if (isBrowser && nav && 'gpu' in nav && nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter();
      if (adapter) {
        hasWebGPU = true;
        if ('info' in adapter && adapter.info) {
          const info = adapter.info as { vendor?: string; architecture?: string; description?: string };
          webGpuAdapterInfo = {
            vendor: info.vendor,
            architecture: info.architecture,
            description: info.description,
          };
        }
      }
    } catch {
      hasWebGPU = false;
    }
  }

  // WebAssembly is natively supported in all target browsers
  const hasWasm = typeof WebAssembly !== 'undefined';

  return {
    hasWebGPU,
    hasWasm,
    preferredBackend: hasWebGPU ? 'webgpu' : 'wasm',
    deviceMemoryGb,
    hardwareConcurrency,
    webGpuAdapterInfo,
  };
}
