/**
 * Strongly-Typed Error Classes for AI Operations.
 */

export type AppErrorCode =
  | 'CANCELLED'
  | 'MODEL_LOAD_FAILED'
  | 'OUT_OF_MEMORY'
  | 'UNSUPPORTED_IMAGE'
  | 'TIMEOUT'
  | 'WORKER_CRASHED'
  | 'UNKNOWN';

export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly recoverable: boolean;
  readonly suggestion?: string;

  constructor(
    message: string,
    code: AppErrorCode,
    recoverable: boolean = true,
    suggestion?: string,
  ) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.recoverable = recoverable;
    this.suggestion = suggestion;
  }
}

export class CancelledError extends AppError {
  constructor(message: string = 'Operation cancelled by user') {
    super(message, 'CANCELLED', true, 'You can start a new processing task at any time.');
    this.name = 'CancelledError';
  }
}

export class ModelLoadError extends AppError {
  constructor(
    modelId: string,
    reason?: string,
    suggestion: string = 'Check your internet connection and try reloading the model.',
  ) {
    super(
      `Failed to load AI model '${modelId}'${reason ? `: ${reason}` : ''}`,
      'MODEL_LOAD_FAILED',
      true,
      suggestion,
    );
    this.name = 'ModelLoadError';
  }
}

export class OutOfMemoryError extends AppError {
  constructor(
    details: string,
    suggestion: string = 'Try processing a smaller image or reducing the upscale scale factor.',
  ) {
    super(
      `Device out of memory: ${details}`,
      'OUT_OF_MEMORY',
      false,
      suggestion,
    );
    this.name = 'OutOfMemoryError';
  }
}

export class UnsupportedImageError extends AppError {
  constructor(
    details: string,
    suggestion: string = 'Please upload a valid PNG, JPEG, or WebP image.',
  ) {
    super(
      `Unsupported image format or dimension: ${details}`,
      'UNSUPPORTED_IMAGE',
      true,
      suggestion,
    );
    this.name = 'UnsupportedImageError';
  }
}

/**
 * Maps arbitrary worker error messages or errors to a typed AppError.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) {
    return error;
  }

  const msg = error instanceof Error ? error.message : String(error);

  if (msg.toLowerCase().includes('cancel')) {
    return new CancelledError(msg);
  }

  if (
    msg.toLowerCase().includes('out of memory') ||
    msg.toLowerCase().includes('oom') ||
    msg.toLowerCase().includes('exceeds max_pixels') ||
    msg.toLowerCase().includes('memory limit')
  ) {
    return new OutOfMemoryError(msg);
  }

  if (
    msg.toLowerCase().includes('model') &&
    (msg.toLowerCase().includes('load') ||
      msg.toLowerCase().includes('download') ||
      msg.toLowerCase().includes('fetch'))
  ) {
    return new ModelLoadError('model', msg);
  }

  if (
    msg.toLowerCase().includes('unsupported') ||
    msg.toLowerCase().includes('invalid image') ||
    msg.toLowerCase().includes('corrupted')
  ) {
    return new UnsupportedImageError(msg);
  }

  return new AppError(msg, 'UNKNOWN', true, 'Please try again or select a different image.');
}
