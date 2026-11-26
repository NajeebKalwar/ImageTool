import { useEffect, useState, useRef } from 'react';
import { useUpscalerStore } from '../lib/stores/upscaler.store';
import { useWorkerClient } from '../lib/hooks/useWorkerClient';
import { useImageFile } from '../lib/hooks/useImageFile';
import { useCompareSlider } from '../lib/hooks/useCompareSlider';
import { detectDeviceCapabilities, type DeviceCapabilities } from '../lib/ai/device';
import { estimateUpscaleMemory, getDeviceMemoryLimits } from '../lib/ai/memory-policy';
import { isModelCachedInBrowser } from '../lib/ai/browser-cache';
import { MODELS } from '../lib/ai/registry';
import type { SupportedFormat } from '../lib/worker-protocol';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function ImageUpscaler() {
  const {
    status,
    source,
    result,
    scale,
    selectedModelId,
    progress,
    error,
    setSource,
    setScale,
    setProgress,
    setResult,
    setStatus,
    setError,
    reset,
  } = useUpscalerStore();

  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null);
  const [isCached, setIsCached] = useState<boolean>(false);
  const [downloadFormat, setDownloadFormat] = useState<SupportedFormat>('image/png');
  const [downloadQuality, setDownloadQuality] = useState<number>(0.92);

  const workerClient = useWorkerClient();
  const abortControllerRef = useRef<AbortController | null>(null);
  const isProcessingRef = useRef<boolean>(false);

  const { dropZoneProps, fileInputProps, openFileDialog, error: fileError } = useImageFile(
    (info) => {
      setSource(info);
    },
  );

  const { containerRef, sliderProps } = useCompareSlider(50);

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

  // Check browser cache status for selected model
  useEffect(() => {
    const selectedMeta = MODELS.find((m) => m.id === selectedModelId);
    if (!selectedMeta) return;

    isModelCachedInBrowser(selectedMeta.repo)
      .then(setIsCached)
      .catch(() => setIsCached(false));
  }, [selectedModelId]);

  // Compute memory estimation
  const memoryEstimation = source
    ? estimateUpscaleMemory(source.width, source.height, scale, getDeviceMemoryLimits())
    : null;

  const handleStartUpscaling = async () => {
    if (!source || !memoryEstimation || isWorking || isProcessingRef.current) return;
    isProcessingRef.current = true;

    if (!memoryEstimation.isSafe) {
      setError(memoryEstimation.rejectionReason || 'Image exceeds safe memory limits.');
      isProcessingRef.current = false;
      return;
    }

    const selectedMeta = MODELS.find((m) => m.id === selectedModelId);
    setStatus('processing');
    setError(null);
    setProgress({
      stage: isCached ? 'preparing' : 'downloading',
      percent: 0,
      loadedBytes: 0,
      totalBytes: isCached ? 0 : (selectedMeta?.approxDownloadBytes.webgpu ?? 0),
    });

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Decode image pixels on scratch canvas
      const img = new Image();
      img.src = source.previewUrl;
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not acquire 2D canvas context.');

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, source.width, source.height);
      const pixelBuffer = imageData.data.buffer.slice(0);

      // Execute tiled super-resolution in Web Worker
      const upscaleResult = await workerClient.upscaleImage(
        selectedModelId,
        scale,
        source.width,
        source.height,
        pixelBuffer,
        undefined,
        controller.signal,
        (p) => {
          setProgress({
            stage: p.stage,
            percent: p.percent,
            currentTile: p.currentTile,
            totalTiles: p.totalTiles,
            loadedBytes: p.loadedBytes,
            totalBytes: p.totalBytes,
          });
        },
      );

      // Render upscale result onto canvas and export to Blob
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
      if (!blob) throw new Error('Failed to generate upscaled image Blob.');

      const url = URL.createObjectURL(blob);
      setResult({
        blob,
        url,
        width: upscaleResult.width,
        height: upscaleResult.height,
        durationMs: upscaleResult.durationMs,
      });
      setIsCached(true);
    } catch (err) {
      if (err instanceof Error && err.message === 'Operation cancelled') {
        setStatus('idle');
      } else {
        setError(err instanceof Error ? err.message : 'Upscaling failed.');
      }
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
    setStatus('idle');
  };

  const handleDownload = async () => {
    if (!result || !source) return;

    let downloadBlob = result.blob;
    let extension = 'png';

    if (downloadFormat !== 'image/png') {
      const img = new Image();
      img.src = result.url;
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = result.width;
      canvas.height = result.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const converted = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob(resolve, downloadFormat, downloadQuality),
        );
        if (converted) {
          downloadBlob = converted;
          extension = downloadFormat === 'image/jpeg' ? 'jpg' : 'webp';
        }
      }
    }

    const baseName = source.file.name.replace(/\.[^/.]+$/, '');
    const filename = `${baseName}-${scale}x.${extension}`;
    const downloadUrl = URL.createObjectURL(downloadBlob);

    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(downloadUrl);
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
        {/* LEFT COLUMN: Upload Dropzone & Comparison Preview */}
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
                  PNG, JPEG, WebP up to 50 MB • Super-resolution 100% on-device
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Uploaded Image Summary Card */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>Uploaded image (1)</span>
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
                        {source.width} × {source.height} px
                        {result ? ` → ${result.width} × ${result.height} px (${scale}×)` : ` (${scale}× target)`}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={reset}
                    disabled={isWorking}
                    aria-label="Remove uploaded image"
                    className="p-1.5 text-slate-400 hover:text-slate-700 disabled:opacity-50"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Comparison / Preview Card */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-700">
                    {result ? 'Comparison Slider (Drag to Compare)' : 'Source Preview'}
                  </span>
                  {result && (
                    <span className="text-[11px] font-mono text-slate-500">
                      {Math.round(result.durationMs)} ms
                    </span>
                  )}
                </div>

                {result ? (
                  <div
                    ref={containerRef}
                    {...sliderProps}
                    className="relative aspect-video max-h-[440px] w-full rounded-lg overflow-hidden select-none cursor-ew-resize bg-slate-100 border border-slate-200"
                    style={{ ['--split' as string]: '50%' }}
                  >
                    <img
                      src={result.url}
                      alt="Upscaled output"
                      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                    />
                    <div
                      className="absolute inset-0 overflow-hidden pointer-events-none"
                      style={{ width: 'var(--split)' }}
                    >
                      <img
                        src={source.previewUrl}
                        alt="Original source"
                        className="absolute inset-0 max-w-none w-full h-full object-contain pointer-events-none"
                      />
                    </div>
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_10px_rgba(0,0,0,0.6)] pointer-events-none"
                      style={{ left: 'var(--split)' }}
                    >
                      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 bg-white text-slate-900 rounded-full shadow-md border border-slate-200 flex items-center justify-center text-xs font-bold">
                        ↔
                      </div>
                    </div>
                    <div className="absolute bottom-2 left-2 px-2 py-1 bg-slate-900/75 backdrop-blur rounded text-[11px] text-white pointer-events-none">
                      Original ({source.width}×{source.height})
                    </div>
                    <div className="absolute bottom-2 right-2 px-2 py-1 bg-blue-600/90 backdrop-blur rounded text-[11px] text-white pointer-events-none">
                      Upscaled {scale}× ({result.width}×{result.height})
                    </div>
                  </div>
                ) : (
                  <div className="relative aspect-video max-h-[360px] w-full rounded-lg overflow-hidden flex items-center justify-center bg-white border border-slate-200/80">
                    <img
                      src={source.previewUrl}
                      alt="Source"
                      className="max-w-full max-h-full object-contain"
                    />

                    {isWorking && (
                      <div className="absolute inset-0 bg-white/90 backdrop-blur-xs flex flex-col items-center justify-center p-6 space-y-3">
                        <div className="w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin" />
                        <div className="text-center space-y-1">
                          <p className="text-xs font-semibold text-slate-900">
                            {progress.stage === 'downloading'
                              ? 'Downloading AI model weights…'
                              : progress.stage === 'tiling'
                                ? `Processing Tile ${progress.currentTile ?? 0} of ${progress.totalTiles ?? 1}…`
                                : progress.stage === 'blending'
                                  ? 'Stitching tiles and blending seams…'
                                  : 'Preparing AI model weights…'}
                          </p>
                          {progress.stage === 'downloading' && progress.loadedBytes && progress.totalBytes ? (
                            <p className="text-[11px] text-slate-500 font-mono">
                              {formatBytes(progress.loadedBytes)} / {formatBytes(progress.totalBytes)} ({progress.percent}%)
                            </p>
                          ) : (
                            <p className="text-[11px] text-blue-600 font-mono">
                              {progress.percent > 0 ? `${progress.percent}% complete` : 'Please wait…'}
                            </p>
                          )}
                        </div>

                        <div className="w-56 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-blue-600 transition-all duration-200"
                            style={{ width: `${Math.min(100, Math.max(progress.stage === 'downloading' ? progress.percent : 10, progress.percent))}%` }}
                          />
                        </div>

                        <button
                          type="button"
                          onClick={handleCancel}
                          className="px-3 py-1 text-xs font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-md"
                        >
                          Cancel
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Choose Scale, Model Status & Action */}
        <div className="lg:col-span-5 bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-slate-900">Choose scale &amp; model</h2>
            {deviceCaps && (
              <span className="text-[11px] font-semibold px-2 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700">
                {deviceCaps.hasWebGPU ? '⚡ WebGPU' : '⚙️ WASM'}
              </span>
            )}
          </div>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500 block">Target Upscale Factor</span>
            <button
              type="button"
              onClick={() => setScale(2)}
              disabled={isWorking}
              className={`w-full px-3.5 py-2.5 rounded-lg text-left text-xs transition-all flex items-center justify-between ${
                scale === 2
                  ? 'bg-slate-200/80 text-blue-600 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>2× Upscale (Swin2SR Lightweight)</span>
              <span className="text-[11px] opacity-80 font-mono">~7.5 MB</span>
            </button>
            <button
              type="button"
              onClick={() => setScale(4)}
              disabled={isWorking}
              className={`w-full px-3.5 py-2.5 rounded-lg text-left text-xs transition-all flex items-center justify-between ${
                scale === 4
                  ? 'bg-slate-200/80 text-blue-600 font-semibold'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>4× Upscale (Swin2SR HD Detail)</span>
              <span className="text-[11px] opacity-80 font-mono">~31 MB</span>
            </button>
          </div>

          {result && (
            <div className="pt-2 border-t border-slate-200/80 space-y-2">
              <span className="text-xs font-medium text-slate-500 block">Export format</span>
              <div className="grid grid-cols-2 gap-2">
                <select
                  value={downloadFormat}
                  onChange={(e) => setDownloadFormat(e.target.value as SupportedFormat)}
                  className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-none focus:border-blue-500"
                >
                  <option value="image/png">PNG (Lossless)</option>
                  <option value="image/jpeg">JPEG</option>
                  <option value="image/webp">WebP</option>
                </select>
                {downloadFormat !== 'image/png' && (
                  <select
                    value={downloadQuality}
                    onChange={(e) => setDownloadQuality(parseFloat(e.target.value))}
                    className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-800 focus:outline-none focus:border-blue-500"
                  >
                    <option value={0.95}>Quality: 95%</option>
                    <option value={0.92}>Quality: 92%</option>
                    <option value={0.85}>Quality: 85%</option>
                  </select>
                )}
              </div>
            </div>
          )}

          <div className="pt-2 space-y-2.5">
            {!result ? (
              <button
                type="button"
                onClick={handleStartUpscaling}
                disabled={!source || isWorking || !memoryEstimation?.isSafe}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {isWorking ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>
                      {progress.stage === 'downloading'
                        ? `Downloading (${progress.percent}%)…`
                        : `Upscaling (${scale}×)…`}
                    </span>
                  </>
                ) : (
                  <span>Upscale Image ({scale}×)</span>
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
                  <span>Download Upscaled ({result.width}×{result.height})</span>
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="w-full py-2 px-4 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
                >
                  Reset
                </button>
              </div>
            )}

            <div className="flex items-center justify-between text-[11px] text-slate-500 pt-1">
              <span>100% On-Device AI</span>
              <span>{isCached ? '💾 Cached Offline Ready' : '⬇️ Downloads on first run'}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
