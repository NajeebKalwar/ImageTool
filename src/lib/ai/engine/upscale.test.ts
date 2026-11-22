import { describe, expect, it, vi, beforeEach } from 'vitest';
import { runUpscale, padTile, cropTile } from './upscale';
import { CancelledError, UnsupportedImageError } from '../errors';

// Mock getPipeline
vi.mock('./pipeline-cache', () => ({
  getPipeline: vi.fn(),
}));

// Mock detectWorkerBackend
vi.mock('./device', () => ({
  detectWorkerBackend: vi.fn(async () => ({
    hasWebGPU: false,
    hasWasm: true,
    backend: 'wasm',
  })),
}));

import { getPipeline } from './pipeline-cache';

describe('Upscaler Engine (Tiled Super-Resolution)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('padTile and cropTile', () => {
    it('returns original tile without copying if already a multiple of 8', () => {
      const data = new Uint8ClampedArray(16 * 16 * 4);
      const res = padTile(data, 16, 16, 8);
      expect(res.padded).toBe(false);
      expect(res.width).toBe(16);
      expect(res.height).toBe(16);
      expect(res.rgba).toBe(data);
    });

    it('pads dimensions up to next multiple of 8 with clamped edge replication', () => {
      // 10x10 -> padded to 16x16
      const data = new Uint8ClampedArray(10 * 10 * 4);
      // Put a distinct pixel at (9, 9)
      const lastIdx = (9 * 10 + 9) * 4;
      data[lastIdx] = 200;
      data[lastIdx + 1] = 100;
      data[lastIdx + 2] = 50;
      data[lastIdx + 3] = 255;

      const res = padTile(data, 10, 10, 8);
      expect(res.padded).toBe(true);
      expect(res.width).toBe(16);
      expect(res.height).toBe(16);
      expect(res.rgba.length).toBe(16 * 16 * 4);

      // Check replicated pixel in padding area (e.g. 15, 15)
      const padIdx = (15 * 16 + 15) * 4;
      expect(res.rgba[padIdx]).toBe(200);
      expect(res.rgba[padIdx + 1]).toBe(100);
      expect(res.rgba[padIdx + 2]).toBe(50);
      expect(res.rgba[padIdx + 3]).toBe(255);
    });

    it('crops padded tile back to target dimensions', () => {
      const padded = new Uint8ClampedArray(16 * 16 * 4);
      // Place pixel at (5, 5)
      padded[(5 * 16 + 5) * 4] = 99;

      const cropped = cropTile(padded, 16, 10, 10);
      expect(cropped.length).toBe(10 * 10 * 4);
      expect(cropped[(5 * 10 + 5) * 4]).toBe(99);
    });
  });

  describe('runUpscale', () => {
    it('rejects invalid image dimensions', async () => {
      const pixels = new Uint8ClampedArray(16);
      await expect(runUpscale(pixels, -1, 10)).rejects.toThrow(UnsupportedImageError);
    });

    it('emits tile-by-tile progress and stitches tiles at 2x without artifacts', async () => {
      const width = 256;
      const height = 256;
      const pixels = new Uint8ClampedArray(width * height * 4).fill(120);

      const mockPipelineFn = vi.fn(async (inputRaw: any) => {
        const scale = 2;
        const outW = inputRaw.width * scale;
        const outH = inputRaw.height * scale;
        const outData = new Uint8Array(outW * outH * 4).fill(120);
        return {
          width: outW,
          height: outH,
          channels: 4,
          data: outData,
          rgba: () => ({ width: outW, height: outH, channels: 4, data: outData }),
        };
      });

      vi.mocked(getPipeline).mockResolvedValue({
        instance: mockPipelineFn as any,
        modelId: 'swin2sr-x2',
        backend: 'wasm',
        model: {} as any,
        lastUsed: Date.now(),
      });

      const progressEvents: any[] = [];
      const result = await runUpscale(
        pixels,
        width,
        height,
        {
          modelId: 'swin2sr-x2',
          scale: 2,
          tileSize: 128,
          overlap: 32,
        },
        (p) => progressEvents.push(p),
      );

      expect(result.scale).toBe(2);
      expect(result.width).toBe(512);
      expect(result.height).toBe(512);
      expect(result.pixels.length).toBe(512 * 512 * 4);
      // Verifies smooth normalization without seam artifacts (120 value maintained)
      expect(result.pixels[0]).toBe(120);
      expect(result.pixels[512 * 256 * 4]).toBe(120);

      // Verify progress events
      const tilingEvents = progressEvents.filter((e) => e.stage === 'tiling');
      expect(tilingEvents.length).toBeGreaterThan(1);
      expect(tilingEvents[tilingEvents.length - 1].currentTile).toBe(
        tilingEvents[tilingEvents.length - 1].totalTiles,
      );
      expect(progressEvents.some((e) => e.stage === 'blending')).toBe(true);
      expect(progressEvents.some((e) => e.stage === 'complete')).toBe(true);
    });

    it('aborts early and throws CancelledError if isCancelled returns true', async () => {
      const width = 128;
      const height = 128;
      const pixels = new Uint8ClampedArray(width * height * 4);

      let callCount = 0;
      const isCancelled = () => {
        callCount++;
        return callCount >= 2;
      };

      const mockPipelineFn = vi.fn(async () => ({
        width: 128,
        height: 128,
        channels: 4,
        data: new Uint8Array(128 * 128 * 4),
        rgba: () => ({ width: 128, height: 128, channels: 4, data: new Uint8Array(128 * 128 * 4) }),
      }));

      vi.mocked(getPipeline).mockResolvedValue({
        instance: mockPipelineFn as any,
        modelId: 'swin2sr-x2',
        backend: 'wasm',
        model: {} as any,
        lastUsed: Date.now(),
      });

      await expect(
        runUpscale(
          pixels,
          width,
          height,
          { tileSize: 64, overlap: 16 },
          undefined,
          isCancelled,
        ),
      ).rejects.toThrow(CancelledError);
    });
  });
});
