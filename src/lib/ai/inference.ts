/**
 * AI Inference Runner and Tensor Pipelines.
 *
 * Implements pre-processing, ONNX Runtime Web inference, and post-processing
 * for background removal and upscaling.
 */

import { getModelMetadata, type ExecutionBackend } from './model-registry';
import { calculateTiles, extractTileRgba, stitchTiles, type ScaledTileResult } from './tiling';

export interface PreprocessedTensor {
  data: Float32Array;
  dims: [number, number, number, number]; // [batch, channels, height, width]
}

export interface AiInferenceOptions {
  modelId: string;
  preferredBackend?: ExecutionBackend;
  threshold?: number; // matte binarization threshold (optional)
}

export interface AiInferenceResult {
  mask: Float32Array;
  width: number;
  height: number;
  backendUsed: ExecutionBackend;
  durationMs: number;
}

export interface AiUpscaleOptions {
  modelId: string;
  scale: number;
  tileSize?: number;
  overlap?: number;
  preferredBackend?: ExecutionBackend;
}

export interface AiProgressInfo {
  currentTile: number;
  totalTiles: number;
  percent: number;
  stage: 'preparing' | 'tiling' | 'blending' | 'complete';
}

export interface AiUpscaleResult {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
  scale: number;
  backendUsed: ExecutionBackend;
  durationMs: number;
}

/**
 * Normalizes RGBA pixel buffer into an NCHW Float32 tensor for vision models.
 * Standard ImageNet normalization:
 * mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225]
 */
export function preprocessRgbaToNchw(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  normalize: boolean = true,
): PreprocessedTensor {
  const pixelCount = width * height;
  const floatData = new Float32Array(3 * pixelCount);

  const mean = [0.485, 0.456, 0.406];
  const std = [0.229, 0.224, 0.225];

  const rOffset = 0;
  const gOffset = pixelCount;
  const bOffset = 2 * pixelCount;

  for (let i = 0; i < pixelCount; i++) {
    const r = rgba[i * 4] / 255.0;
    const g = rgba[i * 4 + 1] / 255.0;
    const b = rgba[i * 4 + 2] / 255.0;

    if (normalize) {
      floatData[rOffset + i] = (r - mean[0]) / std[0];
      floatData[gOffset + i] = (g - mean[1]) / std[1];
      floatData[bOffset + i] = (b - mean[2]) / std[2];
    } else {
      floatData[rOffset + i] = r;
      floatData[gOffset + i] = g;
      floatData[bOffset + i] = b;
    }
  }

  return {
    data: floatData,
    dims: [1, 3, height, width],
  };
}

/**
 * Applies a single-channel alpha matte (values 0.0 to 1.0) onto an RGBA pixel buffer.
 */
export function applyAlphaMatte(
  rgba: Uint8ClampedArray,
  matte: Float32Array,
  width: number,
  height: number,
): void {
  const count = width * height;
  for (let i = 0; i < count; i++) {
    const alphaMultiplier = Math.max(0, Math.min(1, matte[i]));
    rgba[i * 4 + 3] = Math.round(rgba[i * 4 + 3] * alphaMultiplier);
  }
}

/**
 * Abstract AI Pipeline interface enabling unit testing in Node without WebGPU/ONNX binaries.
 */
export interface AiPipeline {
  runBackgroundRemoval(
    imagePixels: Uint8ClampedArray,
    width: number,
    height: number,
    options: AiInferenceOptions,
  ): Promise<AiInferenceResult>;

  runUpscaling(
    imagePixels: Uint8ClampedArray,
    width: number,
    height: number,
    options: AiUpscaleOptions,
    onProgress?: (progress: AiProgressInfo) => void,
    isCancelled?: () => boolean,
  ): Promise<AiUpscaleResult>;
}

/**
 * Mock pipeline for unit testing inference logic in Node.js.
 */
