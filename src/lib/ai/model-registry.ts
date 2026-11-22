/**
 * Central Model Registry for Local AI Inference.
 *
 * Enforces strict license hygiene (P-01 to P-04 compliance):
 * All candidate models must have commercially clean licenses (MIT, Apache-2.0, BSD).
 * Non-commercial, AGPL, and restrictive models are strictly excluded.
 */

export type ModelTask = 'background-removal' | 'upscaling' | 'enhancement';
export type ExecutionBackend = 'webgpu' | 'wasm';
export type ModelLicense = 'MIT' | 'Apache-2.0' | 'BSD-3-Clause' | 'BSD-2-Clause';

export interface ModelMetadata {
  id: string;
  task: ModelTask;
  name: string;
  description: string;
  license: ModelLicense;
  licenseUrl: string;
  commercialAllowed: boolean;
  sizeBytes: number;
  formattedSize: string;
  preferredBackend: ExecutionBackend;
  fallbackBackend: ExecutionBackend;
  inputResolution: number; // e.g. 512 or 1024
  url: string;
  author: string;
}

/**
 * Permitted commercial-friendly licenses.
 */
export const ALLOWED_LICENSES: readonly ModelLicense[] = [
  'MIT',
  'Apache-2.0',
  'BSD-3-Clause',
  'BSD-2-Clause',
] as const;

/**
 * Registry of license-clean candidate models for browser execution.
 */
export const MODEL_REGISTRY: readonly ModelMetadata[] = [
  {
    id: 'birefnet-lite',
    task: 'background-removal',
    name: 'BiRefNet-lite',
    description: 'High-accuracy bilateral reference network for fine hair and edge segmentation.',
    license: 'MIT',
    licenseUrl: 'https://github.com/ZhengPeng7/BiRefNet/blob/main/LICENSE',
    commercialAllowed: true,
    sizeBytes: 38 * 1024 * 1024,
    formattedSize: '38 MB',
    preferredBackend: 'webgpu',
    fallbackBackend: 'wasm',
    inputResolution: 1024,
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/main/onnx/model_fp16.onnx',
    author: 'ZhengPeng7',
  },
  {
    id: 'modnet',
    task: 'background-removal',
    name: 'MODNet',
    description: 'Lightweight real-time portrait and object matting optimized for mobile & lower-end devices.',
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/ZHKKKe/MODNet/blob/master/LICENSE',
    commercialAllowed: true,
    sizeBytes: 25 * 1024 * 1024,
    formattedSize: '25 MB',
    preferredBackend: 'webgpu',
    fallbackBackend: 'wasm',
    inputResolution: 512,
    url: 'https://huggingface.co/Xenova/modnet/resolve/main/onnx/model_fp16.onnx',
    author: 'ZHKKKe',
  },
  {
    id: 'swin2sr-x4',
    task: 'upscaling',
    name: 'Swin2SR Real-World (4x)',
    description: 'Swin Transformer-based super-resolution for photographic detail restoration.',
    license: 'Apache-2.0',
    licenseUrl: 'https://github.com/mv-lab/swin2sr/blob/main/LICENSE',
    commercialAllowed: true,
    sizeBytes: 45 * 1024 * 1024,
    formattedSize: '45 MB',
    preferredBackend: 'webgpu',
    fallbackBackend: 'wasm',
    inputResolution: 512,
    url: 'https://huggingface.co/Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/main/onnx/model_fp16.onnx',
    author: 'mv-lab',
  },
  {
    id: 'realesrgan-compact',
    task: 'upscaling',
    name: 'Real-ESRGAN Compact',
    description: 'Fast, compact super-resolution model for anime, graphics, and lightweight photo scaling.',
    license: 'BSD-3-Clause',
    licenseUrl: 'https://github.com/xinntao/Real-ESRGAN/blob/master/LICENSE',
    commercialAllowed: true,
    sizeBytes: 16 * 1024 * 1024,
    formattedSize: '16 MB',
    preferredBackend: 'webgpu',
    fallbackBackend: 'wasm',
    inputResolution: 512,
    url: 'https://huggingface.co/onnx-community/realesrgan-compact/resolve/main/onnx/model.onnx',
    author: 'xinntao',
  },
] as const;

/**
 * Retrieve a model by its ID.
 */
export function getModelMetadata(id: string): ModelMetadata | undefined {
  return MODEL_REGISTRY.find((model) => model.id === id);
}

/**
 * Retrieve all models for a specific task.
 */
export function getModelsByTask(task: ModelTask): ModelMetadata[] {
  return MODEL_REGISTRY.filter((model) => model.task === task);
}

/**
 * Validates that a model possesses a commercial-clean license.
 */
export function isLicenseClean(model: ModelMetadata): boolean {
  return (
    model.commercialAllowed &&
    (ALLOWED_LICENSES as readonly string[]).includes(model.license)
  );
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
