import { describe, expect, it, vi } from 'vitest';
import { MAX_PIXELS } from '../lib/worker-protocol';
import { handleMessage, type HandlerResult } from './message-handler';
import type { ImageEngine } from '../lib/canvas-ops';
import { MockAiPipeline, type AiPipeline } from '../lib/ai/inference';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePixels(w: number, h: number): ArrayBuffer {
  return new ArrayBuffer(w * h * 4);
}

const mockAiLoader = async (id: number, modelId: string): Promise<HandlerResult> => ({
  response: {
    type: 'ai_loaded',
    id,
    modelId,
    backend: 'webgpu',
  },
  transfer: [],
});

async function send(
  data: unknown,
  engine?: ImageEngine,
  aiPipeline?: AiPipeline,
): Promise<HandlerResult> {
  return await handleMessage(data, engine, aiPipeline, undefined, mockAiLoader);
}

// Mock engine for testing message-handler in Node
const mockEngine: ImageEngine = {
  async process(_buffer, options) {
    const outBuf = new ArrayBuffer(32);
    return {
      data: outBuf,
      width: options.width || 100,
      height: options.height || 100,
      format: options.format || 'image/png',
    };
  },
};

// ---------------------------------------------------------------------------
// 1 — Structural validation
// ---------------------------------------------------------------------------

