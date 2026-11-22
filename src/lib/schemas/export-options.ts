import { z } from 'zod';

export const ExportOptionsSchema = z.object({
  format: z.enum(['image/png', 'image/jpeg', 'image/webp']).default('image/png'),
  quality: z.number().min(0.01).max(1.0).default(0.92),
});

export type ExportOptions = z.infer<typeof ExportOptionsSchema>;
