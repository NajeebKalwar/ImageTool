import { useState, useCallback, useRef } from 'react';
import { ImageFileSchema } from '../schemas/image-file';

export interface LoadedImageInfo {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export function useImageFile(onImageLoaded: (info: LoadedImageInfo) => void) {
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = useCallback(
    (file: File) => {
      setError(null);

      const parsed = ImageFileSchema.safeParse(file);
      if (!parsed.success) {
        setError(parsed.error.issues[0]?.message ?? 'Invalid image file.');
        return;
      }

      const previewUrl = URL.createObjectURL(file);
      const img = new Image();

      img.onload = () => {
        onImageLoaded({
          file,
          previewUrl,
          width: img.naturalWidth,
          height: img.naturalHeight,
        });
      };

      img.onerror = () => {
        URL.revokeObjectURL(previewUrl);
        setError('Failed to decode image file. Please try another image.');
      };

      img.src = previewUrl;
    },
    [onImageLoaded],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files && files.length > 0) {
        processFile(files[0]);
      }
    },
    [processFile],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (files && files.length > 0) {
        processFile(files[0]);
      }
      // Reset input value so re-selecting the same file fires change event
      e.target.value = '';
    },
    [processFile],
  );

  const openFileDialog = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  return {
    isDragging,
    error,
    fileInputRef,
    openFileDialog,
    dropZoneProps: {
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
    fileInputProps: {
      ref: fileInputRef,
      type: 'file' as const,
      accept: 'image/png,image/jpeg,image/webp,image/avif',
      onChange: handleFileInputChange,
      className: 'hidden',
    },
    clearError: () => setError(null),
  };
}
