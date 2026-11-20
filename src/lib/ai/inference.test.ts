import { describe, expect, it } from 'vitest';
import {
  applyAlphaMatte,
  MockAiPipeline,
  preprocessRgbaToNchw,
} from './inference';

describe('AI inference preprocessing and postprocessing', () => {
  it('converts RGBA to NCHW Float32 tensor with ImageNet normalization', () => {
    const w = 2;
    const h = 2;
    const rgba = new Uint8ClampedArray([
      255, 0, 0, 255,   // red
      0, 255, 0, 255,   // green
      0, 0, 255, 255,   // blue
      255, 255, 255, 255 // white
    ]);

    const tensor = preprocessRgbaToNchw(rgba, w, h, true);

    expect(tensor.dims).toEqual([1, 3, 2, 2]);
    expect(tensor.data).toHaveLength(12); // 3 channels * 4 pixels

    // Verify channel order: first 4 elements are Red channel
    // pixel 0 red = (1.0 - 0.485) / 0.229 ≈ 2.2489
    expect(tensor.data[0]).toBeCloseTo((1.0 - 0.485) / 0.229, 3);
    // pixel 1 red = (0 - 0.485) / 0.229 ≈ -2.1179
    expect(tensor.data[1]).toBeCloseTo((0 - 0.485) / 0.229, 3);
  });

  it('applies alpha matte to RGBA buffer correctly', () => {
    const rgba = new Uint8ClampedArray([
      100, 100, 100, 255, // pixel 0
      200, 200, 200, 255, // pixel 1
    ]);

    const matte = new Float32Array([1.0, 0.0]); // pixel 0 kept, pixel 1 fully transparent

    applyAlphaMatte(rgba, matte, 2, 1);

    expect(rgba[3]).toBe(255); // pixel 0 alpha remains 255
    expect(rgba[7]).toBe(0);   // pixel 1 alpha becomes 0
  });

  it('runs MockAiPipeline successfully', async () => {
    const pipeline = new MockAiPipeline();
    const w = 10;
    const h = 10;
    const pixels = new Uint8ClampedArray(w * h * 4).fill(255);

    const result = await pipeline.runBackgroundRemoval(pixels, w, h, {
      modelId: 'modnet',
      preferredBackend: 'webgpu',
    });

    expect(result.width).toBe(10);
    expect(result.height).toBe(10);
    expect(result.mask).toHaveLength(100);
    expect(result.backendUsed).toBe('webgpu');
    expect(result.durationMs).toBeGreaterThan(0);

    // Center pixel should remain visible, corner pixel should be transparent
    const centerIdx = (5 * w + 5) * 4 + 3;
    const cornerIdx = 3;
    expect(pixels[centerIdx]).toBe(255);
    expect(pixels[cornerIdx]).toBe(0);
  });
});
