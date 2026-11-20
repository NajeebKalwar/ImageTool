/**
 * Web Worker entrypoint for image processing.
 *
 * This file runs inside the worker thread. It delegates every incoming
 * message to the pure `handleMessage()` function (which is independently
 * unit-tested in Node) and posts the response back with transferable
 * buffers so large pixel arrays move without copying.
 */

import { handleMessage } from './message-handler';

self.addEventListener('message', (event: MessageEvent) => {
  const { response, transfer } = handleMessage(event.data);
  self.postMessage(response, { transfer });
});
