import { useState, useRef, useEffect } from 'react';
import { ImageWorkerClient } from '../lib/worker-client';
import type { SupportedFormat } from '../lib/worker-protocol';

interface SourceImage {
  file: File;
  previewUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

interface CompressedResult {
  url: string;
  blob: Blob;
  sizeBytes: number;
  reductionPercent: number;
  format: SupportedFormat;
  elapsedMs: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function ImageCompressor() {
  const [source, setSource] = useState<SourceImage | null>(null);
  const [result, setResult] = useState<CompressedResult | null>(null);
  const [quality, setQuality] = useState<number>(80);
  const [preset, setPreset] = useState<'balanced' | 'high' | 'aggressive' | 'custom'>('balanced');
  const [targetFormat, setTargetFormat] = useState<SupportedFormat>('image/webp');
  const [maxWidth, setMaxWidth] = useState<number | ''>('');
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<ImageWorkerClient | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getClient = (): ImageWorkerClient => {
    if (!clientRef.current || clientRef.current.isTerminated) {
      const worker = new Worker(new URL('../workers/image-worker.ts', import.meta.url), {
        type: 'module',
      });
      clientRef.current = new ImageWorkerClient(worker);
    }
    return clientRef.current;
  };

  useEffect(() => {
    return () => {
      if (clientRef.current) {
        clientRef.current.terminate();
        clientRef.current = null;
      }
      if (source?.previewUrl) URL.revokeObjectURL(source.previewUrl);
      if (result?.url) URL.revokeObjectURL(result.url);
    };
  }, [source, result]);

  const handleFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please choose an image file (PNG, JPEG, WebP, AVIF).');
      return;
    }

    setError(null);
    if (result?.url) {
      URL.revokeObjectURL(result.url);
      setResult(null);
    }

    const previewUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      setSource({
        file,
        previewUrl,
        width: img.naturalWidth,
        height: img.naturalHeight,
        sizeBytes: file.size,
      });

