/**
 * The message contract between the page (main thread) and the image worker.
 *
 * Both sides import these types, so TypeScript checks the messages
 * exchanged between them.
 */

/**
 * Maximum image size accepted by our Phase 2 worker demonstration.
 * Measured as width × height in pixels.
 */
export const MAX_PIXELS = 25_000_000;

/**
 * What the main thread asks the worker to do.
 * The worker client will add the request ID.
 */
export type RequestBody =
  | { type: 'ping' }
  | {
      type: 'invert';
      width: number;
      height: number;
      pixels: ArrayBuffer;
    };

/**
 * The complete message sent from the main thread to the worker.
 */
export type MainToWorker = RequestBody & {
  id: number;
};

/**
 * Messages the worker can send back to the main thread.
 */
export type WorkerToMain =
  | { type: 'pong'; id: number }
  | {
      type: 'result';
      id: number;
      width: number;
      height: number;
      pixels: ArrayBuffer;
    }
  | { type: 'error'; id: number; message: string };

/**
 * Maps each request type to its successful response type.
 */
export type ReplyMap = {
  ping: Extract<WorkerToMain, { type: 'pong' }>;
  invert: Extract<WorkerToMain, { type: 'result' }>;
};