import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  isModelCachedInBrowser,
  getCachedModelsSummary,
  clearDownloadedModels,
  TRANSFORMERS_CACHE_NAME,
} from './browser-cache';

describe('browser-cache', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns false when CacheStorage is not defined', async () => {
    const originalCaches = globalThis.caches;
    delete (globalThis as Record<string, unknown>).caches;

    const cached = await isModelCachedInBrowser('Xenova/modnet');
    expect(cached).toBe(false);

    if (originalCaches) {
      globalThis.caches = originalCaches;
    }
  });

  it('correctly queries cache storage for model files', async () => {
    const mockMatch = vi.fn().mockResolvedValue({
      headers: new Headers({ 'content-length': '1024' }),
    });

    const mockCache = {
      keys: vi.fn().mockResolvedValue([
        { url: 'https://models.example.com/Xenova/modnet/config.json' },
        { url: 'https://models.example.com/Xenova/modnet/onnx/model_fp16.onnx' },
      ]),
      match: mockMatch,
    };

    const mockCaches = {
      has: vi.fn().mockResolvedValue(true),
      open: vi.fn().mockResolvedValue(mockCache),
      delete: vi.fn().mockResolvedValue(true),
    };

    // @ts-expect-error - mock caches assignment
    globalThis.caches = mockCaches;

    const isCached = await isModelCachedInBrowser('Xenova/modnet', [
      'config.json',
      'onnx/model_fp16.onnx',
    ]);
    expect(isCached).toBe(true);

    const isMissing = await isModelCachedInBrowser('Xenova/modnet', [
      'non-existent-file.onnx',
    ]);
    expect(isMissing).toBe(false);
  });

  it('summarizes total cached count and byte sizes', async () => {
    const mockCache = {
      keys: vi.fn().mockResolvedValue([
        { url: 'https://models.example.com/file1.onnx' },
        { url: 'https://models.example.com/file2.onnx' },
      ]),
      match: vi.fn().mockResolvedValue({
        headers: new Headers({ 'content-length': '2048' }),
      }),
    };

    // @ts-expect-error - mock caches
    globalThis.caches = {
      has: vi.fn().mockResolvedValue(true),
      open: vi.fn().mockResolvedValue(mockCache),
      delete: vi.fn().mockResolvedValue(true),
    };

    const summary = await getCachedModelsSummary();
    expect(summary.cachedCount).toBe(2);
    expect(summary.totalEstimatedBytes).toBe(4096);
  });

  it('clears downloaded models cache storage', async () => {
    const mockDelete = vi.fn().mockResolvedValue(true);
    // @ts-expect-error - mock caches
    globalThis.caches = {
      delete: mockDelete,
    };

    const success = await clearDownloadedModels();
    expect(success).toBe(true);
    expect(mockDelete).toHaveBeenCalledWith(TRANSFORMERS_CACHE_NAME);
  });
});
