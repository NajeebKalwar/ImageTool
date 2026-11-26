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

interface QueuedFile {
  id: string;
  file: File;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export default function WebpConverter() {
  const [targetFormat, setTargetFormat] = useState<SupportedFormat>('image/webp');
  const [quality, setQuality] = useState<number>(85);

  const [queuedFiles, setQueuedFiles] = useState<QueuedFile[]>([]);
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

  const handleSelectFiles = (files: FileList | File[]) => {
    const valid = Array.from(files).filter((f) => f.type.startsWith('image/'));
    if (valid.length === 0) {
      setError('Please select valid image files (PNG, JPEG, WebP, AVIF).');
      return;
    }

    setError(null);
    const additions: QueuedFile[] = valid.map((file, idx) => ({
      id: `${file.name}-${Date.now()}-${idx}`,
      file,
    }));
    setQueuedFiles((prev) => [...prev, ...additions]);
  };

  const removeQueuedFile = (id: string) => {
    setQueuedFiles((prev) => prev.filter((item) => item.id !== id));
  };

  const handleConvert = async () => {
    if (queuedFiles.length === 0 || isProcessing) return;

    setIsProcessing(true);
    setError(null);
    const client = getClient();
    const newResults: ConvertedFile[] = [];

    try {
      for (let i = 0; i < queuedFiles.length; i++) {
        const { file } = queuedFiles[i];
        setProgressMsg(`Converting ${i + 1} of ${queuedFiles.length}: ${file.name}…`);
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

      setConvertedFiles((prev) => [...newResults, ...prev]);
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
    setQueuedFiles([]);
  };

  return (
    <div className="w-full max-w-5xl mx-auto space-y-5">
      {error && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-start justify-between shadow-2xs">
          <span>{error}</span>
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
        {/* LEFT COLUMN: Dropzone + Uploaded Images Card + Converted Results */}
        <div className="lg:col-span-7 space-y-4">
          {/* Dashed Upload Card */}
          <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs">
            <div
              role="button"
              tabIndex={0}
              aria-label="Upload images to convert"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (e.dataTransfer.files) handleSelectFiles(e.dataTransfer.files);
              }}
              className="border-[1.5px] border-dashed border-slate-300 hover:border-blue-400 rounded-lg py-12 px-6 text-center transition-colors cursor-pointer bg-[#f8f9fc] focus:outline-none focus:ring-2 focus:ring-blue-500"
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
                  if (e.target.files) handleSelectFiles(e.target.files);
                  e.target.value = '';
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
                Batch convert PNG, JPEG, or WebP locally • Up to 50 MB each
              </p>
            </div>
          </div>

          {/* Uploaded Images Card */}
          {queuedFiles.length > 0 && (
            <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-700">
                <span className="flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-slate-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Uploaded images ({queuedFiles.length})
                </span>
                <button
                  type="button"
                  onClick={clearAll}
                  className="text-xs font-medium text-slate-500 hover:text-rose-600 transition-colors"
                >
                  Clear all
                </button>
              </div>

              <div className="space-y-2">
                {queuedFiles.map((item) => (
                  <div
                    key={item.id}
                    className="bg-white border border-slate-200/80 rounded-lg p-3 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-10 h-10 rounded-md bg-slate-50 border border-slate-200 flex items-center justify-center text-slate-600 shrink-0">
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.6}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                        </svg>
                      </div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-900 truncate">{item.file.name}</p>
                        <p className="text-[11px] text-slate-500 mt-0.5">
                          Original: {formatBytes(item.file.size)}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => removeQueuedFile(item.id)}
                      aria-label={`Remove ${item.file.name}`}
                      className="p-1.5 text-slate-400 hover:text-slate-700 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Status Banner */}
          {isProcessing && (
            <div aria-live="polite" className="p-3.5 bg-blue-50 border border-blue-200 text-blue-800 text-xs rounded-xl flex items-center justify-between">
              <span className="font-medium">{progressMsg}</span>
              <div className="w-4 h-4 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* Converted Outputs Card */}
          {convertedFiles.length > 0 && (
            <div aria-live="polite" className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h3 className="font-bold text-xs text-slate-900 uppercase tracking-wider">
                  Converted Files ({convertedFiles.length})
                </h3>
                <button
                  type="button"
                  onClick={downloadAll}
                  className="py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 font-semibold text-xs text-white transition-colors"
                >
                  Download All ({convertedFiles.length})
                </button>
              </div>

              <div className="space-y-2">
                {convertedFiles.map((item) => {
                  const diffPercent = Math.round(((item.originalSize - item.outputSize) / item.originalSize) * 100);
                  return (
                    <div
                      key={item.id}
                      className="p-3 bg-white border border-slate-200/80 rounded-lg flex flex-wrap items-center justify-between gap-3 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 truncate">{item.outputName}</div>
                        <div className="text-slate-500 mt-0.5 font-mono text-[11px]">
                          {formatBytes(item.originalSize)} &rarr; <strong className="text-emerald-700">{formatBytes(item.outputSize)}</strong>
                          {diffPercent > 0 && (
                            <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px]">
                              -{diffPercent}%
                            </span>
                          )}
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => downloadSingle(item)}
                        className="py-1.5 px-3 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs transition-colors"
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

        {/* RIGHT COLUMN: Choose Format Card (Matches Screenshot 1 Right Card) */}
        <div className="lg:col-span-5 bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
          <h2 className="text-base font-bold text-slate-900">Choose format</h2>

          <div className="space-y-1.5">
            <span className="text-xs font-medium text-slate-500 block">Output format</span>
            {(
              [
                { fmt: 'image/webp', label: 'WebP' },
                { fmt: 'image/png', label: 'PNG (Lossless)' },
                { fmt: 'image/jpeg', label: 'JPEG' },
              ] as const
            ).map((opt) => (
              <button
                key={opt.fmt}
                type="button"
                onClick={() => setTargetFormat(opt.fmt)}
                className={`w-full px-3.5 py-2.5 rounded-lg text-left text-xs transition-colors ${
                  targetFormat === opt.fmt
                    ? 'bg-slate-200/80 text-blue-600 font-semibold'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {targetFormat !== 'image/png' && (
            <div className="pt-2 border-t border-slate-200/80 space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-slate-600 font-medium">Quality</span>
                <span className="font-mono font-semibold text-blue-600">{quality}%</span>
              </div>
              <input
                type="range"
                min="20"
                max="100"
                step="5"
                value={quality}
                onChange={(e) => setQuality(parseInt(e.target.value, 10))}
                className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                aria-label="Target format quality slider"
              />
            </div>
          )}

          <button
            type="button"
            onClick={handleConvert}
            disabled={queuedFiles.length === 0 || isProcessing}
            className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors shadow-xs"
          >
            {isProcessing ? 'Converting…' : 'Convert'}
          </button>

          <p className="text-[11px] text-slate-500 text-center">
            100% On-Device Web Worker Encoding • Zero uploads
          </p>
        </div>
      </div>
    </div>
  );
}
