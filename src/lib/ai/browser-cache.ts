/**
 * Helper utilities for querying and managing browser Cache API entries
 * used by Transformers.js ('transformers-cache').
 */

export const TRANSFORMERS_CACHE_NAME = 'transformers-cache';

/**
 * Retrieves the global CacheStorage interface, if available in the current context.
 */
export function getCacheStorage(): CacheStorage | undefined {
  if (typeof caches !== 'undefined') {
    return caches;
  }
  if (typeof self !== 'undefined' && 'caches' in self) {
    return (self as unknown as { caches: CacheStorage }).caches;
  }
  if (typeof window !== 'undefined' && 'caches' in window) {
    return window.caches;
  }
  return undefined;
}

/**
 * Checks whether specific model files exist in the browser's Cache API.
 *
 * @param repoOrModelId The model repo or ID (e.g. 'Xenova/modnet')
 * @param requiredFiles Key filenames that must exist (e.g. ['config.json', 'onnx/model_fp16.onnx'])
 */
export async function isModelCachedInBrowser(
  repoOrModelId: string,
  requiredFiles: string[] = ['config.json'],
): Promise<boolean> {
  const cacheStorage = getCacheStorage();
  if (!cacheStorage) return false;

  try {
    const hasCache = await cacheStorage.has(TRANSFORMERS_CACHE_NAME);
    if (!hasCache) return false;

    const cache = await cacheStorage.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();

    // Check if every required file matches at least one cached URL
    return requiredFiles.every((file) => {
      return keys.some((req) => {
        const url = req.url;
        return url.includes(repoOrModelId) && url.includes(file);
      });
    });
  } catch {
    return false;
  }
}

/**
 * Summarizes the cached models and total storage used in the Cache API.
 */
export async function getCachedModelsSummary(): Promise<{
  cachedCount: number;
  totalEstimatedBytes: number;
}> {
  const cacheStorage = getCacheStorage();
  if (!cacheStorage) return { cachedCount: 0, totalEstimatedBytes: 0 };

  try {
    const hasCache = await cacheStorage.has(TRANSFORMERS_CACHE_NAME);
    if (!hasCache) return { cachedCount: 0, totalEstimatedBytes: 0 };

    const cache = await cacheStorage.open(TRANSFORMERS_CACHE_NAME);
    const keys = await cache.keys();

    let totalBytes = 0;
    for (const req of keys) {
      const match = await cache.match(req);
      if (match) {
        const contentLength = match.headers.get('content-length');
        if (contentLength) {
          totalBytes += Number(contentLength) || 0;
        }
      }
    }

    return {
      cachedCount: keys.length,
      totalEstimatedBytes: totalBytes,
    };
  } catch {
    return { cachedCount: 0, totalEstimatedBytes: 0 };
  }
}

/**
 * Deletes the entire Transformers.js cache storage, freeing device disk space.
 */
export async function clearDownloadedModels(): Promise<boolean> {
  const cacheStorage = getCacheStorage();
  if (!cacheStorage) return false;

  try {
    return await cacheStorage.delete(TRANSFORMERS_CACHE_NAME);
  } catch {
    return false;
  }
}
