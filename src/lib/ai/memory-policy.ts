/**
 * Memory Policy & Resource Limits for Local Browser AI.
 *
 * Prevents WebGPU, WASM, and Canvas tab crashes by evaluating image dimensions,
 * scale factors, and client device capabilities before running heavyweight
 * tensor workloads.
 */

export type DeviceTier = 'low' | 'medium' | 'high';

export interface DeviceMemoryLimits {
  tier: DeviceTier;
  /** Maximum safe canvas resolution in total pixels. */
  maxCanvasPixels: number;
  /** Maximum input image resolution for AI upscaling before rejection. */
  maxUpscaleInputPixels: number;
  /** Maximum output image resolution for AI upscaling. */
  maxUpscaleOutputPixels: number;
  /** Recommended tile dimension (width & height) in pixels. */
  recommendedTileSize: number;
  /** Max single dimension (width or height) supported by WebGL/WebGPU textures. */
  maxDimension: number;
}

export interface MemoryEstimation {
  inputPixels: number;
  outputPixels: number;
  outputWidth: number;
  outputHeight: number;
  inputBytes: number;
  outputBytes: number;
  peakWorkingBytes: number;
  isSafe: boolean;
  warning?: string;
  rejectionReason?: string;
}

/**
 * Default tier limits based on available memory and typical GPU constraints.
 */
export const TIER_LIMITS: Record<DeviceTier, DeviceMemoryLimits> = {
  low: {
    tier: 'low',
    maxCanvasPixels: 16_000_000, // 16 Megapixels (e.g. 4000x4000)
    maxUpscaleInputPixels: 2_500_000, // 2.5 MP (e.g. ~1600x1500)
    maxUpscaleOutputPixels: 16_000_000, // 16 MP (e.g. 4000x4000)
    recommendedTileSize: 256,
    maxDimension: 4096,
  },
  medium: {
    tier: 'medium',
    maxCanvasPixels: 25_000_000, // 25 Megapixels (5000x5000)
    maxUpscaleInputPixels: 6_000_000, // 6 MP (e.g. 3000x2000)
    maxUpscaleOutputPixels: 36_000_000, // 36 MP (e.g. 6000x6000)
    recommendedTileSize: 256,
    maxDimension: 8192,
  },
  high: {
    tier: 'high',
    maxCanvasPixels: 40_000_000, // 40 Megapixels
    maxUpscaleInputPixels: 12_000_000, // 12 MP (e.g. 4000x3000)
    maxUpscaleOutputPixels: 64_000_000, // 64 MP (8000x8000)
    recommendedTileSize: 512,
    maxDimension: 16384,
  },
};

/**
 * Detects device capability tier based on navigator.deviceMemory and hardwareConcurrency.
 * Safe to call in browser and Node environments.
 */
export function detectDeviceTier(overrideMemoryGb?: number): DeviceTier {
  let memoryGb = overrideMemoryGb;

  if (memoryGb === undefined && typeof navigator !== 'undefined') {
    // navigator.deviceMemory reports approximate RAM in GiB (e.g. 0.5, 1, 2, 4, 8)
    const nav = navigator as unknown as { deviceMemory?: number };
    if (typeof nav.deviceMemory === 'number') {
      memoryGb = nav.deviceMemory;
    }
  }

  if (memoryGb !== undefined) {
    if (memoryGb <= 2) return 'low';
    if (memoryGb <= 4) return 'medium';
    return 'high';
  }

  // Fallback heuristic: check CPU cores if deviceMemory is unavailable
  if (typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number') {
    if (navigator.hardwareConcurrency <= 4) return 'medium';
    return 'high';
  }

  return 'medium';
}

/**
 * Returns the active limits for the current environment or a specified tier.
 */
export function getDeviceMemoryLimits(tierOrMemoryGb?: DeviceTier | number): DeviceMemoryLimits {
  if (typeof tierOrMemoryGb === 'string') {
    return TIER_LIMITS[tierOrMemoryGb] || TIER_LIMITS.medium;
  }
  const tier = detectDeviceTier(tierOrMemoryGb);
  return TIER_LIMITS[tier];
}

