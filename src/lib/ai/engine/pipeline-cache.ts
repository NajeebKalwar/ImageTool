/**
 * Pipeline Cache and Session Manager for Transformers.js in Web Worker.
 *
 * Implements one loaded pipeline per modelId, keeps it alive in memory across
 * runs, and automatically falls back from WebGPU to WASM if hardware initialization fails.
 */

import { pipeline } from '@huggingface/transformers';
import '../transformers-env'; // Sets up R2 remoteHost, Cache API, and WASM paths
import { getModelMetadata, type ModelMetadata } from '../registry';
import { detectWorkerBackend, type WorkerExecutionBackend } from './device';
import { ModelLoadError } from '../errors';

export interface ProgressPayload {
  status: 'initiate' | 'progress' | 'done';
  name?: string;
  file?: string;
  loaded?: number;
  total?: number;
  progress?: number;
}

export type PipelineProgressCallback = (payload: ProgressPayload) => void;

export interface LoadedPipelineEntry {
  modelId: string;
  model: ModelMetadata;
  backend: WorkerExecutionBackend;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  instance: any;
  lastUsed: number;
  /** Dtype selected for the backend that actually loaded this pipeline. */
  dtype?: string;
}

const MAX_CACHED_PIPELINES = 2;
const pipelineCache = new Map<string, LoadedPipelineEntry>();

/**
 * Evicts the least-recently used pipeline if cache exceeds maximum capacity.
 * Explicitly disposes the underlying ONNX/Transformers instance to release WebGPU and WASM resources.
 */
function evictLruPipeline(): void {
  if (pipelineCache.size < MAX_CACHED_PIPELINES) return;

  let oldestKey: string | null = null;
  let oldestTime = Infinity;

  for (const [key, entry] of pipelineCache.entries()) {
    if (entry.lastUsed < oldestTime) {
      oldestTime = entry.lastUsed;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    console.log(`[pipeline-cache] Evicting LRU model '${oldestKey}' from memory.`);
    const entry = pipelineCache.get(oldestKey);
    if (entry?.instance && typeof entry.instance.dispose === 'function') {
      try {
        entry.instance.dispose();
      } catch (e) {
        console.warn(`[pipeline-cache] Error disposing pipeline '${oldestKey}':`, e);
      }
    }
    pipelineCache.delete(oldestKey);
  }
}

/**
 * Clears all cached pipelines from memory and disposes underlying sessions.
 */
export function clearPipelineCache(): void {
  for (const [key, entry] of pipelineCache.entries()) {
    if (entry?.instance && typeof entry.instance.dispose === 'function') {
      try {
        entry.instance.dispose();
      } catch (e) {
        console.warn(`[pipeline-cache] Error disposing pipeline '${key}':`, e);
      }
    }
  }
  pipelineCache.clear();
}

/**
 * Retrieves an active Transformers.js pipeline for a model, creating and caching it if not present.
 * Automatically tries WebGPU, then retries with WASM if WebGPU initialization fails.
 * Accepts optional `forceBackend` parameter to bypass WebGPU when recovering from inference errors.
 */
export async function getPipeline(
  modelId: string,
  onProgress?: PipelineProgressCallback,
  isCancelled?: () => boolean,
  forceBackend?: WorkerExecutionBackend,
): Promise<LoadedPipelineEntry> {
  // 1. Check in-memory cache
  const cached = pipelineCache.get(modelId);
  if (cached && (!forceBackend || cached.backend === forceBackend)) {
    cached.lastUsed = Date.now();
    return cached;
  }

  // If cached has different backend than forceBackend, evict it
  if (cached && forceBackend && cached.backend !== forceBackend) {
    if (cached.instance && typeof cached.instance.dispose === 'function') {
      try {
        cached.instance.dispose();
      } catch {}
    }
    pipelineCache.delete(modelId);
  }

  // 2. Validate model in registry
  const model = getModelMetadata(modelId);
  if (!model) {
    throw new ModelLoadError(modelId, 'Model not found in registry');
  }

  if (isCancelled?.()) {
    throw new Error('Operation cancelled before model loading');
  }

  evictLruPipeline();

  // 3. Detect hardware capability
  const { backend: preferredBackend } = await detectWorkerBackend();

  const progressCallback = (info: unknown) => {
    if (isCancelled?.()) {
      throw new Error('Operation cancelled during model download');
    }
    if (onProgress && typeof info === 'object' && info !== null) {
      onProgress(info as ProgressPayload);
    }
  };

  let loadedInstance: unknown = null;
  let usedBackend: WorkerExecutionBackend = preferredBackend;

  // 4. Attempt initialization on preferred backend (e.g. WebGPU)
  if (preferredBackend === 'webgpu' && forceBackend !== 'wasm') {
    try {
      console.log(`[pipeline-cache] Initializing '${modelId}' on WebGPU (dtype: ${model.dtype.webgpu})...`);
      loadedInstance = await pipeline(model.pipeline as never, model.repo, {
        device: 'webgpu',
        dtype: model.dtype.webgpu as never,
        progress_callback: progressCallback,
      });
      usedBackend = 'webgpu';
    } catch (err) {
      console.warn(
        `[pipeline-cache] WebGPU initialization failed for '${modelId}':`,
        err,
        `Retrying on WASM fallback (dtype: ${model.dtype.wasm})...`,
      );
      loadedInstance = null;
    }
  }

  // 5. Fallback or direct initialization on WASM
  if (!loadedInstance) {
    try {
      console.log(`[pipeline-cache] Initializing '${modelId}' on WASM (dtype: ${model.dtype.wasm})...`);
      loadedInstance = await pipeline(model.pipeline as never, model.repo, {
        device: 'wasm',
        dtype: model.dtype.wasm as never,
        progress_callback: progressCallback,
      });
      usedBackend = 'wasm';
    } catch (wasmErr) {
      const msg = wasmErr instanceof Error ? wasmErr.message : String(wasmErr);
      throw new ModelLoadError(modelId, `WASM initialization failed: ${msg}`);
    }
  }

  const entry: LoadedPipelineEntry = {
    modelId,
    model,
    backend: usedBackend,
    instance: loadedInstance,
    lastUsed: Date.now(),
    dtype: usedBackend === 'webgpu' ? model.dtype.webgpu : model.dtype.wasm,
  };

  console.info(
    `[pipeline-cache] Ready: model=${modelId} backend=${usedBackend} dtype=${entry.dtype}`,
  );

  pipelineCache.set(modelId, entry);
  return entry;
}
