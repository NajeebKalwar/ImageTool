import { create } from 'zustand';
import { DEFAULT_BG_REMOVER_SYSTEM_PROMPT } from '../workflow/bg-prompt-planner';

export type BackgroundRemoverStatus = 'idle' | 'loading-model' | 'processing' | 'done' | 'error';
export type PreviewBgMode = 'transparent' | 'white' | 'black' | 'custom';
export type SubjectCategory = 'auto' | 'portrait' | 'fine-edge' | 'product' | 'graphic';
export type BrushMode = 'none' | 'restore' | 'erase';

export interface RefinementSettings {
  threshold: number; // 0 (natural matte) to 100 (binary cutoff)
  edgeSoftness: number; // 0 to 20 px feather
  brushMode: BrushMode;
  brushSize: number; // 5 to 80 px
}

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
  mask?: Uint8ClampedArray;
  durationMs: number;
}

export interface BackgroundProgressState {
  stage: string;
  percent: number;
  loadedBytes?: number;
  totalBytes?: number;
}

const DEFAULT_REFINEMENT: RefinementSettings = {
  threshold: 0,
  edgeSoftness: 0,
  brushMode: 'none',
  brushSize: 30,
};

interface BackgroundRemoverState {
  status: BackgroundRemoverStatus;
  source: SourceImageMeta | null;
  result: BackgroundResultMeta | null;
  selectedModelId: 'modnet' | 'birefnet-lite';
  subjectCategory: SubjectCategory;
  systemPrompt: string;
  userPrompt: string;
  promptPlanNote: string | null;
  previewBg: PreviewBgMode;
  customBgColor: string;
  progress: BackgroundProgressState;
  refinement: RefinementSettings;
  error: string | null;

  // Actions
  setSource: (source: SourceImageMeta | null) => void;
  setModelId: (modelId: 'modnet' | 'birefnet-lite') => void;
  setSubjectCategory: (category: SubjectCategory) => void;
  setSystemPrompt: (systemPrompt: string) => void;
  resetSystemPrompt: () => void;
  setUserPrompt: (userPrompt: string) => void;
  setPromptPlanNote: (note: string | null) => void;
  setPreviewBg: (mode: PreviewBgMode) => void;
  setCustomBgColor: (color: string) => void;
  setProgress: (progress: Partial<BackgroundProgressState>) => void;
  setResult: (result: BackgroundResultMeta | null) => void;
  setRefinement: (settings: Partial<RefinementSettings>) => void;
  resetRefinement: () => void;
  setStatus: (status: BackgroundRemoverStatus) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

export const useBackgroundRemoverStore = create<BackgroundRemoverState>((set) => ({
  status: 'idle',
  source: null,
  result: null,
  selectedModelId: 'birefnet-lite',
  subjectCategory: 'auto',
  systemPrompt: DEFAULT_BG_REMOVER_SYSTEM_PROMPT,
  userPrompt: '',
  promptPlanNote: null,
  previewBg: 'transparent',
  customBgColor: '#3b82f6',
  progress: { stage: 'idle', percent: 0 },
  refinement: { ...DEFAULT_REFINEMENT },
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
        refinement: { ...DEFAULT_REFINEMENT },
      };
    }),

  setModelId: (selectedModelId) => set({ selectedModelId }),

  setSubjectCategory: (subjectCategory) => set({ subjectCategory }),

  setSystemPrompt: (systemPrompt) => set({ systemPrompt }),

  resetSystemPrompt: () => set({ systemPrompt: DEFAULT_BG_REMOVER_SYSTEM_PROMPT }),

  setUserPrompt: (userPrompt) => set({ userPrompt }),

  setPromptPlanNote: (promptPlanNote) => set({ promptPlanNote }),

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

  setRefinement: (settings) =>
    set((state) => ({
      refinement: { ...state.refinement, ...settings },
    })),

  resetRefinement: () => set({ refinement: { ...DEFAULT_REFINEMENT } }),

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
        refinement: { ...DEFAULT_REFINEMENT },
        error: null,
      };
    }),
}));
