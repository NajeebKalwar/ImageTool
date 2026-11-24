/**
 * Background Removal Inference Engine using Transformers.js.
 *
 * Runs on-device AI foreground segmentation and matting (Xenova/modnet or
 * onnx-community/BiRefNet_lite-ONNX) inside the worker, extracting the alpha
 * matte and compositing it onto the source image with zero network egress.
 */

import { RawImage } from '@huggingface/transformers';
import { getPipeline } from './pipeline-cache';
import { getModelMetadata, findModelForTask } from '../registry';
import { CancelledError, ModelLoadError, UnsupportedImageError } from '../errors';
import { logAiExecution } from '../telemetry';

export interface BackgroundRemovalOptions {
  modelId?: string;
}

export interface BackgroundProgressInfo {
  stage: 'downloading' | 'initializing' | 'segmenting' | 'compositing' | 'complete';
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
}

export interface BackgroundRemovalResult {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  mask: Uint8ClampedArray;
  durationMs: number;
}

/**
 * Extracts a RawImage mask from various Transformers.js segmentation output formats.
 */
export function extractMaskFromSegmentationOutput(output: unknown): RawImage {
  if (output instanceof RawImage) {
    return output;
  }

  if (Array.isArray(output) && output.length > 0) {
    const first = output[0];
    if (first instanceof RawImage) {
      return first;
    }
    if (first && typeof first === 'object' && 'mask' in first && (first as { mask: unknown }).mask instanceof RawImage) {
      return (first as { mask: RawImage }).mask;
    }
  }

  if (
    output &&
    typeof output === 'object' &&
    'mask' in output &&
    (output as { mask: unknown }).mask instanceof RawImage
  ) {
    return (output as { mask: RawImage }).mask;
  }

  throw new Error('Segmentation model did not return a valid alpha mask.');
}

/**
 * Extracts a normalized 1-channel 8-bit alpha matte (0-255) from a RawImage mask.
 */
export function extractMaskChannel(
  mask: RawImage,
  width: number,
  height: number,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const matte = new Uint8ClampedArray(pixelCount);
  const maskData = mask.data;
  const maskChannels = mask.channels;

  for (let i = 0; i < pixelCount; i++) {
    if (maskChannels === 1) {
      matte[i] = maskData[i];
    } else if (maskChannels === 4) {
      matte[i] = maskData[i * 4 + 3];
    } else if (maskChannels === 3) {
      matte[i] = Math.round(
        0.299 * maskData[i * 3] +
        0.587 * maskData[i * 3 + 1] +
        0.114 * maskData[i * 3 + 2]
      );
    } else {
      matte[i] = maskData[i * maskChannels];
    }
  }
  return matte;
}

/**
 * Composites the extracted alpha mask into the source RGBA image buffer in-place.
 * Preserves RGB channels while updating the alpha channel, handling RawImage or 1-channel matte.
 */
export function compositeAlphaMask(
  sourceRgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: RawImage | Uint8ClampedArray,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const matte = mask instanceof RawImage ? extractMaskChannel(mask, width, height) : mask;

  for (let i = 0; i < pixelCount; i++) {
    const pxOffset = i * 4;
    const srcA = sourceRgba[pxOffset + 3];
    const maskA = matte[i];
    sourceRgba[pxOffset + 3] = Math.round((srcA * maskA) / 255);
  }

  return sourceRgba;
}

/**
 * Executes on-device AI background removal with automatic WebGPU-to-WASM inference fallback,
 * in-place memory optimization, and output quality validation.
 */
