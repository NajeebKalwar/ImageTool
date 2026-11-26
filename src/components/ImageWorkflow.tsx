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
    <div className="w-full max-w-5xl mx-auto space-y-5">
      {displayError && (
        <div className="p-3.5 bg-rose-50 border border-rose-200 rounded-xl text-rose-700 text-sm flex items-start justify-between shadow-2xs">
          <span>{displayError}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-xs font-medium text-rose-600 hover:text-rose-800 ml-3 underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Two-Column SaaS Layout */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* LEFT COLUMN: Upload / Preview / Pipeline Timeline */}
        <div className="lg:col-span-7 space-y-4">
          {!source ? (
            <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs">
              <div
                {...dropZoneProps}
                onClick={openFileDialog}
                className="border-[1.5px] border-dashed border-slate-300 hover:border-blue-400 rounded-lg py-14 px-6 text-center cursor-pointer transition-colors bg-[#f8f9fc]"
              >
                <input {...fileInputProps} />
                <p className="text-sm font-medium text-slate-700 mb-2">Drag file here</p>
                <p className="text-xs text-slate-400 mb-3">or</p>
                <span className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-blue-200 hover:border-blue-500 text-slate-800 text-xs font-semibold rounded-lg shadow-2xs transition-colors">
                  <svg className="w-4 h-4 text-slate-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5-5m0 0l5 5m-5-5v12" />
                  </svg>
                  Choose file
                </span>
                <p className="text-[11px] text-slate-500 mt-4">
                  PNG, JPEG, WebP up to 50 MB • Multi-step LangChain execution on-device
                </p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Dual Preview Card */}
              <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
                <div className="flex justify-between items-center">
                  <span className="text-xs font-semibold text-slate-700">Preview</span>
                  <div className="flex items-center gap-3">
                    {resultUrl && (
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-slate-500">BG:</span>
                        {(['transparent', 'white', 'black'] as const).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => setPreviewBg(mode)}
                            className={`w-4 h-4 rounded-full border ${
                              previewBg === mode ? 'ring-2 ring-blue-500 border-white' : 'border-slate-300'
                            } ${
                              mode === 'transparent'
                                ? 'bg-[linear-gradient(45deg,#cbd5e1_25%,transparent_25%),linear-gradient(-45deg,#cbd5e1_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#cbd5e1_75%),linear-gradient(-45deg,transparent_75%,#cbd5e1_75%)] bg-[size:6px_6px] bg-white'
                                : mode === 'white'
                                  ? 'bg-white'
                                  : 'bg-slate-900'
                            }`}
                            title={mode}
                          />
                        ))}
                      </div>
                    )}
                    <button
                      type="button"
                      onClick={reset}
                      disabled={isWorking}
                      className="text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-50"
                    >
                      Change file
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-white border border-slate-200/80 rounded-lg p-2">
                    <div className="aspect-square rounded flex items-center justify-center overflow-hidden bg-slate-50">
                      <img src={source.previewUrl} alt="Source" className="max-w-full max-h-full object-contain" />
                    </div>
                    <p className="text-[11px] text-slate-500 text-center mt-1.5 font-mono">
                      {source.width} × {source.height} px
                    </p>
                  </div>

                  <div className="bg-white border border-slate-200/80 rounded-lg p-2">
                    <div
                      className={`aspect-square rounded flex items-center justify-center overflow-hidden relative ${
                        previewBg === 'transparent'
                          ? 'bg-[linear-gradient(45deg,#e2e8f0_25%,transparent_25%),linear-gradient(-45deg,#e2e8f0_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#e2e8f0_75%),linear-gradient(-45deg,transparent_75%,#e2e8f0_75%)] bg-[size:16px_16px] bg-white'
                          : previewBg === 'white'
                            ? 'bg-white'
                            : 'bg-slate-950'
                      }`}
                    >
                      {resultUrl ? (
                        <img src={resultUrl} alt="Workflow output" className="max-w-full max-h-full object-contain" />
                      ) : isWorking ? (
                        <div className="w-full h-full flex flex-col items-center justify-center p-4 space-y-3 bg-white/90">
                          <div className="w-8 h-8 border-[3px] border-blue-600 border-t-transparent rounded-full animate-spin" />
                          <div className="text-center space-y-1">
                            <p className="text-xs font-semibold text-slate-900">
                              {progress.stepName ? `Executing: ${progress.stepName}` : 'Running Workflow…'}
                            </p>
                            <p className="text-[11px] text-blue-600 font-mono">
                              Step {progress.currentStepIndex + 1} of {progress.totalSteps} • {progress.percent}%
                            </p>
                          </div>
                          <div className="w-40 h-1.5 bg-slate-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-blue-600 transition-all duration-200"
                              style={{ width: `${progress.percent}%` }}
                            />
                          </div>
                          <button
                            type="button"
                            onClick={handleCancel}
                            className="px-3 py-1 text-[11px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-md"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-400 px-3 text-center">
                          Click &quot;Run Recipe&quot; to start
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-slate-500 text-center mt-1.5">Output</p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Planned Step Pipeline Timeline */}
          <div className="bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-4 shadow-2xs space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-slate-900">
                Pipeline Steps: {activeRecipe?.title}
              </span>
              <span className="text-[11px] text-blue-600 font-mono">{steps.length} steps</span>
            </div>

            <div className="space-y-2">
              {steps.map((step, idx) => (
                <div
                  key={step.id}
                  className={`p-3 rounded-lg border flex flex-col sm:flex-row justify-between sm:items-center gap-2 transition-colors ${
                    step.status === 'running'
                      ? 'bg-blue-50 border-blue-400'
                      : step.status === 'completed'
                        ? 'bg-emerald-50/60 border-emerald-200'
                        : step.status === 'failed'
                          ? 'bg-rose-50 border-rose-200'
                          : 'bg-white border-slate-200/80'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`w-6 h-6 rounded-lg flex items-center justify-center text-xs font-bold shrink-0 ${
                        step.status === 'completed'
                          ? 'bg-emerald-600 text-white'
                          : step.status === 'running'
                            ? 'bg-blue-600 text-white animate-pulse'
                            : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {step.status === 'completed' ? '✓' : idx + 1}
                    </span>
                    <div>
                      <p className="text-xs font-semibold text-slate-900">{step.name}</p>
                      <p className="text-[11px] text-slate-500">{step.description}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-xs font-mono">
                    {step.durationMs !== undefined && (
                      <span className="text-slate-500">{step.durationMs}ms</span>
                    )}
                    <span
                      className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                        step.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-700'
                          : step.status === 'running'
                            ? 'bg-blue-100 text-blue-700 animate-pulse'
                            : 'bg-slate-100 text-slate-500'
                      }`}
                    >
                      {step.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Choose Workflow Recipe & Run Action */}
        <div className="lg:col-span-5 bg-[#f8f9fc] border border-slate-200/90 rounded-xl p-5 shadow-2xs space-y-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-base font-bold text-slate-900">Choose recipe</h2>
            <div className="flex items-center gap-1.5">
              {deviceCaps && (
                <span className="px-2 py-0.5 bg-blue-50 border border-blue-200 rounded text-[11px] font-semibold text-blue-700">
                  {deviceCaps.hasWebGPU ? '⚡ WebGPU' : '⚙️ WASM'}
                </span>
              )}
              <button
                type="button"
                onClick={() => setShowCopilotModal(true)}
                className="px-2.5 py-0.5 text-[11px] font-medium rounded bg-white hover:bg-slate-50 text-slate-700 border border-slate-200 transition-colors"
              >
                {byokApiKey ? '🔑 Copilot' : '✨ Copilot'}
              </button>
            </div>
          </div>

          <div className="space-y-1.5">
            {WORKFLOW_RECIPES.map((recipe) => {
              const isSelected = activeRecipeId === recipe.id;
              return (
                <button
                  key={recipe.id}
                  type="button"
                  onClick={() => selectRecipe(recipe.id)}
                  disabled={isWorking}
                  className={`w-full p-3 rounded-lg text-left transition-all border ${
                    isSelected
                      ? 'bg-slate-200/80 border-blue-300 text-blue-700'
                      : 'bg-white border-slate-200/80 text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-bold flex items-center gap-1.5">
                      <span>{recipe.icon}</span>
                      <span>{recipe.title}</span>
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/80 border border-slate-200 text-slate-600">
                      {recipe.badge}
                    </span>
                  </div>
                  <p className="text-[11px] text-slate-500 mt-1 line-clamp-2">{recipe.description}</p>
                </button>
              );
            })}
          </div>

          <div className="pt-2 space-y-2">
            {!resultUrl ? (
              <button
                type="button"
                onClick={handleRunWorkflow}
                disabled={!source || isWorking}
                className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed text-white text-sm font-semibold rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
              >
                {isWorking ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                    <span>Running Step {progress.currentStepIndex + 1} / {progress.totalSteps}…</span>
                  </>
                ) : (
                  <span>Run {activeRecipe?.title}</span>
                )}
              </button>
            ) : (
              <div className="space-y-2">
                <button
                  type="button"
                  onClick={handleDownload}
                  className="w-full py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-lg transition-colors shadow-xs flex items-center justify-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download Workflow Result</span>
                </button>
                <button
                  type="button"
                  onClick={reset}
                  className="w-full py-2 px-4 bg-white border border-slate-200 hover:border-slate-300 text-slate-700 text-xs font-semibold rounded-lg transition-colors"
                >
                  Start Over
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Optional AI Copilot BYOK Modal */}
      {showCopilotModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <span>✨</span> AI Copilot Settings (BYOK)
              </h3>
              <button
                type="button"
                onClick={() => setShowCopilotModal(false)}
                className="text-slate-400 hover:text-slate-700 text-lg"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-600">
              Provide an optional API key to store locally for experimental custom recipe planning.
            </p>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-slate-700">API Key (Stored locally in browser)</label>
              <input
                type="password"
                value={byokApiKey}
                onChange={(e) => setByokApiKey(e.target.value)}
                placeholder="AIzaSy... or sk-..."
                className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-900 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCopilotModal(false)}
                className="px-4 py-2 text-xs font-semibold bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors"
              >
                Save &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
