import {
  isSupportedFormat,
  normalizeQuality,
  validateImageBuffer,
  type ImageEngine,
} from '../lib/canvas-ops';
import { invertRgba } from '../lib/image-ops';
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
 * so it remains fully testable in Node without browser globals.
 */
export async function handleMessage(
  data: unknown,
  engine?: ImageEngine,
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

        const expectedBytes = width * height * 4;

        if (pixels.byteLength !== expectedBytes) {
          return fail(
            id,
            `Expected ${expectedBytes} bytes of RGBA data, got ${pixels.byteLength}.`,
          );
        }

        // 6. Process the received pixels in place.
        invertRgba(new Uint8ClampedArray(pixels));

        // 7. Return the same buffer as transferable data.
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
          return fail(id, 'Resize options must be an object.');
        }

        const resizeOpts = options as ResizeOptions;

        if (resizeOpts.width !== undefined && !isPositiveInteger(resizeOpts.width)) {
          return fail(id, 'Target width must be a positive integer.');
        }

        if (resizeOpts.height !== undefined && !isPositiveInteger(resizeOpts.height)) {
          return fail(id, 'Target height must be a positive integer.');
        }

        if (resizeOpts.width && resizeOpts.height && resizeOpts.width * resizeOpts.height > MAX_PIXELS) {
          return fail(
            id,
            `Target dimensions exceed maximum pixel limit: ${resizeOpts.width * resizeOpts.height} > ${MAX_PIXELS}.`,
          );
        }

        if (resizeOpts.format !== undefined && !isSupportedFormat(resizeOpts.format)) {
          return fail(id, `Unsupported output format: ${String(resizeOpts.format)}`);
        }

        if (!engine) {
          return fail(id, 'Image processing engine not available.');
        }

        const res = await engine.process(imageBuffer, resizeOpts);

        return {
          response: {
            type: 'image_result',
            id,
            width: res.width,
            height: res.height,
            format: res.format,
            data: res.data,
          },
          transfer: [res.data],
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

        if (!engine) {
          return fail(id, 'Image processing engine not available.');
        }

        const res = await engine.process(imageBuffer, {
          format: targetFormat as SupportedFormat,
          quality: normalizeQuality(quality),
        });

        return {
          response: {
            type: 'image_result',
            id,
            width: res.width,
            height: res.height,
            format: res.format,
            data: res.data,
          },
          transfer: [res.data],
        };
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
