import { describe, expect, it, vi } from 'vitest';
import { MemoryModelStorage, ModelCacheManager } from './model-cache';

describe('Model Cache Manager', () => {
  it('detects uncached models and stores them upon download', async () => {
    const storage = new MemoryModelStorage();
    const manager = new ModelCacheManager(storage);

    expect(await manager.isCached('modnet')).toBe(false);

    // Mock response with ReadableStream
    const fakeData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-length': '8' }),
      body: {
        getReader() {
          let readCount = 0;
          return {
            async read() {
              if (readCount === 0) {
                readCount++;
                return { done: false, value: fakeData };
              }
              return { done: true, value: undefined };
            },
          };
        },
      },
    });

    const progressEvents: number[] = [];
    const buffer = await manager.downloadAndCache(
      'modnet',
      (p) => progressEvents.push(p.percentage),
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(buffer.byteLength).toBe(8);
    expect(progressEvents).toContain(100);
    expect(await manager.isCached('modnet')).toBe(true);

    // Subsequent retrieval should use storage without calling fetch
    mockFetch.mockClear();
    const cachedBuffer = await manager.downloadAndCache(
      'modnet',
      undefined,
      undefined,
      mockFetch as unknown as typeof fetch,
    );

    expect(cachedBuffer.byteLength).toBe(8);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('deletes model from cache', async () => {
    const storage = new MemoryModelStorage();
    const manager = new ModelCacheManager(storage);

    await storage.set('birefnet-lite', new ArrayBuffer(16));
    expect(await manager.isCached('birefnet-lite')).toBe(true);

    await manager.deleteModel('birefnet-lite');
    expect(await manager.isCached('birefnet-lite')).toBe(false);
  });
});
