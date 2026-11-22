import {
  isSupportedFormat,
  normalizeQuality,
  validateImageBuffer,
  type ImageEngine,
} from '../lib/canvas-ops';
import { invertRgba } from '../lib/image-ops';
import type { AiPipeline } from '../lib/ai/inference';
import { getModelMetadata, isLicenseClean } from '../lib/ai/registry';
import { handleAiLoad, handleAiUpscale, handleAiRemoveBackground } from './ai-handlers';
import {
  MAX_PIXELS,
  type ResizeOptions,
  type SupportedFormat,
  type WorkerToMain,
} from '../lib/worker-protocol';

/**
 * Result produced by the message handler.
 */
export interface HandlerResult {
  response: WorkerToMain;

  /**
   * Buffers that should be transferred back to the main thread
   * instead of copied.
   */
  transfer: Transferable[];
}

/**
 * Active set of request IDs that have been requested to cancel.
 */
const activeCancellations = new Set<number>();

/**
 * Resets cancellation state (primarily for test isolation).
 */
export function resetCancellations(): void {
  activeCancellations.clear();
}

/**
 * Creates a standardized error response.
 */
const fail = (id: number, message: string): HandlerResult => ({
  response: {
    type: 'error',
    id,
    message,
  },
  transfer: [],
});

/**
 * Checks whether a number is a positive integer.
 */
const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0;

/**
 * Handles one incoming message and returns one response asynchronously.
 *
 * This function accepts an optional `ImageEngine` for Canvas operations,
 * an optional `AiPipeline` for AI model execution, and an optional `postProgress`
 * callback for streaming progress updates to the main thread.
 */
