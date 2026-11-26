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
    <div className="w-full max-w-5xl mx-auto space-y-5">
      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm shadow-2xs">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT COLUMN: Dropzone, Original Preview & Result */}
        <div className="lg:col-span-7 space-y-4">
          {!source ? (
            <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs">
              <div
                role="button"
                tabIndex={0}
                aria-label="Upload an image to resize and convert"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  if (e.dataTransfer.files?.[0]) handleFile(e.dataTransfer.files[0]);
                }}
                className="border-[1.5px] border-dashed border-slate-300 hover:border-blue-400 rounded-lg py-14 px-6 text-center transition-colors cursor-pointer bg-[#f8f9fc] focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                <p className="text-sm font-medium text-slate-700 mb-2">Drag file here</p>
                <p className="text-xs text-slate-400 mb-3">or</p>
                <span className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-blue-200 hover:border-blue-500 text-slate-800 text-xs font-semibold rounded-lg shadow-2xs transition-colors">
                  <svg className="w-4 h-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5m0 0l5 5m-5-5v12" />
                  </svg>
                  Choose file
                </span>
                <p className="text-[11px] text-slate-500 mt-4">
                  PNG, JPEG, WebP, AVIF up to 50 MB • Local Web Worker resizing
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Source File & Preview Card */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-700">Original Image</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSource(null);
                      setResult(null);
                    }}
                    className="text-xs font-medium text-blue-600 hover:text-blue-700"
                  >
                    Change file
                  </button>
                </div>
                <div className="relative aspect-video max-h-56 flex items-center justify-center bg-white border border-slate-200/80 rounded-lg overflow-hidden">
                  <img
                    src={source.previewUrl}
                    alt="Original preview"
                    className="max-h-full max-w-full object-contain"
                  />
                </div>
                <div className="grid grid-cols-3 gap-2 text-xs text-slate-600 bg-white border border-slate-200/80 rounded-lg p-2.5 text-center">
                  <div>
                    <span className="text-[10px] text-slate-400 block">Dimensions</span>
                    <strong className="text-slate-900 font-mono">{source.width} × {source.height}</strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 block">Size</span>
                    <strong className="text-slate-900 font-mono">{formatSize(source.file.size)}</strong>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-400 block">Format</span>
                    <strong className="text-slate-900">{source.file.type.replace('image/', '').toUpperCase() || 'IMG'}</strong>
                  </div>
                </div>
              </div>

              {/* Result Card */}
              {result && (
                <div className="bg-[#f8f9fc] p-5 rounded-xl border border-slate-200/90 shadow-2xs space-y-4">
                  <div className="flex justify-between items-center">
                    <span className="text-sm font-bold text-emerald-700 flex items-center gap-1.5">
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Complete ({result.elapsedMs} ms)
                    </span>
                    <span className="text-xs text-slate-500 font-mono">
                      {formatSize(source.file.size)} → <strong className="text-slate-900">{formatSize(result.size)}</strong> (
                      {(((result.size - source.file.size) / source.file.size) * 100).toFixed(1)}%)
                    </span>
                  </div>

                  <div className="relative aspect-video max-h-60 flex items-center justify-center bg-white rounded-lg border border-slate-200/80 overflow-hidden">
                    <img
                      src={result.url}
                      alt="Resized output preview"
                      className="max-h-full max-w-full object-contain"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={downloadResult}
                    className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold text-sm rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    Download Resized ({result.width} × {result.height})
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Resize Settings & Action */}
        <div className="lg:col-span-5 bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
          <h2 className="text-base font-bold text-slate-900">Resize settings</h2>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="target-width" className="block text-xs font-medium text-slate-600 mb-1">
                Width (px)
              </label>
              <input
                id="target-width"
                type="number"
                min="1"
                max="10000"
                disabled={!source}
                value={targetWidth || ''}
                onChange={(e) => onWidthChange(Number(e.target.value))}
                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500 disabled:bg-slate-100"
              />
            </div>
            <div>
              <label htmlFor="target-height" className="block text-xs font-medium text-slate-600 mb-1">
                Height (px)
              </label>
              <input
                id="target-height"
                type="number"
                min="1"
                max="10000"
                disabled={!source}
                value={targetHeight || ''}
                onChange={(e) => onHeightChange(Number(e.target.value))}
                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500 disabled:bg-slate-100"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="lock-aspect"
              checked={lockAspect}
              onChange={(e) => setLockAspect(e.target.checked)}
              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="lock-aspect" className="text-xs text-slate-700 cursor-pointer">
              Lock aspect ratio {source ? `(${source.aspectRatio.toFixed(2)}:1)` : ''}
            </label>
          </div>

          <div>
            <span className="text-xs font-medium text-slate-500 block mb-1.5">Quick Scale Presets</span>
            <div className="flex gap-1.5 flex-wrap">
              {[0.25, 0.5, 0.75, 1, 2].map((s) => (
                <button
                  key={s}
                  type="button"
                  disabled={!source}
                  onClick={() => applyPreset(s)}
                  className="px-2.5 py-1 text-xs font-semibold rounded-md bg-white border border-slate-200 hover:border-blue-400 text-slate-700 hover:text-blue-600 disabled:opacity-50 transition-colors"
                >
                  {s * 100}%
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2.5 pt-2 border-t border-slate-200/80">
            <div>
              <label htmlFor="target-fit" className="block text-xs font-medium text-slate-600 mb-1">
                Fit Mode
              </label>
              <select
                id="target-fit"
                value={fit}
                onChange={(e) => setFit(e.target.value as ResizeFit)}
                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500"
              >
                <option value="contain">Contain</option>
                <option value="cover">Cover</option>
                <option value="fill">Fill (Stretch)</option>
                <option value="inside">Inside (No upscale)</option>
              </select>
            </div>

            <div>
              <label htmlFor="target-format" className="block text-xs font-medium text-slate-600 mb-1">
                Output Format
              </label>
              <select
                id="target-format"
                value={format}
                onChange={(e) => setFormat(e.target.value as SupportedFormat)}
                className="w-full bg-white border border-slate-200 rounded-lg px-2.5 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500"
              >
                <option value="image/webp">WebP</option>
                <option value="image/jpeg">JPEG</option>
                <option value="image/png">PNG</option>
              </select>
            </div>
          </div>

          {format !== 'image/png' && (
            <div className="space-y-1">
              <div className="flex justify-between text-xs">
                <span className="text-slate-600 font-medium">Quality</span>
                <span className="font-mono font-semibold text-blue-600">{quality}%</span>
              </div>
              <input
                id="target-quality"
                type="range"
                min="10"
                max="100"
                value={quality}
                onChange={(e) => setQuality(Number(e.target.value))}
                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              />
            </div>
          )}

          <button
            type="button"
            onClick={processImage}
            disabled={!source || isProcessing}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white font-semibold text-sm rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
          >
            {isProcessing ? (
              <>
                <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                </svg>
                <span>Processing…</span>
              </>
            ) : (
              <span>Resize &amp; Convert</span>
            )}
          </button>

          <p className="text-[11px] text-slate-500 text-center">
            100% Private • Web Worker Processing
          </p>
        </div>
      </div>
    </div>
  );
}
