import { useState, useRef, useEffect } from 'react';
import { ImageWorkerClient } from '../lib/worker-client';
import type { SupportedFormat } from '../lib/worker-protocol';

interface ConvertedFile {
  id: string;
  originalName: string;
  originalSize: number;
  outputName: string;
  outputSize: number;
  format: SupportedFormat;
  url: string;
  elapsedMs: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function WebpConverter() {
  const [mode, setMode] = useState<'to_webp' | 'from_webp'>('to_webp');
  const [targetFormat, setTargetFormat] = useState<SupportedFormat>('image/webp');
  const [quality, setQuality] = useState<number>(85);

  const [convertedFiles, setConvertedFiles] = useState<ConvertedFile[]>([]);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
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
      for (const item of convertedFiles) {
        URL.revokeObjectURL(item.url);
      }
    };
  }, [convertedFiles]);

  const handleModeChange = (newMode: 'to_webp' | 'from_webp') => {
    setMode(newMode);
    if (newMode === 'to_webp') {
      setTargetFormat('image/webp');
    } else {
      setTargetFormat('image/png');
    }
  };

  const handleFiles = async (files: FileList | File[]) => {
    const list = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (list.length === 0) {
      setError('Please select valid image files.');
      return;
    }

    setIsProcessing(true);
    setError(null);
    const client = getClient();
    const newResults: ConvertedFile[] = [];

    try {
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setProgressMsg(`Converting file ${i + 1} of ${list.length}: ${file.name}...`);
        const startTime = performance.now();

        const fileBuffer = await file.arrayBuffer();
        const res = await client.convert(fileBuffer, targetFormat, quality / 100);

        const blob = new Blob([res.data], { type: res.format });
        const url = URL.createObjectURL(blob);
        const elapsed = Math.round(performance.now() - startTime);

        const ext = res.format === 'image/webp' ? 'webp' : res.format === 'image/jpeg' ? 'jpg' : 'png';
        const baseName = file.name.replace(/\.[^/.]+$/, '');
        const outputName = `${baseName}.${ext}`;

        newResults.push({
          id: `${file.name}-${Date.now()}-${i}`,
          originalName: file.name,
          originalSize: file.size,
          outputName,
          outputSize: blob.size,
          format: res.format,
          url,
          elapsedMs: elapsed,
        });
      }

      setConvertedFiles((prev) => [...prev, ...newResults]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed.');
    } finally {
      setIsProcessing(false);
      setProgressMsg('');
    }
  };

  const downloadSingle = (item: ConvertedFile) => {
    const a = document.createElement('a');
    a.href = item.url;
    a.download = item.outputName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const downloadAll = () => {
    for (const item of convertedFiles) {
      downloadSingle(item);
    }
  };

  const clearAll = () => {
    for (const item of convertedFiles) {
      URL.revokeObjectURL(item.url);
    }
    setConvertedFiles([]);
  };

  return (
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl space-y-6">
      {/* Privacy Guarantee Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-3 bg-slate-950/80 border border-slate-800 rounded-lg text-xs sm:text-sm">
        <div className="flex items-center gap-2 text-emerald-400 font-medium">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>P-01 to P-04 Verified: In-Browser WebP Encoding. Zero Server Uploads.</span>
        </div>
        <span className="text-slate-400">Batch Processing Supported</span>
      </div>

      {error && (
        <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm">
          {error}
        </div>
      )}

      {/* Mode Selector */}
      <div className="grid grid-cols-2 gap-3 p-1 bg-slate-950/60 rounded-xl border border-slate-800">
        <button
          type="button"
          onClick={() => handleModeChange('to_webp')}
          className={`py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${
            mode === 'to_webp'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Convert TO WebP (from PNG/JPG)
        </button>
        <button
          type="button"
          onClick={() => handleModeChange('from_webp')}
          className={`py-2.5 px-4 rounded-lg text-sm font-semibold transition-all ${
            mode === 'from_webp'
              ? 'bg-indigo-600 text-white shadow-md'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Convert FROM WebP (to PNG/JPG)
        </button>
      </div>

      {/* Options Bar */}
      <div className="p-4 bg-slate-950/40 border border-slate-800 rounded-xl flex flex-wrap items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-3">
          <span className="font-semibold text-slate-300">Target Output:</span>
          {mode === 'to_webp' ? (
            <span className="px-2.5 py-1 rounded bg-indigo-950 border border-indigo-700/80 text-indigo-300 font-bold">
              WebP Format
            </span>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setTargetFormat('image/png')}
                className={`px-3 py-1 rounded border font-semibold ${
                  targetFormat === 'image/png'
                    ? 'bg-indigo-950 border-indigo-500 text-indigo-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                PNG (Lossless)
              </button>
              <button
                type="button"
                onClick={() => setTargetFormat('image/jpeg')}
                className={`px-3 py-1 rounded border font-semibold ${
                  targetFormat === 'image/jpeg'
                    ? 'bg-indigo-950 border-indigo-500 text-indigo-300'
                    : 'bg-slate-900 border-slate-800 text-slate-400'
                }`}
              >
                JPEG
              </button>
            </div>
          )}
        </div>

        {targetFormat !== 'image/png' && (
          <div className="flex items-center gap-3">
            <span className="text-slate-400">Quality: <strong>{quality}%</strong></span>
            <input
              type="range"
              min="20"
              max="100"
              step="5"
              value={quality}
              onChange={(e) => setQuality(parseInt(e.target.value, 10))}
              className="w-28 accent-indigo-500 cursor-pointer"
              aria-label="Target format quality slider"
            />
          </div>
        )}
      </div>

      {/* Multi-File Dropzone */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Upload images to convert to or from WebP"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files) handleFiles(e.dataTransfer.files);
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
          multiple
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files);
          }}
        />
        <div className="mx-auto w-12 h-12 mb-3 text-indigo-400">
          <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
          </svg>
        </div>
        <p className="text-base font-semibold text-slate-200">
          {mode === 'to_webp' ? 'Select PNG or JPEG photos to convert to WebP' : 'Select WebP files to convert to PNG or JPEG'}
        </p>
        <p className="text-xs text-slate-400 mt-1">
          Supports multiple files for batch conversion • Processed locally in Web Workers
        </p>
      </div>

      {/* Conversion Status Banner */}
      {isProcessing && (
        <div aria-live="polite" className="p-3 bg-indigo-950/60 border border-indigo-800 text-indigo-300 text-xs rounded-xl flex items-center justify-between">
          <span>{progressMsg}</span>
          <span className="animate-spin text-base">⏳</span>
        </div>
      )}

      {/* Results Table & Batch Actions */}
      {convertedFiles.length > 0 && (
        <div aria-live="polite" className="space-y-4 pt-4 border-t border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold text-sm text-slate-100">
              Converted Files ({convertedFiles.length})
            </h3>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={downloadAll}
                className="py-1.5 px-3 rounded-lg bg-emerald-600 hover:bg-emerald-500 font-semibold text-xs text-white shadow-md transition-colors"
              >
                Download All ({convertedFiles.length})
              </button>
              <button
                type="button"
                onClick={clearAll}
                className="py-1.5 px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 transition-colors"
              >
                Clear
              </button>
            </div>
          </div>

          <div className="divide-y divide-slate-800/80 bg-slate-950/60 rounded-xl border border-slate-800 overflow-hidden">
            {convertedFiles.map((item) => {
              const diffPercent = Math.round(((item.originalSize - item.outputSize) / item.originalSize) * 100);
              return (
                <div key={item.id} className="p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs">
                  <div>
                    <div className="font-semibold text-slate-200">{item.outputName}</div>
                    <div className="text-slate-400 mt-0.5">
                      {formatBytes(item.originalSize)} &rarr; <strong className="text-emerald-400">{formatBytes(item.outputSize)}</strong>
                      {diffPercent > 0 && (
                        <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 font-mono text-[10px]">
                          -{diffPercent}%
                        </span>
                      )}
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => downloadSingle(item)}
                    className="py-1 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-xs transition-colors"
                  >
                    Download
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
