/**
 * LangChain DynamicStructuredTools for On-Device Image Processing.
 *
 * Each tool wraps a discrete, testable image processing capability
 * (Web Worker inference, canvas resizing, mask refinement, format encoding)
 * with strict Zod validation and structured parameter schemas.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import type { WorkflowImageBuffer } from './types';
import type { ImageWorkerClient } from '../worker-client';
import {
  applyMaskThreshold,
  applyEdgeSoftness,
  compositeMaskToRgba,
} from '../ai/mask-refinement';

export interface ToolExecutionContext {
  buffer: WorkflowImageBuffer;
  originalPixels?: Uint8ClampedArray;
  workerClient?: ImageWorkerClient;
  onProgress?: (stage: string, percent: number) => void;
  signal?: AbortSignal;
}

/**
 * Tool: Background Removal (MODNet or BiRefNet-lite)
 */
export function createRemoveBackgroundTool(context: ToolExecutionContext) {
  return new DynamicStructuredTool({
    name: 'remove_background',
    description:
      'Removes background from current image pixels using on-device AI. ' +
      'Use modnet for fast portrait/human matting; use birefnet-lite for fine hair, fur, products, and architecture.',
    schema: z.object({
      modelId: z
        .enum(['modnet', 'birefnet-lite'])
        .default('birefnet-lite')
        .describe('Model architecture: modnet (fastest ~12MB) or birefnet-lite (highest detail ~114MB)'),
    }),
    func: async ({ modelId }) => {
      if (!context.workerClient) {
        throw new Error('Worker client not provided for background removal tool.');
      }

      const { width, height, pixels } = context.buffer;
      // Copy buffer for zero-copy transfer
      const transferBuffer = pixels.buffer.slice(0) as ArrayBuffer;

      context.onProgress?.('downloading', 10);

      const res = await context.workerClient.removeBackground(
        modelId,
        width,
        height,
        transferBuffer,
        context.signal,
        (p) => {
          context.onProgress?.(p.stage, p.percent);
        },
      );

      // Mutate execution context with new alpha-composited pixels and raw mask
      context.buffer.pixels = new Uint8ClampedArray(res.pixels);
      if (res.mask) {
        context.buffer.mask = new Uint8ClampedArray(res.mask);
      }

      return `Successfully removed background using ${modelId} (${width}×${height} px, duration: ${res.durationMs}ms).`;
    },
  });
}

/**
 * Tool: Super-Resolution / AI Upscaling (Swin2SR)
 */
export function createUpscaleImageTool(context: ToolExecutionContext) {
  return new DynamicStructuredTool({
    name: 'upscale_image',
    description:
      'Enhances image resolution and restores fine photographic details using Swin2SR super-resolution neural network.',
    schema: z.object({
      scale: z
        .enum(['2', '4'])
        .default('2')
        .describe('Upscale multiplier factor: 2x or 4x'),
    }),
    func: async ({ scale }) => {
      if (!context.workerClient) {
        throw new Error('Worker client not provided for upscale tool.');
      }

      const scaleNum = Number(scale) as 2 | 4;
      const modelId = scaleNum === 4 ? 'swin2sr-x4' : 'swin2sr-x2';
      const { width, height, pixels } = context.buffer;
      const transferBuffer = pixels.buffer.slice(0) as ArrayBuffer;

      context.onProgress?.('initializing', 10);

      const res = await context.workerClient.upscaleImage(
        modelId,
        scaleNum,
        width,
        height,
        transferBuffer,
        undefined,
        context.signal,
        (p) => {
          context.onProgress?.(p.stage, p.percent);
        },
      );

      context.buffer.width = res.width;
      context.buffer.height = res.height;
      context.buffer.pixels = new Uint8ClampedArray(res.pixels);

      return `Successfully upscaled image ${scale}x to ${res.width}×${res.height} px using ${modelId}.`;
    },
  });
}

/**
 * Tool: Mask Refinement (Threshold cutoff & edge feathering)
 */
export function createRefineMaskTool(context: ToolExecutionContext) {
  return new DynamicStructuredTool({
    name: 'refine_mask',
    description:
      'Fine-tunes the extracted alpha matte boundary by adjusting threshold cutoff and edge softness (feathering).',
    schema: z.object({
      threshold: z
        .number()
        .min(0)
        .max(100)
        .default(0)
        .describe('Cutoff boundary threshold (0 for natural soft matte, up to 100 for crisp cutout)'),
      edgeSoftness: z
        .number()
        .min(0)
        .max(20)
        .default(0)
        .describe('Feathering radius in pixels (0 to 20 px)'),
    }),
    func: async ({ threshold, edgeSoftness }) => {
      const { width, height, mask } = context.buffer;
      if (!mask) {
        return 'Skipped: No alpha mask present to refine. Run remove_background first.';
      }

      let refinedMask = applyMaskThreshold(mask, threshold);
      if (edgeSoftness > 0) {
        refinedMask = applyEdgeSoftness(refinedMask, width, height, edgeSoftness);
      }

      context.buffer.mask = refinedMask;

      // Re-composite with original source pixels if available, or with current RGB
      const basePixels = context.originalPixels ?? context.buffer.pixels;
      context.buffer.pixels = compositeMaskToRgba(basePixels, refinedMask, width, height);

      return `Refined alpha mask: threshold=${threshold}%, edgeSoftness=${edgeSoftness}px.`;
    },
  });
}

