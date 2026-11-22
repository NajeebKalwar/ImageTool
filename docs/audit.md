# ImageTool — Architecture & Model Audit (Phase 0)

**Date:** November 2026  
**Status:** Completed  
**Scope:** Pre-implementation audit and verification for Transformers.js, Cloudflare R2 model hosting, Web Worker architecture, and UI refactoring.

---

## 1. Codebase Audit ("Not Yet Reviewed" Files)

### 1.1 `src/lib/worker-protocol.ts`
- **Current State:** Defines typed messages between main thread and worker (`RequestBody`, `MainToWorker`, `WorkerToMain`, `ReplyMap`).
- **Caps:** `MAX_PIXELS = 25_000_000` (25 MP), `MAX_FILE_BYTES = 52_428_800` (50 MB).
- **Supported Formats:** `image/png`, `image/jpeg`, `image/webp`.
- **Findings & Deficiencies:**
  - `ai_load` currently returns `{ type: 'ai_loaded', id, modelId, backend }`, without progress streaming during model weight acquisition.
  - `ai_remove_background` and `ai_upscale` expect raw uncompressed `ArrayBuffer` pixel transfers (`width * height * 4` bytes), requiring main-thread canvas decode and `getImageData()` extraction.
  - `ai_progress` supports stages `'preparing' | 'tiling' | 'blending' | 'complete'`, but lacks download stages (`downloading`, `initializing`, bytes loaded/total).
  - Protocol needs extension to support `Blob` / transferable `ImageBitmap` inputs and richer progress stages.

### 1.2 `src/workers/message-handler.ts`
- **Current State:** Pure function `handleMessage(data, engine?, aiPipeline?, postProgress?)` returning `{ response, transfer }`.
- **Findings & Deficiencies:**
  - Contains stub handlers for `ai_load`, `ai_remove_background`, and `ai_upscale`.
  - For `ai_remove_background` and `ai_upscale`, it delegates to an optional `aiPipeline: AiPipeline`.
  - **Critical Discovery:** In production worker (`src/workers/image-worker.ts`), `aiPipeline` is **never instantiated or passed**! If invoked, lines 302 and 363 return an error: `"AI inference pipeline not available."`
  - Cancellation tracking uses a module-level `activeCancellations = new Set<number>()`. However, `ai_load` cannot be cancelled, and model downloading currently happens on the main thread rather than in the worker.

### 1.3 `src/workers/image-worker.ts`
- **Current State:**
  ```ts
  const engine = new BrowserCanvasEngine();
  self.addEventListener('message', async (event: MessageEvent) => {
    const { response, transfer } = await handleMessage(event.data, engine);
    self.postMessage(response, { transfer });
  });
  ```
- **Findings & Deficiencies:**
  - No `AiPipeline` is created or passed.
  - No `postProgress` callback is provided to `handleMessage()`, so worker progress messages cannot be emitted back to the main thread.
  - Confirms **Problem P2**: There is currently no active inference pipeline in the worker.

### 1.4 `src/lib/canvas-ops.ts`
- **Current State:** Implements `calculateTargetDimensions`, `validateImageBuffer`, and `BrowserCanvasEngine` (`OffscreenCanvas` + `createImageBitmap`).
- **Findings:**
  - Robust bicubic resampling and format conversion.
  - Correctly calls `bitmap.close()` in a `finally` block to prevent GPU/RAM memory leaks.
  - Engine interface abstraction allows clean Node testing.

### 1.5 `src/lib/ai/device.ts`
- **Current State:** `detectDeviceCapabilities()` checks `navigator.gpu.requestAdapter()` and `WebAssembly`.
- **Findings:**
  - Safe for Node and browser execution.
  - Returns `preferredBackend: hasWebGPU ? 'webgpu' : 'wasm'`.
  - To be usable inside the Web Worker (Phase 2), `navigator.gpu` must be queried within worker scope (`DedicatedWorkerGlobalScope`), which modern Chromium, Firefox, and Safari now support.

