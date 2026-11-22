/**
 * Model Registry for Local Transformers.js AI Inference.
 *
 * Defines candidate models, supported tasks, execution dtypes,
 * download size estimates, and tile dimensions.
 */

export type ModelTask = 'upscaling' | 'background-removal' | 'assistant' | 'captioning';

export type PipelineType =
  | 'image-to-image'
  | 'background-removal'
  | 'image-segmentation'
  | 'text-generation'
  | 'image-to-text';

export type ModelLicense = 'MIT' | 'Apache-2.0' | 'BSD-3-Clause' | 'BSD-2-Clause';

export type WebGpuDtype = 'fp16' | 'fp32' | 'q8';
export type WasmDtype = 'q8' | 'q4' | 'fp32';

export interface ModelMetadata {
  id: string; // App ID, e.g. 'swin2sr-x4'
  repo: string; // Hugging Face repo ID, e.g. 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr'
  task: ModelTask;
  pipeline: PipelineType;
  scale?: 2 | 4; // Upscalers: fixed per model
  dtype: {
    webgpu: WebGpuDtype;
    wasm: WasmDtype;
  };
  approxDownloadBytes: {
    webgpu: number;
    wasm: number;
  };
  tile?: {
    webgpu: number;
    wasm: number;
    overlap: number;
  };
  license: ModelLicense;
  licenseUrl: string;
  name: string;
  description: string;
}

export const ALLOWED_LICENSES: readonly ModelLicense[] = [
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
] as const;

/**
 * v1 Model Registry: License-clean models for on-device browser inference.
 */
export const MODELS: readonly ModelMetadata[] = [
  {
    id: 'swin2sr-x2',
    repo: 'Xenova/swin2SR-classical-sr-x2-64',
    task: 'upscaling',
    pipeline: 'image-to-image',
    scale: 2,
    dtype: { webgpu: 'fp16', wasm: 'q8' },
    approxDownloadBytes: { webgpu: 32_428_109, wasm: 21_471_413 },
    tile: { webgpu: 256, wasm: 128, overlap: 32 },
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/mv-lab/swin2sr/blob/main/LICENSE',
    name: 'Swin2SR Classical (2x)',
    description: 'Swin Transformer super-resolution optimized for 2x scale photo and artwork reconstruction.',
  },
  {
    id: 'swin2sr-x4',
    repo: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    task: 'upscaling',
    pipeline: 'image-to-image',
    scale: 4,
    dtype: { webgpu: 'fp16', wasm: 'q8' },
    approxDownloadBytes: { webgpu: 32_357_522, wasm: 21_438_622 },
    tile: { webgpu: 256, wasm: 128, overlap: 32 },
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/mv-lab/swin2sr/blob/main/LICENSE',
    name: 'Swin2SR Real-World (4x)',
    description: 'Swin Transformer super-resolution for photographic detail restoration.',
  },
  {
    id: 'modnet',
    repo: 'Xenova/modnet',
    task: 'background-removal',
    pipeline: 'image-segmentation',
    dtype: { webgpu: 'fp16', wasm: 'q8' },
    approxDownloadBytes: { webgpu: 12_984_781, wasm: 6_632_188 },
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/ZHKKKe/MODNet/blob/master/LICENSE',
    name: 'MODNet Fast Matting',
    description: 'Lightweight real-time portrait and object matting optimized for mobile & lower-end devices.',
  },
  {
    id: 'birefnet-lite',
    repo: 'onnx-community/BiRefNet_lite-ONNX',
    task: 'background-removal',
    pipeline: 'image-segmentation',
    dtype: { webgpu: 'fp16', wasm: 'fp32' },
    approxDownloadBytes: { webgpu: 114_538_221, wasm: 224_005_088 },
    license: 'MIT',
    licenseUrl: 'https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE',
    name: 'BiRefNet-lite',
    description: 'High-accuracy bilateral reference network for fine hair and edge segmentation.',
  },
] as const;

/**
 * Retrieve model metadata by its ID.
 */
export function getModelMetadata(id: string): ModelMetadata | undefined {
  return MODELS.find((model) => model.id === id);
}

/**
 * Retrieve models filtered by task.
 */
export function getModelsByTask(task: ModelTask): ModelMetadata[] {
  return MODELS.filter((model) => model.task === task);
}

/**
 * Validates that a model possesses an approved commercial license.
 */
export function isLicenseClean(model: ModelMetadata): boolean {
  return (ALLOWED_LICENSES as readonly string[]).includes(model.license);
}

/**
 * Explicit blocklist of known non-commercial or restrictive models.
 */
export const RESTRICTED_MODELS: readonly { id: string; reason: string }[] = [
  { id: 'RMBG-2.0', reason: 'Non-commercial / CC-BY-NC license.' },
  { id: 'RMBG-1.4', reason: 'Non-commercial license restrictions.' },
  { id: 'CodeFormer', reason: 'S-Lab license prohibits commercial use.' },
  { id: 'ISNet', reason: 'U-2-Net non-commercial / restrictive derivative.' },
  { id: 'APISR', reason: 'Non-commercial research license.' },
] as const;
