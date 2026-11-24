/**
 * Client-side Mask Refinement Engine.
 *
 * Provides non-destructive, zero-latency adjustments to the retained alpha mask
 * without requiring re-execution of heavy neural network models.
 *
 * Capabilities:
 * - Dynamic threshold cutoff and contrast shaping.
 * - Separable 2D box-blur edge softening / feathering.
 * - Direct interactive foreground (restore) and background (erase) brush painting.
 * - Re-compositing refined masks against original RGBA source pixels.
 */

/**
 * Applies a threshold cutoff and contrast adjustment to a 1-channel alpha mask (0-255).
 * A threshold of 0 preserves the original soft continuous matte.
 * Thresholds > 0 apply a customizable cutoff boundary with controllable transition softness.
 */
export function applyMaskThreshold(
  baseMask: Uint8ClampedArray,
  threshold: number, // 0 to 100
): Uint8ClampedArray {
  const len = baseMask.length;
  const result = new Uint8ClampedArray(len);

  if (threshold <= 0) {
    result.set(baseMask);
    return result;
  }

  // Map 0-100 to an 8-bit cutoff threshold [0..255]
  const cutoff = (threshold / 100) * 255;
  const softness = 24; // Smooth transition width around the cutoff

  const lowBound = Math.max(0, cutoff - softness / 2);
  const highBound = Math.min(255, cutoff + softness / 2);
  const range = Math.max(1, highBound - lowBound);

  for (let i = 0; i < len; i++) {
    const val = baseMask[i];
    if (val <= lowBound) {
      result[i] = 0;
    } else if (val >= highBound) {
      result[i] = 255;
    } else {
      // Smooth Hermite interpolation between lowBound and highBound
      const t = (val - lowBound) / range;
      result[i] = Math.round((t * t * (3 - 2 * t)) * 255);
    }
  }

  return result;
}

/**
 * Fast separable 2D box blur applied to a 1-channel alpha mask for edge softening / feathering.
 */
export function applyEdgeSoftness(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number, // Blur radius in pixels (0 to 20)
): Uint8ClampedArray {
  if (radius <= 0 || width <= 0 || height <= 0) {
    const copy = new Uint8ClampedArray(mask.length);
    copy.set(mask);
    return copy;
  }

  const r = Math.min(Math.round(radius), 20);
  const size = width * height;
  const temp = new Float32Array(size);
  const output = new Uint8ClampedArray(size);
  const windowSize = 2 * r + 1;

  // Horizontal blur pass
  for (let y = 0; y < height; y++) {
    const rowOffset = y * width;
    let sum = 0;

    // Initialize window
    for (let i = -r; i <= r; i++) {
      const x = Math.min(Math.max(i, 0), width - 1);
      sum += mask[rowOffset + x];
    }
    temp[rowOffset] = sum / windowSize;

    // Slide window across row
    for (let x = 1; x < width; x++) {
      const xAdd = Math.min(x + r, width - 1);
      const xSub = Math.max(x - r - 1, 0);
      sum += mask[rowOffset + xAdd] - mask[rowOffset + xSub];
      temp[rowOffset + x] = sum / windowSize;
    }
  }

  // Vertical blur pass
  for (let x = 0; x < width; x++) {
    let sum = 0;

    // Initialize window
    for (let i = -r; i <= r; i++) {
      const y = Math.min(Math.max(i, 0), height - 1);
      sum += temp[y * width + x];
    }
    output[x] = Math.round(sum / windowSize);

    // Slide window down column
    for (let y = 1; y < height; y++) {
      const yAdd = Math.min(y + r, height - 1);
      const ySub = Math.max(y - r - 1, 0);
      sum += temp[yAdd * width + x] - temp[ySub * width + x];
      output[y * width + x] = Math.round(sum / windowSize);
    }
  }

  return output;
}

/**
 * Paints a circular brush stroke onto an alpha mask.
 * - 'restore': paints foreground (alpha -> 255)
 * - 'erase': removes foreground / reveals background (alpha -> 0)
 */
export function applyBrushStroke(
  mask: Uint8ClampedArray,
  width: number,
  height: number,
  centerX: number,
  centerY: number,
  radius: number,
  mode: 'restore' | 'erase',
): void {
  const r = Math.max(1, Math.round(radius));
  const rSquared = r * r;
  const targetAlpha = mode === 'restore' ? 255 : 0;

  const minX = Math.max(0, Math.floor(centerX - r));
  const maxX = Math.min(width - 1, Math.ceil(centerX + r));
  const minY = Math.max(0, Math.floor(centerY - r));
  const maxY = Math.min(height - 1, Math.ceil(centerY + r));

  for (let y = minY; y <= maxY; y++) {
    const dy = y - centerY;
    const dy2 = dy * dy;
    const rowOffset = y * width;

    for (let x = minX; x <= maxX; x++) {
      const dx = x - centerX;
      const dist2 = dx * dx + dy2;

      if (dist2 <= rSquared) {
        // Linear anti-aliasing feather on outer 20% of brush radius
        const dist = Math.sqrt(dist2);
        const featherStart = r * 0.8;
        let factor = 1.0;

        if (dist > featherStart && r > featherStart) {
          factor = 1.0 - (dist - featherStart) / (r - featherStart);
        }

        const idx = rowOffset + x;
        const currentAlpha = mask[idx];
        mask[idx] = Math.round(currentAlpha + (targetAlpha - currentAlpha) * factor);
      }
    }
  }
}

/**
 * Combines source RGBA pixels with a 1-channel alpha mask into a new transparent RGBA buffer.
 */
export function compositeMaskToRgba(
  sourceRgba: Uint8ClampedArray,
  mask: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const pixelCount = width * height;
  const result = new Uint8ClampedArray(pixelCount * 4);

  for (let i = 0; i < pixelCount; i++) {
    const pxOffset = i * 4;
    result[pxOffset] = sourceRgba[pxOffset];
    result[pxOffset + 1] = sourceRgba[pxOffset + 1];
    result[pxOffset + 2] = sourceRgba[pxOffset + 2];

    const srcA = sourceRgba[pxOffset + 3];
    const maskA = mask[i];
    result[pxOffset + 3] = Math.round((srcA * maskA) / 255);
  }

  return result;
}