export class MockAiPipeline implements AiPipeline {
  async runBackgroundRemoval(
    imagePixels: Uint8ClampedArray,
    width: number,
    height: number,
    options: AiInferenceOptions,
  ): Promise<AiInferenceResult> {
    const meta = getModelMetadata(options.modelId);
    if (!meta) throw new Error(`Unknown model: ${options.modelId}`);

    const count = width * height;
    const mask = new Float32Array(count);

    // Creates a test circle mask in the center
    const cx = width / 2;
    const cy = height / 2;
    const radius = Math.min(width, height) / 3;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const dist = Math.hypot(x - cx, y - cy);
        mask[y * width + x] = dist <= radius ? 1.0 : 0.0;
      }
    }

    applyAlphaMatte(imagePixels, mask, width, height);

    return {
      mask,
      width,
      height,
      backendUsed: options.preferredBackend || meta.preferredBackend || 'wasm',
      durationMs: 42,
    };
  }

  async runUpscaling(
    imagePixels: Uint8ClampedArray,
    width: number,
    height: number,
    options: AiUpscaleOptions,
    onProgress?: (progress: AiProgressInfo) => void,
    isCancelled?: () => boolean,
  ): Promise<AiUpscaleResult> {
    const meta = getModelMetadata(options.modelId);
    if (!meta) throw new Error(`Unknown model: ${options.modelId}`);

    const startTime = Date.now();
    const scale = options.scale;
    const outWidth = Math.round(width * scale);
    const outHeight = Math.round(height * scale);
    const tileSize = options.tileSize || 256;
    const overlap = options.overlap || 32;

    onProgress?.({
      currentTile: 0,
      totalTiles: 1,
      percent: 0,
      stage: 'preparing',
    });

    if (isCancelled?.()) throw new Error('Operation cancelled');

    const tiles = calculateTiles(width, height, tileSize, overlap);
    const scaledResults: ScaledTileResult[] = [];

    for (let i = 0; i < tiles.length; i++) {
      if (isCancelled?.()) throw new Error('Operation cancelled');

      const tile = tiles[i];
      const tileRgba = extractTileRgba(imagePixels, width, height, tile);

      // Mock upscale: nearest-neighbor replication
      const scaledW = Math.round(tile.width * scale);
      const scaledH = Math.round(tile.height * scale);
      const scaledRgba = new Uint8ClampedArray(scaledW * scaledH * 4);

      for (let sy = 0; sy < scaledH; sy++) {
        const srcY = Math.min(tile.height - 1, Math.floor(sy / scale));
        for (let sx = 0; sx < scaledW; sx++) {
          const srcX = Math.min(tile.width - 1, Math.floor(sx / scale));
          const srcIdx = (srcY * tile.width + srcX) * 4;
          const destIdx = (sy * scaledW + sx) * 4;

          scaledRgba[destIdx] = tileRgba[srcIdx];
          scaledRgba[destIdx + 1] = tileRgba[srcIdx + 1];
          scaledRgba[destIdx + 2] = tileRgba[srcIdx + 2];
          scaledRgba[destIdx + 3] = tileRgba[srcIdx + 3];
        }
      }

      scaledResults.push({
        tile,
        scaledRgba,
        scale,
      });

      onProgress?.({
        currentTile: i + 1,
        totalTiles: tiles.length,
        percent: Math.round(((i + 1) / tiles.length) * 100),
        stage: 'tiling',
      });
    }

    onProgress?.({
      currentTile: tiles.length,
      totalTiles: tiles.length,
      percent: 100,
      stage: 'blending',
    });

    const outputPixels = stitchTiles(outWidth, outHeight, scaledResults, overlap);

    onProgress?.({
      currentTile: tiles.length,
      totalTiles: tiles.length,
      percent: 100,
      stage: 'complete',
    });

    return {
      pixels: outputPixels,
      width: outWidth,
      height: outHeight,
      scale,
      backendUsed: options.preferredBackend || meta.preferredBackend || 'wasm',
      durationMs: Date.now() - startTime,
    };
  }
}
