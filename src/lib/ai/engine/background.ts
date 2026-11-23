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
 * Composites the extracted alpha mask into the source RGBA image buffer.
 * Preserves RGB channels while updating the alpha channel.
 */
export function compositeAlphaMask(
  sourceRgba: Uint8ClampedArray,
  width: number,
  height: number,
  mask: RawImage,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const result = new Uint8ClampedArray(pixelCount * 4);
  const maskData = mask.data;
  const maskChannels = mask.channels;

  for (let i = 0; i < pixelCount; i++) {
    const pxOffset = i * 4;
    const maskOffset = i * maskChannels;

    result[pxOffset] = sourceRgba[pxOffset];         // R
    result[pxOffset + 1] = sourceRgba[pxOffset + 1]; // G
    result[pxOffset + 2] = sourceRgba[pxOffset + 2]; // B

    // Composite mask value with any pre-existing source alpha channel
    const srcA = sourceRgba[pxOffset + 3];
    const maskA = maskData[maskOffset];
    result[pxOffset + 3] = Math.round((srcA * maskA) / 255);
  }

  return result;
}

/**
 * Executes on-device AI background removal.
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
  const { instance: pipeline } = await getPipeline(
    model.id,
    (info) => {
      if (isCancelled?.()) return;
      const percent = typeof info.progress === 'number'
        ? Math.round(info.progress)
        : info.status === 'done' ? 100 : 0;
      onProgress?.({
        stage: info.status === 'progress' ? 'downloading' : 'initializing',
        percent,
        loadedBytes: info.loaded,
        totalBytes: info.total,
      });
    },
    isCancelled,
  );

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  onProgress?.({
    stage: 'segmenting',
    percent: 50,
  });

  // 3. Construct RawImage input for segmentation pipeline
  const inputRaw = new RawImage(pixels, width, height, 4);

  // 4. Run inference
  const output = await pipeline(inputRaw);

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

  // 6. Composite alpha mask with source RGBA pixels
  const finalPixels = compositeAlphaMask(pixels, width, height, mask);

  onProgress?.({
    stage: 'complete',
    percent: 100,
  });

  return {
    width,
    height,
    pixels: finalPixels,
    durationMs: performance.now() - startTime,
  };
}