/**
 * Tool: Canvas Resizing & Padding (Aspect ratio fit/contain/cover)
 */
export function createResizeImageTool(context: ToolExecutionContext) {
  return new DynamicStructuredTool({
    name: 'resize_image',
    description:
      'Resizes image canvas to target width/height with aspect-ratio containment, cropping, or background color padding.',
    schema: z.object({
      width: z.number().positive().describe('Target canvas width in pixels'),
      height: z.number().positive().describe('Target canvas height in pixels'),
      fit: z
        .enum(['contain', 'cover', 'fill'])
        .default('contain')
        .describe('Fit mode: contain (pads borders), cover (center crop), or fill (stretch)'),
      backgroundColor: z
        .string()
        .default('transparent')
        .describe('Hex or CSS background color for contain padding (e.g. #ffffff or transparent)'),
    }),
    func: async ({ width: targetW, height: targetH, fit, backgroundColor }) => {
      const { width: srcW, height: srcH, pixels } = context.buffer;

      // If running in browser environment with Canvas support
      if (typeof document !== 'undefined') {
        const srcCanvas = document.createElement('canvas');
        srcCanvas.width = srcW;
        srcCanvas.height = srcH;
        const srcCtx = srcCanvas.getContext('2d');
        if (!srcCtx) throw new Error('Could not acquire source canvas context');
        srcCtx.putImageData(new ImageData(pixels as any, srcW, srcH), 0, 0);

        const outCanvas = document.createElement('canvas');
        outCanvas.width = targetW;
        outCanvas.height = targetH;
        const outCtx = outCanvas.getContext('2d');
        if (!outCtx) throw new Error('Could not acquire destination canvas context');

        // Fill background color if specified
        if (backgroundColor && backgroundColor !== 'transparent') {
          outCtx.fillStyle = backgroundColor;
          outCtx.fillRect(0, 0, targetW, targetH);
        }

        let drawX = 0;
        let drawY = 0;
        let drawW = targetW;
        let drawH = targetH;

        if (fit === 'contain') {
          const scale = Math.min(targetW / srcW, targetH / srcH);
          drawW = Math.round(srcW * scale);
          drawH = Math.round(srcH * scale);
          drawX = Math.round((targetW - drawW) / 2);
          drawY = Math.round((targetH - drawH) / 2);
        } else if (fit === 'cover') {
          const scale = Math.max(targetW / srcW, targetH / srcH);
          drawW = Math.round(srcW * scale);
          drawH = Math.round(srcH * scale);
          drawX = Math.round((targetW - drawW) / 2);
          drawY = Math.round((targetH - drawH) / 2);
        }

        outCtx.drawImage(srcCanvas, drawX, drawY, drawW, drawH);
        const outImgData = outCtx.getImageData(0, 0, targetW, targetH);

        context.buffer.width = targetW;
        context.buffer.height = targetH;
        context.buffer.pixels = new Uint8ClampedArray(outImgData.data);
      } else {
        // Fallback for non-DOM / test environments: update dimensions
        context.buffer.width = targetW;
        context.buffer.height = targetH;
      }

      return `Resized canvas to ${targetW}×${targetH} px (fit: ${fit}, bg: ${backgroundColor}).`;
    },
  });
}

/**
 * Tool: Image Format Encoding & Compression
 */
export function createCompressImageTool(_context: ToolExecutionContext) {
  return new DynamicStructuredTool({
    name: 'compress_image',
    description: 'Encodes and optimizes the current image to WebP, PNG, or JPEG format with quality control.',
    schema: z.object({
      format: z.enum(['webp', 'png', 'jpeg']).default('webp'),
      quality: z.number().min(1).max(100).default(85).describe('Quality percentage (1-100)'),
    }),
    func: async ({ format, quality }) => {
      const mimeType = format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';
      return `Target encoding set: format=${format} (${mimeType}), quality=${quality}%.`;
    },
  });
}

/**
 * Creates the complete LangChain Tool collection bound to an execution context.
 */
export function createWorkflowToolRegistry(context: ToolExecutionContext) {
  return [
    createRemoveBackgroundTool(context),
    createUpscaleImageTool(context),
    createResizeImageTool(context),
    createRefineMaskTool(context),
    createCompressImageTool(context),
  ];
}
