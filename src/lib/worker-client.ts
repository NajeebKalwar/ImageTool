/**
 * Main-thread client for the image processing Web Worker.
 *
 * Sends typed messages, tracks in-flight requests with Promise-based
 * request IDs, handles streaming progress events, cancellation signals,
 * timeouts, and worker crashes.
 */

import type {
  MainToWorker,
  ReplyMap,
  RequestBody,
  ResizeOptions,
  SupportedFormat,
  WorkerToMain,
} from './worker-protocol';

// ---------------------------------------------------------------------------
// WorkerLike — testable abstraction over the real Worker
// ---------------------------------------------------------------------------

/**
 * Minimal interface a worker must satisfy.
 *
 * Both the real `Worker` and our test stub implement this, keeping
 * `ImageWorkerClient` fully testable in Node without jsdom.
 */
export interface WorkerLike {
  postMessage(message: MainToWorker, transfer: Transferable[]): void;
  addEventListener(type: 'message', handler: (event: { data: WorkerToMain }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;
  removeEventListener(type: 'message', handler: (event: { data: WorkerToMain }) => void): void;
  removeEventListener(type: 'error', handler: (event: unknown) => void): void;
  terminate(): void;
}

// ---------------------------------------------------------------------------
// Pending request tracking
// ---------------------------------------------------------------------------

export type ProgressCallback = (progress: Extract<WorkerToMain, { type: 'ai_progress' }>) => void;

interface PendingRequest<T extends keyof ReplyMap = keyof ReplyMap> {
  resolve: (value: ReplyMap[T]) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  abortListener?: () => void;
}

// ---------------------------------------------------------------------------
// ImageWorkerClient
// ---------------------------------------------------------------------------

/** Default timeout for worker requests (ms). */
const DEFAULT_TIMEOUT_MS = 60_000;

export class ImageWorkerClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private terminated = false;

  private readonly onMessage: (event: { data: WorkerToMain }) => void;
  private readonly onError: (event: unknown) => void;

  constructor(
    private readonly worker: WorkerLike,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    // Bind event handlers so we can remove them on terminate.
    this.onMessage = this.handleMessage.bind(this);
    this.onError = this.handleError.bind(this);

    this.worker.addEventListener('message', this.onMessage);
    this.worker.addEventListener('error', this.onError);
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Send a typed request to the worker and await its response.
   *
   * The returned promise rejects if:
   * - the worker replies with `{ type: 'error' }`,
   * - the request times out,
   * - the worker fires an error event,
   * - the client has already been terminated,
   * - the request is aborted via AbortSignal.
   */
  request<T extends RequestBody['type']>(
    body: Extract<RequestBody, { type: T }>,
    transfer: Transferable[] = [],
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
  ): Promise<ReplyMap[T]> {
    if (this.terminated) {
      return Promise.reject(new Error('Worker client has been terminated.'));
    }

    if (signal?.aborted) {
      return Promise.reject(new Error('Operation cancelled'));
    }

    const id = this.nextId++;

    return new Promise<ReplyMap[T]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cleanupRequest(id);
        reject(new Error(`Worker request ${id} timed out after ${this.timeoutMs}ms.`));
      }, this.timeoutMs);

      let abortListener: (() => void) | undefined;
      if (signal) {
        abortListener = () => {
          this.cancel(id).catch(() => {});
          this.cleanupRequest(id);
          reject(new Error('Operation cancelled'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }

      this.pending.set(id, {
        resolve: resolve as PendingRequest['resolve'],
        reject,
        timer,
        onProgress,
        signal,
        abortListener,
      });

      const message = { ...body, id } as MainToWorker;
      this.worker.postMessage(message, transfer);
    });
  }

  /**
   * Convenience: send a ping and wait for pong.
   */
  ping(): Promise<ReplyMap['ping']> {
    return this.request({ type: 'ping' });
  }

  /**
   * Convenience: send pixel data for inversion.
   */
  invert(
    width: number,
    height: number,
    pixels: ArrayBuffer,
  ): Promise<ReplyMap['invert']> {
    return this.request(
      { type: 'invert', width, height, pixels },
      [pixels],
    );
  }

  /**
   * Convenience: resize an encoded image buffer using the worker's OffscreenCanvas.
   * Transfers the buffer to avoid copying memory across threads.
   */
  resize(
    imageBuffer: ArrayBuffer,
    options: ResizeOptions,
  ): Promise<ReplyMap['resize']> {
    return this.request(
      { type: 'resize', imageBuffer, options },
      [imageBuffer],
    );
  }

  /**
   * Convenience: convert an encoded image buffer to target format.
   * Transfers the buffer to avoid copying memory across threads.
   */
  convert(
    imageBuffer: ArrayBuffer,
    targetFormat: SupportedFormat,
    quality?: number,
  ): Promise<ReplyMap['convert']> {
    return this.request(
      { type: 'convert', imageBuffer, targetFormat, quality },
      [imageBuffer],
    );
  }

  /**
   * Convenience: load an AI model in the worker using WebGPU or WASM fallback.
   */
  loadAiModel(modelId: string): Promise<ReplyMap['ai_load']> {
    return this.request({ type: 'ai_load', modelId });
  }

  /**
   * Convenience: run local background removal on image pixels in the worker.
   * Transfers pixel buffer zero-copy.
   */
  removeBackground(
    modelId: string,
    width: number,
    height: number,
    pixels: ArrayBuffer,
  ): Promise<ReplyMap['ai_remove_background']> {
    return this.request(
      { type: 'ai_remove_background', modelId, width, height, pixels },
      [pixels],
    );
  }

  /**
   * Convenience: run AI super-resolution / upscaling on image pixels in the worker.
   * Supports streaming progress events and cancellation via AbortSignal.
   */
  upscaleImage(
    modelId: string,
    scale: number,
    width: number,
    height: number,
    pixels: ArrayBuffer,
    options?: { tileSize?: number; overlap?: number },
    signal?: AbortSignal,
    onProgress?: ProgressCallback,
  ): Promise<ReplyMap['ai_upscale']> {
    return this.request(
      {
        type: 'ai_upscale',
        modelId,
        scale,
        width,
        height,
        pixels,
        tileSize: options?.tileSize,
        overlap: options?.overlap,
      },
      [pixels],
      signal,
      onProgress,
    );
  }

  /**
   * Request cancellation of a pending worker request.
   */
  cancel(targetId: number): Promise<ReplyMap['cancel']> {
    return this.request({ type: 'cancel', targetId });
  }

  /**
   * Terminate the worker and reject all pending requests.
   *
   * Safe to call multiple times.
   */
  terminate(): void {
    if (this.terminated) return;
    this.terminated = true;

    this.worker.removeEventListener('message', this.onMessage);
    this.worker.removeEventListener('error', this.onError);
    this.worker.terminate();

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.abortListener) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }
      entry.reject(new Error(`Worker terminated while request ${id} was pending.`));
    }
    this.pending.clear();
  }

  /**
   * Whether `terminate()` has been called.
   */
  get isTerminated(): boolean {
    return this.terminated;
  }

  /**
   * Number of in-flight requests.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  // -----------------------------------------------------------------------
  // Internal event handlers
  // -----------------------------------------------------------------------

  private cleanupRequest(id: number): PendingRequest | undefined {
    const entry = this.pending.get(id);
    if (entry) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.abortListener) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }
      this.pending.delete(id);
    }
    return entry;
  }

  private handleMessage(event: { data: WorkerToMain }): void {
    const msg = event.data;

    // Handle streaming progress events without resolving the pending request
    if (msg.type === 'ai_progress') {
      const entry = this.pending.get(msg.id);
      if (entry) {
        entry.onProgress?.(msg);
        // Refresh timeout timer as long as progress is actively reported
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          this.cleanupRequest(msg.id);
          entry.reject(new Error(`Worker request ${msg.id} timed out after ${this.timeoutMs}ms.`));
        }, this.timeoutMs);
      }
      return;
    }

    const entry = this.cleanupRequest(msg.id);
    if (!entry) return; // stale or unexpected message

    if (msg.type === 'error') {
      entry.reject(new Error(msg.message));
    } else {
      entry.resolve(msg as ReplyMap[keyof ReplyMap]);
    }
  }

  private handleError(_event: unknown): void {
    // A worker `error` event means something went very wrong.
    // Reject all pending requests.
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.abortListener) {
        entry.signal.removeEventListener('abort', entry.abortListener);
      }
      entry.reject(new Error(`Worker error while request ${id} was pending.`));
    }
    this.pending.clear();
  }
}
