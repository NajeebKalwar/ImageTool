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
import {
  DEFAULT_BG_REMOVER_SYSTEM_PROMPT,
  planBackgroundRemovalFromPrompt,
} from '../lib/workflow/bg-prompt-planner';

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
}

const SUBJECT_OPTIONS: readonly SubjectGuidanceOption[] = [
  {
    id: 'product',
    title: 'Objects & Architecture',
    recommendedModel: 'birefnet-lite',
    badge: 'BiRefNet-lite',
    description: 'Buildings, arches, products & general objects',
  },
  {
    id: 'fine-edge',
    title: 'Hair, Fur & Intricate',
    recommendedModel: 'birefnet-lite',
    badge: 'BiRefNet-lite',
    description: 'Fine hair strands, pet fur & lace',
  },
  {
    id: 'portrait',
    title: 'Portraits & People',
    recommendedModel: 'modnet',
    badge: 'MODNet Fast',
    description: 'Selfies & human headshots (~12 MB)',
  },
  {
    id: 'graphic',
    title: 'Logos & Graphics',
    recommendedModel: 'modnet',
    badge: 'MODNet Crisp',
    description: 'Stickers, badges & flat illustrations',
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
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [showSystemPrompt, setShowSystemPrompt] = useState<boolean>(false);

  const workerClient = useWorkerClient();
  const isProcessingRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const sourcePixelsRef = useRef<Uint8ClampedArray | null>(null);
  const baseMaskRef = useRef<Uint8ClampedArray | null>(null);
  const workingMaskRef = useRef<Uint8ClampedArray | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const { dropZoneProps, fileInputProps, openFileDialog, error: fileError } = useImageFile(
    (info) => {
      setSource(info);
    },
  );

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

  useEffect(() => {
    const selectedMeta = MODELS.find((m) => m.id === selectedModelId);
    if (!selectedMeta) return;

    isModelCachedInBrowser(selectedMeta.repo)
      .then(setIsCached)
      .catch(() => setIsCached(false));
  }, [selectedModelId]);

  const handleSelectSubject = (opt: SubjectGuidanceOption) => {
    setSubjectCategory(opt.id);
    setModelId(opt.recommendedModel);
    setPromptPlanNote(null);
  };

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

  const renderRefinedOutput = useCallback(
    async (overrideSettings?: { threshold?: number; edgeSoftness?: number }) => {
      if (!sourcePixelsRef.current || !workingMaskRef.current || !result || !canvasRef.current) {
        return;
      }

      const { width, height } = result;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const effectiveThreshold = overrideSettings?.threshold ?? refinement.threshold;
      const effectiveSoftness = overrideSettings?.edgeSoftness ?? refinement.edgeSoftness;

      let currentMask = applyMaskThreshold(workingMaskRef.current, effectiveThreshold);
      if (effectiveSoftness > 0) {
        currentMask = applyEdgeSoftness(currentMask, width, height, effectiveSoftness);
      }

      const refinedRgba = compositeMaskToRgba(sourcePixelsRef.current, currentMask, width, height);
      const imgData = new ImageData(refinedRgba as any, width, height);
      canvas.width = width;
      canvas.height = height;
      ctx.putImageData(imgData, 0, 0);

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
    },
    [result, refinement.threshold, refinement.edgeSoftness, setResult],
  );

  useEffect(() => {
    if (result && workingMaskRef.current && sourcePixelsRef.current) {
      renderRefinedOutput();
    }
  }, [refinement.threshold, refinement.edgeSoftness]);

  const handleRemoveBackground = async () => {
    if (!source || isWorking || isProcessingRef.current) return;
    isProcessingRef.current = true;

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

    let activeModelId = selectedModelId;
    let plannedThreshold = refinement.threshold;
    let plannedEdgeSoftness = refinement.edgeSoftness;

    const hasCustomPrompt =
      userPrompt.trim().length > 0 || systemPrompt.trim() !== DEFAULT_BG_REMOVER_SYSTEM_PROMPT.trim();

    if (hasCustomPrompt) {
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
      setPromptPlanNote(plan.reasoning);
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
      sourcePixelsRef.current = new Uint8ClampedArray(imageData.data);

      const pixelBuffer = imageData.data.buffer;

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
        if (activeModelId === 'birefnet-lite' && !controller.signal.aborted) {
          console.warn('[BackgroundRemover] BiRefNet-lite failed. Falling back to MODNet...', workerErr);
          setModelId('modnet');
          setPromptPlanNote(
            'Fallback notice: BiRefNet-lite failed on this device, so MODNet was used instead (portrait-focused; use the Restore/Erase brush below if object edges need touch-ups).',
          );
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

      if (res.modelId && res.modelId !== activeModelId && res.modelId === 'modnet') {
        setModelId('modnet');
        setPromptPlanNote(
          'Fallback notice: BiRefNet-lite failed during inference, so MODNet was used instead (portrait-focused; use the Restore/Erase brush below if object edges need touch-ups).',
        );
      }

      let initialDisplayPixels: Uint8ClampedArray = new Uint8ClampedArray(res.pixels);
      let initialDisplayMask: Uint8ClampedArray | undefined = res.mask
        ? new Uint8ClampedArray(res.mask)
        : undefined;

      if (res.mask) {
        const maskArr = new Uint8ClampedArray(res.mask);
        baseMaskRef.current = new Uint8ClampedArray(maskArr);
        workingMaskRef.current = new Uint8ClampedArray(maskArr);

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
    <div className="w-full max-w-5xl mx-auto space-y-5">
      {displayError && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-start justify-between shadow-2xs">
          <span>{displayError}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs font-medium text-rose-600 hover:text-rose-800 ml-3 underline shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Two-Column SaaS Studio Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT COLUMN: Upload Dropzone, File Card & Visual Preview */}
        <div className="lg:col-span-7 space-y-4">
          {!source ? (
            <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs">
              <div
                {...dropZoneProps}
                onClick={openFileDialog}
                className="border-[1.5px] border-dashed border-slate-300 hover:border-blue-400 rounded-lg py-14 px-6 text-center cursor-pointer transition-colors bg-[#f8f9fc]"
              >
                <input {...fileInputProps} />
                <p className="text-sm font-medium text-slate-700 mb-2">Drag file here</p>
                <p className="text-xs text-slate-400 mb-3">or</p>
                <span className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-blue-200 hover:border-blue-500 text-slate-800 text-xs font-semibold rounded-lg shadow-2xs transition-colors">
                  <svg className="w-4 h-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5m0 0l5 5m-5-5v12" />
                  </svg>
                  Choose file
                </span>
                <p className="text-[11px] text-slate-500 mt-4">
                  PNG, JPEG, WebP up to 50 MB • Processed 100% on-device
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Uploaded File Summary Card (matches reference Uploaded images card) */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span className="flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                    Uploaded image (1)
                  </span>
                  <button
                    type="button"
                    onClick={reset}
                    disabled={isWorking}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                  >
                    Change file
                  </button>
                </div>

                <div className="bg-white border border-slate-200/80 rounded-lg p-3 flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={source.previewUrl}
                      alt={source.file.name}
                      className="w-11 h-11 rounded-md object-cover border border-slate-200 shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold text-slate-900 truncate">{source.file.name}</p>
                      <p className="text-[11px] text-slate-500 font-mono mt-0.5">
                        {source.width} × {source.height} px • {(source.file.size / (1024 * 1024)).toFixed(2)} MB
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={reset}
                    disabled={isWorking}
                    aria-label="Remove uploaded image"
                    className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-50 transition-colors"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Dual Side-by-Side Preview Card */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex flex-wrap justify-between items-center gap-2">
                  <span className="text-xs font-semibold text-slate-700">
                    {result ? 'Transparent / Refined Output' : 'Preview'}
                  </span>
                  {result && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] text-slate-500 mr-1">Preview BG:</span>
                      {(['transparent', 'white', 'black', 'custom'] as PreviewBgMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setPreviewBg(mode)}
                          className={`w-4 h-4 rounded-full border ${
                            previewBg === mode ? 'ring-2 ring-blue-500 border-white' : 'border-slate-300'
                          } ${
                            mode === 'transparent'
                              ? 'bg-[linear-gradient(45deg,#cbd5e1_25%,transparent_25%),linear-gradient(-45deg,#cbd5e1_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#cbd5e1_75%),linear-gradient(-45deg,transparent_75%,#cbd5e1_75%)] bg-[size:6px_6px] bg-white'
                              : mode === 'white'
                                ? 'bg-white'
                                : mode === 'black'
                                  ? 'bg-slate-900'
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

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {/* Original */}
                  <div className="bg-white border border-slate-200/80 rounded-lg p-2">
                    <div className="aspect-square rounded flex items-center justify-center overflow-hidden bg-slate-50">
                      <img
                        src={source.previewUrl}
                        alt="Original input"
                        className="max-w-full max-h-full object-contain"
                      />
                    </div>
                    <p className="text-[11px] text-slate-500 text-center mt-1.5 font-medium">Original</p>
                  </div>

                  {/* Output Canvas */}
                  <div className="bg-white border border-slate-200/80 rounded-lg p-2">
                    <div
                      className={`aspect-square rounded flex items-center justify-center overflow-hidden relative ${
                        previewBg === 'transparent'
                          ? 'bg-[linear-gradient(45deg,#e2e8f0_25%,transparent_25%),linear-gradient(-45deg,#e2e8f0_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e2e8f0_75%),linear-gradient(-45deg,transparent_75%,#e2e8f0_75%)] bg-[size:16px_16px] bg-white'
                          : previewBg === 'white'
                            ? 'bg-white'
                            : previewBg === 'black'
                              ? 'bg-slate-950'
                              : ''
                      }`}
                      style={previewBg === 'custom' ? { backgroundColor: customBgColor } : {}}
                    >
                      <canvas
                        ref={canvasRef}
                        onMouseDown={handleCanvasMouseDown}
                        onMouseMove={handleCanvasMouseMove}
                        onMouseUp={handleCanvasMouseUp}
                        onMouseLeave={handleCanvasMouseUp}
                        className={`max-w-full max-h-full object-contain ${
                          result ? 'block' : 'hidden'
                        } ${refinement.brushMode !== 'none' ? 'cursor-crosshair' : 'cursor-default'}`}
                      />

                      {!result && isWorking && (
                        <div className="w-full h-full flex flex-col items-center justify-center p-4 space-y-3 bg-white/90 backdrop-blur-xs">
                          <div className="w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin" />
                          <div className="text-center space-y-1">
                            <p className="text-xs font-semibold text-slate-900">
                              {progress.stage === 'downloading'
                                ? 'Downloading AI model…'
                                : progress.stage === 'initializing'
                                  ? 'Initializing model…'
                                  : progress.stage === 'segmenting'
                                    ? 'Segmenting foreground…'
                                    : progress.stage === 'compositing'
                                      ? 'Compositing output…'
                                      : 'Processing…'}
                            </p>
                            {progress.stage === 'downloading' && progress.loadedBytes && progress.totalBytes ? (
                              <p className="text-[11px] text-slate-500 font-mono">
                                {formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes)} ({progress.percent}%)
                              </p>
                            ) : (
                              <p className="text-[11px] text-blue-600 font-mono">
                                {progress.percent > 0 ? `${progress.percent}%` : 'Please wait…'}
                              </p>
                            )}
                          </div>
                          <div className="w-40 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 transition-all duration-200"
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
                            className="px-3 py-1 text-[11px] font-medium text-rose-600 hover:text-rose-700 bg-rose-50 border border-rose-200 rounded-md transition-colors"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {!result && !isWorking && (
                        <span className="text-xs text-slate-400 px-3 text-center">
                          Click &quot;Remove Background&quot; to start
                        </span>
                      )}
                    </div>
                    <div className="flex justify-between items-center text-[11px] text-slate-500 mt-1.5 px-1 font-mono">
                      <span>{result ? `${result.width} × ${result.height}` : 'Output'}</span>
                      <span>{result ? `${Math.round(result.durationMs)} ms` : '—'}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Refine Mask Card (Shown after inference) */}
              {result && (
                <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-4">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <h3 className="text-xs font-bold text-slate-900 uppercase tracking-wider">
                        Refine Mask &amp; Edges
                      </h3>
                      <p className="text-[11px] text-slate-500 mt-0.5">
                        Tune cutoff threshold, feather edges, or brush directly on the output canvas.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleResetRefinements}
                      className="text-xs font-medium text-blue-600 hover:text-blue-700 underline shrink-0"
                    >
                      Reset
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-700 font-medium">Mask Threshold</span>
                        <span className="text-blue-600 font-mono font-semibold">{refinement.threshold}%</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="100"
                        value={refinement.threshold}
                        onChange={(e) => setRefinement({ threshold: Number(e.target.value) })}
                        className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                      />
                    </div>

                    <div className="space-y-1">
                      <div className="flex justify-between text-xs">
                        <span className="text-slate-700 font-medium">Edge Softness</span>
                        <span className="text-blue-600 font-mono font-semibold">{refinement.edgeSoftness} px</span>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max="20"
                        value={refinement.edgeSoftness}
                        onChange={(e) => setRefinement({ edgeSoftness: Number(e.target.value) })}
                        className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                      />
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-200/80 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-slate-600 font-medium mr-1">Brush:</span>
                      {(['none', 'restore', 'erase'] as BrushMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setRefinement({ brushMode: mode })}
                          className={`px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                            refinement.brushMode === mode
                              ? mode === 'restore'
                                ? 'bg-emerald-600 text-white border-emerald-600'
                                : mode === 'erase'
                                  ? 'bg-rose-600 text-white border-rose-600'
                                  : 'bg-blue-600 text-white border-blue-600'
                              : 'bg-white text-slate-700 border-slate-200 hover:border-slate-300'
                          }`}
                        >
                          {mode === 'none'
                            ? 'Off'
                            : mode === 'restore'
                              ? 'Restore [+]'
                              : 'Erase [-]'}
                        </button>
                      ))}
                    </div>

                    {refinement.brushMode !== 'none' && (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-slate-500">Size:</span>
                        <input
                          type="range"
                          min="5"
                          max="80"
                          value={refinement.brushSize}
                          onChange={(e) => setRefinement({ brushSize: Number(e.target.value) })}
                          className="w-24 h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                        />
                        <span className="text-xs font-mono text-blue-600 w-8">{refinement.brushSize}px</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Choose Model, Subject Guidance, Prompt & Primary CTA */}
        <div className="lg:col-span-5 bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-slate-900">Choose model &amp; subject</h2>
            {deviceCaps && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">
                {deviceCaps.hasWebGPU ? '⚡ WebGPU' : '⚙️ WASM'}
              </span>
            )}
          </div>

          {/* Clean Model Selector List (matches WebP/AVIF style) */}
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500 block">AI Segmentation Model</span>
            <button
              type="button"
              onClick={() => setModelId('birefnet-lite')}
              disabled={isWorking}
              className={`w-full px-3.5 py-2.5 rounded-lg text-left text-xs transition-all flex items-center justify-between ${
                selectedModelId === 'birefnet-lite'
                  ? 'bg-slate-200/80 text-blue-600 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>BiRefNet-lite (Objects, Hair, Arch)</span>
              <span className="text-[11px] opacity-80 font-mono">~114 MB</span>
            </button>
            <button
              type="button"
              onClick={() => setModelId('modnet')}
              disabled={isWorking}
              className={`w-full px-3.5 py-2.5 rounded-lg text-left text-xs transition-all flex items-center justify-between ${
                selectedModelId === 'modnet'
                  ? 'bg-slate-200/80 text-blue-600 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>MODNet (Fast Portrait Matting)</span>
              <span className="text-[11px] opacity-80 font-mono">~12 MB</span>
            </button>
          </div>

          {/* Subject Presets */}
          <div className="pt-2 border-t border-slate-200/80 space-y-2">
            <span className="text-xs font-medium text-slate-500 block">Subject guidance</span>
            <div className="grid grid-cols-2 gap-2">
              {SUBJECT_OPTIONS.map((opt) => {
                const isSelected = subjectCategory === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelectSubject(opt)}
                    disabled={isWorking}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      isSelected
                        ? 'bg-blue-50/90 border-blue-500 text-blue-700'
                        : 'bg-white border-slate-200/80 text-slate-700 hover:border-slate-300'
                    }`}
                  >
                    <div className="text-xs font-semibold">{opt.title}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5 line-clamp-1">{opt.badge}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* LangChain System & Subject Prompt */}
          <div className="pt-2 border-t border-slate-200/80 space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-600">Subject &amp; System Prompt</span>
              <button
                type="button"
                onClick={() => setShowSystemPrompt((prev) => !prev)}
                disabled={isWorking}
                className="text-[11px] font-medium text-blue-600 hover:text-blue-700 underline"
              >
                {showSystemPrompt ? 'Hide System Prompt' : 'Edit System Prompt'}
              </button>
            </div>

            <div className="flex gap-1.5">
              <input
                type="text"
                value={userPrompt}
                onChange={(e) => setUserPrompt(e.target.value)}
                disabled={isWorking}
                placeholder="e.g. Keep stone arch, remove sky"
                className="flex-1 min-w-0 px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs text-slate-800 placeholder-slate-400 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={handleApplyPromptPlan}
                disabled={isWorking}
                className="px-3 py-2 bg-white border border-blue-200 hover:border-blue-500 text-blue-600 text-xs font-semibold rounded-lg transition-colors shrink-0"
              >
                Apply
              </button>
            </div>

            {showSystemPrompt && (
              <div className="p-2.5 bg-white border border-slate-200 rounded-lg space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    LangChain System Prompt
                  </label>
                  <button
                    type="button"
                    onClick={resetSystemPrompt}
                    disabled={isWorking}
                    className="text-[10px] text-blue-600 hover:underline"
                  >
                    Reset Default
                  </button>
                </div>
                <textarea
                  rows={4}
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  disabled={isWorking}
                  className="w-full p-2 bg-slate-50 border border-slate-200 rounded text-[11px] font-mono text-slate-700 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {promptPlanNote && (
              <div className="px-2.5 py-2 bg-blue-50 border border-blue-200 rounded-lg text-[11px] text-blue-800 flex items-start justify-between gap-2">
                <span>{promptPlanNote}</span>
                <button
                  type="button"
                  onClick={() => setPromptPlanNote(null)}
                  className="text-[10px] text-blue-600 underline shrink-0"
                >
                  Clear
                </button>
              </div>
            )}
          </div>

          {/* Primary CTA Buttons */}
          <div className="pt-2 space-y-2.5">
            {!result ? (
              <button
                type="button"
                onClick={handleRemoveBackground}
                disabled={!source || isWorking}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {isWorking ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>
                      {progress.stage === 'downloading'
                        ? `Downloading (${progress.percent}%)…`
                        : progress.stage === 'initializing'
                          ? 'Initializing Engine…'
                          : 'Removing Background…'}
                    </span>
                  </>
                ) : (
                  <span>Remove Background</span>
                )}
              </button>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download Transparent PNG</span>
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="w-full py-2 px-4 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
                >
                  Start Over
                </button>
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
              <span>100% On-Device AI</span>
              <span>
                {isCached ? '💾 Cached Offline Ready' : '⬇️ Downloads on first run'}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
