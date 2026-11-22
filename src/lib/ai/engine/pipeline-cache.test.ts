import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getPipeline, clearPipelineCache } from './pipeline-cache';
import { ModelLoadError } from '../errors';

// Partial mock for @huggingface/transformers preserving env and mocking pipeline
vi.mock(import('@huggingface/transformers'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    pipeline: vi.fn().mockImplementation(async (task, model, options) => {
      if (options?.device === 'webgpu' && String(model).includes('force-fail')) {
        throw new Error('WebGPU adapter not found');
      }
      return {
        task,
        model,
        options,
        run: vi.fn(),
      };
    }),
  };
});

// Mock detectWorkerBackend
vi.mock('./device', () => {
  return {
    detectWorkerBackend: vi.fn().mockResolvedValue({
      backend: 'wasm',
      hasWebGPU: false,
      hasWasm: true,
    }),
  };
});

describe('Pipeline Cache', () => {
  beforeEach(() => {
    clearPipelineCache();
    vi.clearAllMocks();
  });

  it('rejects with ModelLoadError when model is not found in registry', async () => {
    await expect(getPipeline('non-existent-model')).rejects.toThrow(ModelLoadError);
  });

  it('creates and caches pipeline on first load, returning instantly on second load', async () => {
    const progressEvents: unknown[] = [];
    const entry1 = await getPipeline('modnet', (info) => {
      progressEvents.push(info);
    });

    expect(entry1).toBeDefined();
    expect(entry1.modelId).toBe('modnet');
    expect(entry1.backend).toBe('wasm');

    // Second call for the same model
    const entry2 = await getPipeline('modnet');
    expect(entry2).toBe(entry1); // Identical cached reference in memory
  });

  it('clears memory cache when clearPipelineCache is called', async () => {
    const entry1 = await getPipeline('modnet');
    clearPipelineCache();
    const entry2 = await getPipeline('modnet');

    expect(entry2.modelId).toBe('modnet');
    expect(entry2).not.toBe(entry1); // Re-instantiated because cache was cleared
  });
});
