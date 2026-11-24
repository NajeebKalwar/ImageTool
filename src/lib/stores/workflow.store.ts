/**
 * Zustand Store for the LangChain Image Workflow Engine.
 */

import { create } from 'zustand';
import type {
  WorkflowStepExecution,
  WorkflowExecutionProgress,
} from '../workflow/types';
import { WORKFLOW_RECIPES } from '../workflow/recipes';

export interface SourceImageMeta {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

interface WorkflowState {
  source: SourceImageMeta | null;
  activeRecipeId: string;
  steps: WorkflowStepExecution[];
  status: 'idle' | 'running' | 'completed' | 'error';
  progress: WorkflowExecutionProgress;
  resultBlob: Blob | null;
  resultUrl: string | null;
  error: string | null;
  userPrompt: string;
  byokApiKey: string;

  // Actions
  setSource: (source: SourceImageMeta | null) => void;
  selectRecipe: (recipeId: string) => void;
  setSteps: (steps: WorkflowStepExecution[]) => void;
  updateStepParam: (stepIndex: number, paramKey: string, value: unknown) => void;
  setUserPrompt: (prompt: string) => void;
  setByokApiKey: (key: string) => void;
  setStatus: (status: 'idle' | 'running' | 'completed' | 'error') => void;
  setProgress: (progress: Partial<WorkflowExecutionProgress>) => void;
  setResult: (blob: Blob, url: string) => void;
  setError: (error: string | null) => void;
  reset: () => void;
}

const defaultRecipe = WORKFLOW_RECIPES[0];

export const useWorkflowStore = create<WorkflowState>((set) => ({
  source: null,
  activeRecipeId: defaultRecipe.id,
  steps: defaultRecipe.steps.map((s) => ({ ...s, status: 'pending' })),
  status: 'idle',
  progress: {
    currentStepIndex: 0,
    totalSteps: defaultRecipe.steps.length,
    stepName: '',
    stage: 'idle',
    percent: 0,
  },
  resultBlob: null,
  resultUrl: null,
  error: null,
  userPrompt: '',
  byokApiKey: '',

  setSource: (source) =>
    set((state) => {
      if (state.source?.previewUrl) {
        URL.revokeObjectURL(state.source.previewUrl);
      }
      if (state.resultUrl) {
        URL.revokeObjectURL(state.resultUrl);
      }
      return {
        source,
        resultBlob: null,
        resultUrl: null,
        status: 'idle',
        error: null,
      };
    }),

  selectRecipe: (recipeId) =>
    set(() => {
      const recipe = WORKFLOW_RECIPES.find((r) => r.id === recipeId) ?? defaultRecipe;
      return {
        activeRecipeId: recipe.id,
        steps: recipe.steps.map((s) => ({ ...s, status: 'pending' })),
        progress: {
          currentStepIndex: 0,
          totalSteps: recipe.steps.length,
          stepName: '',
          stage: 'idle',
          percent: 0,
        },
        resultBlob: null,
        resultUrl: null,
        status: 'idle',
      };
    }),

  setSteps: (steps) => set({ steps }),

  updateStepParam: (stepIndex, paramKey, value) =>
    set((state) => {
      const nextSteps = [...state.steps];
      if (nextSteps[stepIndex]) {
        nextSteps[stepIndex] = {
          ...nextSteps[stepIndex],
          params: {
            ...nextSteps[stepIndex].params,
            [paramKey]: value,
          },
        };
      }
      return { steps: nextSteps };
    }),

  setUserPrompt: (userPrompt) => set({ userPrompt }),

  setByokApiKey: (byokApiKey) => set({ byokApiKey }),

  setStatus: (status) => set({ status }),

  setProgress: (progress) =>
    set((state) => ({
      progress: { ...state.progress, ...progress },
    })),

  setResult: (blob, url) =>
    set((state) => {
      if (state.resultUrl && state.resultUrl !== url) {
        URL.revokeObjectURL(state.resultUrl);
      }
      return { resultBlob: blob, resultUrl: url, status: 'completed', error: null };
    }),

  setError: (error) => set({ error, status: error ? 'error' : 'idle' }),

  reset: () =>
    set((state) => {
      if (state.source?.previewUrl) URL.revokeObjectURL(state.source.previewUrl);
      if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
      return {
        source: null,
        resultBlob: null,
        resultUrl: null,
        status: 'idle',
        error: null,
        steps: defaultRecipe.steps.map((s) => ({ ...s, status: 'pending' })),
      };
    }),
}));
