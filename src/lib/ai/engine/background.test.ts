import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  removeBackground,
  compositeAlphaMask,
  extractMaskFromSegmentationOutput,
} from './background';
import { RawImage } from '@huggingface/transformers';
import { CancelledError, UnsupportedImageError } from '../errors';

// Mock getPipeline
vi.mock('./pipeline-cache', () => ({
  getPipeline: vi.fn(),
}));

import { getPipeline } from './pipeline-cache';

describe('Background Removal Engine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('extractMaskFromSegmentationOutput', () => {
    it('extracts mask from a direct RawImage instance', () => {
      const raw = new RawImage(new Uint8Array(16), 2, 2, 4);
      expect(extractMaskFromSegmentationOutput(raw)).toBe(raw);
    });

    it('extracts mask from an array of segmentation objects [{ mask }]', () => {
      const raw = new RawImage(new Uint8Array(16), 2, 2, 4);
      expect(extractMaskFromSegmentationOutput([{ label: 'foreground', score: 0.99, mask: raw }])).toBe(raw);
    });

    it('extracts mask from an object with mask property { mask }', () => {
      const raw = new RawImage(new Uint8Array(16), 2, 2, 4);
      expect(extractMaskFromSegmentationOutput({ mask: raw })).toBe(raw);
    });

    it('throws error when no valid mask is found in output', () => {
      expect(() => extractMaskFromSegmentationOutput([])).toThrow();
      expect(() => extractMaskFromSegmentationOutput({ invalid: true })).toThrow();
    });
  });

  describe('compositeAlphaMask', () => {
    it('replaces alpha channel while strictly preserving RGB values', () => {
      const width = 2;
      const height = 2;
      const source = new Uint8ClampedArray([
        255, 100, 50, 255,  // Pixel 0: Reddish, fully opaque
        0, 200, 100, 255,   // Pixel 1: Greenish, fully opaque
        10, 20, 30, 255,    // Pixel 2: Dark
        100, 100, 100, 255, // Pixel 3: Gray
      ]);

      // Alpha mask: 255 (opaque), 128 (semi-transparent), 0 (transparent), 255
      const maskRaw = new RawImage(
        new Uint8Array([255, 128, 0, 255]),
        width,
        height,
        1,
      );

      const result = compositeAlphaMask(source, width, height, maskRaw);

      // Pixel 0: RGB preserved, alpha 255
      expect(result[0]).toBe(255);
      expect(result[1]).toBe(100);
      expect(result[2]).toBe(50);
      expect(result[3]).toBe(255);

      // Pixel 1: RGB preserved, alpha 128
      expect(result[4]).toBe(0);
      expect(result[5]).toBe(200);
      expect(result[6]).toBe(100);
      expect(result[7]).toBe(128);

      // Pixel 2: RGB preserved, alpha 0
      expect(result[8]).toBe(10);
      expect(result[9]).toBe(20);
      expect(result[10]).toBe(30);
      expect(result[11]).toBe(0);

      // Pixel 3: RGB preserved, alpha 255
      expect(result[12]).toBe(100);
      expect(result[13]).toBe(100);
      expect(result[14]).toBe(100);
      expect(result[15]).toBe(255);
      expect(source[3]).toBe(255);
      expect(source[7]).toBe(255);
      expect(source[11]).toBe(255);
      expect(source[15]).toBe(255);
    });

    it('correctly handles 4-channel RGBA masks', () => {
      const width = 1;
      const height = 1;
      const source = new Uint8ClampedArray([255, 0, 0, 255]);
      const maskRaw = new RawImage(new Uint8Array([0, 0, 0, 150]), width, height, 4);

      const result = compositeAlphaMask(source, width, height, maskRaw);
      expect(result[0]).toBe(255);
      expect(result[3]).toBe(150);
    });

    it('correctly calculates luminance for 3-channel RGB masks', () => {
      const width = 1;
      const height = 1;
      const source = new Uint8ClampedArray([0, 255, 0, 255]);
      // White mask: [255, 255, 255] -> luminance ~255
      const maskRaw = new RawImage(new Uint8Array([255, 255, 255]), width, height, 3);

      const result = compositeAlphaMask(source, width, height, maskRaw);
      expect(result[1]).toBe(255);
      expect(result[3]).toBe(255);
    });
  });

  describe('removeBackground', () => {
    it('rejects invalid dimensions', async () => {
      const pixels = new Uint8ClampedArray(16);
      await expect(removeBackground(pixels, 0, 10)).rejects.toThrow(UnsupportedImageError);
    });

    it('throws error when segmentation output is entirely transparent', async () => {
      const width = 2;
      const height = 2;
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
      const allTransparentMask = new RawImage(new Uint8Array(width * height).fill(0), width, height, 1);

      vi.mocked(getPipeline).mockResolvedValue({
        instance: vi.fn(async () => [{ mask: allTransparentMask }]) as any,
        modelId: 'modnet',
        backend: 'wasm',
        model: {} as any,
        lastUsed: Date.now(),
      });

      await expect(
        removeBackground(pixels, width, height, { modelId: 'modnet' }),
      ).rejects.toThrow(/entirely transparent/);
    });

    it('falls back to WASM when primary pipeline inference fails', async () => {
      const width = 2;
      const height = 2;
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
      const validMask = new RawImage(new Uint8Array(width * height).fill(200), width, height, 1);

      const failingGpuPipeline = vi.fn().mockRejectedValue(new Error('GPU device lost'));
      const workingWasmPipeline = vi.fn().mockResolvedValue([{ mask: validMask }]);

      vi.mocked(getPipeline)
        .mockResolvedValueOnce({
          instance: failingGpuPipeline as any,
          modelId: 'birefnet-lite',
          backend: 'webgpu',
          model: {} as any,
          lastUsed: Date.now(),
        })
        .mockResolvedValueOnce({
          instance: workingWasmPipeline as any,
          modelId: 'birefnet-lite',
          backend: 'wasm',
          model: {} as any,
          lastUsed: Date.now(),
        });

      const result = await removeBackground(pixels, width, height, { modelId: 'birefnet-lite' });
      expect(result.pixels[3]).toBe(200);
      expect(failingGpuPipeline).toHaveBeenCalledTimes(1);
      expect(workingWasmPipeline).toHaveBeenCalledTimes(1);
    });

    it('runs inference and emits progress stages', async () => {
      const width = 4;
      const height = 4;
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);

      const maskRaw = new RawImage(new Uint8Array(width * height).fill(180), width, height, 1);
      const mockPipelineFn = vi.fn(async () => [{ mask: maskRaw }]);

      vi.mocked(getPipeline).mockResolvedValue({
        instance: mockPipelineFn as any,
        modelId: 'modnet',
        backend: 'wasm',
        model: {} as any,
        lastUsed: Date.now(),
      });

      const progressEvents: any[] = [];
      const result = await removeBackground(
        pixels,
        width,
        height,
        { modelId: 'modnet' },
        (p) => progressEvents.push(p),
      );

      expect(result.width).toBe(width);
      expect(result.height).toBe(height);
      expect(result.pixels.length).toBe(width * height * 4);
      expect(result.pixels[3]).toBe(180); // Composited alpha

      expect(progressEvents.some((p) => p.stage === 'segmenting')).toBe(true);
      expect(progressEvents.some((p) => p.stage === 'compositing')).toBe(true);
      expect(progressEvents.some((p) => p.stage === 'complete')).toBe(true);
    });

    it('aborts and throws CancelledError if cancellation is signaled', async () => {
      const width = 4;
      const height = 4;
      const pixels = new Uint8ClampedArray(width * height * 4).fill(255);

      const isCancelled = () => true;

      await expect(
        removeBackground(pixels, width, height, { modelId: 'modnet' }, undefined, isCancelled),
      ).rejects.toThrow(CancelledError);
    });
  });
});
