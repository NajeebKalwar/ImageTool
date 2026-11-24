/**
 * The message contract between the page (main thread) and the image worker.
 *
 * Both sides import these types, so TypeScript checks the messages
 * exchanged between them.
 */

/**
 * Maximum image size accepted by worker image processing.
 * Measured as width × height in pixels (e.g. 5000 × 5000 = 25M pixels).
 */
export const MAX_PIXELS = 25_000_000;

/**
 * Maximum encoded input file size accepted by the worker (50 MB).
 * Prevents tab memory exhaustion on low-end devices.
 */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Supported output formats for Canvas export.
 */
export const SUPPORTED_FORMATS = [
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;

export type SupportedFormat = (typeof SUPPORTED_FORMATS)[number];

export type ResizeFit = 'contain' | 'cover' | 'fill' | 'inside';

export interface ResizeOptions {
  width?: number;
  height?: number;
  fit?: ResizeFit;
  format?: SupportedFormat;
  quality?: number; // 0.05 to 1.0 (for jpeg/webp)
}

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
    }
  | {
      type: 'resize';
      imageBuffer: ArrayBuffer;
      options: ResizeOptions;
    }
  | {
      type: 'convert';
      imageBuffer: ArrayBuffer;
      targetFormat: SupportedFormat;
      quality?: number;
    }
  | {
      type: 'ai_load';
      modelId: string;
    }
  | {
      type: 'ai_remove_background';
      modelId: string;
      width: number;
      height: number;
      pixels: ArrayBuffer;
    }
  | {
      type: 'ai_upscale';
      modelId: string;
      scale: number;
      width: number;
      height: number;
      pixels: ArrayBuffer;
      tileSize?: number;
      overlap?: number;
    }
  | {
      type: 'cancel';
      targetId: number;
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
  | {
      type: 'image_result';
      id: number;
      width: number;
      height: number;
      format: SupportedFormat;
      data: ArrayBuffer;
    }
  | {
      type: 'ai_loaded';
      id: number;
      modelId: string;
      backend: 'webgpu' | 'wasm';
    }
  | {
      type: 'ai_result';
      id: number;
      modelId: string;
      width: number;
      height: number;
      pixels: ArrayBuffer;
      mask?: ArrayBuffer;
      durationMs: number;
    }
  | {
      type: 'ai_progress';
      id: number;
      stage:
        | 'downloading'
        | 'initializing'
        | 'segmenting'
        | 'compositing'
        | 'tiling'
        | 'blending'
        | 'encoding'
        | 'preparing'
        | 'complete';
      percent: number;
      currentTile?: number;
      totalTiles?: number;
      loadedBytes?: number;
      totalBytes?: number;
    }
  | {
      type: 'ai_upscale_result';
      id: number;
      modelId: string;
      scale: number;
      width: number;
      height: number;
      pixels: ArrayBuffer;
      durationMs: number;
    }
  | {
      type: 'cancelled';
      id: number;
      targetId: number;
    }
  | { type: 'error'; id: number; message: string };

/**
 * Maps each request type to its successful response type.
 */
export type ReplyMap = {
  ping: Extract<WorkerToMain, { type: 'pong' }>;
  invert: Extract<WorkerToMain, { type: 'result' }>;
  resize: Extract<WorkerToMain, { type: 'image_result' }>;
  convert: Extract<WorkerToMain, { type: 'image_result' }>;
  ai_load: Extract<WorkerToMain, { type: 'ai_loaded' }>;
  ai_remove_background: Extract<WorkerToMain, { type: 'ai_result' }>;
  ai_upscale: Extract<WorkerToMain, { type: 'ai_upscale_result' }>;
  cancel: Extract<WorkerToMain, { type: 'cancelled' }>;
};
