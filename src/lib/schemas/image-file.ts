import { z } from 'zod';

export const SUPPORTED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
] as const;

export const MAX_IMAGE_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB

export const ImageFileSchema = z.custom<File>((val) => val instanceof File, {
  message: 'Input must be a valid File instance.',
})
  .refine((file) => file.size > 0, 'Image file cannot be empty.')
  .refine(
    (file) => file.size <= MAX_IMAGE_FILE_SIZE_BYTES,
    'Image file exceeds 50 MB limit.',
  )
  .refine(
    (file) =>
      SUPPORTED_MIME_TYPES.includes(file.type as (typeof SUPPORTED_MIME_TYPES)[number]) ||
      file.type.startsWith('image/'),
    'Unsupported image format. Please select PNG, JPEG, or WebP.',
  );

export type ValidatedImageFile = z.infer<typeof ImageFileSchema>;
