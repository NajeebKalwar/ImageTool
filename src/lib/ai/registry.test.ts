import { describe, it, expect } from 'vitest';
import {
  MODELS,
  getModelMetadata,
  getModelsByTask,
  isLicenseClean,
  RESTRICTED_MODELS,
} from './registry';

describe('AI Registry', () => {
  it('contains the approved v1 models', () => {
    expect(MODELS.length).toBeGreaterThanOrEqual(4);
    const ids = MODELS.map((m) => m.id);
    expect(ids).toContain('swin2sr-x2');
    expect(ids).toContain('swin2sr-x4');
    expect(ids).toContain('modnet');
    expect(ids).toContain('birefnet-lite');
  });

  it('all registered models pass commercial license validation', () => {
    for (const model of MODELS) {
      expect(isLicenseClean(model)).toBe(true);
      expect(['MIT', 'Apache-2.0', 'BSD-3-Clause']).toContain(model.license);
    }
  });

  it('filters models correctly by task', () => {
    const upscalers = getModelsByTask('upscaling');
    expect(upscalers.length).toBe(2);
    expect(upscalers.every((m) => m.task === 'upscaling')).toBe(true);

    const bgRemovers = getModelsByTask('background-removal');
    expect(bgRemovers.length).toBe(2);
    expect(bgRemovers.every((m) => m.task === 'background-removal')).toBe(true);
  });

  it('retrieves model by ID', () => {
    const modnet = getModelMetadata('modnet');
    expect(modnet).toBeDefined();
    expect(modnet?.repo).toBe('Xenova/modnet');
    expect(modnet?.pipeline).toBe('background-removal');

    const unknown = getModelMetadata('unknown-model');
    expect(unknown).toBeUndefined();
  });

  it('retains explicit blocklist for non-commercial models', () => {
    const restrictedIds = RESTRICTED_MODELS.map((m) => m.id);
    expect(restrictedIds).toContain('RMBG-2.0');
    expect(restrictedIds).toContain('RMBG-1.4');
    expect(restrictedIds).toContain('CodeFormer');
    expect(restrictedIds).toContain('ISNet');
  });
});
