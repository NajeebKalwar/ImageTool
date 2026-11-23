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
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl">
      {/* Privacy & Hardware Capabilities Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6 p-3 bg-slate-950/80 border border-slate-800 rounded-lg">
        <div className="flex items-center gap-2 text-emerald-300 text-xs sm:text-sm font-medium">
          <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>
            <strong>100% On-Device AI:</strong> Super-resolution executes locally in your browser. Zero image data is sent to external servers.
          </span>
        </div>

        {deviceCaps && (
          <div className="flex items-center gap-1.5 px-2.5 py-1 bg-indigo-950/70 border border-indigo-700/60 rounded text-xs font-semibold text-indigo-300">
            <span>{deviceCaps.hasWebGPU ? '⚡ WebGPU' : '⚙️ WASM Fallback'}</span>
          </div>
        )}
      </div>

      {displayError && (
        <div className="mb-6 p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm">
          {displayError}
        </div>
      )}

      {/* Scale & Model Selection Toolbar */}
      <div className="mb-6 p-4 bg-slate-950/50 border border-slate-800 rounded-lg space-y-4">
        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Target Scale & Model
          </span>
          <div className="text-xs text-slate-400">
            Status: {isCached ? (
              <span className="text-emerald-400 font-medium">💾 Cached in Browser (Offline Ready)</span>
            ) : (
              <span className="text-amber-300 font-medium">⬇️ Download Required on First Run</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setScale(2)}
            disabled={isWorking}
            className={`text-left p-3 rounded-lg border transition-all ${
              scale === 2
                ? 'bg-indigo-950/60 border-indigo-500 shadow-sm shadow-indigo-500/20'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-slate-100">2× Upscale (Fast)</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">Swin2SR Lightweight</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Ultra-lightweight super-resolution for quick 2x doubling with low memory overhead.
            </p>
            <div className="flex gap-4 text-[11px] text-slate-500 mt-2">
              <span>Download: ~7.5 MB</span>
              <span>Fastest</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setScale(4)}
            disabled={isWorking}
            className={`text-left p-3 rounded-lg border transition-all ${
              scale === 4
                ? 'bg-indigo-950/60 border-indigo-500 shadow-sm shadow-indigo-500/20'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-slate-100">4× Upscale (HD Detail)</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">Swin2SR RealWorld</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Deep transformer reconstruction trained on real-world photos with BSRGAN artifacts.
            </p>
            <div className="flex gap-4 text-[11px] text-slate-500 mt-2">
              <span>Download: ~31 MB</span>
              <span>Maximum Detail</span>
            </div>
          </button>
        </div>
      </div>

      {/* Upload Zone / Workspace */}
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
          {/* Comparison / Preview View */}
          <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
            <div className="flex justify-between items-center mb-3">
              <div className="flex items-center gap-3">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                  {result ? 'Comparison Slider (Drag to Compare)' : 'Source Preview'}
                </span>
                <span className="text-xs text-slate-500">
                  {source.width} × {source.height} px
                  {result ? ` → ${result.width} × ${result.height} px (${scale}×)` : ` (${scale}× target)`}
                </span>
              </div>
              <button
                type="button"
                onClick={reset}
                disabled={isWorking}
                className="text-xs text-indigo-400 hover:text-indigo-300 disabled:opacity-50"
              >
                Change Image
              </button>
            </div>

            {result ? (
              /* High-Performance 60fps Split Slider using pure CSS var(--split) */
              <div
                ref={containerRef}
                {...sliderProps}
                className="relative aspect-video max-h-[500px] w-full rounded overflow-hidden select-none cursor-ew-resize bg-slate-950"
                style={{ ['--split' as string]: '50%' }}
              >
                {/* Result image (Full base) */}
                <img
                  src={result.url}
                  alt="Upscaled output"
                  className="absolute inset-0 w-full h-full object-contain pointer-events-none"
                />

                {/* Original image (Clipped to split left) */}
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

                {/* Vertical Divider line */}
                <div
                  className="absolute top-0 bottom-0 w-0.5 bg-white shadow-[0_0_10px_rgba(0,0,0,0.8)] pointer-events-none"
                  style={{ left: 'var(--split)' }}
                >
                  <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-7 h-7 bg-white text-slate-900 rounded-full shadow-md flex items-center justify-center text-xs font-bold">
                    ↔
                  </div>
                </div>

                {/* Labels */}
                <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/60 backdrop-blur rounded text-[11px] text-white pointer-events-none">
                  Original ({source.width}×{source.height})
                </div>
                <div className="absolute bottom-2 right-2 px-2 py-1 bg-indigo-900/80 backdrop-blur rounded text-[11px] text-white pointer-events-none">
                  Upscaled {scale}× ({result.width}×{result.height})
                </div>
              </div>
            ) : (
              /* Single Preview when result is not yet available */
              <div className="relative aspect-video max-h-[400px] w-full rounded overflow-hidden flex items-center justify-center bg-slate-950">
                <img
                  src={source.previewUrl}
                  alt="Source"
                  className="max-w-full max-h-full object-contain"
                />

                {isWorking && (
                  <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm flex flex-col items-center justify-center p-6 space-y-4">
                    <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-center space-y-1">
                      <p className="text-sm font-semibold text-slate-100">
                        {progress.stage === 'downloading'
                          ? 'Downloading AI model weights…'
                          : progress.stage === 'tiling'
                            ? `Processing Tile ${progress.currentTile ?? 0} of ${progress.totalTiles ?? 1}…`
                            : progress.stage === 'blending'
                              ? 'Stitching tiles and blending seams…'
                              : 'Preparing AI model weights…'}
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
                    <div className="w-64 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all duration-200"
                        style={{ width: `${Math.min(100, Math.max(progress.stage === 'downloading' ? progress.percent : 10, progress.percent))}%` }}
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
              </div>
            )}
          </div>

          {/* Action & Download Bar */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            {!result ? (
              <button
                type="button"
                onClick={handleStartUpscaling}
                disabled={isWorking || !memoryEstimation?.isSafe}
                className="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {isWorking ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>
                      {progress.stage === 'downloading'
                        ? progress.loadedBytes && progress.totalBytes
                          ? `Downloading Model (${progress.percent}%) • ${formatBytes(progress.loadedBytes)} / ${formatBytes(progress.totalBytes)}…`
                          : `Downloading Model (${progress.percent}%)…`
                        : progress.stage === 'preparing'
                          ? 'Preparing Upscaler…'
                          : `Upscaling (${scale}×)…`}
                    </span>
                  </>
                ) : (
                  <span>Upscale Image ({scale}×)</span>
                )}
              </button>
            ) : (
              <div className="flex flex-col sm:flex-row w-full gap-3 items-center">
                <div className="flex items-center gap-2 w-full sm:w-auto">
                  <select
                    value={downloadFormat}
                    onChange={(e) => setDownloadFormat(e.target.value as SupportedFormat)}
                    className="px-3 py-3 bg-slate-800 border border-slate-700 rounded-lg text-xs font-medium text-slate-200"
                  >
                    <option value="image/png">PNG (Lossless)</option>
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/webp">WebP</option>
                  </select>

                  {downloadFormat !== 'image/png' && (
                    <select
                      value={downloadQuality}
                      onChange={(e) => setDownloadQuality(parseFloat(e.target.value))}
                      className="px-3 py-3 bg-slate-800 border border-slate-700 rounded-lg text-xs font-medium text-slate-200"
                    >
                      <option value={0.95}>Quality: 95%</option>
                      <option value={0.92}>Quality: 92%</option>
                      <option value={0.85}>Quality: 85%</option>
                    </select>
                  )}
                </div>

                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex-1 w-full py-3 px-6 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download Upscaled Image ({result.width}×{result.height})</span>
                </button>

                <button
                  type="button"
                  onClick={reset}
                  className="w-full sm:w-auto px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg transition-colors"
                >
                  Reset
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
