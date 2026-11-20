import { describe, expect, it } from 'vitest';
import {
  detectDeviceTier,
  estimateUpscaleMemory,
  getDeviceMemoryLimits,
  TIER_LIMITS,
} from './memory-policy';

describe('detectDeviceTier', () => {
  it('correctly maps memory override values to tiers', () => {
    expect(detectDeviceTier(1)).toBe('low');
    expect(detectDeviceTier(2)).toBe('low');
    expect(detectDeviceTier(4)).toBe('medium');
    expect(detectDeviceTier(8)).toBe('high');
    expect(detectDeviceTier(16)).toBe('high');
  });

  it('falls back to a valid default tier when no override is provided', () => {
    const tier = detectDeviceTier();
    expect(['low', 'medium', 'high']).toContain(tier);
  });
});

describe('getDeviceMemoryLimits', () => {
  it('returns valid limits for named tiers', () => {
    const lowLimits = getDeviceMemoryLimits('low');
    expect(lowLimits.tier).toBe('low');
    expect(lowLimits.recommendedTileSize).toBe(256);
    expect(lowLimits.maxUpscaleInputPixels).toBeLessThan(TIER_LIMITS.medium.maxUpscaleInputPixels);

    const highLimits = getDeviceMemoryLimits('high');
    expect(highLimits.tier).toBe('high');
    expect(highLimits.recommendedTileSize).toBe(512);
  });
});

describe('estimateUpscaleMemory', () => {
  const limits = TIER_LIMITS.medium; // max input 6MP, max output 36MP, max dim 8192

  it('accepts safe upscale dimensions and calculates bytes', () => {
    const width = 800;
    const height = 600;
    const scale = 4;

    const est = estimateUpscaleMemory(width, height, scale, limits);
    expect(est.isSafe).toBe(true);
    expect(est.outputWidth).toBe(3200);
    expect(est.outputHeight).toBe(2400);
    expect(est.inputPixels).toBe(480_000);
    expect(est.outputPixels).toBe(7_680_000);
    expect(est.inputBytes).toBe(480_000 * 4);
    expect(est.outputBytes).toBe(7_680_000 * 4);
    expect(est.rejectionReason).toBeUndefined();
  });

  it('rejects input exceeding maxUpscaleInputPixels', () => {
    // 3000 x 3000 = 9MP (limit is 6MP)
    const est = estimateUpscaleMemory(3000, 3000, 2, limits);
    expect(est.isSafe).toBe(false);
    expect(est.rejectionReason).toContain('exceeds maximum allowed input');
  });

  it('rejects output exceeding maxUpscaleOutputPixels', () => {
    // 2500 x 2000 = 5MP input (under 6MP), but 4x scale = 10000 x 8000 = 80MP output (limit 36MP)
    const est = estimateUpscaleMemory(2500, 2000, 4, limits);
    expect(est.isSafe).toBe(false);
    expect(est.rejectionReason).toContain('exceeds');
  });

  it('rejects dimensions exceeding maxDimension', () => {
    // 10000 x 100 exceeds 8192
    const est = estimateUpscaleMemory(10000, 100, 1, limits);
    expect(est.isSafe).toBe(false);
    expect(est.rejectionReason).toContain('maximum texture limit');
  });

  it('provides warning for heavy outputs above 60% capacity', () => {
    // 2400 x 2400 = 5.76 MP input -> 4800 x 4800 = 23.04 MP output (36MP * 0.6 = 21.6MP)
    const est = estimateUpscaleMemory(2400, 2400, 2, limits);
    expect(est.isSafe).toBe(true);
    expect(est.warning).toBeDefined();
    expect(est.warning).toContain('Processing may take several seconds');
  });
});
