/**
 * Tiled Processing and Seam Blending Engine for High-Resolution AI Super-Resolution.
 *
 * Prevents GPU VRAM exhaustion (OOM) and browser tab crashes by partitioning
 * large images into overlapping tiles, running inference tile-by-tile, and
 * reconstructing the final high-resolution canvas using cosine-weighted seam blending.
 */

export interface TileBounds {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Whether this tile has an overlapping neighbor on the left */
  hasLeftNeighbor: boolean;
  /** Whether this tile has an overlapping neighbor on the top */
  hasTopNeighbor: boolean;
  /** Whether this tile has an overlapping neighbor on the right */
  hasRightNeighbor: boolean;
  /** Whether this tile has an overlapping neighbor on the bottom */
  hasBottomNeighbor: boolean;
}

/**
 * Calculates a uniform grid of overlapping tiles to cover the entire image.
 *
 * @param imgWidth Source image width in pixels.
 * @param imgHeight Source image height in pixels.
 * @param tileSize Dimension of each tile (e.g. 256 or 512).
 * @param overlap Overlap margin in pixels (e.g. 16 or 32).
 */
export function calculateTiles(
  imgWidth: number,
  imgHeight: number,
  tileSize: number = 256,
  overlap: number = 32,
): TileBounds[] {
  if (imgWidth <= 0 || imgHeight <= 0) {
    throw new Error('Image dimensions must be positive integers.');
  }

  // Ensure overlap is strictly smaller than tile size
  const safeOverlap = Math.min(overlap, Math.floor(tileSize / 4));
  const effectiveTileW = Math.min(tileSize, imgWidth);
  const effectiveTileH = Math.min(tileSize, imgHeight);

  // If image fits within a single tile, return single tile
  if (imgWidth <= effectiveTileW && imgHeight <= effectiveTileH) {
    return [
      {
        index: 0,
        x: 0,
        y: 0,
        width: imgWidth,
        height: imgHeight,
        hasLeftNeighbor: false,
        hasTopNeighbor: false,
        hasRightNeighbor: false,
        hasBottomNeighbor: false,
      },
    ];
  }

  const strideX = Math.max(1, effectiveTileW - safeOverlap);
  const strideY = Math.max(1, effectiveTileH - safeOverlap);

  // Generate X starting positions
  const xPositions: number[] = [];
  for (let x = 0; x < imgWidth; x += strideX) {
    if (x + effectiveTileW >= imgWidth) {
      xPositions.push(Math.max(0, imgWidth - effectiveTileW));
      break;
    }
    xPositions.push(x);
  }

  // Generate Y starting positions
  const yPositions: number[] = [];
  for (let y = 0; y < imgHeight; y += strideY) {
    if (y + effectiveTileH >= imgHeight) {
      yPositions.push(Math.max(0, imgHeight - effectiveTileH));
      break;
    }
    yPositions.push(y);
  }

  const tiles: TileBounds[] = [];
  let index = 0;

  for (let yi = 0; yi < yPositions.length; yi++) {
    const y = yPositions[yi];
    for (let xi = 0; xi < xPositions.length; xi++) {
      const x = xPositions[xi];

      tiles.push({
        index: index++,
        x,
        y,
        width: effectiveTileW,
        height: effectiveTileH,
        hasLeftNeighbor: xi > 0,
        hasTopNeighbor: yi > 0,
        hasRightNeighbor: xi < xPositions.length - 1,
        hasBottomNeighbor: yi < yPositions.length - 1,
      });
    }
  }

  return tiles;
}

/**
 * Extracts RGBA pixel data for a specific tile from the source image buffer.
 */
export function extractTileRgba(
  sourceRgba: Uint8ClampedArray,
  imgWidth: number,
  imgHeight: number,
  tile: TileBounds,
): Uint8ClampedArray {
  const tileRgba = new Uint8ClampedArray(tile.width * tile.height * 4);

  for (let row = 0; row < tile.height; row++) {
    const srcY = tile.y + row;
    if (srcY >= imgHeight) break;

    const srcOffset = (srcY * imgWidth + tile.x) * 4;
    const destOffset = row * tile.width * 4;
    const bytesToCopy = tile.width * 4;

    tileRgba.set(sourceRgba.subarray(srcOffset, srcOffset + bytesToCopy), destOffset);
  }

  return tileRgba;
}

/**
 * Generates a 2D cosine (Hann) window for feathering seams between overlapping tiles.
 *
 * Uses cosine bell curves along overlapping borders so the sum of weights
 * across overlapping tiles is smooth and artifact-free.
 */
