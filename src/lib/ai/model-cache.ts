/**
 * Model Downloader and Cache Manager.
 *
 * Downloads model weight files with real-time progress events and stores
 * them in browser IndexedDB (via idb-keyval) so subsequent loads
 * cost 0 network egress and load instantly offline.
 */

import { get, set, del, keys, createStore } from 'idb-keyval';
import { getModelMetadata } from './model-registry';

export interface DownloadProgress {
  modelId: string;
  loadedBytes: number;
  totalBytes: number;
  percentage: number;
}

export type ProgressCallback = (progress: DownloadProgress) => void;

/**
 * Storage interface for caching models, abstracted for Node unit testing.
 */
export interface ModelStorage {
  get(key: string): Promise<ArrayBuffer | undefined>;
  set(key: string, value: ArrayBuffer): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/**
 * IndexedDB implementation of ModelStorage using idb-keyval.
 */
export class IndexedDbModelStorage implements ModelStorage {
  private customStore = createStore('imagetool-ai-cache', 'model-weights');

  async get(key: string): Promise<ArrayBuffer | undefined> {
    return await get<ArrayBuffer>(key, this.customStore);
  }

  async set(key: string, value: ArrayBuffer): Promise<void> {
    await set(key, value, this.customStore);
  }

  async del(key: string): Promise<void> {
    await del(key, this.customStore);
  }

  async keys(): Promise<string[]> {
    const k = await keys(this.customStore);
    return k.map(String);
  }
}

/**
 * In-memory storage for unit testing without IndexedDB.
 */
export class MemoryModelStorage implements ModelStorage {
  private map = new Map<string, ArrayBuffer>();

  async get(key: string): Promise<ArrayBuffer | undefined> {
    return this.map.get(key);
  }

  async set(key: string, value: ArrayBuffer): Promise<void> {
    this.map.set(key, value);
  }

  async del(key: string): Promise<void> {
    this.map.delete(key);
  }

  async keys(): Promise<string[]> {
    return Array.from(this.map.keys());
  }
}

export class ModelCacheManager {
  constructor(private storage: ModelStorage = new IndexedDbModelStorage()) {}

  /**
   * Checks if a model's weights are already cached locally.
   */
  async isCached(modelId: string): Promise<boolean> {
    const buffer = await this.storage.get(modelId);
    return buffer !== undefined && buffer.byteLength > 0;
  }

  /**
   * Retrieves model weights from local cache if present.
   */
  async getModelWeights(modelId: string): Promise<ArrayBuffer | undefined> {
    return await this.storage.get(modelId);
  }

  /**
   * Downloads model weights with progress reporting and stores in cache.
   */
  async downloadAndCache(
    modelId: string,
    onProgress?: ProgressCallback,
    signal?: AbortSignal,
    customFetch: typeof fetch = fetch,
  ): Promise<ArrayBuffer> {
    // 1. Check local cache first
    const cached = await this.storage.get(modelId);
    if (cached) {
      if (onProgress) {
        onProgress({
          modelId,
          loadedBytes: cached.byteLength,
          totalBytes: cached.byteLength,
          percentage: 100,
        });
      }
      return cached;
    }

    // 2. Resolve model metadata
    const meta = getModelMetadata(modelId);
    if (!meta) {
      throw new Error(`Model '${modelId}' not found in registry.`);
    }

    // 3. Perform network fetch
    const response = await customFetch(meta.url, { signal });
    if (!response.ok) {
      throw new Error(`Failed to download model '${modelId}': HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length')) || meta.sizeBytes;

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      await this.storage.set(modelId, buffer);
      return buffer;
    }

    // 4. Stream response to track download progress
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let receivedBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      chunks.push(value);
      receivedBytes += value.length;

      if (onProgress) {
        const percent = contentLength > 0
          ? Math.min(100, Math.round((receivedBytes / contentLength) * 100))
          : 0;
        onProgress({
          modelId,
          loadedBytes: receivedBytes,
          totalBytes: contentLength,
          percentage: percent,
        });
      }
    }

    // 5. Assemble buffer and save into storage
    const allBytes = new Uint8Array(receivedBytes);
    let position = 0;
    for (const chunk of chunks) {
      allBytes.set(chunk, position);
      position += chunk.length;
    }

    const arrayBuffer = allBytes.buffer;
    await this.storage.set(modelId, arrayBuffer);

    return arrayBuffer;
  }

  /**
   * Delete a cached model to free up storage space.
   */
  async deleteModel(modelId: string): Promise<void> {
    await this.storage.del(modelId);
  }

  /**
   * List all cached model IDs.
   */
  async listCachedModels(): Promise<string[]> {
    return await this.storage.keys();
  }
}
