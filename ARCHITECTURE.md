# ImageTool Architecture and Privacy Rules

## Product boundary

ImageTool is a browser-based image toolkit. The intended default is that image processing happens on the visitor's device. Astro generates the public website; React provides interactive tools; Web Workers keep expensive processing away from the main UI thread.

## Testable privacy requirements

### P-01 — Image pixels stay on the visitor's device

Source image bytes, decoded pixel buffers, intermediate image data, and processed image bytes must never be uploaded or transmitted off-device by any image-tool workflow.

- **What could break this:** an upload endpoint, third-party script, analytics/error-reporting SDK, remote image-processing library, or a future cloud-save/share feature.
- **How to detect it:** inspect browser DevTools Network requests while using every tool; use a test image with a recognizable marker; confirm no request body, URL, beacon, or telemetry payload contains image data. Add automated browser tests that fail on unexpected upload requests.

### P-02 — Local inference is the default

AI models execute in the browser through a browser-compatible runtime, preferably inside a Web Worker. Model files and runtime assets may be downloaded, but user image pixels must not be sent with those downloads.

- **What could break this:** replacing local inference with a hosted inference API or sending image data to a remote model endpoint.
- **How to detect it:** review worker and runtime code; inspect network destinations and request bodies during inference; maintain an allowlist of expected model/runtime asset hosts.

### P-03 — Third parties do not receive image content

Analytics, advertising, crash reporting, fonts, widgets, and other third-party integrations must not receive source images, processed images, image URLs containing private data, or pixel-derived payloads.

- **What could break this:** SDK auto-capture, session replay, DOM snapshots, file-input instrumentation, error breadcrumbs, or ad scripts reading page state.
- **How to detect it:** review each third-party integration and its data collection settings; test with network inspection; ensure file contents and image data are never attached to telemetry.

### P-04 — Future features must preserve the boundary

Features such as sharing, cloud storage, accounts, batch queues, or collaboration must not silently change the local-processing promise.

- **What could break this:** a feature that uploads images or sends them to a service without explicit product review and clear user consent.
- **How to detect it:** require an architecture/privacy decision record, a user-facing disclosure, and a network-level test before such a feature is merged.

## Operational safeguards

- Use Web Workers for costly processing so the interface remains responsive.
- Lazy-load model files only when the user selects the relevant tool.
- Explain WebGPU/WASM capability and fallback behavior honestly.
- Apply input dimension and memory limits; surface recoverable errors instead of leaving a blank interface.
- Treat model hosts and CDNs as network dependencies: they can observe request metadata such as IP address and requested asset paths, even when image pixels remain local.
- Before production, define a Content Security Policy (CSP) that restricts scripts, workers, connections, and asset origins to the minimum required set.
- Do not claim that no data leaves the device until network inspection and tests support that exact claim. Distinguish image-pixel privacy from ordinary website request metadata.

## Verification checklist

- [x] Inspect network traffic for each image-processing workflow.
- [x] Confirm no image bytes or pixel buffers appear in outgoing request bodies.
- [x] Review every analytics, advertising, and error-reporting integration.
- [x] Document and allowlist model/runtime asset origins.
- [x] Test WebGPU and WASM paths.
- [x] Add automated tests for unexpected image upload requests.
- [x] Define and test production CSP before launch.
