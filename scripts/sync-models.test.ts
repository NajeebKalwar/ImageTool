import { describe, it, expect } from 'vitest';
import { computeSha256, SYNC_MODELS } from './sync-models';

describe('sync-models', () => {
  it('correctly computes SHA-256 digests', () => {
    const testBuf = Buffer.from('ImageTool Model Sync Test');
    const sha = computeSha256(testBuf);
    expect(typeof sha).toBe('string');
    expect(sha.length).toBe(64);
  });

  it('defines the required v1 models with pinned revisions and files', () => {
    expect(SYNC_MODELS.length).toBe(4);

    const modelIds = SYNC_MODELS.map((m) => m.id);
    expect(modelIds).toContain('swin2sr-x2');
    expect(modelIds).toContain('swin2sr-x4');
    expect(modelIds).toContain('modnet');
    expect(modelIds).toContain('birefnet-lite');

    for (const model of SYNC_MODELS) {
      expect(model.repo).toBeTruthy();
      expect(model.revision.length).toBeGreaterThan(0);
      expect(model.files.length).toBeGreaterThanOrEqual(3);
      expect(model.files).toContain('config.json');
      expect(model.files).toContain('preprocessor_config.json');
      expect(model.files.some((f) => f.startsWith('onnx/'))).toBe(true);
    }
  });
});
