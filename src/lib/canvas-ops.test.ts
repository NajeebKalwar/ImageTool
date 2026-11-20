import { describe, expect, it } from 'vitest';
import {
  calculateTargetDimensions,
  isSupportedFormat,
  normalizeQuality,
  validateImageBuffer,
} from './canvas-ops';
import { MAX_FILE_BYTES } from './worker-protocol';

describe('canvas-ops — format and quality validation', () => {
  it('identifies supported formats correctly', () => {
    expect(isSupportedFormat('image/png')).toBe(true);
    expect(isSupportedFormat('image/jpeg')).toBe(true);
    expect(isSupportedFormat('image/webp')).toBe(true);
    expect(isSupportedFormat('image/gif')).toBe(false);
    expect(isSupportedFormat('application/pdf')).toBe(false);
    expect(isSupportedFormat(null)).toBe(false);
  });

  it('normalizes quality values', () => {
    expect(normalizeQuality(0.85)).toBe(0.85);
    expect(normalizeQuality(1.5)).toBe(1.0);
    expect(normalizeQuality(-0.5)).toBe(0.05);
    expect(normalizeQuality(undefined)).toBe(0.85);
    expect(normalizeQuality('high')).toBe(0.85);
  });
});

describe('canvas-ops — buffer validation', () => {
  it('accepts valid non-empty ArrayBuffer', () => {
    const buf = new ArrayBuffer(100);
    expect(() => validateImageBuffer(buf)).not.toThrow();
  });

  it('rejects non-ArrayBuffer', () => {
    expect(() => validateImageBuffer(null)).toThrow('must be an ArrayBuffer');
    expect(() => validateImageBuffer([1, 2, 3])).toThrow('must be an ArrayBuffer');
  });

  it('rejects empty ArrayBuffer', () => {
    expect(() => validateImageBuffer(new ArrayBuffer(0))).toThrow('cannot be empty');
  });

  it('rejects oversized buffer', () => {
    // Fake buffer object with large byteLength
    const fake = {
      byteLength: MAX_FILE_BYTES + 1,
    };
    Object.setPrototypeOf(fake, ArrayBuffer.prototype);
    expect(() => validateImageBuffer(fake)).toThrow('exceeds limit');
  });
});

describe('canvas-ops — calculateTargetDimensions', () => {
  const src = { width: 1920, height: 1080 }; // 16:9

  it('preserves dimensions when neither width nor height is provided', () => {
    const dim = calculateTargetDimensions(src.width, src.height, {});
    expect(dim).toEqual({ width: 1920, height: 1080 });
  });

  it('scales height proportionally when only width is provided', () => {
    const dim = calculateTargetDimensions(src.width, src.height, { width: 960 });
    expect(dim).toEqual({ width: 960, height: 540 });
  });

  it('scales width proportionally when only height is provided', () => {
    const dim = calculateTargetDimensions(src.width, src.height, { height: 540 });
    expect(dim).toEqual({ width: 960, height: 540 });
  });

  it('calculates contain mode correctly', () => {
    // Square box 800x800 for 16:9 image
    const dim = calculateTargetDimensions(src.width, src.height, {
      width: 800,
      height: 800,
      fit: 'contain',
    });
    expect(dim.width).toBe(800);
    expect(dim.height).toBe(450); // 800 * (1080/1920)
  });

  it('calculates cover mode correctly', () => {
    const dim = calculateTargetDimensions(src.width, src.height, {
      width: 800,
      height: 800,
      fit: 'cover',
    });
    expect(dim.height).toBe(800);
    expect(dim.width).toBe(1422); // 800 * (1920/1080)
  });

  it('calculates fill mode (exact dimensions)', () => {
    const dim = calculateTargetDimensions(src.width, src.height, {
      width: 500,
      height: 400,
      fit: 'fill',
    });
    expect(dim).toEqual({ width: 500, height: 400 });
  });

  it('calculates inside mode without upscaling', () => {
    const dim = calculateTargetDimensions(800, 600, {
      width: 1600,
      height: 1200,
      fit: 'inside',
    });
    // Should NOT upscale because source is smaller than box
    expect(dim).toEqual({ width: 800, height: 600 });
  });

  it('throws on non-positive source dimensions', () => {
    expect(() => calculateTargetDimensions(0, 100, { width: 50 })).toThrow();
    expect(() => calculateTargetDimensions(-10, 100, { width: 50 })).toThrow();
  });
});
