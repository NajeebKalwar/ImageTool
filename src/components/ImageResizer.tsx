import { useState, useRef, useEffect, useCallback } from 'react';
import { ImageWorkerClient } from '../lib/worker-client';
import type { ResizeFit, SupportedFormat } from '../lib/worker-protocol';

interface ImageMeta {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
  aspectRatio: number;
}

interface ProcessedResult {
  url: string;
  blob: Blob;
  width: number;
  height: number;
  format: SupportedFormat;
  size: number;
  elapsedMs: number;
}

export default function ImageResizer() {
  const [source, setSource] = useState<ImageMeta | null>(null);
  const [targetWidth, setTargetWidth] = useState<number>(0);
  const [targetHeight, setTargetHeight] = useState<number>(0);
  const [lockAspect, setLockAspect] = useState<boolean>(true);
  const [fit, setFit] = useState<ResizeFit>('contain');
  const [format, setFormat] = useState<SupportedFormat>('image/webp');
  const [quality, setQuality] = useState<number>(85);

  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessedResult | null>(null);

  const clientRef = useRef<ImageWorkerClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Initialize or retrieve worker client
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

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.terminate();
        clientRef.current = null;
      }
      if (source?.previewUrl) {
        URL.revokeObjectURL(source.previewUrl);
      }
      if (result?.url) {
        URL.revokeObjectURL(result.url);
      }
    };
  }, []);

  const handleFile = useCallback((file: File) => {
    setError(null);
    setResult(null);

    if (!file.type.startsWith('image/')) {
      setError('Please select a valid image file (JPEG, PNG, WebP, etc.).');
      return;
    }

    if (file.size > 50 * 1024 * 1024) {
      setError('Image file is too large. Maximum supported file size is 50 MB.');
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const aspect = w / h;

      if (source?.previewUrl) {
        URL.revokeObjectURL(source.previewUrl);
      }

      setSource({
        file,
        previewUrl,
        width: w,
        height: h,
        aspectRatio: aspect,
      });

      setTargetWidth(w);
      setTargetHeight(h);
    };

    img.onerror = () => {
      URL.revokeObjectURL(previewUrl);
      setError('Failed to load image preview. The file may be corrupt.');
    };

    img.src = previewUrl;
  }, [source]);

  const onWidthChange = (val: number) => {
    const w = Math.max(1, Math.round(val));
    setTargetWidth(w);
    if (lockAspect && source && source.aspectRatio > 0) {
      setTargetHeight(Math.max(1, Math.round(w / source.aspectRatio)));
    }
  };

  const onHeightChange = (val: number) => {
    const h = Math.max(1, Math.round(val));
    setTargetHeight(h);
    if (lockAspect && source && source.aspectRatio > 0) {
      setTargetWidth(Math.max(1, Math.round(h * source.aspectRatio)));
    }
  };

  const applyPreset = (scale: number) => {
    if (!source) return;
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    setTargetWidth(w);
    setTargetHeight(h);
  };

  const processImage = async () => {
    if (!source) return;

    setError(null);
    setIsProcessing(true);

    try {
      const client = getClient();
      const startTime = performance.now();

      // Read file bytes into ArrayBuffer - transfer directly to worker
      const fileBuffer = await source.file.arrayBuffer();

      const response = await client.resize(fileBuffer, {
        width: targetWidth,
        height: targetHeight,
        fit,
        format,
        quality: quality / 100,
      });

      const elapsed = Math.round(performance.now() - startTime);

      const blob = new Blob([response.data], { type: response.format });
      const url = URL.createObjectURL(blob);

      if (result?.url) {
        URL.revokeObjectURL(result.url);
      }

      setResult({
        url,
        blob,
        width: response.width,
        height: response.height,
        format: response.format,
        size: blob.size,
        elapsedMs: elapsed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Image processing failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadResult = () => {
    if (!result || !source) return;

    const baseName = source.file.name.replace(/\.[^/.]+$/, '');
    const ext = result.format === 'image/jpeg' ? 'jpg' : result.format === 'image/webp' ? 'webp' : 'png';
    const filename = `${baseName}-${result.width}x${result.height}.${ext}`;

    const a = document.createElement('a');
    a.href = result.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl">
      {/* Privacy Badge */}
      <div className="flex items-center gap-2 mb-6 px-3 py-2 bg-emerald-950/60 border border-emerald-800/60 rounded-lg text-emerald-300 text-xs sm:text-sm font-medium">
        <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
        </svg>
        <span>
          <strong>100% Private & Local:</strong> Image bytes never leave your device. All decoding, resizing, and encoding run entirely in your browser via Web Workers.
        </span>
      </div>

      {error && (
        <div className="mb-6 p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm">
          {error}
        </div>
      )}

      {/* File Upload Dropzone */}
      {!source ? (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload an image to resize and convert"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
          }}
          className="border-2 border-dashed border-slate-700 hover:border-indigo-500 rounded-xl p-10 text-center transition-colors cursor-pointer bg-slate-950/40 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          onClick={() => fileInputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
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
            Click to upload or drag and drop an image
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Supports PNG, JPEG, WebP, AVIF up to 50 MB
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Image Info & Preview Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
            {/* Source Preview Card */}
            <div className="bg-slate-950/60 p-4 rounded-lg border border-slate-800">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Original Image</span>
                <button
                  type="button"
                  onClick={() => {
                    setSource(null);
                    setResult(null);
                  }}
                  className="text-xs text-slate-400 hover:text-rose-400 transition-colors"
                >
                  Change Image
                </button>
              </div>
              <div className="relative aspect-video max-h-48 flex items-center justify-center bg-slate-900 rounded overflow-hidden mb-3">
                <img
                  src={source.previewUrl}
                  alt="Original preview"
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <div className="text-xs text-slate-400 space-y-1">
                <div className="flex justify-between">
                  <span>Dimensions:</span>
                  <strong className="text-slate-200">{source.width} × {source.height} px</strong>
                </div>
                <div className="flex justify-between">
                  <span>File size:</span>
                  <strong className="text-slate-200">{formatSize(source.file.size)}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Format:</span>
                  <strong className="text-slate-200">{source.file.type || 'image'}</strong>
                </div>
              </div>
            </div>

            {/* Resize Controls */}
            <div className="space-y-4 bg-slate-950/60 p-4 rounded-lg border border-slate-800">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-400 block mb-2">
                Resize Settings
              </span>

              {/* Dimension Inputs */}
              <div className="grid grid-cols-2 gap-3 items-end">
                <div>
                  <label htmlFor="target-width" className="block text-xs font-medium text-slate-300 mb-1">
                    Width (px)
                  </label>
                  <input
                    id="target-width"
                    type="number"
                    min="1"
                    max="10000"
                    value={targetWidth || ''}
                    onChange={(e) => onWidthChange(Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label htmlFor="target-height" className="block text-xs font-medium text-slate-300 mb-1">
                    Height (px)
                  </label>
                  <input
                    id="target-height"
                    type="number"
                    min="1"
                    max="10000"
                    value={targetHeight || ''}
                    onChange={(e) => onHeightChange(Number(e.target.value))}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-sm text-slate-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Aspect Ratio Lock */}
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="lock-aspect"
                  checked={lockAspect}
                  onChange={(e) => setLockAspect(e.target.checked)}
                  className="rounded bg-slate-900 border-slate-700 text-indigo-600 focus:ring-0"
                />
                <label htmlFor="lock-aspect" className="text-xs text-slate-300 cursor-pointer">
                  Lock aspect ratio ({source.aspectRatio.toFixed(2)}:1)
                </label>
              </div>

              {/* Quick Presets */}
              <div>
                <span className="text-xs text-slate-400 block mb-1">Quick Scale Presets</span>
                <div className="flex gap-1.5 flex-wrap">
                  {[0.25, 0.5, 0.75, 1, 2].map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => applyPreset(s)}
                      className="px-2 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 text-slate-200 transition-colors"
                    >
                      {s * 100}%
                    </button>
                  ))}
                </div>
              </div>

              {/* Format & Quality */}
              <div className="grid grid-cols-3 gap-2.5 pt-2 border-t border-slate-800">
                <div>
                  <label htmlFor="target-fit" className="block text-xs font-medium text-slate-300 mb-1">
                    Fit Mode
                  </label>
                  <select
                    id="target-fit"
                    value={fit}
                    onChange={(e) => setFit(e.target.value as ResizeFit)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="contain">Contain</option>
                    <option value="cover">Cover</option>
                    <option value="fill">Fill (Stretch)</option>
                    <option value="inside">Inside (No upscale)</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="target-format" className="block text-xs font-medium text-slate-300 mb-1">
                    Output Format
                  </label>
                  <select
                    id="target-format"
                    value={format}
                    onChange={(e) => setFormat(e.target.value as SupportedFormat)}
                    className="w-full bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="image/webp">WebP</option>
                    <option value="image/jpeg">JPEG</option>
                    <option value="image/png">PNG</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="target-quality" className="block text-xs font-medium text-slate-300 mb-1">
                    Quality ({quality}%)
                  </label>
                  <input
                    id="target-quality"
                    type="range"
                    min="10"
                    max="100"
                    value={quality}
                    disabled={format === 'image/png'}
                    onChange={(e) => setQuality(Number(e.target.value))}
                    className="w-full accent-indigo-500 cursor-pointer mt-1"
                  />
                </div>
              </div>

              {/* Action Button */}
              <button
                type="button"
                onClick={processImage}
                disabled={isProcessing}
                className="w-full mt-2 py-2.5 px-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-indigo-900/50 text-white font-medium text-sm rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>Processing in Worker…</span>
                  </>
                ) : (
                  <span>Resize & Convert</span>
                )}
              </button>
            </div>
          </div>

          {/* Result Card */}
          {result && (
            <div className="bg-slate-950 p-5 rounded-lg border border-indigo-900/60 space-y-4">
              <div className="flex justify-between items-center">
                <span className="text-sm font-semibold text-emerald-400 flex items-center gap-1.5">
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Processing Complete ({result.elapsedMs} ms)
                </span>
                <span className="text-xs text-slate-400">
                  {formatSize(source.file.size)} → <strong>{formatSize(result.size)}</strong> ({(((result.size - source.file.size) / source.file.size) * 100).toFixed(1)}%)
                </span>
              </div>

              <div className="relative aspect-video max-h-64 flex items-center justify-center bg-slate-900/80 rounded border border-slate-800 overflow-hidden">
                <img
                  src={result.url}
                  alt="Resized output preview"
                  className="max-h-full max-w-full object-contain"
                />
              </div>

              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={downloadResult}
                  className="flex-1 py-2.5 px-4 bg-emerald-600 hover:bg-emerald-500 text-white font-semibold text-sm rounded-lg transition-colors shadow-lg flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  Download Resized Image ({result.width} × {result.height})
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
