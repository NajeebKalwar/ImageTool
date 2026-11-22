import { describe, it, expect } from 'vitest';
import { env } from './transformers-env';

describe('transformers-env', () => {
  it('disallows local model filesystem access and enables browser caching', () => {
    expect(env.allowLocalModels).toBe(false);
    expect(env.useBrowserCache).toBe(true);
  });

  it('has a valid remote host and path template configured', () => {
    expect(typeof env.remoteHost).toBe('string');
    expect(env.remoteHost.length).toBeGreaterThan(0);
    expect(env.remoteHost.endsWith('/')).toBe(true);

    expect(typeof env.remotePathTemplate).toBe('string');
    expect(env.remotePathTemplate).toContain('{model}');
  });
});
