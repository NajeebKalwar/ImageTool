import { useEffect, useState, useRef, useCallback } from 'react';
import {
  useBackgroundRemoverStore,
  type PreviewBgMode,
  type SubjectCategory,
  type BrushMode,
} from '../lib/stores/bgremover.store';
import { useWorkerClient } from '../lib/hooks/useWorkerClient';
import { useImageFile } from '../lib/hooks/useImageFile';
import { detectDeviceCapabilities, type DeviceCapabilities } from '../lib/ai/device';
import { isModelCachedInBrowser } from '../lib/ai/browser-cache';
import { MODELS } from '../lib/ai/registry';
import { detectDeviceTier, TIER_LIMITS } from '../lib/ai/memory-policy';
import {
  applyMaskThreshold,
  applyEdgeSoftness,
  applyBrushStroke,
  compositeMaskToRgba,
} from '../lib/ai/mask-refinement';
import { planBackgroundRemovalFromPrompt } from '../lib/workflow/bg-prompt-planner';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SubjectGuidanceOption {
  id: SubjectCategory;
  title: string;
  recommendedModel: 'modnet' | 'birefnet-lite';
  badge: string;
  description: string;
  icon: string;
}

const SUBJECT_OPTIONS: readonly SubjectGuidanceOption[] = [
  {
    id: 'portrait',
    title: 'Portraits & People',
    recommendedModel: 'modnet',
    badge: 'Fastest (~12 MB)',
    description: 'Selfies, full-body humans, portrait photography.',
    icon: '👤',
  },
  {
    id: 'fine-edge',
    title: 'Hair, Fur & Intricate',
    recommendedModel: 'birefnet-lite',
    badge: 'High Detail (~114 MB)',
    description: 'Fine hair strands, pet fur, lace, and complex transparencies.',
    icon: '🐾',
  },
  {
    id: 'product',
    title: 'Objects & Architecture',
    recommendedModel: 'birefnet-lite',
    badge: 'High Precision',
    description: 'Buildings, monuments, vehicles, e-commerce products & furniture.',
    icon: '🏛️',
  },
  {
    id: 'graphic',
    title: 'Logos & Graphics',
    recommendedModel: 'modnet',
    badge: 'Crisp Cutout',
    description: 'Stickers, illustrations, badges, and high-contrast artwork.',
    icon: '🎨',
  },
] as const;