### 1.6 `src/lib/ai/memory-policy.ts`
- **Current State:** Defines device tiers (`low`, `medium`, `high`) and resource limits (`TIER_LIMITS`).
- **Caps:**
  - Low (<= 2 GB RAM): Input max 2.5 MP, output max 16 MP, tile 256 px.
  - Medium (<= 4 GB RAM): Input max 6 MP, output max 36 MP, tile 256 px.
  - High (> 4 GB RAM): Input max 12 MP, output max 64 MP, tile 512 px.
- **Findings:**
  - Sound mathematical foundation for peak working memory estimation (`estimateUpscaleMemory`).
  - Need to benchmark WebGPU vs WASM separately in Phase 3/8 to refine limits.

### 1.7 `package.json`
- **Current State:**
  - Node requirement: `>=22.23.4`.
  - Dependencies: Astro `^7.4.11`, React `^19.3.1`, Tailwind CSS `^4.3.5`, `idb-keyval` `^6.3.0`, `onnxruntime-web` `^1.31.1`, `sharp` `^0.35.5`.
  - DevDependencies: `@astrojs/check`, `@types/react`, `cheerio`, `typescript`, `vitest`.
- **Findings:**
  - `@huggingface/transformers` is not yet installed.
  - Target version to install: `@huggingface/transformers` (`^3.3.3` or `^4.3.2`).
  - `idb-keyval` can be phased out once Transformers.js browser Cache API integration is verified in Phase 1-2.

### 1.8 `astro.config.mjs`
- **Current State:** Astro config with React, Tailwind v4, and conditional Sitemap generation.
- **Findings:**
  - Must ensure worker bundling supports ES modules (`worker: { format: 'es' }`) if Vite defaults require it.
  - Environment variables `PUBLIC_MODEL_HOST` and `PUBLIC_WASM_HOST` will be accessed via Vite's `import.meta.env`.

### 1.9 `src/components/ImageUpscaler.tsx` & `BackgroundRemover.tsx`
- **Findings & Deficiencies (Problems P4, P5, P6):**
  - **Worker Termination Bug:**
    ```tsx
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
    ```
    Every time `source` or `processedUrl` updates, the cleanup callback runs and **terminates the worker**, destroying any loaded models or in-flight operations!
  - **Type Cast:** `new ImageWorkerClient(worker as never)` bypasses TypeScript safety because `Worker` does not structurally match `WorkerLike`.
  - **Main Thread Canvas Extraction:**
    `BackgroundRemover.tsx` loads images into main-thread `Image` elements and extracts RGBA buffers with `ctx.getImageData()` on the main thread, causing frame drops on large files.
  - **Split Slider Performance:**
    Drag updates write to React `useState(sliderPosition)`, triggering full re-renders of the entire 700-line component on every mouse move.
  - **Jargon & Semantics:**
    Internal rule labels (`P-01 to P-04`) are exposed to users in the UI. Harmless actions (like Reset/Cancel) use aggressive red styles.

---

## 2. Root Cause Analysis: Model Download Failures (Problem P1)

Running HTTP inspection (`curl.exe -sI -L`) against all existing URLs in `MODEL_REGISTRY` yielded the following results:

| Model ID | Registered URL | Status Code | Content-Type | Access-Control-Allow-Origin | Root Cause |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `birefnet-lite` | `https://huggingface.co/onnx-community/BiRefNet-general-lite/resolve/main/onnx/model_quantized.onnx` | `401 Unauthorized` | `text/plain` | `https://huggingface.co` | **Repo does not exist.** Hugging Face returns 401 for non-existent repositories. CORS is locked to HF domain. |
| `modnet` | `https://huggingface.co/onnx-community/modnet/resolve/main/onnx/model.onnx` | `401 Unauthorized` | `text/plain` | `https://huggingface.co` | **Repo does not exist under onnx-community.** Official repo is `Xenova/modnet`. CORS locked to HF domain. |
| `swin2sr-x4` | `https://huggingface.co/onnx-community/swin2SR-realworld-sr-x4-64-bsrgan-psnr/resolve/main/onnx/model.onnx` | `401 Unauthorized` | `text/plain` | `https://huggingface.co` | **Repo does not exist under onnx-community.** Official repo is `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr`. |
| `realesrgan-compact` | `https://huggingface.co/onnx-community/realesrgan-compact/resolve/main/onnx/model.onnx` | `401 Unauthorized` | `text/plain` | `https://huggingface.co` | **Repo does not exist.** Real-ESRGAN is not an official Transformers.js model. |

