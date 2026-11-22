import { describe, it, expect } from 'vitest';
import {
  AppError,
  CancelledError,
  ModelLoadError,
  OutOfMemoryError,
  UnsupportedImageError,
  toAppError,
} from './errors';

describe('AI Errors', () => {
  it('creates strongly-typed error instances', () => {
    const cancel = new CancelledError();
    expect(cancel).toBeInstanceOf(AppError);
    expect(cancel.code).toBe('CANCELLED');
    expect(cancel.recoverable).toBe(true);

    const modelErr = new ModelLoadError('swin2sr-x4', 'Network 404');
    expect(modelErr.code).toBe('MODEL_LOAD_FAILED');
    expect(modelErr.message).toContain('swin2sr-x4');

    const oom = new OutOfMemoryError('Texture allocation failed');
    expect(oom.code).toBe('OUT_OF_MEMORY');
    expect(oom.recoverable).toBe(false);

    const unsupported = new UnsupportedImageError('GIF not supported');
    expect(unsupported.code).toBe('UNSUPPORTED_IMAGE');
  });

  it('maps string error messages to typed AppErrors', () => {
    const err1 = toAppError('Operation cancelled by signal');
    expect(err1).toBeInstanceOf(CancelledError);

    const err2 = toAppError('Failed to fetch model weights from host');
    expect(err2).toBeInstanceOf(ModelLoadError);

    const err3 = toAppError('Canvas exceeds MAX_PIXELS limit');
    expect(err3).toBeInstanceOf(OutOfMemoryError);

    const err4 = toAppError('Unsupported image buffer: corrupt header');
    expect(err4).toBeInstanceOf(UnsupportedImageError);

    const err5 = toAppError('Something else broke');
    expect(err5.code).toBe('UNKNOWN');
  });

  it('preserves existing AppError instances', () => {
    const custom = new OutOfMemoryError('OOM');
    expect(toAppError(custom)).toBe(custom);
  });
});