export function generateCosineWeightMask(
  width: number,
  height: number,
  overlap: number,
  hasLeft: boolean,
  hasTop: boolean,
  hasRight: boolean,
  hasBottom: boolean,
): Float32Array {
  const weights = new Float32Array(width * height);
  const effectiveOverlap = Math.max(1, Math.min(overlap, Math.floor(Math.min(width, height) / 2)));

  // Precompute 1D weights
  const weightX = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let wx = 1.0;
    if (hasLeft && x < effectiveOverlap) {
      wx *= 0.5 * (1 - Math.cos((Math.PI * (x + 0.5)) / effectiveOverlap));
    }
    if (hasRight && x >= width - effectiveOverlap) {
      const dist = width - 1 - x;
      wx *= 0.5 * (1 - Math.cos((Math.PI * (dist + 0.5)) / effectiveOverlap));
    }
    weightX[x] = wx;
  }

  const weightY = new Float32Array(height);
  for (let y = 0; y < height; y++) {
    let wy = 1.0;
    if (hasTop && y < effectiveOverlap) {
      wy *= 0.5 * (1 - Math.cos((Math.PI * (y + 0.5)) / effectiveOverlap));
    }
    if (hasBottom && y >= height - effectiveOverlap) {
      const dist = height - 1 - y;
      wy *= 0.5 * (1 - Math.cos((Math.PI * (dist + 0.5)) / effectiveOverlap));
    }
    weightY[y] = wy;
  }

  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    const wy = weightY[y];
    for (let x = 0; x < width; x++) {
      weights[rowOffset + x] = weightX[x] * wy;
    }
  }

  return weights;
}

export interface ScaledTileResult {
  tile: TileBounds;
  scaledRgba: Uint8ClampedArray;
  scale: number;
}

/**
 * Merges upscaled tiles into the final high-resolution image buffer.
 * Normalizes all pixel values using the accumulated cosine weight matrix,
 * completely eliminating tile seam artifacts.
 */
export function stitchTiles(
  outputWidth: number,
  outputHeight: number,
  tiles: ScaledTileResult[],
  overlap: number = 32,
): Uint8ClampedArray {
  const pixelCount = outputWidth * outputHeight;

  // Use Float64 accumulators to prevent rounding drift during multi-tile accumulation
  const accumR = new Float64Array(pixelCount);
  const accumG = new Float64Array(pixelCount);
  const accumB = new Float64Array(pixelCount);
  const accumA = new Float64Array(pixelCount);
  const accumW = new Float32Array(pixelCount);

  for (const item of tiles) {
    const { tile, scaledRgba, scale } = item;
    const scaledTileW = Math.round(tile.width * scale);
    const scaledTileH = Math.round(tile.height * scale);
    const scaledTileX = Math.round(tile.x * scale);
    const scaledTileY = Math.round(tile.y * scale);
    const scaledOverlap = Math.round(overlap * scale);

    const weights = generateCosineWeightMask(
      scaledTileW,
      scaledTileH,
      scaledOverlap,
      tile.hasLeftNeighbor,
      tile.hasTopNeighbor,
      tile.hasRightNeighbor,
      tile.hasBottomNeighbor,
    );

    for (let ty = 0; ty < scaledTileH; ty++) {
      const outY = scaledTileY + ty;
      if (outY >= outputHeight) continue;

      const tileRowOffset = ty * scaledTileW;
      const outRowOffset = outY * outputWidth;

      for (let tx = 0; tx < scaledTileW; tx++) {
        const outX = scaledTileX + tx;
        if (outX >= outputWidth) continue;

        const tilePixelIdx = tileRowOffset + tx;
        const outPixelIdx = outRowOffset + outX;
        const w = weights[tilePixelIdx];

        if (w <= 0.00001) continue;

        const r = scaledRgba[tilePixelIdx * 4];
        const g = scaledRgba[tilePixelIdx * 4 + 1];
        const b = scaledRgba[tilePixelIdx * 4 + 2];
        const a = scaledRgba[tilePixelIdx * 4 + 3];

        accumR[outPixelIdx] += r * w;
        accumG[outPixelIdx] += g * w;
        accumB[outPixelIdx] += b * w;
        accumA[outPixelIdx] += a * w;
        accumW[outPixelIdx] += w;
      }
    }
  }

  // Final normalization and clamp into Uint8ClampedArray
  const finalRgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    const weight = accumW[i];
    const norm = weight > 0 ? 1 / weight : 1;

    finalRgba[i * 4] = Math.round(accumR[i] * norm);
    finalRgba[i * 4 + 1] = Math.round(accumG[i] * norm);
    finalRgba[i * 4 + 2] = Math.round(accumB[i] * norm);
    finalRgba[i * 4 + 3] = Math.round(accumA[i] * norm);
  }

  return finalRgba;
}
