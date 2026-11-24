/**
 * Types and interfaces for the LangChain-powered Image Workflow Engine.
 */

export type ToolName =
  | 'remove_background'
  | 'upscale_image'
  | 'resize_image'
  | 'refine_mask'
  | 'compress_image';

export interface WorkflowImageBuffer {
  width: number;
  height: number;
  pixels: Uint8ClampedArray; // RGBA 4 channels
  mask?: Uint8ClampedArray; // 1-channel alpha (0-255)
}

export interface WorkflowStepConfig {
  id: string;
  tool: ToolName;
  params: Record<string, unknown>;
  name: string;
  description: string;
}

export interface WorkflowStepExecution extends WorkflowStepConfig {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  durationMs?: number;
  error?: string;
  outputSummary?: string;
}

export interface WorkflowRecipe {
  id: string;
  title: string;
  badge: string;
  description: string;
  icon: string;
  steps: WorkflowStepConfig[];
}

export interface WorkflowExecutionProgress {
  currentStepIndex: number;
  totalSteps: number;
  stepName: string;
  stage: string;
  percent: number;
}
