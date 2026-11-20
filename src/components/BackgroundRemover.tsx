import { useState, useRef, useEffect, useCallback } from 'react';
import { detectDeviceCapabilities, type DeviceCapabilities } from '../lib/ai/device';
import { ModelCacheManager } from '../lib/ai/model-cache';
import { getModelsByTask, type ModelMetadata } from '../lib/ai/model-registry';
import { ImageWorkerClient } from '../lib/worker-client';

interface SourceImage {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
}

export default function BackgroundRemover() {
  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null);
  const [availableModels] = useState<ModelMetadata[]>(() => getModelsByTask('background-removal'));
  const [selectedModelId, setSelectedModelId] = useState<string>('modnet');
  const [isModelCached, setIsModelCached] = useState<boolean>(false);
  const [downloadProgress, setDownloadProgress] = useState<number | null>(null);

  const [source, setSource] = useState<SourceImage | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [previewBg, setPreviewBg] = useState<'transparent' | 'white' | 'black' | 'custom'>('transparent');
  const [customBgColor, setCustomBgColor] = useState<string>('#3b82f6');

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [processingStatus, setProcessingStatus] = useState<string>('');
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<ImageWorkerClient | null>(null);
  const cacheManagerRef = useRef<ModelCacheManager | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize device detection and cache manager
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

  const getClient = useCallback((): ImageWorkerClient => {
    if (clientRef.current && !clientRef.current.isTerminated) {
      return clientRef.current;
    }
    const worker = new Worker(
      new URL('../workers/image-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const client = new ImageWorkerClient(worker as never);
    clientRef.current = client;
    return client;
  }, []);

  const handleFile = useCallback((file: File) => {
    setError(null);
    setProcessedUrl(null);
    setDurationMs(null);

    if (!file.type.startsWith('image/')) {
      setError('Please choose a valid image file (PNG, JPEG, WebP, etc.).');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setError('Image file is too large. Maximum supported file size is 50 MB.');
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      if (source?.previewUrl) URL.revokeObjectURL(source.previewUrl);
      setSource({
        file,
        previewUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    };

    img.onerror = () => {
      URL.revokeObjectURL(previewUrl);
      setError('Failed to load image preview.');
    };

    img.src = previewUrl;
  }, [source]);

  const removeBackground = async () => {
    if (!source) return;

    setError(null);
    setIsProcessing(true);
    setDownloadProgress(null);

    try {
      // 1. Download & cache model if not cached yet
      if (!isModelCached && cacheManagerRef.current) {
        setProcessingStatus('Downloading AI model weights to browser cache…');
        await cacheManagerRef.current.downloadAndCache(
          selectedModelId,
          (progress) => {
            setDownloadProgress(progress.percentage);
          },
        );
        setIsModelCached(true);
      }

      setProcessingStatus('Running AI segmentation model in Web Worker…');
      const startTime = performance.now();

      // Read image into canvas to extract raw RGBA pixels
      const img = new Image();
      img.src = source.previewUrl;
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = reject;
      });

      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not create canvas context.');

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, source.width, source.height);

      const client = getClient();

      // Ensure model is loaded in worker
      await client.loadAiModel(selectedModelId);

      // Run AI background removal
      const res = await client.removeBackground(
        selectedModelId,
        source.width,
        source.height,
        imgData.data.buffer,
      );

      const elapsed = Math.round(performance.now() - startTime);
      setDurationMs(elapsed);

      // Put segmented pixels back on canvas
      const outputImageData = new ImageData(
        new Uint8ClampedArray(res.pixels),
        res.width,
        res.height,
      );
      ctx.putImageData(outputImageData, 0, 0);

      // Export canvas to transparent PNG Blob
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/png'),
      );

      if (!blob) throw new Error('Failed to generate output image.');

      const outputUrl = URL.createObjectURL(blob);
      if (processedUrl) URL.revokeObjectURL(processedUrl);
      setProcessedUrl(outputUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Background removal failed.');
    } finally {
      setIsProcessing(false);
      setProcessingStatus('');
      setDownloadProgress(null);
    }
  };

  const downloadResult = () => {
    if (!processedUrl || !source) return;

    const baseName = source.file.name.replace(/\.[^/.]+$/, '');
    const filename = `${baseName}-no-bg.png`;

    const a = document.createElement('a');
    a.href = processedUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl">
      {/* Privacy & Hardware Capabilities Badge */}
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

      {error && (
        <div className="mb-6 p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm">
          {error}
        </div>
      )}

      {/* Model Selection Toolbar */}
      <div className="mb-6 p-4 bg-slate-950/50 border border-slate-800 rounded-lg space-y-3">
        <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-2">
          <label htmlFor="ai-model-select" className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            AI Segmentation Model
          </label>
          <div className="text-xs text-slate-400">
            Status: {isModelCached ? (
              <span className="text-emerald-400 font-medium">💾 Cached in Browser (Offline Ready)</span>
            ) : (
              <span className="text-amber-300 font-medium">⬇️ Download Required on First Run</span>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {availableModels.map((m) => {
            const isSelected = m.id === selectedModelId;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setSelectedModelId(m.id)}
                className={`p-3 rounded-lg border text-left transition-all ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-950/40 text-slate-100 shadow-md'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400 hover:border-slate-700'
                }`}
              >
                <div className="flex justify-between items-center mb-1">
                  <strong className="text-sm text-slate-200">{m.name}</strong>
                  <span className="text-xs px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono">
                    {m.license}
                  </span>
                </div>
                <p className="text-xs text-slate-400 line-clamp-2 mb-2">{m.description}</p>
                <div className="text-[11px] text-slate-500 font-mono flex justify-between">
                  <span>Size: {m.formattedSize}</span>
                  <span>Input: {m.inputResolution}×{m.inputResolution}px</span>
                </div>
              </button>
            );
          })}
        </div>

        {downloadProgress !== null && (
          <div className="pt-2">
            <div className="flex justify-between text-xs text-slate-300 mb-1">
              <span>Downloading Model Weights…</span>
              <span>{downloadProgress}%</span>
            </div>
            <div className="w-full bg-slate-800 rounded-full h-2 overflow-hidden">
              <div
                className="bg-indigo-500 h-2 rounded-full transition-all duration-200"
                style={{ width: `${downloadProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {/* File Dropzone */}
      {!source ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
          }}
          className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-10 text-center transition-colors cursor-pointer bg-slate-950/40"
          onClick={() => fileInputRef.current?.click()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) handleFile(e.target.files[0]);
            }}
          />
          <div className="mx-auto w-12 h-12 mb-3 text-slate-400">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <p className="text-base font-semibold text-slate-200">
            Choose a photo to remove its background
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Drag and drop or browse • PNG, JPEG, WebP supported up to 50 MB
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            {/* Original Card */}
            <div className="bg-slate-950/60 p-4 rounded-lg border border-slate-800">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Original</span>
                <button
                  type="button"
                  onClick={() => {
                    setSource(null);
                    setProcessedUrl(null);
                  }}
                  className="text-xs text-slate-400 hover:text-rose-400 transition-colors"
                >
                  Change Image
                </button>
              </div>
              <div className="relative aspect-video max-h-56 flex items-center justify-center bg-slate-900 rounded overflow-hidden mb-3">
                <img
                  src={source.previewUrl}
                  alt="Original input"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <div className="text-xs text-slate-400 flex justify-between">
                <span>{source.width} × {source.height} px</span>
                <span>{(source.file.size / 1024 / 1024).toFixed(2)} MB</span>
              </div>
            </div>

            {/* Output Preview / Process Action Card */}
            <div className="bg-slate-950/60 p-4 rounded-lg border border-slate-800 flex flex-col justify-between">
              <div>
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Transparent Output
                  </span>
                  {durationMs && (
                    <span className="text-xs text-emerald-400 font-medium">
                      Finished in {durationMs} ms
                    </span>
                  )}
                </div>

                {/* Preview Window with Background Toggles */}
                <div
                  className="relative aspect-video max-h-56 flex items-center justify-center rounded overflow-hidden mb-3 border border-slate-800"
                  style={{
                    backgroundColor:
                      previewBg === 'white'
                        ? '#ffffff'
                        : previewBg === 'black'
                        ? '#000000'
                        : previewBg === 'custom'
                        ? customBgColor
                        : undefined,
                    backgroundImage:
                      previewBg === 'transparent'
                        ? 'linear-gradient(45deg, #1e293b 25%, transparent 25%), linear-gradient(-45deg, #1e293b 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1e293b 75%), linear-gradient(-45deg, transparent 75%, #1e293b 75%)'
                        : undefined,
                    backgroundSize: '16px 16px',
                    backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
                  }}
                >
                  {processedUrl ? (
                    <img
                      src={processedUrl}
                      alt="Segmented output preview"
                      className="max-h-full max-w-full object-contain"
                    />
                  ) : (
                    <span className="text-xs text-slate-500">
                      Click "Remove Background" to start
                    </span>
                  )}
                </div>

                {/* Background Color Preview Buttons */}
                {processedUrl && (
                  <div className="flex items-center gap-2 mb-4">
                    <span className="text-xs text-slate-400">Preview On:</span>
                    <button
                      type="button"
                      onClick={() => setPreviewBg('transparent')}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        previewBg === 'transparent' ? 'border-indigo-500 text-white' : 'border-slate-800 text-slate-400'
                      }`}
                    >
                      Transparent
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewBg('white')}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        previewBg === 'white' ? 'border-indigo-500 text-white' : 'border-slate-800 text-slate-400'
                      }`}
                    >
                      White
                    </button>
                    <button
                      type="button"
                      onClick={() => setPreviewBg('black')}
                      className={`text-xs px-2 py-0.5 rounded border ${
                        previewBg === 'black' ? 'border-indigo-500 text-white' : 'border-slate-800 text-slate-400'
                      }`}
                    >
                      Black
                    </button>
                    <input
                      type="color"
                      value={customBgColor}
                      onChange={(e) => {
                        setCustomBgColor(e.target.value);
                        setPreviewBg('custom');
                      }}
                      className="w-6 h-6 rounded cursor-pointer bg-transparent border-0"
                      title="Custom color"
                    />
                  </div>
                )}
              </div>

              {/* Action Buttons */}
              <div className="space-y-2">
                {!processedUrl ? (
                  <button
                    type="button"
                    onClick={removeBackground}
                    disabled={isProcessing}
                    className="w-full py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900/50 text-white font-medium text-sm rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
                  >
                    {isProcessing ? (
                      <>
                        <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                        </svg>
                        <span>{processingStatus || 'Processing in Web Worker…'}</span>
                      </>
                    ) : (
                      <span>Remove Background</span>
                    )}
                  </button>
                ) : (
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={downloadResult}
                      className="flex-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
                    >
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                      Download Transparent PNG
                    </button>
                    <button
                      type="button"
                      onClick={removeBackground}
                      disabled={isProcessing}
                      className="py-2.5 px-3 bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm rounded-lg"
                      title="Reprocess"
                    >
                      ↻
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