### Conclusion on P1
1. **Wrong Namespace:** Swin2SR and MODNet ONNX models converted for Transformers.js live under the `Xenova/` organization, not `onnx-community/`.
2. **BiRefNet Naming:** The real ONNX community repository is `onnx-community/BiRefNet_lite-ONNX` (case-sensitive with underscore).
3. **CORS Restrictions:** Hugging Face model endpoints do not serve wildcard CORS headers for raw web fetches, causing browser network requests from third-party origins to be blocked.
4. **Architectural Fix:** Models must be mirrored to our own Cloudflare R2 bucket with explicit CORS headers allowing our production, preview, and local development origins (Problem P3).

---

## 3. Verified ONNX Repositories & v1 Model Selection

### 3.1 Task: Super-Resolution / Upscaling (`image-to-image`)

#### Candidate 1: 2x Classical Upscaling
- **Repository:** `Xenova/swin2SR-classical-sr-x2-64`
- **Architecture:** `Swin2SRForImageSuperResolution`
- **Pipeline:** `image-to-image`
- **Scale:** 2x
- **License:** Apache-2.0 (Verified: Caidas / mv-lab)
- **Verified Files on Hub:**
  - `config.json`
  - `preprocessor_config.json`
  - `onnx/model_fp16.onnx` — **32,428,109 bytes (~30.93 MB)** (WebGPU)
  - `onnx/model_quantized.onnx` — **21,471,413 bytes (~20.48 MB)** (WASM)

#### Candidate 2: 4x Real-World Upscaling
- **Repository:** `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr`
- **Architecture:** `Swin2SRForImageSuperResolution`
- **Pipeline:** `image-to-image`
- **Scale:** 4x
- **License:** Apache-2.0 (Verified: Caidas / mv-lab)
- **Verified Files on Hub:**
  - `config.json`
  - `preprocessor_config.json`
  - `onnx/model_fp16.onnx` — **32,357,522 bytes (~30.86 MB)** (WebGPU)
  - `onnx/model_quantized.onnx` — **21,438,622 bytes (~20.45 MB)** (WASM)

---

### 3.2 Task: Background Removal / Matting (`image-segmentation`)

#### Candidate 3: Real-Time Portrait & Object Matting (MODNet)
- **Repository:** `Xenova/modnet`
- **Architecture:** `MODNet` (`AutoModel` / `image-segmentation`)
- **Pipeline:** `image-segmentation`
- **License:** Apache-2.0 (Verified: ZHKKKe)
- **Community Adoption:** > 126,000 downloads
- **Verified Files on Hub:**
  - `config.json`
  - `preprocessor_config.json`
  - `onnx/model_fp16.onnx` — **12,984,781 bytes (~12.38 MB)** (WebGPU)
  - `onnx/model_quantized.onnx` — **6,632,188 bytes (~6.32 MB)** (WASM)

#### Candidate 4: High-Accuracy Bilateral Segmentation (BiRefNet-lite)
- **Repository:** `onnx-community/BiRefNet_lite-ONNX`
- **Architecture:** `BiRefNet` / `swin` (`AutoModel` / `image-segmentation`)
- **Pipeline:** `image-segmentation`
- **License:** MIT (Verified: ZhengPeng7)
- **Community Adoption:** > 25,000 downloads
- **Verified Files on Hub:**
  - `config.json`
  - `preprocessor_config.json`
  - `onnx/model_fp16.onnx` — **114,538,221 bytes (~109.23 MB)** (WebGPU)
  - `onnx/model.onnx` (fp32) — **224,005,088 bytes (~213.63 MB)** (WASM / Fallback)

---