/**
 * Estimates memory consumption for an upscaling operation and verifies against tier limits.
 */
export function estimateUpscaleMemory(
  width: number,
  height: number,
  scale: number,
  limits: DeviceMemoryLimits = TIER_LIMITS.medium,
  tileSize: number = limits.recommendedTileSize,
): MemoryEstimation {
  const inputPixels = width * height;
  const outputWidth = Math.round(width * scale);
  const outputHeight = Math.round(height * scale);
  const outputPixels = outputWidth * outputHeight;

  // Uncompressed RGBA = 4 bytes per pixel
  const inputBytes = inputPixels * 4;
  const outputBytes = outputPixels * 4;

  // Peak working memory:
  // 1. Input RGBA buffer
  // 2. Output RGBA accumulator
  // 3. Tile input tensor (float32 NCHW = 3 * tileSize^2 * 4 bytes)
  // 4. Tile output tensor (float32 NCHW = 3 * (tileSize * scale)^2 * 4 bytes)
  // 5. Normalization / weight accumulator
  const tileInputTensorBytes = 3 * tileSize * tileSize * 4;
  const tileOutputTensorBytes = 3 * (tileSize * scale) * (tileSize * scale) * 4;
  const peakWorkingBytes = inputBytes + outputBytes + tileInputTensorBytes + tileOutputTensorBytes + (outputPixels * 4);

  if (width > limits.maxDimension || height > limits.maxDimension) {
    return {
      inputPixels,
      outputPixels,
      outputWidth,
      outputHeight,
      inputBytes,
      outputBytes,
      peakWorkingBytes,
      isSafe: false,
      rejectionReason: `Input dimension (${Math.max(width, height)}px) exceeds maximum texture limit of ${limits.maxDimension}px.`,
    };
  }

  if (outputWidth > limits.maxDimension || outputHeight > limits.maxDimension) {
    return {
      inputPixels,
      outputPixels,
      outputWidth,
      outputHeight,
      inputBytes,
      outputBytes,
      peakWorkingBytes,
      isSafe: false,
      rejectionReason: `Output dimension (${Math.max(outputWidth, outputHeight)}px) exceeds maximum canvas limit of ${limits.maxDimension}px.`,
    };
  }

  if (inputPixels > limits.maxUpscaleInputPixels) {
    return {
      inputPixels,
      outputPixels,
      outputWidth,
      outputHeight,
      inputBytes,
      outputBytes,
      peakWorkingBytes,
      isSafe: false,
      rejectionReason: `Image resolution (${(inputPixels / 1_000_000).toFixed(1)} MP) exceeds maximum allowed input of ${(limits.maxUpscaleInputPixels / 1_000_000).toFixed(1)} MP for ${limits.tier} memory devices.`,
    };
  }

  if (outputPixels > limits.maxUpscaleOutputPixels) {
    return {
      inputPixels,
      outputPixels,
      outputWidth,
      outputHeight,
      inputBytes,
      outputBytes,
      peakWorkingBytes,
      isSafe: false,
      rejectionReason: `Target output resolution (${(outputPixels / 1_000_000).toFixed(1)} MP) exceeds device limit of ${(limits.maxUpscaleOutputPixels / 1_000_000).toFixed(1)} MP.`,
    };
  }

  // Warning thresholds (e.g. >= 60% of max limit)
  let warning: string | undefined;
  if (outputPixels >= limits.maxUpscaleOutputPixels * 0.6) {
    warning = `Large upscale (${outputWidth}×${outputHeight} px). Processing may take several seconds.`;
  }

  return {
    inputPixels,
    outputPixels,
    outputWidth,
    outputHeight,
    inputBytes,
    outputBytes,
    peakWorkingBytes,
    isSafe: true,
    warning,
  };
}