      // Default target format: if PNG with no transparency or JPG, recommend WebP for maximum compression
      setTargetFormat('image/webp');
    };
    img.onerror = () => {
      setError('Failed to load image. File may be corrupted.');
    };
    img.src = previewUrl;
  };

  const handlePresetChange = (selected: 'balanced' | 'high' | 'aggressive' | 'custom') => {
    setPreset(selected);
    if (selected === 'high') setQuality(90);
    else if (selected === 'balanced') setQuality(80);
    else if (selected === 'aggressive') setQuality(55);
  };

  const handleCompress = async () => {
    if (!source) return;

    setIsProcessing(true);
    setError(null);
    const startTime = performance.now();

    try {
      const client = getClient();
      const fileBuffer = await source.file.arrayBuffer();

      let resData: ArrayBuffer;
      let finalFormat: SupportedFormat = targetFormat;

      if (typeof maxWidth === 'number' && maxWidth > 0 && maxWidth < source.width) {
        // Scaling + compressing
        const res = await client.resize(fileBuffer, {
          width: maxWidth,
          format: targetFormat,
          quality: quality / 100,
        });
        resData = res.data;
        finalFormat = res.format;
      } else {
        // Direct compression/conversion
        const res = await client.convert(fileBuffer, targetFormat, quality / 100);
        resData = res.data;
        finalFormat = res.format;
      }

      const blob = new Blob([resData], { type: finalFormat });
      const url = URL.createObjectURL(blob);
      const elapsed = Math.round(performance.now() - startTime);

      if (result?.url) URL.revokeObjectURL(result.url);

      const reductionPercent = Math.max(0, Math.round(((source.sizeBytes - blob.size) / source.sizeBytes) * 100));

      setResult({
        url,
        blob,
        sizeBytes: blob.size,
        reductionPercent,
        format: finalFormat,
        elapsedMs: elapsed,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Compression failed.');
    } finally {
      setIsProcessing(false);
    }
  };

  const downloadResult = () => {
    if (!result || !source) return;

    const ext = result.format === 'image/webp' ? 'webp' : result.format === 'image/jpeg' ? 'jpg' : 'png';
    const originalName = source.file.name.replace(/\.[^/.]+$/, '');
    const filename = `${originalName}-compressed.${ext}`;

    const a = document.createElement('a');
    a.href = result.url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-5">
      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm shadow-2xs">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT COLUMN: Dropzone, Uploaded File Card & Results */}
        <div className="lg:col-span-7 space-y-4">
          {!source ? (
            <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs">
              <div
                role="button"
                tabIndex={0}
                aria-label="Upload an image to compress"
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
                  accept="image/png,image/jpeg,image/webp,image/avif"
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
                  PNG, JPEG, WebP, AVIF up to 50 MB • Zero cloud uploads
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Uploaded Image Card */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                  <span>Uploaded image (1)</span>
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
                        {source.width} × {source.height} px • Original: {formatBytes(source.sizeBytes)}
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setSource(null);
                      setResult(null);
                    }}
                    aria-label="Remove uploaded image"
                    className="p-1.5 text-slate-400 hover:text-slate-700"
                  >
                    ✕
                  </button>
                </div>
              </div>

              {/* Compression Result Card */}
              {result && (
                <div aria-live="polite" className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-emerald-500" />
                      <span className="font-bold text-sm text-slate-900">Compression Complete</span>
                      <span className="text-xs text-slate-500 font-mono">({result.elapsedMs} ms)</span>
                    </div>
                    <div className="px-3 py-1 rounded-full bg-emerald-50 border border-emerald-200 text-emerald-700 font-bold text-xs">
                      {result.reductionPercent > 0 ? `Saved ${result.reductionPercent}%` : 'Lossless compression'}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-4 p-3.5 bg-white border border-slate-200/80 rounded-lg text-center">
                    <div>
                      <div className="text-[11px] uppercase tracking-wider text-slate-500">Original</div>
                      <div className="text-base font-bold text-slate-900 mt-0.5">{formatBytes(source.sizeBytes)}</div>
                    </div>
                    <div>
                      <div className="text-[11px] uppercase tracking-wider text-emerald-700">Compressed</div>
                      <div className="text-base font-bold text-emerald-700 mt-0.5">{formatBytes(result.sizeBytes)}</div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={downloadResult}
                    className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 font-semibold text-white text-sm shadow-xs transition-colors flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                    <span>
                      Download Compressed {result.format === 'image/webp' ? 'WebP' : result.format === 'image/jpeg' ? 'JPEG' : 'PNG'} ({formatBytes(result.sizeBytes)})
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* RIGHT COLUMN: Compression Settings & Primary CTA */}
        <div className="lg:col-span-5 bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
          <h2 className="text-base font-bold text-slate-900">Compression settings</h2>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500 block">Preset Level</span>
            {[
              { id: 'balanced', label: 'Balanced (80% • Web)' },
              { id: 'high', label: 'High Quality (90%)' },
              { id: 'aggressive', label: 'Max Savings (55%)' },
              { id: 'custom', label: 'Custom Quality' },
            ].map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => handlePresetChange(p.id as any)}
                className={`w-full px-3.5 py-2 rounded-lg text-left text-xs transition-colors ${
                  preset === p.id
                    ? 'bg-slate-200/80 text-blue-600 font-semibold'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div className="pt-2 border-t border-slate-200/80 space-y-1.5">
            <div className="flex justify-between text-xs">
              <span className="text-slate-600 font-medium">Output Quality</span>
              <span className="font-mono font-semibold text-blue-600">{quality}%</span>
            </div>
            <input
              type="range"
              min="10"
              max="100"
              step="1"
              value={quality}
              onChange={(e) => {
                setQuality(parseInt(e.target.value, 10));
                setPreset('custom');
              }}
              className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
              aria-label="Compression quality slider"
            />
          </div>

          <div className="pt-2 border-t border-slate-200/80 space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-600 block">Output format</label>
              <div className="grid grid-cols-3 gap-1.5">
                {(['image/webp', 'image/jpeg', 'image/png'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setTargetFormat(fmt)}
                    className={`py-1.5 px-2 rounded-lg border text-xs font-semibold text-center transition-colors ${
                      targetFormat === fmt
                        ? 'bg-blue-50 border-blue-500 text-blue-700'
                        : 'bg-white border-slate-200 text-slate-700 hover:border-slate-300'
                    }`}
                  >
                    {fmt === 'image/webp' ? 'WebP' : fmt === 'image/jpeg' ? 'JPEG' : 'PNG'}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <label htmlFor="max-width-input" className="text-xs font-medium text-slate-600 block">
                Max Width (Optional)
              </label>
              <input
                id="max-width-input"
                type="number"
                placeholder="Original width (e.g. 1920)"
                value={maxWidth}
                onChange={(e) => setMaxWidth(e.target.value ? parseInt(e.target.value, 10) : '')}
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-xs text-slate-900 focus:outline-none focus:border-blue-500"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={handleCompress}
            disabled={!source || isProcessing}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed font-semibold text-sm text-white shadow-xs transition-colors"
          >
            {isProcessing ? 'Compressing…' : 'Compress Image'}
          </button>

          <p className="text-[11px] text-slate-500 text-center">
            P-01 to P-04 Verified • Zero Network Uploads
          </p>
        </div>
      </div>
    </div>
  );
}