export default function BackgroundRemover() {
  const {
    status,
    source,
    result,
    selectedModelId,
    subjectCategory,
    systemPrompt,
    userPrompt,
    promptPlanNote,
    previewBg,
    customBgColor,
    progress,
    refinement,
    error,
    setSource,
    setModelId,
    setSubjectCategory,
    setSystemPrompt,
    resetSystemPrompt,
    setUserPrompt,
    setPromptPlanNote,
    setPreviewBg,
    setCustomBgColor,
    setProgress,
    setResult,
    setRefinement,
    resetRefinement,
    setStatus,
    setError,
    reset,
  } = useBackgroundRemoverStore();

  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null);
  const [isCached, setIsCached] = useState<boolean>(false);
  const [activeStep, setActiveStep] = useState<number>(1);
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState<boolean>(false);

  const workerClient = useWorkerClient();
  const isProcessingRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  // References to preserve raw buffers for instantaneous non-destructive refinement
  const sourcePixelsRef = useRef<Uint8ClampedArray | null>(null);
  const baseMaskRef = useRef<Uint8ClampedArray | null>(null);
  const workingMaskRef = useRef<Uint8ClampedArray | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { dropZoneProps, fileInputProps, openFileDialog, error: fileError } = useImageFile(
    (info) => {
      setSource(info);
      setActiveStep(2);
    },
  );

  // Initialize hardware capabilities
  useEffect(() => {
    detectDeviceCapabilities()
      .then(setDeviceCaps)
      .catch(() => {
        setDeviceCaps({
          hasWebGPU: false,
          hasWasm: true,
          preferredBackend: 'wasm',
          hardwareConcurrency: 4,
        });
      });
  }, []);

  // Update offline cache status
  useEffect(() => {
    const selectedMeta = MODELS.find((m) => m.id === selectedModelId);
    if (!selectedMeta) return;

    isModelCachedInBrowser(selectedMeta.repo)
      .then(setIsCached)
      .catch(() => setIsCached(false));
  }, [selectedModelId]);

  // Sync active step with workflow progression
  useEffect(() => {
    if (!source) {
      setActiveStep(1);
    } else if (result) {
      setActiveStep(4);
    } else if (status === 'processing' || status === 'loading-model') {
      setActiveStep(3);
    } else {
      setActiveStep(2);
    }
  }, [source, result, status]);

  // Subject category selection handler
  const handleSelectSubject = (opt: SubjectGuidanceOption) => {
    setSubjectCategory(opt.id);
    setModelId(opt.recommendedModel);
    setPromptPlanNote(null);
  };

  // Apply LangChain System + Subject Prompt routing
  const handleApplyPromptPlan = async () => {
    const plan = await planBackgroundRemovalFromPrompt({
      systemPrompt,
      userPrompt,
      fallbackModelId: selectedModelId,
      fallbackSubjectCategory: subjectCategory,
    });
    setModelId(plan.modelId);
    setSubjectCategory(plan.subjectCategory);
    setRefinement({
      threshold: plan.threshold,
      edgeSoftness: plan.edgeSoftness,
    });
    setPromptPlanNote(plan.reasoning);
    return plan;
  };

  // Redraws refined image from working mask, threshold, and edge softness
  const renderRefinedOutput = useCallback(async (overrideSettings?: { threshold?: number; edgeSoftness?: number }) => {
    if (!sourcePixelsRef.current || !workingMaskRef.current || !result || !canvasRef.current) {
      return;
    }

    const { width, height } = result;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const effectiveThreshold = overrideSettings?.threshold ?? refinement.threshold;
    const effectiveSoftness = overrideSettings?.edgeSoftness ?? refinement.edgeSoftness;

    // 1. Threshold
    let currentMask = applyMaskThreshold(workingMaskRef.current, effectiveThreshold);

    // 2. Edge Softness
    if (effectiveSoftness > 0) {
      currentMask = applyEdgeSoftness(currentMask, width, height, effectiveSoftness);
    }

    // 3. Composite with original pixels
    const refinedRgba = compositeMaskToRgba(sourcePixelsRef.current, currentMask, width, height);

    // 4. Draw to canvas
    const imgData = new ImageData(refinedRgba as any, width, height);
    canvas.width = width;
    canvas.height = height;
    ctx.putImageData(imgData, 0, 0);

    // 5. Update exported Blob
    canvas.toBlob((blob) => {
      if (blob) {
        const newUrl = URL.createObjectURL(blob);
        setResult({
          ...result,
          blob,
          url: newUrl,
          mask: currentMask,
        });
      }
    }, 'image/png');
  }, [result, refinement.threshold, refinement.edgeSoftness, setResult]);

  // Handle threshold & softness changes
  useEffect(() => {
    if (result && workingMaskRef.current && sourcePixelsRef.current) {
      renderRefinedOutput();
    }
  }, [refinement.threshold, refinement.edgeSoftness]);

  // Execute Background Removal
  const handleRemoveBackground = async () => {
    if (!source || isWorking || isProcessingRef.current) return;
    isProcessingRef.current = true;

    // Memory verification based on device tier
    const tier = detectDeviceTier();
    const limits = TIER_LIMITS[tier];
    const totalPixels = source.width * source.height;
    if (totalPixels > limits.maxCanvasPixels) {
      setError(
        `Image resolution (${source.width}×${source.height} = ${(totalPixels / 1e6).toFixed(1)} MP) exceeds safe limits for this device (${(limits.maxCanvasPixels / 1e6).toFixed(1)} MP). Please resize or choose a smaller image.`,
      );
      isProcessingRef.current = false;
      return;
    }

    // Evaluate LangChain System + User prompt if user entered instructions or custom directives
    let activeModelId = selectedModelId;
    let plannedThreshold = refinement.threshold;
    let plannedEdgeSoftness = refinement.edgeSoftness;

    if (userPrompt.trim() || systemPrompt.trim() !== '') {
      const plan = await planBackgroundRemovalFromPrompt({
        systemPrompt,
        userPrompt,
        fallbackModelId: selectedModelId,
        fallbackSubjectCategory: subjectCategory,
      });
      activeModelId = plan.modelId;
      plannedThreshold = plan.threshold;
      plannedEdgeSoftness = plan.edgeSoftness;
      if (plan.modelId !== selectedModelId) {
        setModelId(plan.modelId);
      }
      if (plan.subjectCategory !== subjectCategory) {
        setSubjectCategory(plan.subjectCategory);
      }
      if (userPrompt.trim()) {
        setPromptPlanNote(plan.reasoning);
      }
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const selectedMeta = MODELS.find((m) => m.id === activeModelId);
    setStatus('processing');
    setError(null);
    setProgress({
      stage: isCached ? 'initializing' : 'downloading',
      percent: 0,
      loadedBytes: 0,
      totalBytes: isCached ? 0 : (selectedMeta?.approxDownloadBytes.webgpu ?? 0),
    });

    try {
      // Decode image pixels on scratch canvas
      const img = new Image();
      img.src = source.previewUrl;
      await img.decode();

      const scratchCanvas = document.createElement('canvas');
      scratchCanvas.width = source.width;
      scratchCanvas.height = source.height;
      const scratchCtx = scratchCanvas.getContext('2d', { willReadFrequently: true });
      if (!scratchCtx) throw new Error('Could not acquire 2D canvas context.');

      scratchCtx.drawImage(img, 0, 0);
      const imageData = scratchCtx.getImageData(0, 0, source.width, source.height);

      // Save pristine copy of original pixels for subsequent interactive refinements
      sourcePixelsRef.current = new Uint8ClampedArray(imageData.data);

      const pixelBuffer = imageData.data.buffer; // Zero-copy transferable buffer

      let res;
      try {
        res = await workerClient.removeBackground(
          activeModelId,
          source.width,
          source.height,
          pixelBuffer,
          controller.signal,
          (p) => {
            setProgress({
              stage: p.stage,
              percent: p.percent,
              loadedBytes: p.loadedBytes,
              totalBytes: p.totalBytes,
            });
          },
        );
      } catch (workerErr) {
        // Automatic fallback: if BiRefNet-lite encounters memory/initialization error, degrade to MODNet
        if (activeModelId === 'birefnet-lite' && !controller.signal.aborted) {
          console.warn('[BackgroundRemover] BiRefNet-lite failed. Falling back to MODNet...', workerErr);
          setModelId('modnet');
          setProgress({ stage: 'initializing', percent: 20 });

          const retryImageData = scratchCtx.getImageData(0, 0, source.width, source.height);
          res = await workerClient.removeBackground(
            'modnet',
            source.width,
            source.height,
            retryImageData.data.buffer,
            controller.signal,
            (p) => {
              setProgress({
                stage: p.stage,
                percent: p.percent,
                loadedBytes: p.loadedBytes,
                totalBytes: p.totalBytes,
              });
            },
          );
        } else {
          throw workerErr;
        }
      }

      // Store raw masks for zero-latency adjustments
      let initialDisplayPixels: Uint8ClampedArray = new Uint8ClampedArray(res.pixels);
      let initialDisplayMask: Uint8ClampedArray | undefined = res.mask
        ? new Uint8ClampedArray(res.mask)
        : undefined;

      if (res.mask) {
        const maskArr = new Uint8ClampedArray(res.mask);
        baseMaskRef.current = new Uint8ClampedArray(maskArr);
        workingMaskRef.current = new Uint8ClampedArray(maskArr);

        // Apply prompt-planned threshold / softness if configured
        if (plannedThreshold > 0 || plannedEdgeSoftness > 0) {
          let adjustedMask = applyMaskThreshold(maskArr, plannedThreshold);
          if (plannedEdgeSoftness > 0) {
            adjustedMask = applyEdgeSoftness(adjustedMask, res.width, res.height, plannedEdgeSoftness);
          }
          initialDisplayMask = adjustedMask;
          if (sourcePixelsRef.current) {
            initialDisplayPixels = new Uint8ClampedArray(
              compositeMaskToRgba(sourcePixelsRef.current, adjustedMask, res.width, res.height),
            );
          }
        }
      }

      // Draw initial result onto canvas
      const outCanvas = canvasRef.current || document.createElement('canvas');
      outCanvas.width = res.width;
      outCanvas.height = res.height;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) throw new Error('Could not acquire output canvas context.');

      const outImageData = new ImageData(initialDisplayPixels as any, res.width, res.height);
      outCtx.putImageData(outImageData, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob(resolve, 'image/png'),
      );
      if (!blob) throw new Error('Failed to create PNG output blob.');

      const url = URL.createObjectURL(blob);
      setResult({
        blob,
        url,
        width: res.width,
        height: res.height,
        mask: initialDisplayMask,
        durationMs: res.durationMs,
      });

      setIsCached(true);
      setRefinement({
        threshold: plannedThreshold,
        edgeSoftness: plannedEdgeSoftness,
        brushMode: 'none',
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'Operation cancelled') {
        setStatus('idle');
        return;
      }
      setError(err instanceof Error ? err.message : 'Background removal failed.');
    } finally {
      isProcessingRef.current = false;
      abortControllerRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isProcessingRef.current = false;
    setStatus('idle');
    setProgress({ stage: 'idle', percent: 0 });
  };

  // Interactive Brush stroke handling on the canvas
  const handleCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (refinement.brushMode === 'none' || !workingMaskRef.current || !result) return;
    setIsDrawing(true);
    applyBrushAtEvent(e);
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!isDrawing || refinement.brushMode === 'none' || !workingMaskRef.current || !result) return;
    applyBrushAtEvent(e);
  };

  const handleCanvasMouseUp = () => {
    if (isDrawing) {
      setIsDrawing(false);
      renderRefinedOutput();
    }
  };

  const applyBrushAtEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!canvasRef.current || !workingMaskRef.current || !result || refinement.brushMode === 'none') {
      return;
    }
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const scaleX = result.width / rect.width;
    const scaleY = result.height / rect.height;

    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    applyBrushStroke(
      workingMaskRef.current,
      result.width,
      result.height,
      x,
      y,
      refinement.brushSize,
      refinement.brushMode,
    );

    // Fast preview redraw
    const ctx = canvas.getContext('2d');
    if (ctx && sourcePixelsRef.current) {
      const fastRgba = compositeMaskToRgba(
        sourcePixelsRef.current,
        workingMaskRef.current,
        result.width,
        result.height,
      );
      ctx.putImageData(
        new ImageData(fastRgba as any, result.width, result.height),
        0,
        0,
      );
    }
  };

  const handleResetRefinements = () => {
    if (baseMaskRef.current && workingMaskRef.current) {
      workingMaskRef.current.set(baseMaskRef.current);
      resetRefinement();
      renderRefinedOutput({ threshold: 0, edgeSoftness: 0 });
    }
  };

  const handleDownload = () => {
    if (!result || !source) return;
    const baseName = source.file.name.replace(/\.[^/.]+$/, '');
    const filename = `${baseName}-no-bg.png`;

    const a = document.createElement('a');
    a.href = result.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const isWorking = status === 'loading-model' || status === 'processing';
  const displayError = error || fileError;

  return (
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl space-y-6">
      {/* Privacy & Hardware Capabilities Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 p-3 bg-slate-950/80 border border-slate-800 rounded-lg">
        <div className="flex items-center gap-2 text-emerald-300 text-xs sm:text-sm font-medium">
          <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>
            <strong>100% On-Device AI:</strong> Model executes locally in your browser. Zero image data is sent to external servers.
          </span>
        </div>

        {deviceCaps && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-indigo-950/70 border border-indigo-700/60 rounded text-xs font-semibold text-indigo-300">
            <span>{deviceCaps.hasWebGPU ? '⚡ WebGPU Accelerated' : '⚙️ WebAssembly Fallback'}</span>
          </div>
        )}
      </div>

      {/* Guided Workflow Stepper */}
      <div className="border border-slate-800 bg-slate-950/50 rounded-lg p-3">
        <div className="grid grid-cols-5 gap-2 text-center text-xs">
          {[
            { step: 1, label: '1. Select Image' },
            { step: 2, label: '2. Subject & Model' },
            { step: 3, label: '3. Segmentation' },
            { step: 4, label: '4. Refine Mask' },
            { step: 5, label: '5. Export' },
          ].map((s) => {
            const isCompleted = activeStep > s.step;
            const isCurrent = activeStep === s.step;
            return (
              <div
                key={s.step}
                className={`py-1.5 px-1 rounded transition-colors ${
                  isCurrent
                    ? 'bg-indigo-600/30 text-indigo-300 font-semibold border border-indigo-500/40'
                    : isCompleted
                      ? 'text-emerald-400 font-medium'
                      : 'text-slate-500'
                }`}
              >
                <span>{s.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      {displayError && (
        <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm flex items-start justify-between">
          <span>{displayError}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs text-rose-300 hover:text-white ml-2 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Step 2: Subject Guidance & Model Selection */}
      <div className="p-4 bg-slate-950/50 border border-slate-800 rounded-lg space-y-3">
        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
          <div>
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Step 2: Subject Guidance & Recommendation
            </span>
            <p className="text-xs text-slate-400 mt-0.5">
              Select your subject type for optimal AI segmentation quality and edge preservation.
            </p>
          </div>
          <div className="text-xs text-slate-400">
            Status:{' '}
            {isCached ? (
              <span className="text-emerald-400 font-medium">💾 Cached (Offline Ready)</span>
            ) : (
              <span className="text-amber-300 font-medium">⬇️ Download on first run</span>
            )}
          </div>
        </div>

        {/* Subject Guidance Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {SUBJECT_OPTIONS.map((opt) => {
            const isSelected = subjectCategory === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => handleSelectSubject(opt)}
                disabled={isWorking}
                className={`p-3 text-left rounded-lg border transition-all ${
                  isSelected
                    ? 'bg-indigo-950/60 border-indigo-500 shadow-sm shadow-indigo-500/20 ring-1 ring-indigo-500/40'
                    : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-sm font-semibold text-slate-100 flex items-center gap-1.5">
                    <span>{opt.icon}</span>
                    <span>{opt.title}</span>
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 line-clamp-2">{opt.description}</p>
                <div className="mt-2 flex items-center justify-between text-[10px]">
                  <span className="text-indigo-400 font-mono">{opt.recommendedModel}</span>
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">{opt.badge}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Direct Model Override Toggle */}
        <div className="pt-2 flex flex-wrap items-center justify-between gap-2 text-xs border-t border-slate-800/80">
          <span className="text-slate-400">Direct Model Selection:</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setModelId('modnet')}
              disabled={isWorking}
              className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                selectedModelId === 'modnet'
                  ? 'bg-indigo-600 text-white border-indigo-500'
                  : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              MODNet (~12 MB)
            </button>
            <button
              type="button"
              onClick={() => setModelId('birefnet-lite')}
              disabled={isWorking}
              className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                selectedModelId === 'birefnet-lite'
                  ? 'bg-indigo-600 text-white border-indigo-500'
                  : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'
              }`}
            >
              BiRefNet-lite (~114 MB)
            </button>
          </div>
        </div>

        {/* LangChain System & Subject Prompt Section */}
        <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-indigo-300">
                🦜️🔗 Subject Prompt & System Prompt
              </span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-950/80 border border-indigo-800/70 text-indigo-300">
                LangChain On-Device
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowSystemPrompt((prev) => !prev)}
              disabled={isWorking}
              className="text-xs text-slate-400 hover:text-indigo-300 underline transition-colors"
            >
              {showSystemPrompt ? 'Hide System Prompt' : 'Edit System Prompt'}
            </button>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              value={userPrompt}
              onChange={(e) => setUserPrompt(e.target.value)}
              disabled={isWorking}
              placeholder="Describe what to keep/remove (e.g. 'Keep the stone arch and pillars, remove sky')"
              className="flex-1 px-3 py-2 bg-slate-900 border border-slate-800 rounded-lg text-xs sm:text-sm text-slate-100 placeholder-slate-500 focus:outline-none focus:border-indigo-500"
            />
            <button
              type="button"
              onClick={handleApplyPromptPlan}
              disabled={isWorking}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-medium text-indigo-300 border border-slate-700 rounded-lg transition-colors whitespace-nowrap"
            >
              Apply Prompt Plan
            </button>
          </div>

          {showSystemPrompt && (
            <div className="p-3 bg-slate-900/90 border border-slate-800 rounded-lg space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                  System Prompt (ChatPromptTemplate)
                </label>
                <button
                  type="button"
                  onClick={resetSystemPrompt}
                  disabled={isWorking}
                  className="text-[11px] text-slate-400 hover:text-slate-200 underline"
                >
                  Reset Default
                </button>
              </div>
              <textarea
                rows={5}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                disabled={isWorking}
                className="w-full p-2.5 bg-slate-950 border border-slate-800 rounded text-xs font-mono text-slate-200 focus:outline-none focus:border-indigo-500 leading-relaxed"
              />
              <p className="text-[11px] text-slate-500">
                Supports directives such as <code className="text-slate-400">always use birefnet-lite</code>,{' '}
                <code className="text-slate-400">threshold: 20</code>, or{' '}
                <code className="text-slate-400">edgeSoftness: 2</code>.
              </p>
            </div>
          )}

          {promptPlanNote && (
            <div className="px-3 py-2 bg-indigo-950/40 border border-indigo-800/50 rounded text-xs text-indigo-200 flex items-center justify-between gap-2">
              <span>
                <strong>Applied Plan:</strong> {promptPlanNote}
              </span>
              <button
                type="button"
                onClick={() => setPromptPlanNote(null)}
                className="text-[11px] text-indigo-400 hover:text-white underline shrink-0"
              >
                Clear
              </button>
            </div>
          )}

          <p className="text-[11px] text-slate-500">
            Routes subject instructions locally via LangChain to choose the best vision model &amp; refinement settings without sending pixels or prompts off-device.
          </p>
        </div>
      </div>

      {/* Step 1 & Work Area */}
      {!source ? (
        <div
          {...dropZoneProps}
          onClick={openFileDialog}
          className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-8 sm:p-12 text-center cursor-pointer transition-colors bg-slate-950/40"
        >
          <input {...fileInputProps} />
          <svg className="w-12 h-12 mx-auto text-slate-500 mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          <p className="text-base font-medium text-slate-200 mb-1">
            Drop an image here, or <span className="text-indigo-400 underline">browse</span>
          </p>
          <p className="text-xs text-slate-400">Supports PNG, JPEG, WebP up to 50 MB</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Dual Preview Area */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Original Image Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Original</span>
                <button
                  type="button"
                  onClick={reset}
                  disabled={isWorking}
                  className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
                >
                  Change Image
                </button>
              </div>
              <div className="aspect-square bg-slate-900 rounded flex items-center justify-center overflow-hidden">
                <img
                  src={source.previewUrl}
                  alt="Original input"
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              <div className="flex justify-between text-xs text-slate-500 mt-2 font-mono">
                <span>{source.width} × {source.height} px</span>
                <span>{(source.file.size / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
            </div>

            {/* Output / Interactive Canvas Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  {result ? 'Refined Output' : 'Transparent Output'}
                </span>
                {result && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-slate-400 mr-1">Preview BG:</span>
                    {(['transparent', 'white', 'black', 'custom'] as PreviewBgMode[]).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setPreviewBg(mode)}
                        className={`w-4 h-4 rounded-full border ${
                          previewBg === mode ? 'ring-2 ring-indigo-400 border-white' : 'border-slate-700'
                        } ${
                          mode === 'transparent'
                            ? 'bg-[linear-gradient(45deg,#334155_25%,transparent_25%),linear-gradient(-45deg,#334155_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#334155_75%),linear-gradient(-45deg,transparent_75%,#334155_75%)] bg-[size:6px_6px] bg-slate-800'
                            : mode === 'white'
                              ? 'bg-white'
                              : mode === 'black'
                                ? 'bg-black'
                                : ''
                        }`}
                        style={mode === 'custom' ? { backgroundColor: customBgColor } : {}}
                        title={mode}
                      />
                    ))}
                    {previewBg === 'custom' && (
                      <input
                        type="color"
                        value={customBgColor}
                        onChange={(e) => setCustomBgColor(e.target.value)}
                        className="w-4 h-4 p-0 rounded border-0 cursor-pointer"
                        title="Pick background color"
                      />
                    )}
                  </div>
                )}
              </div>

              <div
                className={`aspect-square rounded flex items-center justify-center overflow-hidden relative ${
                  previewBg === 'transparent'
                    ? 'bg-[linear-gradient(45deg,#1e293b_25%,transparent_25%),linear-gradient(-45deg,#1e293b_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#1e293b_75%),linear-gradient(-45deg,transparent_75%,#1e293b_75%)] bg-[size:16px_16px] bg-slate-900'
                    : previewBg === 'white'
                      ? 'bg-white'
                      : previewBg === 'black'
                        ? 'bg-black'
                        : ''
                }`}
                style={previewBg === 'custom' ? { backgroundColor: customBgColor } : {}}
              >
                {/* Interactive HTML5 Canvas */}
                <canvas
                  ref={canvasRef}
                  onMouseDown={handleCanvasMouseDown}
                  onMouseMove={handleCanvasMouseMove}
                  onMouseUp={handleCanvasMouseUp}
                  onMouseLeave={handleCanvasMouseUp}
                  className={`max-w-full max-h-full object-contain ${
                    result ? 'block' : 'hidden'
                  } ${
                    refinement.brushMode !== 'none'
                      ? 'cursor-crosshair'
                      : 'cursor-default'
                  }`}
                />

                {!result && isWorking && (
                  <div className="w-full h-full flex flex-col items-center justify-center p-6 space-y-4 bg-slate-950/80 backdrop-blur-sm">
                    <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-center space-y-1 max-w-[280px]">
                      <p className="text-sm font-semibold text-slate-100">
                        {progress.stage === 'downloading'
                          ? 'Downloading AI model weights…'
                          : progress.stage === 'initializing'
                            ? 'Initializing AI model engine…'
                            : progress.stage === 'segmenting'
                              ? 'Segmenting foreground subject…'
                              : progress.stage === 'compositing'
                                ? 'Compositing transparent output…'
                                : 'Processing background removal…'}
                      </p>
                      {progress.stage === 'downloading' && progress.loadedBytes && progress.totalBytes ? (
                        <p className="text-xs text-slate-400 font-mono">
                          {formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes)} ({progress.percent}%)
                        </p>
                      ) : progress.stage === 'downloading' && progress.totalBytes ? (
                        <p className="text-xs text-slate-400 font-mono">
                          Connecting… ~{formatBytes(progress.totalBytes)}
                        </p>
                      ) : (
                        <p className="text-xs text-indigo-400 font-mono">
                          {progress.percent > 0 ? `${progress.percent}% complete` : 'Please wait…'}
                        </p>
                      )}
                    </div>

                    {/* Progress Bar */}
                    <div className="w-48 sm:w-64 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all duration-200"
                        style={{
                          width: `${Math.min(
                            100,
                            Math.max(progress.stage === 'downloading' ? progress.percent : 15, progress.percent),
                          )}%`,
                        }}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleCancel}
                      className="px-4 py-1.5 text-xs text-rose-300 hover:text-rose-200 bg-rose-950/60 border border-rose-800 rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {!result && !isWorking && (
                  <span className="text-xs text-slate-500">Click &quot;Remove Background&quot; to start</span>
                )}
              </div>

              <div className="flex justify-between text-xs text-slate-500 mt-2 font-mono">
                <span>{result ? `${result.width} × ${result.height} px` : '—'}</span>
                <span>{result ? `${result.durationMs} ms` : '—'}</span>
              </div>
            </div>
          </div>

          {/* Step 4: Mask Refinement Controls (Shown when result is available) */}
          {result && (
            <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-lg space-y-4">
              <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
                    Step 4: Refine Mask & Perfect Edges
                  </span>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Adjust mask threshold, soften edge borders, or brush in foreground/background.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleResetRefinements}
                  className="text-xs text-slate-400 hover:text-slate-200 underline"
                >
                  Reset Adjustments
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                {/* Threshold Slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-300 font-medium">Mask Threshold</span>
                    <span className="text-indigo-400 font-mono">{refinement.threshold}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={refinement.threshold}
                    onChange={(e) => setRefinement({ threshold: Number(e.target.value) })}
                    className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                  <p className="text-[10px] text-slate-500">Expands or cuts border pixels to clean fringes.</p>
                </div>

                {/* Edge Softness Slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-slate-300 font-medium">Edge Softness / Feather</span>
                    <span className="text-indigo-400 font-mono">{refinement.edgeSoftness} px</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="20"
                    value={refinement.edgeSoftness}
                    onChange={(e) => setRefinement({ edgeSoftness: Number(e.target.value) })}
                    className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                  />
                  <p className="text-[10px] text-slate-500">Blurs alpha transitions for natural integration.</p>
                </div>
              </div>

              {/* Interactive Brush Toolbar */}
              <div className="pt-3 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-300 font-medium">Touch-up Brush:</span>
                  {(['none', 'restore', 'erase'] as BrushMode[]).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => setRefinement({ brushMode: mode })}
                      className={`px-3 py-1 rounded text-xs font-medium border transition-colors ${
                        refinement.brushMode === mode
                          ? mode === 'restore'
                            ? 'bg-emerald-600 text-white border-emerald-500'
                            : mode === 'erase'
                              ? 'bg-rose-600 text-white border-rose-500'
                              : 'bg-indigo-600 text-white border-indigo-500'
                          : 'bg-slate-900 text-slate-300 border-slate-800 hover:border-slate-700'
                      }`}
                    >
                      {mode === 'none'
                        ? 'Off'
                        : mode === 'restore'
                          ? 'Restore Foreground [+]'
                          : 'Erase Background [-]'}
                    </button>
                  ))}
                </div>

                {refinement.brushMode !== 'none' && (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-400">Size:</span>
                    <input
                      type="range"
                      min="5"
                      max="80"
                      value={refinement.brushSize}
                      onChange={(e) => setRefinement({ brushSize: Number(e.target.value) })}
                      className="w-24 h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-indigo-500"
                    />
                    <span className="text-xs font-mono text-indigo-400 w-8">{refinement.brushSize}px</span>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            {!result ? (
              <button
                type="button"
                onClick={handleRemoveBackground}
                disabled={isWorking}
                className="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
              >
                {isWorking ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>
                      {progress.stage === 'downloading'
                        ? progress.loadedBytes && progress.totalBytes
                          ? `Downloading Model (${progress.percent}%) • ${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}…`
                          : `Downloading Model (${progress.percent}%)…`
                        : progress.stage === 'initializing'
                          ? 'Initializing Model Engine…'
                          : progress.stage === 'segmenting'
                            ? 'Segmenting Foreground Subject…'
                            : 'Processing…'}
                    </span>
                  </>
                ) : (
                  <span>Remove Background</span>
                )}
              </button>
            ) : (
              <div className="flex flex-col sm:flex-row w-full gap-3">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex-1 py-3 px-6 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download Transparent PNG</span>
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg transition-colors"
                >
                  Start Over
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
