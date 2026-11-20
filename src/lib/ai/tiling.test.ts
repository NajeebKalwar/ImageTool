import { describe, expect, it } from 'vitest';
import {
  calculateTiles,
  extractTileRgba,
  generateCosineWeightMask,
  stitchTiles,
  type ScaledTileResult,
} from './tiling';

describe('calculateTiles', () => {
  it('returns a single tile for images smaller than tile size', () => {
    const tiles = calculateTiles(120, 100, 256, 32);
    expect(tiles).toHaveLength(1);
    expect(tiles[0]).toEqual({
      index: 0,
      x: 0,
      y: 0,
      width: 120,
      height: 100,
      hasLeftNeighbor: false,
      hasTopNeighbor: false,
      hasRightNeighbor: false,
      hasBottomNeighbor: false,
    });
  });

  it('partitions a larger image into a grid of overlapping tiles', () => {
    // 500x500 image, 256x256 tiles with 32px overlap -> stride = 224
    // X positions: 0, 224, 244 (500 - 256) -> 3 columns
    // Y positions: 0, 224, 244 (500 - 256) -> 3 rows -> 9 tiles total
    const tiles = calculateTiles(500, 500, 256, 32);
    expect(tiles.length).toBeGreaterThan(1);

    // Verify all tiles have expected dimensions
    for (const t of tiles) {
      expect(t.width).toBe(256);
      expect(t.height).toBe(256);
      expect(t.x + t.width).toBeLessThanOrEqual(500);
      expect(t.y + t.height).toBeLessThanOrEqual(500);
    }

    // Top-left tile
    expect(tiles[0].hasLeftNeighbor).toBe(false);
    expect(tiles[0].hasTopNeighbor).toBe(false);
    expect(tiles[0].hasRightNeighbor).toBe(true);
    expect(tiles[0].hasBottomNeighbor).toBe(true);

    // Bottom-right tile
    const lastTile = tiles[tiles.length - 1];
    expect(lastTile.hasRightNeighbor).toBe(false);
    expect(lastTile.hasBottomNeighbor).toBe(false);
  });
});

describe('extractTileRgba', () => {
  it('extracts pixel sub-rectangle accurately', () => {
    const width = 10;
    const height = 10;
    const src = new Uint8ClampedArray(width * height * 4);

    // Fill image with unique coordinates: R=x, G=y, B=100, A=255
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        src[idx] = x;
        src[idx + 1] = y;
        src[idx + 2] = 100;
        src[idx + 3] = 255;
      }
    }

    const tile = {
      index: 0,
      x: 2,
      y: 3,
      width: 4,
      height: 4,
      hasLeftNeighbor: false,
      hasTopNeighbor: false,
      hasRightNeighbor: false,
      hasBottomNeighbor: false,
    };

    const tilePixels = extractTileRgba(src, width, height, tile);
    expect(tilePixels.length).toBe(4 * 4 * 4);

    // Check pixel at (0, 0) inside tile, corresponding to (2, 3) in source
    expect(tilePixels[0]).toBe(2); // R = x = 2
    expect(tilePixels[1]).toBe(3); // G = y = 3
    expect(tilePixels[2]).toBe(100);
    expect(tilePixels[3]).toBe(255);

    // Check pixel at (3, 3) inside tile, corresponding to (5, 6) in source
    const lastIdx = (3 * 4 + 3) * 4;
    expect(tilePixels[lastIdx]).toBe(5);
    expect(tilePixels[lastIdx + 1]).toBe(6);
    expect(tilePixels[lastIdx + 2]).toBe(100);
    expect(tilePixels[lastIdx + 3]).toBe(255);
  });
});

describe('generateCosineWeightMask', () => {
  it('is 1.0 everywhere when tile has no neighbors', () => {
    const mask = generateCosineWeightMask(32, 32, 8, false, false, false, false);
    for (let i = 0; i < mask.length; i++) {
      expect(mask[i]).toBeCloseTo(1.0, 4);
    }
  });

  it('feathers smoothly along borders with neighbors', () => {
    const mask = generateCosineWeightMask(32, 32, 8, true, false, true, false);
    // At left boundary x=0, weight should be close to 0
    expect(mask[0]).toBeLessThan(0.2);
    // In the center x=16, weight should be 1.0
    expect(mask[16]).toBeCloseTo(1.0, 4);
    // At right boundary x=31, weight should be close to 0
    expect(mask[31]).toBeLessThan(0.2);
  });
});

describe('stitchTiles', () => {
  it('recovers original image exactly at scale=1 without seam artifacts', () => {
    const width = 64;
    const height = 64;
    const original = new Uint8ClampedArray(width * height * 4);

    // Fill with smooth gradient
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        original[idx] = Math.round((x / width) * 255);
        original[idx + 1] = Math.round((y / height) * 255);
        original[idx + 2] = 128;
        original[idx + 3] = 255;
      }
    }

    const tiles = calculateTiles(width, height, 32, 8);
    const scaledResults: ScaledTileResult[] = tiles.map((t) => ({
      tile: t,
      scaledRgba: extractTileRgba(original, width, height, t),
      scale: 1,
    }));

    const reconstructed = stitchTiles(width, height, scaledResults, 8);

    // Every pixel in reconstructed must match original
    for (let i = 0; i < original.length; i++) {
      expect(Math.abs(reconstructed[i] - original[i])).toBeLessThanOrEqual(1);
    }
  });

  it('stitches 2x scaled tiles to correct output dimensions', () => {
    const width = 32;
    const height = 32;
    const original = new Uint8ClampedArray(width * height * 4);
    original.fill(200);

    const scale = 2;
    const outWidth = width * scale;
    const outHeight = height * scale;

    const tiles = calculateTiles(width, height, 16, 4);
    const scaledResults: ScaledTileResult[] = tiles.map((t) => {
      // 2x upscale: replicate each pixel 2x2
      const sw = t.width * scale;
      const sh = t.height * scale;
      const scaled = new Uint8ClampedArray(sw * sh * 4);
      scaled.fill(200);
      return {
        tile: t,
        scaledRgba: scaled,
        scale,
      };
    });

    const reconstructed = stitchTiles(outWidth, outHeight, scaledResults, 4);
    expect(reconstructed.length).toBe(outWidth * outHeight * 4);

    // Pixel values should remain 200
    for (let i = 0; i < 100; i++) {
      expect(reconstructed[i]).toBe(200);
    }
  });
});