describe('structural validation', () => {
  it('rejects null', async () => {
    const { response } = await send(null);
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });

  it('rejects a non-object primitive', async () => {
    const { response } = await send('hello');
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });

  it('rejects a missing id', async () => {
    const { response } = await send({ type: 'ping' });
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });

  it('rejects a non-integer id', async () => {
    const { response } = await send({ type: 'ping', id: 1.5 });
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 2 — ping / pong
// ---------------------------------------------------------------------------

describe('ping', () => {
  it('responds with pong and echoes the id', async () => {
    const { response, transfer } = await send({ type: 'ping', id: 42 });
    expect(response).toEqual({ type: 'pong', id: 42 });
    expect(transfer).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 — Unknown type
// ---------------------------------------------------------------------------

describe('unknown type', () => {
  it('returns an error for an unrecognised type', async () => {
    const { response } = await send({ type: 'rotate', id: 1 });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('Unknown message type');
    }
  });
});

// ---------------------------------------------------------------------------
// 4 — Invert: dimension validation
// ---------------------------------------------------------------------------

describe('invert — dimension validation', () => {
  it('rejects missing width', async () => {
    const { response } = await send({
      type: 'invert',
      id: 1,
      height: 1,
      pixels: makePixels(1, 1),
    });
    expect(response.type).toBe('error');
  });

  it('rejects zero height', async () => {
    const { response } = await send({
      type: 'invert',
      id: 2,
      width: 1,
      height: 0,
      pixels: makePixels(1, 1),
    });
    expect(response.type).toBe('error');
  });

  it('rejects fractional width', async () => {
    const { response } = await send({
      type: 'invert',
      id: 3,
      width: 1.5,
      height: 1,
      pixels: makePixels(1, 1),
    });
    expect(response.type).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 5 — Invert: size cap
// ---------------------------------------------------------------------------

describe('invert — size cap', () => {
  it('rejects images exceeding MAX_PIXELS', async () => {
    const big = MAX_PIXELS + 1;
    const { response } = await send({
      type: 'invert',
      id: 4,
      width: big,
      height: 1,
      pixels: new ArrayBuffer(0),
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('too large');
    }
  });
});

// ---------------------------------------------------------------------------
// 6 — Invert: pixel buffer validation
// ---------------------------------------------------------------------------

describe('invert — pixel buffer', () => {
  it('rejects a non-ArrayBuffer pixels value', async () => {
    const { response } = await send({
      type: 'invert',
      id: 5,
      width: 1,
      height: 1,
      pixels: [0, 0, 0, 255],
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('ArrayBuffer');
    }
  });

  it('rejects a byte-length mismatch', async () => {
    const { response } = await send({
      type: 'invert',
      id: 6,
      width: 2,
      height: 2,
      pixels: new ArrayBuffer(4),
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('16');
    }
  });
});

// ---------------------------------------------------------------------------
// 7 — Invert: happy path
// ---------------------------------------------------------------------------

describe('invert — happy path', () => {
  it('inverts RGB channels and preserves alpha', async () => {
    const buf = new ArrayBuffer(4);
    const view = new Uint8ClampedArray(buf);
    view.set([100, 150, 200, 255]);

    const { response, transfer } = await send({
      type: 'invert',
      id: 7,
      width: 1,
      height: 1,
      pixels: buf,
    });

    expect(response.type).toBe('result');
    if (response.type === 'result') {
      expect(response.id).toBe(7);
      expect(response.width).toBe(1);
      expect(response.height).toBe(1);

      const out = new Uint8ClampedArray(response.pixels);
      expect(out[0]).toBe(155);
      expect(out[1]).toBe(105);
      expect(out[2]).toBe(55);
      expect(out[3]).toBe(255);
    }

    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(buf);
  });

  it('handles a 2×2 image correctly', async () => {
    const buf = new ArrayBuffer(16);
    const view = new Uint8ClampedArray(buf);
    view.set([
      0, 0, 0, 255,
      255, 255, 255, 128,
      128, 64, 32, 0,
      1, 254, 127, 200,
    ]);

    const { response } = await send({
      type: 'invert',
      id: 8,
      width: 2,
      height: 2,
      pixels: buf,
    });

    expect(response.type).toBe('result');
    if (response.type === 'result') {
      const out = new Uint8ClampedArray(response.pixels);
      expect(out[0]).toBe(255);
      expect(out[1]).toBe(255);
      expect(out[2]).toBe(255);
      expect(out[3]).toBe(255);

      expect(out[4]).toBe(0);
      expect(out[5]).toBe(0);
      expect(out[6]).toBe(0);
      expect(out[7]).toBe(128);
    }
  });
});

// ---------------------------------------------------------------------------
// 8 — Resize: message handling & validation
// ---------------------------------------------------------------------------

describe('resize — message handling', () => {
  it('rejects missing or empty image buffer', async () => {
    const { response } = await send({
      type: 'resize',
      id: 10,
      imageBuffer: null,
      options: { width: 100 },
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('ArrayBuffer');
    }
  });

  it('rejects invalid target dimensions', async () => {
    const buf = new ArrayBuffer(10);
    const { response } = await send({
      type: 'resize',
      id: 11,
      imageBuffer: buf,
      options: { width: -50 },
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('positive integer');
    }
  });

  it('rejects unsupported output format', async () => {
    const buf = new ArrayBuffer(10);
    const { response } = await send({
      type: 'resize',
      id: 12,
      imageBuffer: buf,
      options: { format: 'image/bmp' },
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('Unsupported output format');
    }
  });

  it('fails if engine is not provided', async () => {
    const buf = new ArrayBuffer(10);
    const { response } = await send({
      type: 'resize',
      id: 13,
      imageBuffer: buf,
      options: { width: 100, height: 100 },
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('engine not available');
    }
  });

  it('processes resize successfully with engine', async () => {
    const buf = new ArrayBuffer(10);
    const { response, transfer } = await send(
      {
        type: 'resize',
        id: 14,
        imageBuffer: buf,
        options: { width: 400, height: 300, format: 'image/webp' },
      },
      mockEngine,
    );

    expect(response.type).toBe('image_result');
    if (response.type === 'image_result') {
      expect(response.id).toBe(14);
      expect(response.width).toBe(400);
      expect(response.height).toBe(300);
      expect(response.format).toBe('image/webp');
      expect(transfer).toHaveLength(1);
      expect(transfer[0]).toBe(response.data);
    }
  });
});

// ---------------------------------------------------------------------------
// 9 — Convert: message handling & validation
// ---------------------------------------------------------------------------

describe('convert — message handling', () => {
  it('rejects unsupported target format', async () => {
    const buf = new ArrayBuffer(10);
    const { response } = await send({
      type: 'convert',
      id: 20,
      imageBuffer: buf,
      targetFormat: 'image/tiff',
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('Unsupported target format');
    }
  });

  it('processes convert successfully with engine', async () => {
    const buf = new ArrayBuffer(10);
    const { response, transfer } = await send(
      {
        type: 'convert',
        id: 21,
        imageBuffer: buf,
        targetFormat: 'image/jpeg',
        quality: 0.8,
      },
      mockEngine,
    );

    expect(response.type).toBe('image_result');
    if (response.type === 'image_result') {
      expect(response.id).toBe(21);
      expect(response.format).toBe('image/jpeg');
      expect(transfer).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------------
// 10 — AI operations: ai_load and ai_remove_background
// ---------------------------------------------------------------------------

describe('ai operations — message handling', () => {
  const mockAi = new MockAiPipeline();

  it('loads a valid registered model', async () => {
    const { response } = await send({
      type: 'ai_load',
      id: 30,
      modelId: 'modnet',
    });

    expect(response.type).toBe('ai_loaded');
    if (response.type === 'ai_loaded') {
      expect(response.id).toBe(30);
      expect(response.modelId).toBe('modnet');
      expect(response.backend).toBe('webgpu');
    }
  });

  it('rejects loading an unknown model', async () => {
    const { response } = await send({
      type: 'ai_load',
      id: 31,
      modelId: 'non-existent-ai',
    });

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('not found in registry');
    }
  });

  it('delegates background removal to aiBgRemover when aiPipeline is not provided', async () => {
    const pixels = makePixels(2, 2);
    const mockRemover = vi.fn(async (id: number, params: any): Promise<HandlerResult> => ({
      response: {
        type: 'ai_result',
        id,
        modelId: params.modelId,
        width: params.width,
        height: params.height,
        pixels: params.pixels,
        durationMs: 15,
      },
      transfer: [params.pixels],
    }));

    const { response } = await handleMessage(
      {
        type: 'ai_remove_background',
        id: 32,
        modelId: 'modnet',
        width: 2,
        height: 2,
        pixels,
      },
      undefined,
      undefined,
      undefined,
      mockAiLoader,
      undefined,
      mockRemover,
    );

    expect(response.type).toBe('ai_result');
    expect(mockRemover).toHaveBeenCalledTimes(1);
  });

  it('executes background removal successfully with pipeline', async () => {
    const pixels = makePixels(4, 4);
    const { response, transfer } = await send(
      {
        type: 'ai_remove_background',
        id: 33,
        modelId: 'modnet',
        width: 4,
        height: 4,
        pixels,
      },
      undefined,
      mockAi,
    );

    expect(response.type).toBe('ai_result');
    if (response.type === 'ai_result') {
      expect(response.id).toBe(33);
      expect(response.modelId).toBe('modnet');
      expect(response.width).toBe(4);
      expect(response.height).toBe(4);
      expect(response.durationMs).toBeGreaterThan(0);
      expect(response.mask).toBeDefined();
      expect(transfer).toHaveLength(2);
      expect(transfer[0]).toBe(pixels);
    }
  });

  it('rejects ai_upscale with invalid dimensions or scale', async () => {
    const pixels = makePixels(4, 4);
    const { response } = await send(
      {
        type: 'ai_upscale',
        id: 34,
        modelId: 'swin2sr-x4',
        scale: -1,
        width: 4,
        height: 4,
        pixels,
      },
      undefined,
      mockAi,
    );

    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('Scale factor must be a positive number');
    }
  });

  it('executes ai_upscale successfully with progress and transferable buffer', async () => {
    const pixels = makePixels(8, 8);
    const progressList: unknown[] = [];

    const { response, transfer } = await handleMessage(
      {
        type: 'ai_upscale',
        id: 35,
        modelId: 'swin2sr-x4',
        scale: 2,
        width: 8,
        height: 8,
        pixels,
        tileSize: 4,
        overlap: 1,
      },
      undefined,
      mockAi,
      (p) => progressList.push(p),
    );

    expect(response.type).toBe('ai_upscale_result');
    if (response.type === 'ai_upscale_result') {
      expect(response.id).toBe(35);
      expect(response.scale).toBe(2);
      expect(response.width).toBe(16);
      expect(response.height).toBe(16);
      expect(response.pixels.byteLength).toBe(16 * 16 * 4);
      expect(transfer).toHaveLength(1);
    }
    expect(progressList.length).toBeGreaterThan(0);
  });

  it('handles cancel request and marks targetId as cancelled', async () => {
    const { response } = await send({
      type: 'cancel',
      id: 36,
      targetId: 100,
    });

    expect(response.type).toBe('cancelled');
    if (response.type === 'cancelled') {
      expect(response.targetId).toBe(100);
    }
  });
});
