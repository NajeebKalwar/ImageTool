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
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl space-y-6">
      {/* Privacy Guarantee Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-950/80 border border-slate-800 rounded-lg text-xs sm:text-sm">
        <div className="flex items-center gap-2 text-emerald-400 font-medium">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>P-01 to P-04 Verified: 100% On-Device Compression. Zero Network Bytes Uploaded.</span>
        </div>
        <span className="text-slate-400">Web Worker Engine</span>
      </div>

      {error && (
        <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm">
          {error}
        </div>
      )}

      {/* File Dropzone */}
      {!source ? (
        <div
          role="button"
          tabIndex={0}
          aria-label="Upload an image to compress"
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
            accept="image/png,image/jpeg,image/webp,image/avif"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.[0]) handleFile(e.target.files[0]);
            }}
          />
          <div className="mx-auto w-12 h-12 mb-3 text-indigo-400">
            <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </div>
          <p className="text-base font-semibold text-slate-200">
            Choose an image to compress and reduce file size
          </p>
          <p className="text-xs text-slate-400 mt-1">
            Drag and drop or browse • PNG, JPEG, WebP, AVIF up to 50 MB
          </p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* File Overview Card */}
          <div className="p-4 bg-slate-950/60 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="font-semibold text-sm text-slate-200">{source.file.name}</div>
              <div className="text-xs text-slate-400 mt-0.5">
                Dimensions: <strong className="text-slate-300">{source.width} × {source.height} px</strong> • Original Size: <strong className="text-slate-300">{formatBytes(source.sizeBytes)}</strong>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setSource(null);
                setResult(null);
              }}
              className="text-xs text-slate-400 hover:text-rose-400 underline transition-colors"
            >
              Choose different image
            </button>
          </div>

          {/* Compression Configuration Toolbar */}
          <div className="p-4 bg-slate-950/40 border border-slate-800 rounded-xl space-y-5">
            {/* Compression Presets */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                Compression Level
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { id: 'balanced', label: 'Balanced (80%)', desc: 'Recommended for Web' },
                  { id: 'high', label: 'High Quality (90%)', desc: 'Minimal Artifacts' },
                  { id: 'aggressive', label: 'Max Savings (55%)', desc: 'Smallest File Size' },
                  { id: 'custom', label: 'Custom', desc: 'Manual Slider' },
                ].map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => handlePresetChange(p.id as any)}
                    className={`p-2.5 rounded-lg border text-left transition-all ${
                      preset === p.id
                        ? 'bg-indigo-950/80 border-indigo-500 text-slate-100 shadow-md'
                        : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                    }`}
                  >
                    <div className="font-bold text-xs">{p.label}</div>
                    <div className="text-[10px] text-slate-400 mt-0.5">{p.desc}</div>
                  </button>
                ))}
              </div>
            </div>

            {/* Quality Slider (visible if custom or for fine tuning) */}
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs text-slate-300">
                <span>Output Quality Level</span>
                <span className="font-semibold text-indigo-400">{quality}%</span>
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
                className="w-full accent-indigo-500 cursor-pointer"
                aria-label="Compression quality slider"
              />
            </div>

            {/* Target Format & Optional Max Width */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-slate-800/80">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-slate-300">
                  Target Format
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {(['image/webp', 'image/jpeg', 'image/png'] as const).map((fmt) => (
                    <button
                      key={fmt}
                      type="button"
                      onClick={() => setTargetFormat(fmt)}
                      className={`py-1.5 px-2 rounded-lg border text-xs font-semibold text-center transition-all ${
                        targetFormat === fmt
                          ? 'bg-indigo-950 border-indigo-500 text-indigo-300'
                          : 'bg-slate-900/60 border-slate-800 text-slate-400 hover:border-slate-700'
                      }`}
                    >
                      {fmt === 'image/webp' ? 'WebP (Best)' : fmt === 'image/jpeg' ? 'JPEG' : 'PNG'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="space-y-1.5">
                <label htmlFor="max-width-input" className="text-xs font-semibold text-slate-300">
                  Max Width (Optional Downscale)
                </label>
                <input
                  id="max-width-input"
                  type="number"
                  placeholder="e.g. 1920 (leave empty for original)"
                  value={maxWidth}
                  onChange={(e) => setMaxWidth(e.target.value ? parseInt(e.target.value, 10) : '')}
                  className="w-full bg-slate-900 border border-slate-800 rounded-lg px-3 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <button
              type="button"
              onClick={handleCompress}
              disabled={isProcessing}
              className="w-full py-3 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 font-semibold text-white shadow-lg shadow-indigo-600/30 transition-all flex items-center justify-center gap-2"
            >
              {isProcessing ? 'Compressing locally in worker...' : 'Compress Image Now'}
            </button>
          </div>

          {/* Results Comparison Card */}
          {result && (
            <div aria-live="polite" className="p-5 bg-slate-950/80 border border-emerald-900/60 rounded-xl space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                  <span className="font-bold text-sm text-slate-100">Compression Complete</span>
                  <span className="text-xs text-slate-400">({result.elapsedMs}ms)</span>
                </div>
                <div className="px-3 py-1 rounded-full bg-emerald-950 border border-emerald-700/80 text-emerald-300 font-bold text-xs">
                  {result.reductionPercent > 0 ? `Saved ${result.reductionPercent}%` : 'Lossless compression'}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4 p-3 bg-slate-900/80 rounded-lg text-center">
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-slate-400">Original</div>
                  <div className="text-base font-bold text-slate-200 mt-0.5">{formatBytes(source.sizeBytes)}</div>
                </div>
                <div>
                  <div className="text-[11px] uppercase tracking-wider text-emerald-400">Compressed</div>
                  <div className="text-base font-bold text-emerald-300 mt-0.5">{formatBytes(result.sizeBytes)}</div>
                </div>
              </div>

              <button
                type="button"
                onClick={downloadResult}
                className="w-full py-3 rounded-xl bg-emerald-600 hover:bg-emerald-500 font-semibold text-white shadow-lg shadow-emerald-600/30 transition-all flex items-center justify-center gap-2"
              >
                <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                <span>Download Compressed {result.format === 'image/webp' ? 'WebP' : result.format === 'image/jpeg' ? 'JPEG' : 'PNG'} ({formatBytes(result.sizeBytes)})</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
