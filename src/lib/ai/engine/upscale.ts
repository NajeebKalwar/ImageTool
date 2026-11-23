/**
 * Super-Resolution Inference Pipeline using Transformers.js with Tiling and Seam Blending.
 *
 * Implements memory-safe off-thread upscaling via overlapping Hann/cosine-weighted
 * tiles to prevent WebGPU/WASM out-of-memory crashes on large images.
 */

import { RawImage } from '@huggingface/transformers';
import { getPipeline } from './pipeline-cache';
import { getModelMetadata, findModelForTask } from '../registry';
import { detectWorkerBackend } from './device';
import { CancelledError, ModelLoadError, UnsupportedImageError } from '../errors';
import {
  calculateTiles,
  extractTileRgba,
  stitchTiles,
  type ScaledTileResult,
  type TileBounds,
} from '../tiling';

export interface UpscaleOptions {
  modelId?: string;
  scale?: number;
  tileSize?: number;
  overlap?: number;
  denoise?: boolean;
  faceEnhance?: boolean;
}

export interface UpscaleProgressInfo {
  stage: 'downloading' | 'initializing' | 'tiling' | 'blending' | 'complete';
  currentTile?: number;
  totalTiles?: number;
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
}

export interface UpscaleResult {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
  scale: number;
  durationMs: number;
}

/**
 * Pads an RGBA image tile so its width and height are divisible by `multiple` (e.g. 8).
 * Clamps edge pixels across padded regions to prevent boundary color bleeding.
 */
export function padTile(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  multiple: number = 8,
): { rgba: Uint8ClampedArray; width: number; height: number; padded: boolean } {
  const paddedW = Math.ceil(width / multiple) * multiple;
  const paddedH = Math.ceil(height / multiple) * multiple;

  if (paddedW === width && paddedH === height) {
    return { rgba, width, height, padded: false };
  }

  const paddedRgba = new Uint8ClampedArray(paddedW * paddedH * 4);

  for (let y = 0; y < paddedH; y++) {
    const srcY = Math.min(y, height - 1);
    const srcRowOffset = srcY * width * 4;
    const destRowOffset = y * paddedW * 4;

    // Copy valid columns
    paddedRgba.set(
      rgba.subarray(srcRowOffset, srcRowOffset + width * 4),
      destRowOffset,
    );

    // Replicate last pixel across right padding
    const lastPxOffset = srcRowOffset + (width - 1) * 4;
    const r = rgba[lastPxOffset];
    const g = rgba[lastPxOffset + 1];
    const b = rgba[lastPxOffset + 2];
    const a = rgba[lastPxOffset + 3];

    for (let x = width; x < paddedW; x++) {
      const idx = destRowOffset + x * 4;
      paddedRgba[idx] = r;
      paddedRgba[idx + 1] = g;
      paddedRgba[idx + 2] = b;
      paddedRgba[idx + 3] = a;
    }
  }

  return { rgba: paddedRgba, width: paddedW, height: paddedH, padded: true };
}

/**
 * Crops a padded RGBA image tile back to its exact target dimensions.
 */
export function cropTile(
  rgba: Uint8ClampedArray,
  paddedWidth: number,
  targetWidth: number,
  targetHeight: number,
): Uint8ClampedArray {
  const cropped = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const rowBytes = targetWidth * 4;

  for (let y = 0; y < targetHeight; y++) {
    const srcOffset = y * paddedWidth * 4;
    const destOffset = y * rowBytes;
    cropped.set(rgba.subarray(srcOffset, srcOffset + rowBytes), destOffset);
  }

  return cropped;
}

/**
 * Executes super-resolution over the given RGBA image pixels using tiled inference.
 */
