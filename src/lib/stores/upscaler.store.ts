import { create } from 'zustand';

export type UpscalerStatus = 'idle' | 'loading-model' | 'processing' | 'done' | 'error';

export interface SourceImageMeta {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export interface UpscaleResultMeta {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface UpscaleProgressState {
  stage: string;
  percent: number;
  currentTile?: number;
  totalTiles?: number;
  loadedBytes?: number;
  totalBytes?: number;
}

interface UpscalerState {
  status: UpscalerStatus;
  source: SourceImageMeta | null;
  result: UpscaleResultMeta | null;
  scale: 2 | 4;
  selectedModelId: string;
  progress: UpscaleProgressState;
  error: string | null;

  // Actions
  setSource: (source: SourceImageMeta | null) => void;
  setScale: (scale: 2 | 4) => void;
  setProgress: (progress: Partial<UpscaleProgressState>) => void;
  setResult: (result: UpscaleResultMeta | null) => void;
  setStatus: (status: UpscalerStatus) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useUpscalerStore = create<UpscalerState>((set) => ({
  status: 'idle',
  source: null,
  result: null,
  scale: 2,
  selectedModelId: 'swin2sr-x2',
  progress: { stage: 'idle', percent: 0 },
  error: null,

  setSource: (source) =>
    set((state) => {
      if (state.source?.previewUrl) {
        URL.revokeObjectURL(state.source.previewUrl);
      }
      if (state.result?.url) {
        URL.revokeObjectURL(state.result.url);
      }
      return {
        source,
        result: null,
        status: source ? 'idle' : 'idle',
        error: null,
        progress: { stage: 'idle', percent: 0 },
      };
    }),

  setScale: (scale) =>
    set({
      scale,
      selectedModelId: scale === 4 ? 'swin2sr-x4' : 'swin2sr-x2',
    }),

  setProgress: (progress) =>
    set((state) => ({
      progress: { ...state.progress, ...progress },
    })),

  setResult: (result) =>
    set((state) => {
      if (state.result?.url && state.result.url !== result?.url) {
        URL.revokeObjectURL(state.result.url);
      }
      return { result, status: 'done', error: null };
    }),

  setStatus: (status) => set({ status }),

  setError: (error) => set({ error, status: 'error' }),

  reset: () =>
    set((state) => {
      if (state.source?.previewUrl) {
        URL.revokeObjectURL(state.source.previewUrl);
      }
      if (state.result?.url) {
        URL.revokeObjectURL(state.result.url);
      }
      return {
        status: 'idle',
        source: null,
        result: null,
        progress: { stage: 'idle', percent: 0 },
        error: null,
      };
    }),
}));
