/**
 * Inverts the red, green and blue channels of RGBA pixel data in place.
 * The alpha channel is left untouched.
 *
 * This operation is deliberately simple. Phase 2 uses it to verify
 * that image pixel data can travel to the worker and back.
 */
export function invertRgba(pixels: Uint8ClampedArray): void {
  for (let i = 0; i < pixels.length; i += 4) {
    // Invert red
    pixels[i] = 255 - pixels[i];

    // Invert green
    pixels[i + 1] = 255 - pixels[i + 1];

    // Invert blue
    pixels[i + 2] = 255 - pixels[i + 2];

    // Alpha (pixels[i + 3]) remains unchanged.
  }
}