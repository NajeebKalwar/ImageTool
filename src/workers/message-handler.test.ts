import { describe, expect, it } from 'vitest';
import { handleMessage, type HandlerResult } from './message-handler';
import { MAX_PIXELS } from '../lib/worker-protocol';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal RGBA ArrayBuffer for given dimensions. */
function makePixels(w: number, h: number): ArrayBuffer {
  return new ArrayBuffer(w * h * 4);
}

/** Shorthand: send a message and return the result. */
function send(data: unknown): HandlerResult {
  return handleMessage(data);
}

// ---------------------------------------------------------------------------
// 1 — Structural validation
// ---------------------------------------------------------------------------

describe('structural validation', () => {
  it('rejects null', () => {
    const { response } = send(null);
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });

  it('rejects a non-object primitive', () => {
    const { response } = send('hello');
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });

  it('rejects a missing id', () => {
    const { response } = send({ type: 'ping' });
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });

  it('rejects a non-integer id', () => {
    const { response } = send({ type: 'ping', id: 1.5 });
    expect(response.type).toBe('error');
    expect(response.id).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// 2 — ping / pong
// ---------------------------------------------------------------------------

describe('ping', () => {
  it('responds with pong and echoes the id', () => {
    const { response, transfer } = send({ type: 'ping', id: 42 });
    expect(response).toEqual({ type: 'pong', id: 42 });
    expect(transfer).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3 — Unknown type
// ---------------------------------------------------------------------------

describe('unknown type', () => {
  it('returns an error for an unrecognised type', () => {
    const { response } = send({ type: 'resize', id: 1 });
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
  it('rejects missing width', () => {
    const { response } = send({
      type: 'invert', id: 1,
      height: 1, pixels: makePixels(1, 1),
    });
    expect(response.type).toBe('error');
  });

  it('rejects zero height', () => {
    const { response } = send({
      type: 'invert', id: 2,
      width: 1, height: 0, pixels: makePixels(1, 1),
    });
    expect(response.type).toBe('error');
  });

  it('rejects fractional width', () => {
    const { response } = send({
      type: 'invert', id: 3,
      width: 1.5, height: 1, pixels: makePixels(1, 1),
    });
    expect(response.type).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// 5 — Invert: size cap
// ---------------------------------------------------------------------------

describe('invert — size cap', () => {
  it('rejects images exceeding MAX_PIXELS', () => {
    // Use dimensions whose product just exceeds the cap without
    // allocating huge memory. The handler checks before accessing bytes.
    const big = MAX_PIXELS + 1;
    const { response } = send({
      type: 'invert', id: 4,
      width: big, height: 1,
      pixels: new ArrayBuffer(0), // handler rejects before reading
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
  it('rejects a non-ArrayBuffer pixels value', () => {
    const { response } = send({
      type: 'invert', id: 5,
      width: 1, height: 1,
      pixels: [0, 0, 0, 255],
    });
    expect(response.type).toBe('error');
    if (response.type === 'error') {
      expect(response.message).toContain('ArrayBuffer');
    }
  });

  it('rejects a byte-length mismatch', () => {
    const { response } = send({
      type: 'invert', id: 6,
      width: 2, height: 2,
      pixels: new ArrayBuffer(4), // expects 16
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
  it('inverts RGB channels and preserves alpha', () => {
    const buf = new ArrayBuffer(4);
    const view = new Uint8ClampedArray(buf);
    view.set([100, 150, 200, 255]); // R, G, B, A

    const { response, transfer } = send({
      type: 'invert', id: 7,
      width: 1, height: 1,
      pixels: buf,
    });

    expect(response.type).toBe('result');
    if (response.type === 'result') {
      expect(response.id).toBe(7);
      expect(response.width).toBe(1);
      expect(response.height).toBe(1);

      const out = new Uint8ClampedArray(response.pixels);
      expect(out[0]).toBe(155); // 255 - 100
      expect(out[1]).toBe(105); // 255 - 150
      expect(out[2]).toBe(55);  // 255 - 200
      expect(out[3]).toBe(255); // alpha unchanged
    }

    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(buf);
  });

  it('handles a 2×2 image correctly', () => {
    const buf = new ArrayBuffer(16);
    const view = new Uint8ClampedArray(buf);
    // Fill all 4 pixels with known values
    view.set([
      0, 0, 0, 255,       // black → white (alpha stays)
      255, 255, 255, 128,  // white → black (alpha stays)
      128, 64, 32, 0,      // mid tones
      1, 254, 127, 200,    // near-edge values
    ]);

    const { response } = send({
      type: 'invert', id: 8,
      width: 2, height: 2,
      pixels: buf,
    });

    expect(response.type).toBe('result');
    if (response.type === 'result') {
      const out = new Uint8ClampedArray(response.pixels);
      // pixel 0: black → white
      expect(out[0]).toBe(255);
      expect(out[1]).toBe(255);
      expect(out[2]).toBe(255);
      expect(out[3]).toBe(255); // alpha unchanged
      // pixel 1: white → black
      expect(out[4]).toBe(0);
      expect(out[5]).toBe(0);
      expect(out[6]).toBe(0);
      expect(out[7]).toBe(128); // alpha unchanged
    }
  });
});
