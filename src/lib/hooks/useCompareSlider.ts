import { useRef, useCallback, useEffect } from 'react';

/**
 * High-performance comparison slider hook.
 *
 * Directly mutates the container's CSS custom property `--split` via PointerEvents.
 * Completely avoids React state churn and component re-renders during 60 FPS slider drag.
 */
export function useCompareSlider(initialPercent: number = 50) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);

  const updateSplit = useCallback((clientX: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width === 0) return;

    const clampedX = Math.max(0, Math.min(clientX - rect.left, rect.width));
    const percent = Math.max(0, Math.min(100, (clampedX / rect.width) * 100));
    containerRef.current.style.setProperty('--split', `${percent.toFixed(2)}%`);
  }, []);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      isDraggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      updateSplit(e.clientX);
    },
    [updateSplit],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isDraggingRef.current) return;
      updateSplit(e.clientX);
    },
    [updateSplit],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    isDraggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignored if capture already lost
    }
  }, []);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.style.setProperty('--split', `${initialPercent}%`);
    }
  }, [initialPercent]);

  return {
    containerRef,
    sliderProps: {
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerCancel: handlePointerUp,
    },
  };
}
