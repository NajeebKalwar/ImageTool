import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageWorkerClient, type WorkerLike } from './worker-client';
import type { MainToWorker, WorkerToMain } from './worker-protocol';

// ---------------------------------------------------------------------------
// Fake Worker — a minimal in-memory stub
// ---------------------------------------------------------------------------

type MessageHandler = (event: { data: WorkerToMain }) => void;
type ErrorHandler = (event: unknown) => void;

class FakeWorker implements WorkerLike {
  /** Messages posted by the client. */
  readonly posted: MainToWorker[] = [];

  private messageHandlers: MessageHandler[] = [];
  private errorHandlers: ErrorHandler[] = [];

  terminated = false;

  postMessage(message: MainToWorker, _transfer: Transferable[]): void {
    this.posted.push(message);
  }

  addEventListener(type: 'message', handler: MessageHandler): void;
  addEventListener(type: 'error', handler: ErrorHandler): void;
  addEventListener(type: string, handler: MessageHandler | ErrorHandler): void {
    if (type === 'message') this.messageHandlers.push(handler as MessageHandler);
    if (type === 'error') this.errorHandlers.push(handler as ErrorHandler);
  }

  removeEventListener(type: 'message', handler: MessageHandler): void;
  removeEventListener(type: 'error', handler: ErrorHandler): void;
  removeEventListener(type: string, handler: MessageHandler | ErrorHandler): void {
    if (type === 'message') {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    }
    if (type === 'error') {
      this.errorHandlers = this.errorHandlers.filter((h) => h !== handler);
    }
  }

  terminate(): void {
    this.terminated = true;
  }

  // --- Test helpers (not part of WorkerLike) ---

  /** Simulate the worker sending a response. */
  respond(data: WorkerToMain): void {
    for (const handler of this.messageHandlers) {
      handler({ data });
    }
  }

