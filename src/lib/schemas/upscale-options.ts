import { z } from 'zod';

export const UpscaleOptionsSchema = z.object({
  scale: z.union([z.literal(2), z.literal(4)]).default(2),
  modelId: z.string().min(1).optional(),
  denoise: z.boolean().default(false),
  faceEnhance: z.boolean().default(false),
  tileSize: z.number().int().positive().optional(),
  overlap: z.number().int().positive().optional(),
});

export type UpscaleFormOptions = z.infer<typeof UpscaleOptionsSchema>;
