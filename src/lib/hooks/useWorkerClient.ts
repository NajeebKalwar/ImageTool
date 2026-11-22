import { ImageWorkerClient } from '../worker-client';

let globalWorkerClient: ImageWorkerClient | null = null;

/**
 * Returns a persistent singleton instance of the ImageWorkerClient.
 *
 * Prevents thrashing worker process creation and preserves in-memory
 * Transformers.js pipelines across component re-renders.
 */
export function getWorkerClient(): ImageWorkerClient {
  if (!globalWorkerClient || globalWorkerClient.isTerminated) {
    if (typeof Worker !== 'undefined') {
      const worker = new Worker(
        new URL('../../workers/image-worker.ts', import.meta.url),
        { type: 'module' },
      );
      globalWorkerClient = new ImageWorkerClient(worker as never);
    } else {
      // Safe fallback for SSR environments
      globalWorkerClient = new ImageWorkerClient({
        postMessage: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        terminate: () => {},
      } as unknown as Worker);
    }
  }

  return globalWorkerClient;
}

export function useWorkerClient(): ImageWorkerClient {
  return getWorkerClient();
}
