import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectWorkerBackend } from './device';

describe('Worker Device Detection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects WebGPU when navigator.gpu is available and requestAdapter succeeds', async () => {
    vi.stubGlobal('navigator', {
      gpu: {
        requestAdapter: vi.fn().mockResolvedValue({}),
      },
    });

    const caps = await detectWorkerBackend();
    expect(caps.hasWebGPU).toBe(true);
    expect(caps.backend).toBe('webgpu');
  });

  it('falls back to wasm when navigator.gpu is unavailable', async () => {
    vi.stubGlobal('navigator', {});

    const caps = await detectWorkerBackend();
    expect(caps.hasWebGPU).toBe(false);
    expect(caps.hasWasm).toBe(true);
    expect(caps.backend).toBe('wasm');
  });
});
