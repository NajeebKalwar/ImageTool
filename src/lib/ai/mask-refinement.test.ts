import { describe, expect, it } from 'vitest';
import {
  applyMaskThreshold,
  applyEdgeSoftness,
  applyBrushStroke,
  compositeMaskToRgba,
} from './mask-refinement';

describe('Mask Refinement Engine', () => {
  describe('applyMaskThreshold', () => {
    it('returns exact copy of base mask when threshold is 0', () => {
      const mask = new Uint8ClampedArray([0, 50, 128, 200, 255]);
      const res = applyMaskThreshold(mask, 0);
      expect(Array.from(res)).toEqual([0, 50, 128, 200, 255]);
    });

    it('cuts low alpha values to 0 and high values to 255 with threshold', () => {
      const mask = new Uint8ClampedArray([10, 50, 128, 200, 250]);
      const res = applyMaskThreshold(mask, 50); // Cutoff near 128
      expect(res[0]).toBe(0);
      expect(res[1]).toBe(0);
      expect(res[4]).toBe(255);
    });
  });

  describe('applyEdgeSoftness', () => {
    it('returns copy when radius is 0', () => {
      const mask = new Uint8ClampedArray([0, 255, 0, 255]);
      const res = applyEdgeSoftness(mask, 2, 2, 0);
      expect(Array.from(res)).toEqual([0, 255, 0, 255]);
    });

    it('blurs sharp step edge between pixels', () => {
      // 4x1 row: [0, 0, 255, 255]
      const mask = new Uint8ClampedArray([0, 0, 255, 255]);
      const res = applyEdgeSoftness(mask, 4, 1, 1);
      // The boundary pixel values should be blended
      expect(res[1]).toBeGreaterThan(0);
      expect(res[2]).toBeLessThan(255);
    });
  });

  describe('applyBrushStroke', () => {
    it('paints restore stroke setting center pixel towards 255', () => {
      const mask = new Uint8ClampedArray(9).fill(0); // 3x3 empty mask
      applyBrushStroke(mask, 3, 3, 1, 1, 1, 'restore');
      // Center pixel (1, 1) index 4 should be 255
      expect(mask[4]).toBe(255);
    });

    it('paints erase stroke setting center pixel towards 0', () => {
      const mask = new Uint8ClampedArray(9).fill(255); // 3x3 full mask
      applyBrushStroke(mask, 3, 3, 1, 1, 1, 'erase');
      expect(mask[4]).toBe(0);
    });
  });

  describe('compositeMaskToRgba', () => {
    it('composites original RGB with refined mask alpha', () => {
      const source = new Uint8ClampedArray([255, 128, 64, 255, 10, 20, 30, 255]);
      const mask = new Uint8ClampedArray([128, 0]);

      const result = compositeMaskToRgba(source, mask, 2, 1);
      expect(result[0]).toBe(255);
      expect(result[1]).toBe(128);
      expect(result[2]).toBe(64);
      expect(result[3]).toBe(128);

      expect(result[4]).toBe(10);
      expect(result[5]).toBe(20);
      expect(result[6]).toBe(30);
      expect(result[7]).toBe(0);
    });
  });
});
