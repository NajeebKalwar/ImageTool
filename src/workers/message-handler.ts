import { invertRgba } from '../lib/image-ops';
import {
  MAX_PIXELS,
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
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0;

/**
 * Handles one incoming message and returns one response.
 *
 * This function contains no worker globals, so it can be tested in Node.
 */
export function handleMessage(data: unknown): HandlerResult {
  // 1. Validate the incoming message.
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
        if (
          !isPositiveInteger(width) ||
          !isPositiveInteger(height)
        ) {
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

      default:
        return fail(
          id,
          `Unknown message type: ${String(record.type)}`,
        );
    }
  } catch (error) {
    return fail(
      id,
      error instanceof Error
        ? error.message
        : 'Unexpected worker error.',
    );
  }
}