export async function removeBackground(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: BackgroundRemovalOptions = {},
  onProgress?: (progress: BackgroundProgressInfo) => void,
  isCancelled?: () => boolean,
): Promise<BackgroundRemovalResult> {
  const startTime = performance.now();

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
    throw new UnsupportedImageError('Invalid image dimensions or pixel buffer size.');
  }

  // 1. Resolve model metadata
  let model = options.modelId ? getModelMetadata(options.modelId) : null;
  if (!model) {
    model = findModelForTask('background-removal');
  }

  if (!model) {
    throw new ModelLoadError(
      options.modelId ?? 'modnet',
      'No background removal model available in registry.',
    );
  }

  // 2. Acquire segmentation pipeline from cache or download
  const loadedPipeline = await getPipeline(
    model.id,
    (info) => {
      if (isCancelled?.()) return;
      const isDownload = info.status === 'progress' || info.status === 'initiate' || (info as { status: string }).status === 'download';
      const totalBytes = info.total ?? (model ? model.approxDownloadBytes.webgpu : 0);
      const loadedBytes = info.loaded ?? (info.status === 'done' ? totalBytes : 0);
      const computedPercent = typeof info.progress === 'number'
        ? Math.round(info.progress)
        : totalBytes > 0 && loadedBytes > 0
          ? Math.round((loadedBytes / totalBytes) * 100)
          : info.status === 'done' ? 100 : 0;

      onProgress?.({
        stage: isDownload ? 'downloading' : 'initializing',
        percent: Math.min(100, Math.max(0, computedPercent)),
        loadedBytes,
        totalBytes,
      });
    },
    isCancelled,
  );

  let activePipeline = loadedPipeline.instance;
  let activeBackend = loadedPipeline.backend;

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  onProgress?.({
    stage: 'segmenting',
    percent: 50,
  });

  // 3. Construct RawImage input for segmentation pipeline
  const inputRaw = new RawImage(pixels, width, height, 4);

  // 4. Run inference with automatic runtime fallback to WASM if WebGPU fails during execution
  let output: unknown;
  let fallbackOccurred = false;
  try {
    output = await activePipeline(inputRaw);
  } catch (inferenceErr) {
    if (isCancelled?.()) throw new CancelledError();
    // WebGPU can initialize successfully and still fail when an operator exceeds
    // device shader limits. Retry this model on WASM, and use MODNet if that fails.
    console.warn(
      `[background] Inference failed on '${activeBackend}', falling back to WASM...`,
      inferenceErr,
    );
    fallbackOccurred = true;
    try {
      const fallbackEntry = await getPipeline(model.id, undefined, isCancelled, 'wasm');
      activePipeline = fallbackEntry.instance;
      activeBackend = 'wasm';
      output = await activePipeline(inputRaw);
    } catch (wasmErr) {
      if (isCancelled?.()) throw new CancelledError();
      if (model.id !== 'birefnet-lite') throw wasmErr;
      console.warn('[background] BiRefNet-lite failed on WASM; retrying with MODNet.', wasmErr);
      const fallbackEntry = await getPipeline('modnet', undefined, isCancelled);
      activePipeline = fallbackEntry.instance;
      activeBackend = fallbackEntry.backend;
      output = await activePipeline(inputRaw);
      model = fallbackEntry.model;
    }
  }

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  onProgress?.({
    stage: 'compositing',
    percent: 90,
  });

  // 5. Extract alpha mask
  let mask = extractMaskFromSegmentationOutput(output);

  // Resize mask to match original dimensions if output size differs
  if (mask.width !== width || mask.height !== height) {
    mask = await mask.resize(width, height);
  }

  // 6. Extract normalized 1-channel matte and composite in-place
  const rawMask = extractMaskChannel(mask, width, height);
  const finalPixels = compositeAlphaMask(pixels, width, height, rawMask);

  // 7. Output quality verification: guard against all-transparent failure
  const pixelCount = width * height;
  let transparentCount = 0;
  for (let i = 0; i < pixelCount; i++) {
    if (finalPixels[i * 4 + 3] < 10) transparentCount++;
  }
  if (transparentCount === pixelCount) {
    throw new Error('Background removal failed: output was entirely transparent (no subject detected).');
  }

  const durationMs = performance.now() - startTime;

  logAiExecution({
    task: 'background-removal',
    modelId: model.id,
    backend: activeBackend,
    width,
    height,
    megapixels: (width * height) / 1_000_000,
    durationMs,
    success: true,
    fallbackTriggered: fallbackOccurred,
  });

  onProgress?.({
    stage: 'complete',
    percent: 100,
  });

  return {
    width,
    height,
    pixels: finalPixels,
    mask: rawMask,
    durationMs,
  };
}
