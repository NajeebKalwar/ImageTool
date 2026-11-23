import { create } from 'zustand';

export type BackgroundRemoverStatus = 'idle' | 'loading-model' | 'processing' | 'done' | 'error';
export type PreviewBgMode = 'transparent' | 'white' | 'black' | 'custom';

export interface SourceImageMeta {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export interface BackgroundResultMeta {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  durationMs: number;
}

export interface BackgroundProgressState {
  stage: string;
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
}

interface BackgroundRemoverState {
  status: BackgroundRemoverStatus;
  source: SourceImageMeta | null;
  result: BackgroundResultMeta | null;
  selectedModelId: 'modnet' | 'birefnet-lite';
  previewBg: PreviewBgMode;
  customBgColor: string;
  progress: BackgroundProgressState;
  error: string | null;

  // Actions
  setSource: (source: SourceImageMeta | null) => void;
  setModelId: (modelId: 'modnet' | 'birefnet-lite') => void;
  setPreviewBg: (mode: PreviewBgMode) => void;
  setCustomBgColor: (color: string) => void;
  setProgress: (progress: Partial<BackgroundProgressState>) => void;
  setResult: (result: BackgroundResultMeta | null) => void;
  setStatus: (status: BackgroundRemoverStatus) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useBackgroundRemoverStore = create<BackgroundRemoverState>((set) => ({
  status: 'idle',
  source: null,
  result: null,
  selectedModelId: 'modnet',
  previewBg: 'transparent',
  customBgColor: '#3b82f6',
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

  setModelId: (selectedModelId) => set({ selectedModelId }),

  setPreviewBg: (previewBg) => set({ previewBg }),

  setCustomBgColor: (customBgColor) => set({ customBgColor }),

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