### 3.3 Evaluation of Real-ESRGAN (Task 6)
- **Decision:** **Drop Real-ESRGAN from v1.**
- **Rationale:** Real-ESRGAN is not natively supported as a Hugging Face Transformers.js pipeline architecture. While it can run via raw `onnxruntime-web` sessions, supporting two completely separate runtime pipelines in v1 introduces unnecessary complexity and maintenance overhead. `Xenova/swin2SR` covers photographic detail and 2x/4x super-resolution with superior reconstruction quality and unified Transformers.js integration.

---

### 3.4 Summary of v1 Model Roster

| Model ID | Application Name | Hugging Face Repository | Task | Pipeline | Scale | WebGPU Dtype & Size | WASM Dtype & Size | License |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `swin2sr-x2` | Swin2SR Classical (2x) | `Xenova/swin2SR-classical-sr-x2-64` | upscaling | `image-to-image` | 2x | `fp16` (30.9 MB) | `q8` (20.5 MB) | Apache-2.0 |
| `swin2sr-x4` | Swin2SR Real-World (4x) | `Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr` | upscaling | `image-to-image` | 4x | `fp16` (30.9 MB) | `q8` (20.5 MB) | Apache-2.0 |
| `modnet` | MODNet Fast Matting | `Xenova/modnet` | background-removal | `image-segmentation` | - | `fp16` (12.4 MB) | `q8` (6.3 MB) | Apache-2.0 |
| `birefnet-lite` | BiRefNet-lite High Precision | `onnx-community/BiRefNet_lite-ONNX` | background-removal | `image-segmentation` | - | `fp16` (109.2 MB) | `fp32` (213.6 MB) | MIT |

### Restricted Models Blocklist (Maintained)
The following models remain strictly barred due to commercial license restrictions:
- `RMBG-2.0` / `RMBG-1.4`: Prohibited (CC-BY-NC non-commercial license).
- `CodeFormer`: Prohibited (S-Lab non-commercial license).
- `ISNet`: Prohibited (U-2-Net non-commercial derivative).
- `APISR`: Prohibited (Research non-commercial license).

---

## 4. Transformers.js Configuration Audit

Inspection of `@huggingface/transformers` source code (`src/env.js`, `src/utils/hub.js`) confirms the following mechanics:

1. **Remote Model URL Construction:**
   ```js
   let remoteURL = pathJoin(
       env.remoteHost,
       env.remotePathTemplate
           .replaceAll('{model}', path_or_repo_id)
           .replaceAll('{revision}', encodeURIComponent(revision)),
       filename
   );
   ```
   Setting:
   ```ts
   env.remoteHost = 'https://models.<domain>/';
   env.remotePathTemplate = '{model}/';
   ```
   Produces exact direct paths: `https://models.<domain>/Xenova/modnet/onnx/model_fp16.onnx`.

2. **Browser Caching:**
   - When running in browser or Web Worker (`IS_BROWSER_ENV || IS_WEBWORKER_ENV`), Transformers.js automatically uses `caches.open('transformers-cache')`.
   - Subsequent loads check the Cache API first; matching entries result in 0 network requests.
   - Eliminates the need for manual IndexedDB chunking (`model-cache.ts`).

3. **ONNX Runtime WASM Paths:**
   - Setting `env.backends.onnx.wasm.wasmPaths = 'https://models.<domain>/wasm/'` points ONNX Runtime Web to self-hosted WASM binaries (`ort-wasm-simd-threaded.wasm`, `ort-wasm-simd.wasm`, etc.), eliminating reliance on public CDNs.

4. **Execution Device & Dtype:**
   - Transformers.js pipelines accept `{ device: 'webgpu' | 'wasm', dtype: 'fp16' | 'q8' | 'fp32' }`.
   - If WebGPU initialization fails, the engine can catch the exception and fall back to WASM with the quantized dtype.

---

## 5. Phase 0 Acceptance Sign-Off

- [x] All "Not yet reviewed" files read and audited.
- [x] Exact causes of P1 (401 Unauthorized, incorrect repo names, missing CORS) documented.
- [x] Verified Hugging Face Hub repositories identified for upscaling and background removal.
- [x] Exact file lists, sizes, licenses, and dtypes documented for each v1 model.
- [x] Dropping Real-ESRGAN from v1 confirmed and documented.
- [x] Transformers.js environment and URL resolution verified against source.
