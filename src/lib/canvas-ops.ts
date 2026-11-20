/**
 * Canvas operations and dimension calculations for image resizing and format conversion.
 */

import {
  MAX_FILE_BYTES,
  MAX_PIXELS,
  SUPPORTED_FORMATS,
  type ResizeOptions,
  type SupportedFormat,
} from './worker-protocol';

/**
 * Validates whether a given MIME type is supported for output.
 */
export function isSupportedFormat(value: unknown): value is SupportedFormat {
  return typeof value === 'string' && (SUPPORTED_FORMATS as readonly string[]).includes(value);
}

/**
 * Normalizes quality value to a float between 0.05 and 1.0.
 * Default is 0.85 for lossy formats (JPEG/WebP).
 */
export function normalizeQuality(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0.85;
  }
  return Math.min(1.0, Math.max(0.05, value));
}

/**
 * Calculates target dimensions preserving aspect ratio based on options and fit mode.
 */
export function calculateTargetDimensions(
  srcWidth: number,
  srcHeight: number,
  options: ResizeOptions,
): { width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new Error('Source dimensions must be positive integers.');
  }

  const { width: targetWidth, height: targetHeight, fit = 'contain' } = options;

  if (!targetWidth && !targetHeight) {
    return { width: srcWidth, height: srcHeight };
  }

  // Width only
  if (targetWidth && !targetHeight) {
    const scale = targetWidth / srcWidth;
    const computedHeight = Math.max(1, Math.round(srcHeight * scale));
    return { width: targetWidth, height: computedHeight };
  }

  // Height only
  if (!targetWidth && targetHeight) {
    const scale = targetHeight / srcHeight;
    const computedWidth = Math.max(1, Math.round(srcWidth * scale));
    return { width: computedWidth, height: targetHeight };
  }

  // Both width and height provided
  const tw = targetWidth as number;
  const th = targetHeight as number;

  switch (fit) {
    case 'fill':
      return { width: tw, height: th };

    case 'inside': {
      const scale = Math.min(1, Math.min(tw / srcWidth, th / srcHeight));
      return {
        width: Math.max(1, Math.round(srcWidth * scale)),
        height: Math.max(1, Math.round(srcHeight * scale)),
      };
    }

    case 'cover': {
      const scale = Math.max(tw / srcWidth, th / srcHeight);
      return {
        width: Math.max(1, Math.round(srcWidth * scale)),
        height: Math.max(1, Math.round(srcHeight * scale)),
      };
    }

    case 'contain':
    default: {
      const scale = Math.min(tw / srcWidth, th / srcHeight);
      return {
        width: Math.max(1, Math.round(srcWidth * scale)),
        height: Math.max(1, Math.round(srcHeight * scale)),
      };
    }
  }
}

/**
 * Validates basic buffer constraints (presence, size limit).
 */
export function validateImageBuffer(buffer: unknown): asserts buffer is ArrayBuffer {
  if (!(buffer instanceof ArrayBuffer)) {
    throw new Error('Image data must be an ArrayBuffer.');
  }

  if (buffer.byteLength === 0) {
    throw new Error('Image data cannot be empty.');
  }

  if (buffer.byteLength > MAX_FILE_BYTES) {
    throw new Error(
      `Image file size exceeds limit: ${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB (limit: ${MAX_FILE_BYTES / 1024 / 1024}MB).`,
    );
  }
}

/**
 * Engine interface for decoding, drawing, and encoding images.
 * Abstracted so pure logic can be tested in Node without browser Canvas globals.
 */
export interface ImageEngine {
  process(
    buffer: ArrayBuffer,
    options: ResizeOptions,
  ): Promise<{ data: ArrayBuffer; width: number; height: number; format: SupportedFormat }>;
}

/**
 * Real browser/worker implementation using `createImageBitmap` and `OffscreenCanvas`.
 */
export class BrowserCanvasEngine implements ImageEngine {
  async process(
    buffer: ArrayBuffer,
    options: ResizeOptions,
  ): Promise<{ data: ArrayBuffer; width: number; height: number; format: SupportedFormat }> {
    validateImageBuffer(buffer);

    const blob = new Blob([buffer]);
    const bitmap = await createImageBitmap(blob);

    try {
      const { width: srcWidth, height: srcHeight } = bitmap;

      const targetDim = calculateTargetDimensions(srcWidth, srcHeight, options);
      const { width, height } = targetDim;

      if (width * height > MAX_PIXELS) {
        throw new Error(
          `Target dimensions too large: ${width} × ${height} (${width * height} pixels, limit ${MAX_PIXELS}).`,
        );
      }

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        throw new Error('Failed to acquire 2D rendering context from OffscreenCanvas.');
      }

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);

      const format: SupportedFormat = options.format && isSupportedFormat(options.format)
        ? options.format
        : 'image/png';
      const quality = normalizeQuality(options.quality);

      const outputBlob = await canvas.convertToBlob({ type: format, quality });
      const data = await outputBlob.arrayBuffer();

      return { data, width, height, format };
    } finally {
      bitmap.close();
    }
  }
}
