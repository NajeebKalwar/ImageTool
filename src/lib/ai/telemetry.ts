/**
 * Lightweight, Privacy-First Telemetry and Observability for On-Device AI.
 *
 * Records only performance metrics, error categories, and device capabilities.
 * Zero image data, pixels, or user-identifying attributes are logged or transmitted.
 */

export interface AiExecutionMetric {
  task: 'background-removal' | 'upscaling';
  modelId: string;
  backend: 'webgpu' | 'wasm';
  dtype?: string;
  width: number;
  height: number;
  megapixels: number;
  durationMs: number;
  success: boolean;
  fallbackTriggered?: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export function logAiExecution(metric: AiExecutionMetric): void {
  const timestamp = new Date().toISOString();
  const summary = `[AI Telemetry] ${metric.task} | model=${metric.modelId} | backend=${metric.backend}` +
    (metric.dtype ? ` dtype=${metric.dtype}` : '') + ' | ' +
    `${metric.width}x${metric.height} (${metric.megapixels.toFixed(2)} MP) | ` +
    `${metric.durationMs.toFixed(0)}ms | success=${metric.success}` +
    (metric.fallbackTriggered ? ' | fallback=true' : '') +
    (metric.errorCode ? ` | error=${metric.errorCode}` : '');

  if (metric.success) {
    console.info(summary, { timestamp, ...metric });
  } else {
    console.error(summary, { timestamp, ...metric });
  }
}