  /** Simulate a worker error event. */
  emitError(event: unknown = new Error('Worker crashed')): void {
    for (const handler of this.errorHandlers) {
      handler(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ImageWorkerClient', () => {
  let worker: FakeWorker;
  let client: ImageWorkerClient;

  beforeEach(() => {
    vi.useFakeTimers();
    worker = new FakeWorker();
    client = new ImageWorkerClient(worker, 5_000); // 5s timeout for tests
  });

  afterEach(() => {
    client.terminate();
    vi.useRealTimers();
  });

  // -----------------------------------------------------------------------
  // 1 — ping / pong round-trip
  // -----------------------------------------------------------------------
  it('resolves a ping request with pong', async () => {
    const promise = client.ping();

    // The client should have posted a message with an id.
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0].type).toBe('ping');
    const sentId = worker.posted[0].id;

    // Simulate the worker responding.
    worker.respond({ type: 'pong', id: sentId });

    const result = await promise;
    expect(result).toEqual({ type: 'pong', id: sentId });
    expect(client.pendingCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 2 — Request IDs are unique and incrementing
  // -----------------------------------------------------------------------
  it('assigns incrementing request IDs', async () => {
    // Suppress the unhandled rejections from terminate() in afterEach.
    const p1 = client.ping().catch(() => {});
    const p2 = client.ping().catch(() => {});

    expect(worker.posted).toHaveLength(2);
    expect(worker.posted[0].id).toBe(1);
    expect(worker.posted[1].id).toBe(2);

    // Resolve both so afterEach terminate() has nothing to reject.
    worker.respond({ type: 'pong', id: 1 });
    worker.respond({ type: 'pong', id: 2 });
    await p1;
    await p2;
  });

  // -----------------------------------------------------------------------
  // 3 — Error responses reject the promise
  // -----------------------------------------------------------------------
  it('rejects when the worker replies with an error', async () => {
    const promise = client.ping();
    const sentId = worker.posted[0].id;

    worker.respond({ type: 'error', id: sentId, message: 'Something broke' });

    await expect(promise).rejects.toThrow('Something broke');
    expect(client.pendingCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 4 — Timeout rejects the promise
  // -----------------------------------------------------------------------
  it('rejects when a request times out', async () => {
    const promise = client.ping();

    // Advance past the timeout.
    vi.advanceTimersByTime(6_000);

    await expect(promise).rejects.toThrow(/timed out/);
    expect(client.pendingCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 5 — Worker error event rejects all pending
  // -----------------------------------------------------------------------
  it('rejects all pending requests on worker error event', async () => {
    const p1 = client.ping();
    const p2 = client.ping();
    expect(client.pendingCount).toBe(2);

    worker.emitError();

    await expect(p1).rejects.toThrow(/Worker error/);
    await expect(p2).rejects.toThrow(/Worker error/);
    expect(client.pendingCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 6 — terminate() rejects pending and prevents new requests
  // -----------------------------------------------------------------------
  it('rejects pending requests on terminate and blocks new ones', async () => {
    const promise = client.ping();

    client.terminate();

    await expect(promise).rejects.toThrow(/terminated/i);
    expect(client.isTerminated).toBe(true);
    expect(worker.terminated).toBe(true);

    // New requests after terminate should reject immediately.
    await expect(client.ping()).rejects.toThrow(/terminated/i);
  });

  // -----------------------------------------------------------------------
  // 7 — terminate() is idempotent
  // -----------------------------------------------------------------------
  it('allows multiple terminate() calls without throwing', () => {
    client.terminate();
    expect(() => client.terminate()).not.toThrow();
    expect(client.isTerminated).toBe(true);
  });

  // -----------------------------------------------------------------------
  // 8 — Stale/unexpected messages are silently ignored
  // -----------------------------------------------------------------------
  it('ignores messages with unknown IDs', async () => {
    const promise = client.ping();
    const sentId = worker.posted[0].id;

    // Send a response with a different ID.
    worker.respond({ type: 'pong', id: sentId + 999 });

    // The original request is still pending.
    expect(client.pendingCount).toBe(1);

    // Now resolve it properly.
    worker.respond({ type: 'pong', id: sentId });
    const result = await promise;
    expect(result.type).toBe('pong');
  });

  // -----------------------------------------------------------------------
  // 9 — invert() sends correct message and resolves
  // -----------------------------------------------------------------------
  it('sends an invert request and resolves with result', async () => {
    const buf = new ArrayBuffer(4);
    const promise = client.invert(1, 1, buf);

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('invert');
    if (msg.type === 'invert') {
      expect(msg.width).toBe(1);
      expect(msg.height).toBe(1);
      expect(msg.pixels).toBe(buf);
    }

    const resultBuf = new ArrayBuffer(4);
    worker.respond({
      type: 'result',
      id: msg.id,
      width: 1,
      height: 1,
      pixels: resultBuf,
    });

    const result = await promise;
    expect(result.type).toBe('result');
    if (result.type === 'result') {
      expect(result.pixels).toBe(resultBuf);
    }
  });

  // -----------------------------------------------------------------------
  // 10 — Multiple concurrent requests resolve independently
  // -----------------------------------------------------------------------
  it('tracks multiple concurrent requests independently', async () => {
    const p1 = client.ping();
    const p2 = client.ping();
    expect(client.pendingCount).toBe(2);

    const id1 = worker.posted[0].id;
    const id2 = worker.posted[1].id;

    // Resolve in reverse order.
    worker.respond({ type: 'pong', id: id2 });
    expect(client.pendingCount).toBe(1);

    worker.respond({ type: 'pong', id: id1 });
    expect(client.pendingCount).toBe(0);

    const r1 = await p1;
    const r2 = await p2;
    expect(r1.id).toBe(id1);
    expect(r2.id).toBe(id2);
  });

  // -----------------------------------------------------------------------
  // 11 — resize() sends request with transferred buffer and resolves
  // -----------------------------------------------------------------------
  it('sends resize request and resolves with image_result', async () => {
    const inputBuf = new ArrayBuffer(64);
    const promise = client.resize(inputBuf, { width: 800, height: 600, format: 'image/webp' });

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('resize');
    if (msg.type === 'resize') {
      expect(msg.imageBuffer).toBe(inputBuf);
      expect(msg.options.width).toBe(800);
      expect(msg.options.format).toBe('image/webp');
    }

    const outputBuf = new ArrayBuffer(128);
    worker.respond({
      type: 'image_result',
      id: msg.id,
      width: 800,
      height: 600,
      format: 'image/webp',
      data: outputBuf,
    });

    const result = await promise;
    expect(result.type).toBe('image_result');
    if (result.type === 'image_result') {
      expect(result.width).toBe(800);
      expect(result.format).toBe('image/webp');
      expect(result.data).toBe(outputBuf);
    }
  });

  // -----------------------------------------------------------------------
  // 12 — convert() sends request with transferred buffer and resolves
  // -----------------------------------------------------------------------
  it('sends convert request and resolves with image_result', async () => {
    const inputBuf = new ArrayBuffer(64);
    const promise = client.convert(inputBuf, 'image/jpeg', 0.9);

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('convert');
    if (msg.type === 'convert') {
      expect(msg.imageBuffer).toBe(inputBuf);
      expect(msg.targetFormat).toBe('image/jpeg');
      expect(msg.quality).toBe(0.9);
    }

    const outputBuf = new ArrayBuffer(90);
    worker.respond({
      type: 'image_result',
      id: msg.id,
      width: 400,
      height: 300,
      format: 'image/jpeg',
      data: outputBuf,
    });

    const result = await promise;
    expect(result.type).toBe('image_result');
    if (result.type === 'image_result') {
      expect(result.format).toBe('image/jpeg');
      expect(result.data).toBe(outputBuf);
    }
  });

  // -----------------------------------------------------------------------
  // 13 — loadAiModel() sends ai_load request and resolves
  // -----------------------------------------------------------------------
  it('sends ai_load request and resolves with ai_loaded', async () => {
    const promise = client.loadAiModel('modnet');

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('ai_load');
    if (msg.type === 'ai_load') {
      expect(msg.modelId).toBe('modnet');
    }

    worker.respond({
      type: 'ai_loaded',
      id: msg.id,
      modelId: 'modnet',
      backend: 'webgpu',
    });

    const result = await promise;
    expect(result.type).toBe('ai_loaded');
    if (result.type === 'ai_loaded') {
      expect(result.backend).toBe('webgpu');
    }
  });

  // -----------------------------------------------------------------------
  // 14 — removeBackground() transfers pixel buffer and resolves with ai_result
  // -----------------------------------------------------------------------
  it('sends ai_remove_background request and resolves with ai_result', async () => {
    const pixels = new ArrayBuffer(16);
    const promise = client.removeBackground('modnet', 2, 2, pixels);

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('ai_remove_background');
    if (msg.type === 'ai_remove_background') {
      expect(msg.modelId).toBe('modnet');
      expect(msg.pixels).toBe(pixels);
    }

    const outputPixels = new ArrayBuffer(16);
    worker.respond({
      type: 'ai_result',
      id: msg.id,
      modelId: 'modnet',
      width: 2,
      height: 2,
      pixels: outputPixels,
      durationMs: 55,
    });

    const result = await promise;
    expect(result.type).toBe('ai_result');
    if (result.type === 'ai_result') {
      expect(result.durationMs).toBe(55);
      expect(result.pixels).toBe(outputPixels);
    }
  });

  // -----------------------------------------------------------------------
  // 15 — upscaleImage() streaming progress and result
  // -----------------------------------------------------------------------
  it('sends ai_upscale request, receives streaming progress, and resolves', async () => {
    const pixels = new ArrayBuffer(64);
    const progressList: number[] = [];

    const promise = client.upscaleImage(
      'swin2sr-x4',
      4,
      4,
      4,
      pixels,
      { tileSize: 16, overlap: 4 },
      undefined,
      (p) => progressList.push(p.percent),
    );

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('ai_upscale');

    // Simulate streaming progress from worker
    worker.respond({
      type: 'ai_progress',
      id: msg.id,
      currentTile: 1,
      totalTiles: 2,
      percent: 50,
      stage: 'tiling',
    });

    expect(progressList).toEqual([50]);
    // The request should still be pending after progress update
    expect(client.pendingCount).toBe(1);

    const outPixels = new ArrayBuffer(1024);
    worker.respond({
      type: 'ai_upscale_result',
      id: msg.id,
      modelId: 'swin2sr-x4',
      scale: 4,
      width: 16,
      height: 16,
      pixels: outPixels,
      durationMs: 120,
    });

    const result = await promise;
    expect(result.type).toBe('ai_upscale_result');
    if (result.type === 'ai_upscale_result') {
      expect(result.scale).toBe(4);
      expect(result.width).toBe(16);
      expect(result.pixels).toBe(outPixels);
    }
    expect(client.pendingCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // 16 — cancel() sends cancel request
  // -----------------------------------------------------------------------
  it('sends cancel request and resolves with cancelled response', async () => {
    const promise = client.cancel(99);

    expect(worker.posted).toHaveLength(1);
    const msg = worker.posted[0];
    expect(msg.type).toBe('cancel');
    if (msg.type === 'cancel') {
      expect(msg.targetId).toBe(99);
    }

    worker.respond({
      type: 'cancelled',
      id: msg.id,
      targetId: 99,
    });

    const result = await promise;
    expect(result.type).toBe('cancelled');
    if (result.type === 'cancelled') {
      expect(result.targetId).toBe(99);
    }
  });

  // -----------------------------------------------------------------------
  // 17 — AbortSignal integration rejects request and triggers cancel
  // -----------------------------------------------------------------------
  it('aborts pending request when AbortSignal triggers', async () => {
    const controller = new AbortController();
    const promise = client.request({ type: 'ping' }, [], controller.signal);

    expect(worker.posted).toHaveLength(1);
    const pingId = worker.posted[0].id;

    // Trigger abort
    controller.abort();

    await expect(promise).rejects.toThrow('Operation cancelled');

    // Should have sent cancel message to worker
    expect(worker.posted.length).toBeGreaterThanOrEqual(2);
    const cancelMsg = worker.posted[worker.posted.length - 1];
    expect(cancelMsg.type).toBe('cancel');
    if (cancelMsg.type === 'cancel') {
      expect(cancelMsg.targetId).toBe(pingId);
    }
  });
});
