import { describe, it, expect, vi } from 'vitest';
import {
  createWorkflowToolRegistry,
  createRefineMaskTool,
  createResizeImageTool,
  createCompressImageTool,
  createRemoveBackgroundTool,
  createUpscaleImageTool,
  type ToolExecutionContext,
} from './tools';
import { executeWorkflow } from './engine';
import { WORKFLOW_RECIPES } from './recipes';
import type { WorkflowImageBuffer } from './types';

describe('LangChain Workflow Tools', () => {
  function makeBuffer(width = 4, height = 4): WorkflowImageBuffer {
    const pixels = new Uint8ClampedArray(width * height * 4);
    // Fill with solid red opaque pixels
    for (let i = 0; i < width * height; i++) {
      pixels[i * 4] = 255;
      pixels[i * 4 + 1] = 0;
      pixels[i * 4 + 2] = 0;
      pixels[i * 4 + 3] = 255;
    }
    const mask = new Uint8ClampedArray(width * height);
    mask.fill(200);
    return { width, height, pixels, mask };
  }

  it('creates registry with all 5 core tools', () => {
    const context: ToolExecutionContext = { buffer: makeBuffer() };
    const registry = createWorkflowToolRegistry(context);

    expect(registry).toHaveLength(5);
    const names = registry.map((t) => t.name);
    expect(names).toContain('remove_background');
    expect(names).toContain('upscale_image');
    expect(names).toContain('resize_image');
    expect(names).toContain('refine_mask');
    expect(names).toContain('compress_image');
  });

  it('executes refine_mask tool and updates alpha matte in context', async () => {
    const context: ToolExecutionContext = { buffer: makeBuffer(2, 2) };
    const tool = createRefineMaskTool(context);

    const result = await tool.invoke({ threshold: 50, edgeSoftness: 0 });
    expect(result).toContain('Refined alpha mask');
    expect(context.buffer.mask).toBeDefined();
    // Since original alpha was 200, and 50% threshold cutoff is ~127.5, value 200 should stay high (255)
    expect(context.buffer.mask![0]).toBe(255);
  });

  it('executes resize_image tool schema and updates target dimensions', async () => {
    const context: ToolExecutionContext = { buffer: makeBuffer(4, 4) };
    const tool = createResizeImageTool(context);

    const result = await tool.invoke({
      width: 800,
      height: 600,
      fit: 'contain',
      backgroundColor: '#ffffff',
    });

    expect(result).toContain('800×600 px');
    expect(context.buffer.width).toBe(800);
    expect(context.buffer.height).toBe(600);
  });

  it('executes compress_image tool schema and returns target encoding', async () => {
    const context: ToolExecutionContext = { buffer: makeBuffer(4, 4) };
    const tool = createCompressImageTool(context);

    const result = await tool.invoke({ format: 'webp', quality: 90 });
    expect(result).toContain('format=webp');
    expect(result).toContain('quality=90%');
  });

  it('executes remove_background tool using mock worker client', async () => {
    const buffer = makeBuffer(2, 2);
    const mockWorkerClient = {
      removeBackground: vi.fn().mockResolvedValue({
        type: 'ai_result',
        id: 1,
        modelId: 'modnet',
        width: 2,
        height: 2,
        pixels: new ArrayBuffer(16),
        mask: new ArrayBuffer(4),
        durationMs: 42,
      }),
    };

    const context: ToolExecutionContext = {
      buffer,
      workerClient: mockWorkerClient as any,
    };

    const tool = createRemoveBackgroundTool(context);
    const result = await tool.invoke({ modelId: 'modnet' });

    expect(result).toContain('Successfully removed background using modnet');
    expect(mockWorkerClient.removeBackground).toHaveBeenCalledWith(
      'modnet',
      2,
      2,
      expect.any(ArrayBuffer),
      undefined,
      expect.any(Function),
    );
  });

  it('executes upscale_image tool using mock worker client', async () => {
    const buffer = makeBuffer(2, 2);
    const mockWorkerClient = {
      upscaleImage: vi.fn().mockResolvedValue({
        type: 'ai_upscale_result',
        id: 2,
        modelId: 'swin2sr-x2',
        scale: 2,
        width: 4,
        height: 4,
        pixels: new ArrayBuffer(64),
        durationMs: 120,
      }),
    };

    const context: ToolExecutionContext = {
      buffer,
      workerClient: mockWorkerClient as any,
    };

    const tool = createUpscaleImageTool(context);
    const result = await tool.invoke({ scale: '2' });

    expect(result).toContain('Successfully upscaled image 2x to 4×4 px');
    expect(context.buffer.width).toBe(4);
    expect(context.buffer.height).toBe(4);
  });

  it('executes compound recipe workflow through executeWorkflow engine', async () => {
    const recipe = WORKFLOW_RECIPES[0]; // E-Commerce Studio
    const initialBuffer = makeBuffer(2, 2);

    const mockWorkerClient = {
      removeBackground: vi.fn().mockResolvedValue({
        type: 'ai_result',
        id: 1,
        modelId: 'birefnet-lite',
        width: 2,
        height: 2,
        pixels: new ArrayBuffer(16),
        mask: new ArrayBuffer(4),
        durationMs: 50,
      }),
    };

    const progressLogs: string[] = [];
    const result = await executeWorkflow({
      steps: [...recipe.steps],
      initialBuffer,
      workerClient: mockWorkerClient as any,
      onProgress: (p) => {
        progressLogs.push(`${p.stepName}: ${p.percent}%`);
      },
    });

    expect(result.success).toBe(true);
    expect(result.executedSteps).toHaveLength(3);
    expect(result.executedSteps.every((s) => s.status === 'completed')).toBe(true);
    expect(result.finalBuffer.width).toBe(1200);
    expect(result.finalBuffer.height).toBe(1200);
  });
});
