import { useState, useRef, useEffect, useCallback } from 'react';
import { detectDeviceCapabilities, type DeviceCapabilities } from '../lib/ai/device';
import { ModelCacheManager, type DownloadProgress } from '../lib/ai/model-cache';
import { getModelsByTask, type ModelMetadata } from '../lib/ai/model-registry';
import { estimateUpscaleMemory, getDeviceMemoryLimits, type MemoryEstimation } from '../lib/ai/memory-policy';
import { ImageWorkerClient } from '../lib/worker-client';
import type { SupportedFormat } from '../lib/worker-protocol';

interface SourceImage {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export default function ImageUpscaler() {
  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null);
  const [availableModels] = useState<ModelMetadata[]>(() => getModelsByTask('upscaling'));
  const [selectedModelId, setSelectedModelId] = useState<string>('swin2sr-x4');
  const [selectedScale, setSelectedScale] = useState<number>(4);
  const [isModelCached, setIsModelCached] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const [source, setSource] = useState<SourceImage | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [processedDims, setProcessedDims] = useState<{ width: number; height: number } | null>(null);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [tileProgress, setTileProgress] = useState<{ current: number; total: number; percent: number; stage: string } | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Split-view slider position (percentage 0 to 100)
  const [sliderPosition, setSliderPosition] = useState<number>(50);
  const [isDraggingSlider, setIsDraggingSlider] = useState<boolean>(false);

  // Download options
  const [downloadFormat, setDownloadFormat] = useState<SupportedFormat>('image/png');
  const [downloadQuality, setDownloadQuality] = useState<number>(0.92);

  const clientRef = useRef<ImageWorkerClient | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const cacheManagerRef = useRef<ModelCacheManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const splitContainerRef = useRef<HTMLDivElement>(null);

  // Initialize hardware capabilities and cache manager
  useEffect(() => {
    cacheManagerRef.current = new ModelCacheManager();

    detectDeviceCapabilities()
      .then((caps) => setDeviceCaps(caps))
      .catch(() => {
        setDeviceCaps({
          hasWebGPU: false,
          hasWasm: true,
          preferredBackend: 'wasm',
          hardwareConcurrency: 4,
        });
      });
  }, []);

  // Check cache state when model changes
  useEffect(() => {
    if (cacheManagerRef.current) {
      cacheManagerRef.current.isCached(selectedModelId).then((cached) => {
        setIsModelCached(cached);
      });
    }
  }, [selectedModelId]);

