# Cloudflare R2 Model Hosting Setup Guide

This guide describes how to configure Cloudflare R2 object storage to host Transformers.js model weights and ONNX Runtime WebAssembly (WASM) binaries.

---

## 1. Why Cloudflare R2?

1. **Size Limits:** Cloudflare Pages and Workers have a 25 MiB per-file limit for static assets. Several high-performance model weights (`model_fp16.onnx`) and ONNX WASM binaries exceed 25 MiB (up to ~114 MB).
2. **Zero Egress Fees:** Cloudflare R2 provides S3-compatible storage with zero bandwidth / egress fees, making client-side browser weight distribution cost-effective.
3. **CORS Control:** Directly controls allowed origins and exposes headers (`Content-Length`, `ETag`) required by browser streaming fetch and progress bars.

---

## 2. Bucket Creation & Custom Domain

### Step 1: Create the Bucket
Using Wrangler or the Cloudflare Dashboard:
```bash
npx wrangler r2 bucket create imagetool-models
```

### Step 2: Attach Custom Domain
Attach a custom domain under your Cloudflare zone (e.g. `models.imagetool.io` or `models.imagetool.example`):
1. In Cloudflare Dashboard, go to **R2 > Overview > imagetool-models > Settings**.
2. Under **Custom Domains**, click **Connect Domain**.
3. Enter `models.imagetool.io` and click **Continue**.

---

## 3. Configure CORS

Apply `cloudflare/r2-cors.json` to allow browser clients to fetch weights:
```bash
npx wrangler r2 bucket cors set imagetool-models --file cloudflare/r2-cors.json
```

Or configure via Dashboard:
- **Allowed Origins:** `https://imagetool.io`, `https://*.pages.dev`, `http://localhost:*`, `http://127.0.0.1:*`
- **Allowed Methods:** `GET`, `HEAD`
- **Expose Headers:** `Content-Length`, `ETag`, `Content-Type`, `Accept-Ranges`
- **Max Age:** `86400` seconds

---

## 4. Cache-Control Header Policy

All model weights and WASM files in R2 should be served with immutable caching headers:
```http
Cache-Control: public, max-age=31536000, immutable
```
Model versions are pinned by repository and revision. New model architectures or updates should be placed in new subpaths, never overwriting existing files in place.

---

## 5. Model Synchronization Script

The repository includes `scripts/sync-models.ts` to automate downloading, hash verification, manifest creation, and R2 synchronization:

```bash
# 1. Download and verify model files locally (into .cache/models/)
npm run sync:models -- --download

# 2. Upload to Cloudflare R2 with immutable cache headers
npm run sync:models -- --upload --bucket imagetool-models

# 3. Verify remote custom domain connectivity and CORS headers
npm run sync:models -- --verify-remote https://models.imagetool.io/
```

---

## 6. Self-Hosted ONNX Runtime WASM

The sync script automatically extracts the ONNX Runtime Web WASM binaries from `node_modules/onnxruntime-web/dist/*.wasm` and places them in `wasm/`:
- `wasm/ort-wasm-simd-threaded.wasm`
- `wasm/ort-wasm-simd-threaded.jsep.wasm`
- `wasm/ort-wasm-simd-threaded.jspi.wasm`
- `wasm/ort-wasm-simd-threaded.asyncify.wasm`

When deployed, `PUBLIC_WASM_HOST=https://models.imagetool.io/wasm/` tells Transformers.js and ONNX Runtime to load these self-hosted binaries instead of public CDNs.
