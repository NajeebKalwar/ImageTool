/**
 * Web Worker entrypoint for image processing.
 *
 * This file runs inside the dedicated worker thread. It receives incoming
 * messages, executes them via `handleMessage` using the browser's OffscreenCanvas
 * and createImageBitmap capabilities, and posts the responses back using
 * zero-copy ArrayBuffer transfers.
 */

import { BrowserCanvasEngine } from '../lib/canvas-ops';
import { handleMessage } from './message-handler';

const engine = new BrowserCanvasEngine();

self.addEventListener('message', async (event: MessageEvent) => {
  const { response, transfer } = await handleMessage(
    event.data,
    engine,
    undefined,
    (progressMsg) => {
      self.postMessage(progressMsg);
    },
  );
  self.postMessage(response, { transfer });
});