  // Clean up object URLs on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.terminate();
        clientRef.current = null;
      }
      if (source?.previewUrl) URL.revokeObjectURL(source.previewUrl);
      if (processedUrl) URL.revokeObjectURL(processedUrl);
    };
  }, [source, processedUrl]);

  // Compute memory estimation
  const memoryEstimation: MemoryEstimation | null = source
    ? estimateUpscaleMemory(source.width, source.height, selectedScale, getDeviceMemoryLimits())
    : null;

  // Handle image upload
  const handleFileChange = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please select a valid image file (PNG, JPEG, WebP).');
      return;
    }

    setError(null);
    if (processedUrl) {
      URL.revokeObjectURL(processedUrl);
      setProcessedUrl(null);
      setProcessedDims(null);
    }

    const previewUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource({
        file,
        previewUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };
    img.onerror = () => {
      setError('Failed to load image. File may be corrupted.');
    };
    img.src = previewUrl;
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileChange(e.dataTransfer.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  // Start Upscaling Process
  const handleStartUpscaling = async () => {
    if (!source || !memoryEstimation) return;

    if (!memoryEstimation.isSafe) {
      setError(memoryEstimation.rejectionReason || 'Image exceeds safe memory limits.');
      return;
    }

    setIsProcessing(true);
    setError(null);
    setDurationMs(null);
    setTileProgress({ current: 0, total: 1, percent: 0, stage: 'preparing' });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // 1. Download/Cache model if not already cached
      if (cacheManagerRef.current && !isModelCached) {
        setTileProgress({ current: 0, total: 1, percent: 0, stage: 'downloading_weights' });
        await cacheManagerRef.current.downloadAndCache(
          selectedModelId,
          (p: DownloadProgress) => {
            setDownloadProgress(p.percentage);
          },
          controller.signal,
        );
        setIsModelCached(true);
        setDownloadProgress(null);
      }

      if (controller.signal.aborted) {
        throw new Error('Operation cancelled');
      }

      // 2. Decode source pixels via OffscreenCanvas / Canvas
      const img = new Image();
      img.src = source.previewUrl;
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('Failed to decode image pixels for AI worker.'));
      });

      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Could not acquire 2D canvas context.');

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, source.width, source.height);
      const pixelBuffer = imageData.data.buffer.slice(0);

      // 3. Initialize Worker Client
      if (!clientRef.current || clientRef.current.isTerminated) {
        const worker = new Worker(new URL('../workers/image-worker.ts', import.meta.url), {
          type: 'module',
        });
        clientRef.current = new ImageWorkerClient(worker, 180_000); // 3-minute timeout for large models
      }

      // 4. Send AI upscale request to Web Worker
      const upscaleResult = await clientRef.current.upscaleImage(
        selectedModelId,
        selectedScale,
        source.width,
        source.height,
        pixelBuffer,
        { tileSize: 256, overlap: 32 },
        controller.signal,
        (progress) => {
          setTileProgress({
            current: progress.currentTile ?? 0,
            total: progress.totalTiles ?? 1,
            percent: progress.percent,
            stage: progress.stage,
          });
        },
      );

      // 5. Render result onto a canvas and create Blob URL
      const outCanvas = document.createElement('canvas');
      outCanvas.width = upscaleResult.width;
      outCanvas.height = upscaleResult.height;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) throw new Error('Could not acquire output canvas context.');

      const outClamped = new Uint8ClampedArray(upscaleResult.pixels);
      const outImageData = new ImageData(outClamped, upscaleResult.width, upscaleResult.height);
      outCtx.putImageData(outImageData, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob(resolve, 'image/png'),
      );

      if (!blob) throw new Error('Failed to generate high-resolution image output.');

      const url = URL.createObjectURL(blob);
      setProcessedUrl(url);
      setProcessedDims({ width: upscaleResult.width, height: upscaleResult.height });
      setDurationMs(upscaleResult.durationMs);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes('cancelled')) {
        setError('Upscaling cancelled by user.');
      } else {
        setError(err instanceof Error ? err.message : 'Upscaling failed.');
      }
    } finally {
      setIsProcessing(false);
      setTileProgress(null);
      abortControllerRef.current = null;
    }
  };

  // Cancel processing
  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    if (clientRef.current) {
      clientRef.current.terminate();
      clientRef.current = null;
    }
  };

  // Slider dragging handlers for Before/After split comparison
  const handleSliderMove = useCallback((clientX: number) => {
    if (!splitContainerRef.current) return;
    const rect = splitContainerRef.current.getBoundingClientRect();
    const pos = ((clientX - rect.left) / rect.width) * 100;
    setSliderPosition(Math.max(5, Math.min(95, pos)));
  }, []);

  const handleMouseDown = () => setIsDraggingSlider(true);
  const handleTouchStart = () => setIsDraggingSlider(true);

  useEffect(() => {
    const handleMouseUp = () => setIsDraggingSlider(false);
    const handleMouseMove = (e: MouseEvent) => {
      if (isDraggingSlider) handleSliderMove(e.clientX);
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (isDraggingSlider && e.touches[0]) handleSliderMove(e.touches[0].clientX);
    };

    if (isDraggingSlider) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      window.addEventListener('touchmove', handleTouchMove);
      window.addEventListener('touchend', handleMouseUp);
    }

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleMouseUp);
    };
  }, [isDraggingSlider, handleSliderMove]);

  // Download high-resolution result
  const handleDownload = async () => {
    if (!processedUrl || !processedDims) return;

    const img = new Image();
    img.src = processedUrl;
    await new Promise<void>((resolve) => {
      img.onload = () => resolve();
    });

    const canvas = document.createElement('canvas');
    canvas.width = processedDims.width;
    canvas.height = processedDims.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(img, 0, 0);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, downloadFormat, downloadQuality),
    );

    if (!blob) return;

    const extension = downloadFormat === 'image/jpeg' ? 'jpg' : downloadFormat === 'image/webp' ? 'webp' : 'png';
    const originalName = source?.file.name.replace(/\.[^/.]+$/, '') || 'upscaled';
    const filename = `${originalName}-${selectedScale}x-${processedDims.width}x${processedDims.height}.${extension}`;

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-8">
      {/* Hardware Acceleration & Privacy Status Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-slate-900/80 border border-slate-800 rounded-xl text-sm">
        <div className="flex items-center gap-3">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className="font-medium text-slate-200">Execution Hardware:</span>
          {deviceCaps ? (
            <span
              className={`px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                deviceCaps.hasWebGPU
                  ? 'bg-indigo-950 text-indigo-300 border border-indigo-700/60'
                  : 'bg-amber-950 text-amber-300 border border-amber-700/60'
              }`}
            >
              {deviceCaps.hasWebGPU ? 'WebGPU (Hardware Accelerated)' : 'WebAssembly (WASM Fallback)'}
            </span>
          ) : (
            <span className="text-slate-500">Detecting...</span>
          )}
        </div>

        <div className="flex items-center gap-2 text-xs text-slate-400">
          <svg className="w-4 h-4 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>P-01 to P-04: Zero Cloud Transmission</span>
        </div>
      </div>

      {/* Main Workspace Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
        {/* Left Column: File Dropzone & Viewer */}
        <div className="lg:col-span-7 space-y-4">
          {!source ? (
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload an image to upscale"
              onDrop={handleDrop}
              onDragOver={handleDragOver}
              onClick={() => fileInputRef.current?.click()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  fileInputRef.current?.click();
                }
              }}
              className="flex flex-col items-center justify-center p-12 border-2 border-dashed border-slate-700 hover:border-indigo-500/80 bg-slate-900/50 hover:bg-slate-900/80 rounded-2xl cursor-pointer transition-colors text-center min-h-[380px] focus:outline-none focus:ring-2 focus:ring-indigo-500"
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => e.target.files?.[0] && handleFileChange(e.target.files[0])}
              />
              <div className="w-16 h-16 mb-4 rounded-2xl bg-indigo-950/60 border border-indigo-700/50 flex items-center justify-center text-indigo-400">
                <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <h3 className="text-lg font-bold text-slate-100 mb-1">
                Drop your photo here, or <span className="text-indigo-400 underline">browse</span>
              </h3>
              <p className="text-xs text-slate-400 max-w-sm mt-1">
                Supports PNG, JPEG, WebP up to 50 MB. Your image is never uploaded to any remote server.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Image Preview & Interactive Split Comparison Slider */}
              <div
                ref={splitContainerRef}
                className="relative overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 min-h-[380px] max-h-[560px] flex items-center justify-center select-none"
              >
                {processedUrl ? (
                  <div className="relative w-full h-[460px] overflow-hidden flex items-center justify-center">
                    {/* Upscaled Result (Base / Right side) */}
                    <img
                      src={processedUrl}
                      alt="Upscaled AI Result"
                      className="absolute inset-0 w-full h-full object-contain"
                    />

                    {/* Original Source (Clipped / Left side) */}
                    <div
                      className="absolute inset-0 overflow-hidden"
                      style={{ width: `${sliderPosition}%` }}
                    >
                      <img
                        src={source.previewUrl}
                        alt="Original Source"
                        className="absolute inset-0 w-full h-full object-contain max-w-none"
                        style={{ width: splitContainerRef.current?.clientWidth || '100%' }}
                      />
                    </div>

                    {/* Draggable Divider Handle with Keyboard Accessibility */}
                    <div
                      role="slider"
                      tabIndex={0}
                      aria-label="Comparison split slider position"
                      aria-valuemin={5}
                      aria-valuemax={95}
                      aria-valuenow={Math.round(sliderPosition)}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          setSliderPosition((p) => Math.max(5, p - 5));
                        } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
                          e.preventDefault();
                          setSliderPosition((p) => Math.min(95, p + 5));
                        } else if (e.key === 'Home') {
                          e.preventDefault();
                          setSliderPosition(5);
                        } else if (e.key === 'End') {
                          e.preventDefault();
                          setSliderPosition(95);
                        }
                      }}
                      className="absolute top-0 bottom-0 w-1 bg-white cursor-ew-resize shadow-[0_0_12px_rgba(0,0,0,0.8)] z-20 flex items-center justify-center focus:outline-none focus:ring-2 focus:ring-indigo-400"
                      style={{ left: `${sliderPosition}%` }}
                      onMouseDown={handleMouseDown}
                      onTouchStart={handleTouchStart}
                    >
                      <div className="w-8 h-8 rounded-full bg-slate-900 border-2 border-white shadow-lg flex items-center justify-center text-white text-xs">
                        &harr;
                      </div>
                    </div>

                    {/* Labels */}
                    <div className="absolute top-3 left-3 bg-slate-900/80 backdrop-blur-sm border border-slate-700/80 px-2.5 py-1 rounded text-[11px] font-semibold text-slate-200 pointer-events-none z-10">
                      Original ({source.width}×{source.height})
                    </div>
                    <div className="absolute top-3 right-3 bg-indigo-950/80 backdrop-blur-sm border border-indigo-700/80 px-2.5 py-1 rounded text-[11px] font-semibold text-indigo-300 pointer-events-none z-10">
                      Upscaled {selectedScale}x ({processedDims?.width}×{processedDims?.height})
                    </div>
                  </div>
                ) : (
                  <div className="relative p-4 flex items-center justify-center w-full h-[460px]">
                    <img
                      src={source.previewUrl}
                      alt="Source preview"
                      className="max-h-[420px] max-w-full object-contain rounded-lg"
                    />
                  </div>
                )}
              </div>

              {/* Reset image button */}
              <div className="flex items-center justify-between text-xs text-slate-400 px-1">
                <span>
                  Source: <strong className="text-slate-200">{source.width} × {source.height} px</strong> ({(source.width * source.height / 1_000_000).toFixed(2)} MP)
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setSource(null);
                    setProcessedUrl(null);
                    setProcessedDims(null);
                  }}
                  className="text-slate-400 hover:text-rose-400 underline transition-colors"
                >
                  Choose another image
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: Controls, Scale, Model, Progress & Download */}
        <div className="lg:col-span-5 space-y-6">
          <div className="p-6 bg-slate-900/60 border border-slate-800 rounded-2xl space-y-6">
            {/* Scale Factor Selector */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-200 flex items-center justify-between">
                <span>Scale Factor</span>
                <span className="text-xs text-indigo-400 font-normal">Super-resolution multiplier</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                {[
                  { scale: 2, label: '2x (200%)', desc: 'Faster • 4x pixel density' },
                  { scale: 4, label: '4x (400%)', desc: 'Maximum detail • 16x pixels' },
                ].map((item) => (
                  <button
                    key={item.scale}
                    type="button"
                    onClick={() => setSelectedScale(item.scale)}
                    className={`p-3 rounded-xl border text-left transition-all ${
                      selectedScale === item.scale
                        ? 'bg-indigo-950/80 border-indigo-500 text-slate-100 shadow-lg shadow-indigo-950/50'
                        : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-bold text-sm">{item.label}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{item.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* AI Model Selector */}
            <div className="space-y-3">
              <label className="text-sm font-semibold text-slate-200 flex items-center justify-between">
                <span>Vision Model</span>
                <span className="text-xs text-emerald-400 font-normal">Commercial Permissive</span>
              </label>

              <div className="space-y-2">
                {availableModels.map((model) => (
                  <label
                    key={model.id}
                    className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-all ${
                      selectedModelId === model.id
                        ? 'bg-indigo-950/70 border-indigo-500/80 text-slate-100 shadow-md'
                        : 'bg-slate-950/30 border-slate-800/80 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <input
                      type="radio"
                      name="modelId"
                      value={model.id}
                      checked={selectedModelId === model.id}
                      onChange={() => setSelectedModelId(model.id)}
                      className="mt-1 text-indigo-600 focus:ring-indigo-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-sm text-slate-100">{model.name}</span>
                        <div className="flex items-center gap-1.5">
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                            {model.license}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400 font-mono">
                            {model.formattedSize}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-slate-400 mt-1 leading-relaxed">
                        {model.description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Memory & Resolution Estimation Banner */}
            {memoryEstimation && (
              <div
                className={`p-3.5 rounded-xl border text-xs leading-relaxed ${
                  !memoryEstimation.isSafe
                    ? 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                    : memoryEstimation.warning
                    ? 'bg-amber-950/40 border-amber-800/60 text-amber-300'
                    : 'bg-slate-950/50 border-slate-800 text-slate-300'
                }`}
              >
                <div className="font-semibold flex items-center justify-between mb-1">
                  <span>Output: {memoryEstimation.outputWidth} × {memoryEstimation.outputHeight} px</span>
                  <span>({(memoryEstimation.outputPixels / 1_000_000).toFixed(1)} MP)</span>
                </div>
                {memoryEstimation.warning && <div>{memoryEstimation.warning}</div>}
                {memoryEstimation.rejectionReason && <div className="font-bold">{memoryEstimation.rejectionReason}</div>}
              </div>
            )}

            {/* Action / Cancel Buttons & Progress Bar */}
            <div className="space-y-3 pt-2">
              {!isProcessing ? (
                <button
                  type="button"
                  onClick={handleStartUpscaling}
                  disabled={!source || Boolean(memoryEstimation && !memoryEstimation.isSafe)}
                  className="w-full py-3.5 px-5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed font-semibold text-white shadow-lg shadow-indigo-600/30 transition-all flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                  <span>Upscale Image ({selectedScale}x)</span>
                </button>
              ) : (
                <div className="space-y-3" aria-live="polite">
                  <div className="flex items-center justify-between text-xs text-slate-300">
                    <span className="font-semibold">
                      {tileProgress?.stage === 'downloading_weights'
                        ? `Downloading model weights... (${downloadProgress ?? 0}%)`
                        : tileProgress?.stage === 'tiling'
                        ? `Processing tile ${tileProgress.current} of ${tileProgress.total}...`
                        : tileProgress?.stage === 'blending'
                        ? 'Blending cosine seam masks...'
                        : 'Preparing neural pipeline...'}
                    </span>
                    <span>{tileProgress?.percent ?? 0}%</span>
                  </div>

                  <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-indigo-500 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${tileProgress?.percent ?? 0}%` }}
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleCancel}
                    className="w-full py-2.5 px-4 rounded-xl bg-rose-950/60 hover:bg-rose-900/60 border border-rose-800/80 font-medium text-rose-300 text-sm transition-colors flex items-center justify-center gap-2"
                  >
                    <span>Cancel Upscaling</span>
                  </button>
                </div>
              )}

              {/* Error Message */}
              {error && (
                <div className="p-3 bg-rose-950/60 border border-rose-800 text-rose-300 text-xs rounded-xl">
                  {error}
                </div>
              )}

              {/* Duration Report */}
              {durationMs && (
                <div className="text-center text-xs text-slate-400">
                  Completed in <strong className="text-indigo-400">{(durationMs / 1000).toFixed(2)}s</strong> with zero cloud latency.
                </div>
              )}
            </div>

            {/* Download & Export Section */}
            {processedUrl && (
              <div className="pt-4 border-t border-slate-800 space-y-4">
                <div className="flex items-center justify-between text-sm font-semibold text-slate-200">
                  <span>Export Format</span>
                </div>

                <div className="grid grid-cols-3 gap-2">
                  {(['image/png', 'image/jpeg', 'image/webp'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setDownloadFormat(fmt)}
                      className={`py-2 px-3 rounded-lg border text-xs font-semibold text-center transition-all ${
                        downloadFormat === fmt
                          ? 'bg-indigo-950 border-indigo-500 text-indigo-300'
                          : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {fmt === 'image/png' ? 'PNG' : fmt === 'image/jpeg' ? 'JPEG' : 'WebP'}
                    </button>
                  ))}
                </div>

                {downloadFormat !== 'image/png' && (
                  <div className="space-y-1.5">
                    <div className="flex justify-between text-xs text-slate-400">
                      <span>Compression Quality</span>
                      <span>{Math.round(downloadQuality * 100)}%</span>
                    </div>
                    <input
                      type="range"
                      min="0.5"
                      max="1.0"
                      step="0.05"
                      value={downloadQuality}
                      onChange={(e) => setDownloadQuality(parseFloat(e.target.value))}
                      className="w-full accent-indigo-500 cursor-pointer"
                    />
                  </div>
                )}

                <button
                  type="button"
                  onClick={handleDownload}
                  className="w-full py-3 px-5 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold text-white shadow-lg shadow-emerald-600/30 transition-all flex items-center justify-center gap-2"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download High-Res Image</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
