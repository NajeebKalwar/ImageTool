import { describe, expect, it } from 'vitest';
import { detectDeviceCapabilities } from './device';

describe('Device capabilities detection', () => {
  it('runs safely in Node.js environment without throwing', async () => {
    const caps = await detectDeviceCapabilities();

    expect(caps).toBeDefined();
    expect(typeof caps.hasWebGPU).toBe('boolean');
    expect(typeof caps.hasWasm).toBe('boolean');
    expect(caps.preferredBackend).toMatch(/^(webgpu|wasm)$/);
    expect(caps.hardwareConcurrency).toBeGreaterThan(0);
  });

  it('selects wasm as fallback when WebGPU is absent in Node', async () => {
    const caps = await detectDeviceCapabilities();
    // In Node without browser WebGPU flags, hasWebGPU is false
    expect(caps.hasWebGPU).toBe(false);
    expect(caps.hasWasm).toBe(true);
    expect(caps.preferredBackend).toBe('wasm');
  });
});
