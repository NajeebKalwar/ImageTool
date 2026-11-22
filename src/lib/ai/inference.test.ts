import { describe, expect, it } from 'vitest';
import {
  applyAlphaMatte,
  MockAiPipeline,
  preprocessRgbaToNchw,
} from './inference';

describe('preprocessRgbaToNchw', () => {
  it('correctly normalizes RGBA buffer to 1x3xHxW Float32Array', () => {
    const width = 2;
    const height = 2;
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,   // Red
      0, 255, 0, 255,   // Green
      0, 0, 255, 255,   // Blue
      255, 255, 255, 255 // White
    ]);

    const tensor = preprocessRgbaToNchw(rgba, width, height, true);
    expect(tensor.dims).toEqual([1, 3, 2, 2]);
    expect(tensor.data.length).toBe(3 * 2 * 2);

    // Channel 0 (R) of first pixel (255)
    // Normalized: (1.0 - 0.485) / 0.229 ≈ 2.2489
    expect(tensor.data[0]).toBeCloseTo(2.2489, 2);
  });
});

describe('applyAlphaMatte', () => {
  it('modulates alpha channel without altering RGB values', () => {
    const rgba = new Uint8ClampedArray([100, 150, 200, 255]);
    const matte = new Float32Array([0.5]);

    applyAlphaMatte(rgba, matte, 1, 1);
    expect(rgba[0]).toBe(100);
    expect(rgba[1]).toBe(150);
    expect(rgba[2]).toBe(200);
    expect(rgba[3]).toBe(128); // 255 * 0.5 = 127.5 -> 128
  });
});

describe('MockAiPipeline', () => {
  it('runs mock background removal producing masked RGBA pixels', async () => {
    const pipeline = new MockAiPipeline();
    const width = 20;
    const height = 20;
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(255); // Solid white

    const result = await pipeline.runBackgroundRemoval(pixels, width, height, {
      modelId: 'birefnet-lite',
    });

    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.mask.length).toBe(width * height);
    expect(result.backendUsed).toBe('webgpu');
  });

  it('runs mock upscaling with progress reports', async () => {
    const pipeline = new MockAiPipeline();
    const width = 16;
    const height = 16;
    const pixels = new Uint8ClampedArray(width * height * 4);
    pixels.fill(120);

    const progressReports: number[] = [];
    const result = await pipeline.runUpscaling(
      pixels,
      width,
      height,
      {
        modelId: 'swin2sr-x4',
        scale: 2,
        tileSize: 8,
        overlap: 2,
      },
      (p) => progressReports.push(p.percent),
    );

    expect(result.width).toBe(32);
    expect(result.height).toBe(32);
    expect(result.pixels.length).toBe(32 * 32 * 4);
    expect(progressReports.length).toBeGreaterThan(0);
    expect(progressReports[progressReports.length - 1]).toBe(100);
  });

  it('supports cancellation during upscaling', async () => {
    const pipeline = new MockAiPipeline();
    const width = 32;
    const height = 32;
    const pixels = new Uint8ClampedArray(width * height * 4);

    let cancelled = false;
    await expect(
      pipeline.runUpscaling(
        pixels,
        width,
        height,
        {
          modelId: 'swin2sr-x2',
          scale: 4,
          tileSize: 8,
          overlap: 2,
        },
        () => {
          cancelled = true;
        },
        () => cancelled,
      ),
    ).rejects.toThrow('Operation cancelled');
  });
});
