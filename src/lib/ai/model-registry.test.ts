import { describe, expect, it } from 'vitest';
import {
  ALLOWED_LICENSES,
  MODEL_REGISTRY,
  RESTRICTED_MODELS,
  getModelMetadata,
  getModelsByTask,
  isLicenseClean,
} from './model-registry';

describe('Model Registry', () => {
  it('contains candidate models for required tasks', () => {
    expect(MODEL_REGISTRY.length).toBeGreaterThanOrEqual(4);

    const bgModels = getModelsByTask('background-removal');
    expect(bgModels.length).toBeGreaterThanOrEqual(2);
    expect(bgModels.map((m) => m.id)).toContain('birefnet-lite');
    expect(bgModels.map((m) => m.id)).toContain('modnet');

    const upscaleModels = getModelsByTask('upscaling');
    expect(upscaleModels.length).toBeGreaterThanOrEqual(2);
    expect(upscaleModels.map((m) => m.id)).toContain('swin2sr-x4');
    expect(upscaleModels.map((m) => m.id)).toContain('realesrgan-compact');
  });

  it('guarantees every registered model has a commercial-clean license', () => {
    MODEL_REGISTRY.forEach((model) => {
      expect(model.commercialAllowed).toBe(true);
      expect(ALLOWED_LICENSES).toContain(model.license);
      expect(isLicenseClean(model)).toBe(true);
      expect(model.sizeBytes).toBeGreaterThan(0);
      expect(model.url).toMatch(/^https:\/\//);
      expect(model.inputResolution).toBeGreaterThanOrEqual(256);
    });
  });

  it('retrieves model by ID', () => {
    const modnet = getModelMetadata('modnet');
    expect(modnet).toBeDefined();
    expect(modnet?.license).toBe('Apache-2.0');
    expect(modnet?.task).toBe('background-removal');
  });

  it('returns undefined for non-existent model', () => {
    expect(getModelMetadata('unknown-model')).toBeUndefined();
  });

  it('documents known restricted models in blocklist', () => {
    const ids = RESTRICTED_MODELS.map((m) => m.id);
    expect(ids).toContain('RMBG-2.0');
    expect(ids).toContain('CodeFormer');

    // Ensure none of the restricted models accidentally entered MODEL_REGISTRY
    MODEL_REGISTRY.forEach((registered) => {
      expect(ids).not.toContain(registered.id);
    });
  });
});