export async function handleMessage(
  data: unknown,
  engine?: ImageEngine,
  aiPipeline?: AiPipeline,
  postProgress?: (msg: WorkerToMain) => void,
  aiLoader: (
    id: number,
    modelId: string,
    postProgress?: (msg: WorkerToMain) => void,
    isCancelled?: () => boolean,
  ) => Promise<HandlerResult> = handleAiLoad,
  aiUpscaler: (
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
  ) => Promise<HandlerResult> = handleAiUpscale,
  aiBgRemover: (
    id: number,
    params: {
      modelId: string;
      width: number;
      height: number;
      pixels: ArrayBuffer;
    },
    postProgress?: (msg: WorkerToMain) => void,
    isCancelled?: () => boolean,
  ) => Promise<HandlerResult> = handleAiRemoveBackground,
): Promise<HandlerResult> {
  // 1. Validate the incoming message container.
  if (typeof data !== 'object' || data === null) {
    return fail(-1, 'Message must be an object.');
  }

  const record = data as Record<string, unknown>;
  const id = record.id;

  if (typeof id !== 'number' || !Number.isInteger(id)) {
    return fail(-1, 'Message id must be an integer.');
  }

  try {
    // 2. Identify the requested operation.
    switch (record.type) {
      case 'ping':
        return {
          response: {
            type: 'pong',
            id,
          },
          transfer: [],
        };

      case 'cancel': {
        const targetId = record.targetId;
        if (typeof targetId !== 'number' || !Number.isInteger(targetId)) {
          return fail(id, 'Target ID must be an integer.');
        }

        activeCancellations.add(targetId);

        return {
          response: {
            type: 'cancelled',
            id,
            targetId,
          },
          transfer: [],
        };
      }

      case 'invert': {
        const { width, height, pixels } = record;

        // 3. Validate image dimensions.
        if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
          return fail(
            id,
            'Width and height must be positive whole numbers.',
          );
        }

        // 4. Protect against excessively large images.
        if (width * height > MAX_PIXELS) {
          return fail(
            id,
            `Image is too large: ${width * height} pixels (limit ${MAX_PIXELS}).`,
          );
        }

        // 5. Validate the pixel buffer.
        if (!(pixels instanceof ArrayBuffer)) {
          return fail(id, 'Pixel data must be an ArrayBuffer.');
        }

        const expectedByteLength = width * height * 4;
        if (pixels.byteLength !== expectedByteLength) {
          return fail(
            id,
            `Buffer length mismatch: expected ${expectedByteLength} bytes for ${width}×${height} RGBA, got ${pixels.byteLength}.`,
          );
        }

        // 6. Perform the in-place invert operation.
        const view = new Uint8ClampedArray(pixels);
        invertRgba(view);

        // 7. Return the mutated buffer as a transferable.
        return {
          response: {
            type: 'result',
            id,
            width,
            height,
            pixels,
          },
          transfer: [pixels],
        };
      }

      case 'resize': {
        const { imageBuffer, options } = record;

        try {
          validateImageBuffer(imageBuffer);
        } catch (err) {
          return fail(id, err instanceof Error ? err.message : 'Invalid image buffer.');
        }

        if (typeof options !== 'object' || options === null) {
          return fail(id, 'Options must be an object.');
        }

        const resizeOpts = options as ResizeOptions;
        if (resizeOpts.width !== undefined && !isPositiveInteger(resizeOpts.width)) {
          return fail(id, 'Target width must be a positive integer.');
        }
        if (resizeOpts.height !== undefined && !isPositiveInteger(resizeOpts.height)) {
          return fail(id, 'Target height must be a positive integer.');
        }
        if (resizeOpts.format !== undefined && !isSupportedFormat(resizeOpts.format)) {
          return fail(id, `Unsupported output format: ${String(resizeOpts.format)}`);
        }

        if (!engine) {
          return fail(id, 'Image engine not available.');
        }

        const buffer = imageBuffer as ArrayBuffer;
        const result = await engine.process(buffer, resizeOpts);

        return {
          response: {
            type: 'image_result',
            id,
            width: result.width,
            height: result.height,
            format: result.format,
            data: result.data,
          },
          transfer: [result.data],
        };
      }

      case 'convert': {
        const { imageBuffer, targetFormat, quality } = record;

        try {
          validateImageBuffer(imageBuffer);
        } catch (err) {
          return fail(id, err instanceof Error ? err.message : 'Invalid image buffer.');
        }

        if (!isSupportedFormat(targetFormat)) {
          return fail(id, `Unsupported target format: ${String(targetFormat)}`);
        }

        const normalizedQuality = normalizeQuality(quality as number | undefined);

        if (!engine) {
          return fail(id, 'Image engine not available.');
        }

        const buffer = imageBuffer as ArrayBuffer;
        const result = await engine.process(buffer, {
          format: targetFormat as SupportedFormat,
          quality: normalizedQuality,
        });

        return {
          response: {
            type: 'image_result',
            id,
            width: result.width,
            height: result.height,
            format: result.format,
            data: result.data,
          },
          transfer: [result.data],
        };
      }

      case 'ai_load': {
        const modelId = record.modelId;
        if (typeof modelId !== 'string' || !modelId) {
          return fail(id, 'Model ID must be a non-empty string.');
        }

        const meta = getModelMetadata(modelId);
        if (!meta) {
          return fail(id, `Model '${modelId}' not found in registry.`);
        }

        if (!isLicenseClean(meta)) {
          return fail(id, `Model '${modelId}' does not have an approved commercial license.`);
        }

        try {
          return await aiLoader(
            id,
            modelId,
            postProgress,
            () => activeCancellations.has(id),
          );
        } catch (err) {
          return fail(id, err instanceof Error ? err.message : 'Model loading failed.');
        }
      }

      case 'ai_remove_background': {
        const { modelId, width, height, pixels } = record;

        if (typeof modelId !== 'string' || !modelId) {
          return fail(id, 'Model ID must be a non-empty string.');
        }

        const meta = getModelMetadata(modelId);
        if (!meta) {
          return fail(id, `Model '${modelId}' not found in registry.`);
        }

        if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
          return fail(id, 'Width and height must be positive integers.');
        }

        if (width * height > MAX_PIXELS) {
          return fail(id, `Image exceeds MAX_PIXELS (${width * height} > ${MAX_PIXELS}).`);
        }

        if (!(pixels instanceof ArrayBuffer)) {
          return fail(id, 'Pixel data must be an ArrayBuffer.');
        }

        const expectedBytes = width * height * 4;
        if (pixels.byteLength !== expectedBytes) {
          return fail(id, `Expected ${expectedBytes} bytes of RGBA data, got ${pixels.byteLength}.`);
        }

        if (activeCancellations.has(id)) {
          activeCancellations.delete(id);
          return fail(id, 'Operation cancelled');
        }

        if (aiPipeline) {
          const clampedPixels = new Uint8ClampedArray(pixels);
          try {
            const aiRes = await aiPipeline.runBackgroundRemoval(clampedPixels, width, height, {
              modelId,
              preferredBackend: 'webgpu',
            });

            activeCancellations.delete(id);

            return {
              response: {
                type: 'ai_result',
                id,
                modelId,
                width: aiRes.width,
                height: aiRes.height,
                pixels,
                durationMs: aiRes.durationMs,
              },
              transfer: [pixels],
            };
          } catch (err) {
            activeCancellations.delete(id);
            return fail(id, err instanceof Error ? err.message : 'Background removal failed.');
          }
        }

        // When aiPipeline is not injected, delegate to Transformers.js handleAiRemoveBackground
        try {
          const result = await aiBgRemover(
            id,
            { modelId, width, height, pixels },
            postProgress,
            () => activeCancellations.has(id),
          );
          activeCancellations.delete(id);
          return result;
        } catch (err) {
          activeCancellations.delete(id);
          return fail(id, err instanceof Error ? err.message : 'Background removal failed.');
        }
      }

      case 'ai_upscale': {
        const { modelId, scale, width, height, pixels, tileSize, overlap } = record;

        if (typeof modelId !== 'string' || !modelId) {
          return fail(id, 'Model ID must be a non-empty string.');
        }

        const meta = getModelMetadata(modelId);
        if (!meta) {
          return fail(id, `Model '${modelId}' not found in registry.`);
        }

        if (!isLicenseClean(meta)) {
          return fail(id, `Model '${modelId}' does not have an approved commercial license.`);
        }

        if (typeof scale !== 'number' || scale <= 0) {
          return fail(id, 'Scale factor must be a positive number.');
        }

        if (!isPositiveInteger(width) || !isPositiveInteger(height)) {
          return fail(id, 'Width and height must be positive integers.');
        }

        if (width * height > MAX_PIXELS) {
          return fail(id, `Image exceeds MAX_PIXELS (${width * height} > ${MAX_PIXELS}).`);
        }

        if (!(pixels instanceof ArrayBuffer)) {
          return fail(id, 'Pixel data must be an ArrayBuffer.');
        }

        const expectedBytes = width * height * 4;
        if (pixels.byteLength !== expectedBytes) {
          return fail(id, `Expected ${expectedBytes} bytes of RGBA data, got ${pixels.byteLength}.`);
        }

        if (activeCancellations.has(id)) {
          activeCancellations.delete(id);
          return fail(id, 'Operation cancelled');
        }

        if (aiPipeline) {
          const clampedPixels = new Uint8ClampedArray(pixels);
          try {
            const upscaleRes = await aiPipeline.runUpscaling(
              clampedPixels,
              width,
              height,
              {
                modelId,
                scale,
                tileSize: typeof tileSize === 'number' ? tileSize : undefined,
                overlap: typeof overlap === 'number' ? overlap : undefined,
                preferredBackend: 'webgpu',
              },
              (progress) => {
                postProgress?.({
                  type: 'ai_progress',
                  id,
                  currentTile: progress.currentTile,
                  totalTiles: progress.totalTiles,
                  percent: progress.percent,
                  stage: progress.stage,
                });
              },
              () => activeCancellations.has(id),
            );

            activeCancellations.delete(id);

            const outBuffer = upscaleRes.pixels.buffer as ArrayBuffer;

            return {
              response: {
                type: 'ai_upscale_result',
                id,
                modelId,
                scale: upscaleRes.scale,
                width: upscaleRes.width,
                height: upscaleRes.height,
                pixels: outBuffer,
                durationMs: upscaleRes.durationMs,
              },
              transfer: [outBuffer],
            };
          } catch (err) {
            activeCancellations.delete(id);
            return fail(id, err instanceof Error ? err.message : 'Upscaling failed.');
          }
        }

        // When aiPipeline is not injected, delegate to Transformers.js handleAiUpscale
        try {
          const result = await aiUpscaler(
            id,
            {
              modelId,
              scale,
              width,
              height,
              pixels,
              tileSize: typeof tileSize === 'number' ? tileSize : undefined,
              overlap: typeof overlap === 'number' ? overlap : undefined,
            },
            postProgress,
            () => activeCancellations.has(id),
          );
          activeCancellations.delete(id);
          return result;
        } catch (err) {
          activeCancellations.delete(id);
          return fail(id, err instanceof Error ? err.message : 'Upscaling failed.');
        }
      }

      default:
        return fail(
          id,
          `Unknown message type: ${String(record.type)}`,
        );
    }
  } catch (error) {
    return fail(
      id,
      error instanceof Error ? error.message : 'Unexpected worker error.',
    );
  }
}
