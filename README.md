# ImageTool

ImageTool is a free, privacy-first, browser-native image processing platform. All image decoding, manipulation, and machine learning inference run directly on the user's device via client-side Web Workers, OffscreenCanvas, WebGPU, and WebAssembly.

Image bytes never leave the device. There are zero remote cloud uploads, no server-side processing queues, and no third-party tracking scripts.

---

## Features & Available Tools

1. **Background Remover (`/background-remover`)**:
   - Neural salient object segmentation running on-device via WebGPU with multi-threaded WASM fallback.
   - Powered by commercial-friendly models (BiRefNet-lite, MODNet) with persistent IndexedDB weight caching.

2. **AI Image Upscaler (`/image-upscaler`)**:
   - 2x and 4x super-resolution (Swin2SR, Real-ESRGAN).
   - Tiled execution with 2D cosine (Hann) seam blending to prevent WebGPU out-of-memory crashes on large images.
   - Interactive before/after split comparison slider and cancellation support.

3. **Image Resizer (`/image-resizer`)**:
   - High-quality bicubic resampling inside dedicated background Web Workers.
   - Aspect ratio constraints (`contain`, `cover`, `inside`, `fill`) and multi-format outputs.

4. **Image Compressor (`/image-compressor`)**:
   - File size reduction with live byte calculation and compression ratio comparisons.

5. **WebP Converter (`/webp-converter`)**:
   - Fast client-side conversion between WebP, PNG, and JPEG with multi-file batch processing.

6. **Trust & Compliance (`/privacy`, `/terms`, `/about`, `/contact`)**:
   - Full legal disclosures, model license attributions, and contact channels.

---

## Technical Stack & Architecture

- **Astro 7**: Static SEO shell, pre-rendered metadata, zero-drift JSON-LD (`WebApplication`, `HowTo`, `FAQPage`), and fail-closed robots/sitemap policies.
- **React 19**: Interactive tool islands with W3C ARIA accessibility controls.
- **Web Workers**: Off-thread image manipulation and neural inference preventing UI jank.
- **WebGPU / WebAssembly**: Hardware-accelerated local AI execution using ONNX Runtime Web.
- **Content Security Policy**: Strict browser-level network sandbox (`connect-src` limited to model CDNs, `form-action 'none'`).

---

## Requirements

- **Node.js**: `>=22.23.4`

---

## Getting Started

```bash
# Install dependencies
npm ci

# Start local Astro development server
npm run dev
```

---

## Verification & Testing Suite

ImageTool includes comprehensive test coverage for TypeScript, unit logic, SEO fail-closed rules, and privacy sandboxing:

```powershell
# 1. Astro type and template check
npm run check

# 2. Vitest unit tests (worker protocol, image ops, tiling, memory policy)
npm run test:unit

# 3. SEO verifier test suite
npm run test:verify

# 4. Automated privacy audit (CSP & network exfiltration check)
npm run test:privacy

# 5. Build integration tests
npm run test:integration

# 6. Preview build verification (must emit noindex, nofollow)
$env:SITE_ENV = "preview"
npm run build
npm run verify:preview

# 7. Production build verification (must emit index, follow, and sitemap)
$env:SITE_ENV = "production"
npm run build
npm run verify:production
npm run verify:privacy
Remove-Item Env:SITE_ENV -ErrorAction SilentlyContinue
```

---

## Production Deployment Checklist

1. **Production Domain**: Replace `https://imagetool.example` with your production domain in `astro.config.mjs`, `public/_headers`, and `src/layouts/Layout.astro`.
2. **Environment Variables**: Configure `SITE_ENV=production` in your hosting platform (Cloudflare Pages, Netlify, or Vercel).
3. **Security Headers**: Ensure hosting provider respects `public/_headers` (CSP, COOP `same-origin`, COEP `credentialless`).

---

## License

ImageTool is open source software released under the [MIT License](LICENSE).
