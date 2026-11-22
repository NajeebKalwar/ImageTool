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
