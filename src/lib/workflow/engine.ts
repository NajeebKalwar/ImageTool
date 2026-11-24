/**
 * Workflow Execution Engine powered by LangChain tools.
 *
 * Coordinates execution of compound recipes or dynamic tool chains,
 * streaming progress, enforcing cancellation, and recording step metrics.
 */

import type {
  WorkflowImageBuffer,
  WorkflowStepConfig,
  WorkflowStepExecution,
  WorkflowExecutionProgress,
} from './types';
import type { ImageWorkerClient } from '../worker-client';
import {
  createWorkflowToolRegistry,
  type ToolExecutionContext,
} from './tools';

export interface ExecuteWorkflowOptions {
  steps: WorkflowStepConfig[];
  initialBuffer: WorkflowImageBuffer;
  workerClient?: ImageWorkerClient;
  onProgress?: (progress: WorkflowExecutionProgress) => void;
  onStepChange?: (steps: WorkflowStepExecution[]) => void;
  signal?: AbortSignal;
}

export interface WorkflowExecutionResult {
  success: boolean;
  finalBuffer: WorkflowImageBuffer;
  executedSteps: WorkflowStepExecution[];
  totalDurationMs: number;
  error?: string;
}

/**
 * Executes a sequence of workflow steps using LangChain tools.
 */
export async function executeWorkflow({
  steps,
  initialBuffer,
  workerClient,
  onProgress,
  onStepChange,
  signal,
}: ExecuteWorkflowOptions): Promise<WorkflowExecutionResult> {
  const startTime = performance.now();

  // Create mutable working buffer copy
  const workingBuffer: WorkflowImageBuffer = {
    width: initialBuffer.width,
    height: initialBuffer.height,
    pixels: new Uint8ClampedArray(initialBuffer.pixels),
    mask: initialBuffer.mask ? new Uint8ClampedArray(initialBuffer.mask) : undefined,
  };

  const originalPixels = new Uint8ClampedArray(initialBuffer.pixels);

  // Initialize execution track state
  const executedSteps: WorkflowStepExecution[] = steps.map((s) => ({
    ...s,
    status: 'pending',
  }));

  onStepChange?.([...executedSteps]);

  for (let i = 0; i < steps.length; i++) {
    if (signal?.aborted) {
      executedSteps[i].status = 'skipped';
      break;
    }

    const step = steps[i];
    const execStep = executedSteps[i];
    execStep.status = 'running';
    onStepChange?.([...executedSteps]);

    onProgress?.({
      currentStepIndex: i,
      totalSteps: steps.length,
      stepName: step.name,
      stage: 'running',
      percent: Math.round((i / steps.length) * 100),
    });

    const stepStartTime = performance.now();

    // Bind execution context to current buffer state
    const toolContext: ToolExecutionContext = {
      buffer: workingBuffer,
      originalPixels,
      workerClient,
      signal,
      onProgress: (stage, percent) => {
        onProgress?.({
          currentStepIndex: i,
          totalSteps: steps.length,
          stepName: step.name,
          stage,
          percent: Math.round(((i + percent / 100) / steps.length) * 100),
        });
      },
    };

    const toolRegistry = createWorkflowToolRegistry(toolContext);
    const targetTool = toolRegistry.find((t) => t.name === step.tool);

    if (!targetTool) {
      execStep.status = 'failed';
      execStep.error = `Tool '${step.tool}' not found in registry.`;
      onStepChange?.([...executedSteps]);
      return {
        success: false,
        finalBuffer: workingBuffer,
        executedSteps,
        totalDurationMs: performance.now() - startTime,
        error: execStep.error,
      };
    }

    try {
      // Execute via LangChain Tool interface
      const output = await (targetTool as any).invoke(step.params);
      execStep.status = 'completed';
      execStep.durationMs = Math.round(performance.now() - stepStartTime);
      execStep.outputSummary = typeof output === 'string' ? output : JSON.stringify(output);
      onStepChange?.([...executedSteps]);
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.message === 'Operation cancelled')) {
        execStep.status = 'skipped';
        execStep.error = 'Operation cancelled';
        onStepChange?.([...executedSteps]);
        return {
          success: false,
          finalBuffer: workingBuffer,
          executedSteps,
          totalDurationMs: performance.now() - startTime,
          error: 'Operation cancelled',
        };
      }

      execStep.status = 'failed';
      execStep.error = err instanceof Error ? err.message : String(err);
      onStepChange?.([...executedSteps]);

      return {
        success: false,
        finalBuffer: workingBuffer,
        executedSteps,
        totalDurationMs: performance.now() - startTime,
        error: execStep.error,
      };
    }
  }

  const totalDurationMs = Math.round(performance.now() - startTime);

  onProgress?.({
    currentStepIndex: steps.length,
    totalSteps: steps.length,
    stepName: 'Complete',
    stage: 'complete',
    percent: 100,
  });

  return {
    success: true,
    finalBuffer: workingBuffer,
    executedSteps,
    totalDurationMs,
  };
}
