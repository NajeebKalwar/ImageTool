import { useState, useRef, useEffect } from 'react';
import { useWorkflowStore } from '../lib/stores/workflow.store';
import { WORKFLOW_RECIPES } from '../lib/workflow/recipes';
import { executeWorkflow } from '../lib/workflow/engine';
import { useWorkerClient } from '../lib/hooks/useWorkerClient';
import { useImageFile } from '../lib/hooks/useImageFile';
import { detectDeviceCapabilities, type DeviceCapabilities } from '../lib/ai/device';
import type { WorkflowImageBuffer } from '../lib/workflow/types';

export default function ImageWorkflow() {
  const {
    source,
    activeRecipeId,
    steps,
    status,
    progress,
    resultUrl,
    error,
    byokApiKey,
    setSource,
    selectRecipe,
    setSteps,
    setByokApiKey,
    setStatus,
    setProgress,
    setResult,
    setError,
    reset,
  } = useWorkflowStore();

  const [deviceCaps, setDeviceCaps] = useState<DeviceCapabilities | null>(null);
  const [showCopilotModal, setShowCopilotModal] = useState<boolean>(false);
  const [previewBg, setPreviewBg] = useState<'transparent' | 'white' | 'black'>('transparent');

  const workerClient = useWorkerClient();
  const abortControllerRef = useRef<AbortController | null>(null);
  const isWorkingRef = useRef<boolean>(false);

  const { dropZoneProps, fileInputProps, openFileDialog, error: fileError } = useImageFile((info) => {
    setSource(info);
  });

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

  const handleRunWorkflow = async () => {
    if (!source || status === 'running' || isWorkingRef.current) return;
    isWorkingRef.current = true;
    setStatus('running');
    setError(null);

    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      // Decode source image to scratch canvas to acquire raw pixel buffer
      const img = new Image();
      img.src = source.previewUrl;
      await img.decode();

      const canvas = document.createElement('canvas');
      canvas.width = source.width;
      canvas.height = source.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) throw new Error('Could not acquire 2D canvas context.');

      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, source.width, source.height);

      const initialBuffer: WorkflowImageBuffer = {
        width: source.width,
        height: source.height,
        pixels: new Uint8ClampedArray(imgData.data),
      };

      // Execute LangChain tool sequence
      const execResult = await executeWorkflow({
        steps: steps.map((s) => ({
          id: s.id,
          tool: s.tool,
          params: s.params,
          name: s.name,
          description: s.description,
        })),
        initialBuffer,
        workerClient,
        signal: controller.signal,
        onProgress: (p) => {
          setProgress(p);
        },
        onStepChange: (updatedSteps) => {
          setSteps(updatedSteps);
        },
      });

      if (!execResult.success) {
        if (execResult.error !== 'Operation cancelled') {
          setError(execResult.error ?? 'Workflow execution failed.');
        } else {
          setStatus('idle');
        }
        return;
      }

      // Convert final output buffer to Blob and preview URL
      const outCanvas = document.createElement('canvas');
      outCanvas.width = execResult.finalBuffer.width;
      outCanvas.height = execResult.finalBuffer.height;
      const outCtx = outCanvas.getContext('2d');
      if (!outCtx) throw new Error('Could not acquire output canvas context.');

      outCtx.putImageData(
        new ImageData(
          execResult.finalBuffer.pixels as any,
          execResult.finalBuffer.width,
          execResult.finalBuffer.height,
        ),
        0,
        0,
      );

      // Determine MIME format from last step params if compress_image was used
      const lastStep = steps[steps.length - 1];
      const format = (lastStep?.params?.format as string) ?? 'png';
      const mimeType = format === 'webp' ? 'image/webp' : format === 'jpeg' ? 'image/jpeg' : 'image/png';

      const blob = await new Promise<Blob | null>((resolve) =>
        outCanvas.toBlob(resolve, mimeType),
      );
      if (!blob) throw new Error('Failed to export final workflow Blob.');

      const url = URL.createObjectURL(blob);
      setResult(blob, url);
    } catch (err) {
      if (err instanceof Error && err.message === 'Operation cancelled') {
        setStatus('idle');
        return;
      }
      setError(err instanceof Error ? err.message : 'Workflow execution failed.');
    } finally {
      isWorkingRef.current = false;
      abortControllerRef.current = null;
    }
  };

  const handleCancel = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    isWorkingRef.current = false;
    setStatus('idle');
  };

  const handleDownload = () => {
    if (!resultUrl || !source) return;
    const baseName = source.file.name.replace(/\.[^/.]+$/, '');
    const lastStep = steps[steps.length - 1];
    const ext = (lastStep?.params?.format as string) ?? 'png';
    const filename = `${baseName}-workflow.${ext}`;

    const a = document.createElement('a');
    a.href = resultUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const isWorking = status === 'running';
  const displayError = error || fileError;
  const activeRecipe = WORKFLOW_RECIPES.find((r) => r.id === activeRecipeId);

  return (
    <div className="w-full max-w-4xl mx-auto my-6 p-4 sm:p-6 bg-slate-900 text-slate-100 rounded-xl border border-slate-800 shadow-xl space-y-6">
      {/* Header with Privacy & Copilot Modal Toggle */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 p-3 bg-slate-950/80 border border-slate-800 rounded-lg">
        <div className="flex items-center gap-2 text-emerald-300 text-xs sm:text-sm font-medium">
          <svg className="w-4 h-4 shrink-0 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
          <span>
            <strong>LangChain Workflow Engine:</strong> Turnkey compound recipes executing 100% on-device.
          </span>
        </div>

        <div className="flex items-center gap-2">
          {deviceCaps && (
            <span className="px-2 py-0.5 bg-indigo-950/70 border border-indigo-700/60 rounded text-xs font-semibold text-indigo-300">
              {deviceCaps.hasWebGPU ? '⚡ WebGPU' : '⚙️ WASM'}
            </span>
          )}
          <button
            type="button"
            onClick={() => setShowCopilotModal(true)}
            className="px-2.5 py-1 text-xs font-medium rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 transition-colors"
          >
            {byokApiKey ? '🔑 Copilot Active' : '✨ AI Copilot'}
          </button>
        </div>
      </div>

      {displayError && (
        <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-lg text-rose-200 text-sm flex items-start justify-between">
          <span>{displayError}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs text-rose-300 hover:text-white ml-2 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Preset Recipes Carousel / Selector */}
      <div className="p-4 bg-slate-950/50 border border-slate-800 rounded-lg space-y-3">
        <div className="flex justify-between items-center">
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
            Select Compound Workflow Recipe
          </span>
          <span className="text-xs text-indigo-400 font-mono">
            {steps.length} Automated Steps
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {WORKFLOW_RECIPES.map((recipe) => {
            const isSelected = activeRecipeId === recipe.id;
            return (
              <button
                key={recipe.id}
                type="button"
                onClick={() => selectRecipe(recipe.id)}
                disabled={isWorking}
                className={`p-3 text-left rounded-lg border transition-all ${
                  isSelected
                    ? 'bg-indigo-950/60 border-indigo-500 shadow-sm shadow-indigo-500/20 ring-1 ring-indigo-500/40'
                    : 'bg-slate-900 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center gap-1.5 mb-1">
                  <span className="text-base">{recipe.icon}</span>
                  <span className="text-xs font-semibold text-slate-100">{recipe.title}</span>
                </div>
                <p className="text-[11px] text-slate-400 line-clamp-2">{recipe.description}</p>
                <div className="mt-2 text-[10px]">
                  <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                    {recipe.badge}
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Upload Zone or Workspace */}
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
            Drop an image here to run workflow, or <span className="text-indigo-400 underline">browse</span>
          </p>
          <p className="text-xs text-slate-400">Supports PNG, JPEG, WebP up to 50 MB</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Dual Preview Box */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Original Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Input Image</span>
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
                  alt="Source"
                  className="max-w-full max-h-full object-contain"
                />
              </div>
              <div className="flex justify-between text-xs text-slate-500 mt-2 font-mono">
                <span>{source.width} × {source.height} px</span>
                <span>{(source.file.size / (1024 * 1024)).toFixed(2)} MB</span>
              </div>
            </div>

            {/* Workflow Output Card */}
            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-3">
              <div className="flex justify-between items-center mb-2">
                <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Workflow Output</span>
                {resultUrl && (
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-slate-400 mr-1">Preview BG:</span>
                    {(['transparent', 'white', 'black'] as const).map((mode) => (
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
                              : 'bg-black'
                        }`}
                        title={mode}
                      />
                    ))}
                  </div>
                )}
              </div>

              <div
                className={`aspect-square rounded flex items-center justify-center overflow-hidden relative ${
                  previewBg === 'transparent'
                    ? 'bg-[linear-gradient(45deg,#1e293b_25%,transparent_25%),linear-gradient(-45deg,#1e293b_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#1e293b_75%),linear-gradient(-45deg,transparent_75%,#1e293b_75%)] bg-[size:16px_16px] bg-slate-900'
                    : previewBg === 'white'
                      ? 'bg-white'
                      : 'bg-black'
                }`}
              >
                {resultUrl ? (
                  <img
                    src={resultUrl}
                    alt="Workflow output"
                    className="max-w-full max-h-full object-contain"
                  />
                ) : isWorking ? (
                  <div className="w-full h-full flex flex-col items-center justify-center p-6 space-y-4 bg-slate-950/80 backdrop-blur-sm">
                    <div className="w-10 h-10 border-3 border-indigo-500 border-t-transparent rounded-full animate-spin" />
                    <div className="text-center space-y-1 max-w-[280px]">
                      <p className="text-sm font-semibold text-slate-100">
                        {progress.stepName ? `Executing: ${progress.stepName}` : 'Running Workflow…'}
                      </p>
                      <p className="text-xs text-indigo-400 font-mono">
                        Step {progress.currentStepIndex + 1} of {progress.totalSteps} • {progress.percent}%
                      </p>
                    </div>

                    <div className="w-48 sm:w-64 h-2 bg-slate-800 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all duration-200"
                        style={{ width: `${progress.percent}%` }}
                      />
                    </div>

                    <button
                      type="button"
                      onClick={handleCancel}
                      className="px-4 py-1.5 text-xs text-rose-300 hover:text-rose-200 bg-rose-950/60 border border-rose-800 rounded transition-colors"
                    >
                      Cancel Workflow
                    </button>
                  </div>
                ) : (
                  <span className="text-xs text-slate-500">Click &quot;Run Workflow&quot; to execute</span>
                )}
              </div>
            </div>
          </div>

          {/* Planned Step Pipeline Timeline */}
          <div className="p-4 bg-slate-950/70 border border-slate-800 rounded-lg space-y-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-indigo-300">
              Pipeline Steps for {activeRecipe?.title}
            </span>

            <div className="space-y-2">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={`p-3 rounded-lg border flex flex-col sm:flex-row justify-between sm:items-center gap-2 transition-colors ${
                    step.status === 'running'
                      ? 'bg-indigo-950/50 border-indigo-500/80 ring-1 ring-indigo-500/40'
                      : step.status === 'completed'
                        ? 'bg-emerald-950/20 border-emerald-900/40'
                        : step.status === 'failed'
                          ? 'bg-rose-950/30 border-rose-800'
                          : 'bg-slate-900/60 border-slate-800/80'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                        step.status === 'completed'
                          ? 'bg-emerald-600 text-white'
                          : step.status === 'running'
                            ? 'bg-indigo-600 text-white animate-pulse'
                            : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {step.status === 'completed' ? '✓' : idx + 1}
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-slate-200">{step.name}</p>
                      <p className="text-[11px] text-slate-400">{step.description}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-mono">
                    {step.durationMs !== undefined && (
                      <span className="text-slate-400">{step.durationMs}ms</span>
                    )}
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                        step.status === 'completed'
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                          : step.status === 'running'
                            ? 'bg-indigo-950 text-indigo-300 border border-indigo-700 animate-pulse'
                            : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {step.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Action Execution Bar */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            {!resultUrl ? (
              <button
                type="button"
                onClick={handleRunWorkflow}
                disabled={isWorking}
                className="w-full py-3 px-6 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20"
              >
                {isWorking ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Executing Step {progress.currentStepIndex + 1} of {progress.totalSteps}…</span>
                  </>
                ) : (
                  <span>Run {activeRecipe?.title}</span>
                )}
              </button>
            ) : (
              <div className="flex flex-col sm:flex-row w-full gap-3">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="flex-1 py-3 px-6 bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg transition-colors flex items-center justify-center gap-2 shadow-lg shadow-emerald-600/20"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download Workflow Result</span>
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="px-6 py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium rounded-lg transition-colors"
                >
                  Start Over
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Optional AI Copilot BYOK Modal */}
      {showCopilotModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex justify-between items-center">
              <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                <span>✨</span> AI Copilot Settings (BYOK)
              </h3>
              <button
                type="button"
                onClick={() => setShowCopilotModal(false)}
                className="text-slate-400 hover:text-white text-lg"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-slate-400">
              Provide an optional Google Gemini or OpenAI API key to enable freeform natural language prompt interpretation for custom workflows.
            </p>

            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-300">API Key (Stored locally in your browser)</label>
              <input
                type="password"
                value={byokApiKey}
                onChange={(e) => setByokApiKey(e.target.value)}
                placeholder="AIzaSy... or sk-..."
                className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded text-sm text-slate-200 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCopilotModal(false)}
                className="px-4 py-2 text-xs font-medium bg-indigo-600 hover:bg-indigo-500 text-white rounded transition-colors"
              >
                Save & Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