export async function runUpscale(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: UpscaleOptions = {},
  onProgress?: (progress: UpscaleProgressInfo) => void,
  isCancelled?: () => boolean,
): Promise<UpscaleResult> {
  const startTime = performance.now();

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  if (width <= 0 || height <= 0 || pixels.length !== width * height * 4) {
    throw new UnsupportedImageError('Invalid image dimensions or pixel buffer size.');
  }

  // 1. Resolve model metadata
  const requestedScale = options.scale ?? 2;
  let model = options.modelId ? getModelMetadata(options.modelId) : null;
  if (!model) {
    model = findModelForTask('upscaling', { scale: requestedScale });
  }

  if (!model) {
    throw new ModelLoadError(
      options.modelId ?? `swin2sr-x${requestedScale}`,
      `No model found for scale ${requestedScale}x`,
    );
  }

  const effectiveScale = model.scale ?? requestedScale;

  // 2. Query device capabilities for optimal tile sizing
  const deviceCaps = await detectWorkerBackend();
  const defaultTileSize = deviceCaps.hasWebGPU
    ? model.tile?.webgpu ?? 256
    : model.tile?.wasm ?? 128;
  const tileSize = options.tileSize ?? defaultTileSize;
  const overlap = options.overlap ?? model.tile?.overlap ?? 32;

  // 3. Acquire pipeline from cache or download
  const { instance: pipeline } = await getPipeline(
    model.id,
    (info) => {
      if (isCancelled?.()) return;
      const isDownload = info.status === 'progress' || info.status === 'initiate' || (info as { status: string }).status === 'download';
      const totalBytes = info.total ?? model.approxDownloadBytes.webgpu;
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

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  // 4. Calculate overlapping tile grid
  const tiles: TileBounds[] = calculateTiles(width, height, tileSize, overlap);
  const scaledTiles: ScaledTileResult[] = [];

  // 5. Process each tile sequentially with cancellation check
  for (let i = 0; i < tiles.length; i++) {
    if (isCancelled?.()) {
      throw new CancelledError();
    }

    const tile = tiles[i];

    onProgress?.({
      stage: 'tiling',
      currentTile: i + 1,
      totalTiles: tiles.length,
      percent: Math.round(((i + 1) / tiles.length) * 100),
    });

    // Extract tile pixels
    const tileRgba = extractTileRgba(pixels, width, height, tile);

    // Pad tile to multiple of 8 if required for Swin window patch alignment
    const { rgba: inRgba, width: inW, height: inH, padded } = padTile(
      tileRgba,
      tile.width,
      tile.height,
      8,
    );

    // Construct RawImage for Transformers.js image-to-image pipeline
    const inputRaw = new RawImage(inRgba, inW, inH, 4);

    // Execute pipeline inference
    const outputRaw = await pipeline(inputRaw);

    if (isCancelled?.()) {
      throw new CancelledError();
    }

    const resultImage = Array.isArray(outputRaw) ? outputRaw[0] : outputRaw;
    const rawRgba = resultImage.channels === 4
      ? resultImage.data
      : resultImage.rgba().data;

    const targetTileW = Math.round(tile.width * effectiveScale);
    const targetTileH = Math.round(tile.height * effectiveScale);
    const paddedOutW = Math.round(inW * effectiveScale);

    const finalTileRgba = padded
      ? cropTile(new Uint8ClampedArray(rawRgba), paddedOutW, targetTileW, targetTileH)
      : new Uint8ClampedArray(rawRgba);

    scaledTiles.push({
      tile,
      scaledRgba: finalTileRgba,
      scale: effectiveScale,
    });
  }

  if (isCancelled?.()) {
    throw new CancelledError();
  }

  // 6. Stitch scaled tiles using 2D Hann/cosine seam blending
  onProgress?.({
    stage: 'blending',
    percent: 100,
  });

  const outWidth = Math.round(width * effectiveScale);
  const outHeight = Math.round(height * effectiveScale);
  const finalPixels = stitchTiles(outWidth, outHeight, scaledTiles, overlap);

  onProgress?.({
    stage: 'complete',
    percent: 100,
  });

  return {
    width: outWidth,
    height: outHeight,
    pixels: finalPixels,
    scale: effectiveScale,
    durationMs: performance.now() - startTime,
  };
}
