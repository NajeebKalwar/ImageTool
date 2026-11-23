import { useEffect, useState, useRef } from 'react';
import { useBackgroundRemoverStore, type PreviewBgMode } from '../lib/stores/bgremover.store';
import { useWorkerClient } from '../lib/hooks/useWorkerClient';
import { useImageFile } from '../lib/hooks/useImageFile';
import { detectDeviceCapabilities, type DeviceCapabilities } from '../lib/ai/device';
import { isModelCachedInBrowser } from '../lib/ai/browser-cache';
import { MODELS } from '../lib/ai/registry';

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function BackgroundRemover() {
  const {
    status,
    source,
    result,
    selectedModelId,
    previewBg,
    customBgColor,
    progress,
    error,
    setSource,
    setModelId,
    setPreviewBg,
    setCustomBgColor,
    setProgress,
    setResult,
    setStatus,
    setError,
    reset,
  } = useBackgroundRemoverStore();

  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null);
  const [isCached, setIsCached] = useState<boolean>(false);
  const workerClient = useWorkerClient();
  const isProcessingRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  const { dropZoneProps, fileInputProps, openFileDialog, error: fileError } = useImageFile(
    (info) => {
      setSource(info);
    },
  );

  // Initialize device detection
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

  const handleRemoveBackground = async () => {
    if (!source || isWorking || isProcessingRef.current) return;
    isProcessingRef.current = true;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    const selectedMeta = MODELS.find((m) => m.id === selectedModelId);
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

      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not acquire 2D canvas context.');

      ctx.drawImage(img, 0, 0);
      const imageData = ctx.getImageData(0, 0, source.width, source.height);
      const pixelBuffer = imageData.data.buffer.slice(0);

      // Execute AI background removal in Web Worker with progress and cancel support
      const res = await workerClient.removeBackground(
        selectedModelId,
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

      // Composite output pixels to canvas and export to PNG Blob
      const outCanvas = document.createElement('canvas');
      outCanvas.width = res.width;
      outCanvas.height = res.height;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) throw new Error('Could not acquire output canvas context.');

      const outImageData = new ImageData(
        new Uint8ClampedArray(res.pixels),
        res.width,
        res.height,
      );
      outCtx.putImageData(outImageData, 0, 0);

      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob(resolve, 'image/png'),
      );
      if (!blob) throw new Error('Failed to generate output image Blob.');

      const url = URL.createObjectURL(blob);
      setResult({
        blob,
        url,
        width: res.width,
        height: res.height,
        durationMs: res.durationMs,
      });
      setIsCached(true);
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
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl">
      {/* Privacy & Hardware Capabilities Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6 p-3 bg-slate-950/80 border border-slate-800 rounded-lg">
        <div className="flex items-center gap-2 text-emerald-300 text-xs sm:text-sm font-medium">
          <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>
            <strong>100% On-Device AI:</strong> Model executes in your browser. Zero image data is sent to external servers.
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

      {/* Model Selection Toolbar */}
      <div className="mb-6 p-4 bg-slate-950/50 border border-slate-800 rounded-lg space-y-3">
        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            AI Segmentation Model
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
            onClick={() => setModelId('modnet')}
            disabled={isWorking}
            className={`text-left p-3 rounded-lg border transition-all ${
              selectedModelId === 'modnet'
                ? 'bg-indigo-950/60 border-indigo-500 shadow-sm shadow-indigo-500/20'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-slate-100">MODNet</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">Apache-2.0</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              Lightweight real-time portrait and object matting optimized for mobile & lower-end devices.
            </p>
            <div className="flex gap-4 text-[11px] text-slate-500 mt-2">
              <span>Size: ~12 MB</span>
              <span>Fastest</span>
            </div>
          </button>

          <button
            type="button"
            onClick={() => setModelId('birefnet-lite')}
            disabled={isWorking}
            className={`text-left p-3 rounded-lg border transition-all ${
              selectedModelId === 'birefnet-lite'
                ? 'bg-indigo-950/60 border-indigo-500 shadow-sm shadow-indigo-500/20'
                : 'bg-slate-900 border-slate-800 hover:border-slate-700'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-slate-100">BiRefNet-lite</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">MIT</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">
              High-accuracy bilateral reference network for fine hair, fur, and intricate edges.
            </p>
            <div className="flex gap-4 text-[11px] text-slate-500 mt-2">
              <span>Size: ~114 MB</span>
              <span>Highest Quality</span>
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
          {/* Dual Preview Area */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Original Card */}
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
              <div className="flex justify-between text-xs text-slate-500 mt-2">
                <span>{source.width} × {source.height} px</span>
                <span>{(source.file.size / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
            </div>

            {/* Processed Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Transparent Output</span>
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
                className={`aspect-square rounded flex items-center justify-center overflow-hidden ${
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
                {result ? (
                  <img
                    src={result.url}
                    alt="Background removed output"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : isWorking ? (
                  <div className="w-full h-full flex flex-col items-center justify-center p-6 space-y-4 bg-slate-950/80 backdrop-blur-sm">
                    <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-center space-y-1 max-w-[280px]">
                      <p className="text-sm font-semibold text-slate-100">
                        {progress.stage === 'downloading'
                          ? 'Downloading AI model weights…'
                          : progress.stage === 'initializing'
                            ? 'Initializing AI model engine…'
                            : progress.stage === 'segmenting'
                              ? 'Extracting foreground subject…'
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

                    {/* Real-time Progress Bar */}
                    <div className="w-48 sm:w-64 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all duration-200"
                        style={{
                          width: `${Math.min(100, Math.max(progress.stage === 'downloading' ? progress.percent : 15, progress.percent))}%`,
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
                ) : (
                  <span className="text-xs text-slate-500">Click &quot;Remove Background&quot; to start</span>
                )}
              </div>

              <div className="flex justify-between text-xs text-slate-500 mt-2">
                <span>{result ? `${result.width} × ${result.height} px` : '—'}</span>
                <span>{result ? `${result.durationMs} ms` : '—'}</span>
              </div>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            {!result ? (
              <button
                type="button"
                onClick={handleRemoveBackground}
                disabled={isWorking}
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
                        : progress.stage === 'initializing'
                          ? 'Initializing Model Engine…'
                          : progress.stage === 'segmenting'
                            ? 'Segmenting Subject…'
                            : 'Processing…'}
                    </span>
                  </>
                ) : (
                  <span>Remove Background</span>
                )}
              </button>
            ) : (
              <div className="flex w-full gap-3">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex-1 py-3 px-6 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2"
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
