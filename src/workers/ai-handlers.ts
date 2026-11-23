/**
 * Pure Request Handlers for AI Worker Operations.
 *
 * Implements ai_load, ai_remove_background, and ai_upscale using
 * the cached Transformers.js pipelines. Supports granular progress streaming
 * and non-destructive cancellation checks.
 */

import { getPipeline } from '../lib/ai/engine/pipeline-cache';
import { getModelMetadata } from '../lib/ai/registry';
import { CancelledError, ModelLoadError } from '../lib/ai/errors';
import { runUpscale } from '../lib/ai/engine/upscale';
import { removeBackground } from '../lib/ai/engine/background';
import type { HandlerResult } from './message-handler';
import type { WorkerToMain } from '../lib/worker-protocol';

/**
 * Handles 'ai_load' requests by acquiring and caching the pipeline.
 * Emits download and initialization progress without blocking.
 */
export async function handleAiLoad(
  id: number,
  modelId: string,
  postProgress?: (msg: WorkerToMain) => void,
  isCancelled?: () => boolean,
): Promise<HandlerResult> {
  const model = getModelMetadata(modelId);
  if (!model) {
    throw new ModelLoadError(modelId, 'Model ID not found in registry');
  }

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  const loaded = await getPipeline(
    modelId,
    (info) => {
      if (isCancelled?.()) return;

      const percent = typeof info.progress === 'number'
        ? Math.round(info.progress)
        : info.status === 'done'
          ? 100
          : 0;

      postProgress?.({
        type: 'ai_progress',
        id,
        stage: info.status === 'progress' ? 'downloading' : 'initializing',
        percent,
        loadedBytes: info.loaded,
        totalBytes: info.total,
      });
    },
    isCancelled,
  );

  return {
    response: {
      type: 'ai_loaded',
      id,
      modelId,
      backend: loaded.backend,
    },
    transfer: [],
  };
}

/**
 * Handles 'ai_upscale' requests using tiled super-resolution with seam blending.
 * Emits tile-by-tile progress updates and transfers the result buffer back to main.
 */
export async function handleAiUpscale(
  id: number,
  params: {
    modelId: string;
    scale: number;
    width: number;
    height: number;
    pixels: ArrayBuffer;
    tileSize?: number;
    overlap?: number;
  },
  postProgress?: (msg: WorkerToMain) => void,
  isCancelled?: () => boolean,
): Promise<HandlerResult> {
  const clampedPixels = new Uint8ClampedArray(params.pixels);

  const result = await runUpscale(
    clampedPixels,
    params.width,
    params.height,
    {
      modelId: params.modelId,
      scale: params.scale,
      tileSize: params.tileSize,
      overlap: params.overlap,
    },
    (progress) => {
      postProgress?.({
        type: 'ai_progress',
        id,
        stage: progress.stage === 'blending'
          ? 'blending'
          : progress.stage === 'downloading'
            ? 'downloading'
            : progress.stage === 'initializing'
              ? 'initializing'
              : 'tiling',
        percent: progress.percent,
        currentTile: progress.currentTile,
        totalTiles: progress.totalTiles,
        loadedBytes: progress.loadedBytes,
        totalBytes: progress.totalBytes,
      });
    },
    isCancelled,
  );

  const outBuffer = result.pixels.buffer as ArrayBuffer;

  return {
    response: {
      type: 'ai_upscale_result',
      id,
      modelId: params.modelId,
      scale: result.scale,
      width: result.width,
      height: result.height,
      pixels: outBuffer,
      durationMs: result.durationMs,
    },
    transfer: [outBuffer],
  };
}

/**
 * Handles 'ai_remove_background' requests using on-device segmentation models.
 * Replaces the alpha matte and transfers the result buffer back to main thread.
 */
export async function handleAiRemoveBackground(
  id: number,
  params: {
    modelId: string;
    width: number;
    height: number;
    pixels: ArrayBuffer;
  },
  postProgress?: (msg: WorkerToMain) => void,
  isCancelled?: () => boolean,
): Promise<HandlerResult> {
  const clampedPixels = new Uint8ClampedArray(params.pixels);

  const result = await removeBackground(
    clampedPixels,
    params.width,
    params.height,
    {
      modelId: params.modelId,
    },
    (progress) => {
      postProgress?.({
        type: 'ai_progress',
        id,
        stage: progress.stage === 'initializing'
          ? 'initializing'
          : progress.stage === 'downloading'
            ? 'downloading'
            : progress.stage === 'complete'
              ? 'complete'
              : 'tiling',
        percent: progress.percent,
        loadedBytes: progress.loadedBytes,
        totalBytes: progress.totalBytes,
      });
    },
    isCancelled,
  );

  const outBuffer = result.pixels.buffer as ArrayBuffer;

  return {
    response: {
      type: 'ai_result',
      id,
      modelId: params.modelId,
      width: result.width,
      height: result.height,
      pixels: outBuffer,
      durationMs: result.durationMs,
    },
    transfer: [outBuffer],
  };
}
