import { useState, useCallback, useRef } from 'react';
import { ImageWorkerClient } from '../lib/worker-client';

type LogEntry = { key: number; text: string; ok: boolean };

/**
 * WorkerLab — a minimal React island for verifying that the
 * Web Worker plumbing works end-to-end in the browser.
 *
 * Tests:
 * 1. ping → pong round-trip
 * 2. invert: send RGBA pixels, receive inverted pixels back via transferable ArrayBuffer
 */
export default function WorkerLab() {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const clientRef = useRef<ImageWorkerClient | null>(null);
  const keyRef = useRef(0);

  const addLog = useCallback((text: string, ok: boolean) => {
    setLog((prev) => [...prev, { key: ++keyRef.current, text, ok }]);
  }, []);

  const getClient = useCallback((): ImageWorkerClient => {
    if (clientRef.current && !clientRef.current.isTerminated) {
      return clientRef.current;
    }
    const worker = new Worker(
      new URL('../workers/image-worker.ts', import.meta.url),
      { type: 'module' },
    );
    const client = new ImageWorkerClient(worker as never);
    clientRef.current = client;
    return client;
  }, []);

  // -----------------------------------------------------------------------
  // Test 1 — ping / pong
  // -----------------------------------------------------------------------
  const runPing = useCallback(async () => {
    setBusy(true);
    try {
      const client = getClient();
      const t0 = performance.now();
      const result = await client.ping();
      const ms = (performance.now() - t0).toFixed(1);
      addLog(`✅ ping → ${result.type} (${ms} ms)`, true);
    } catch (err) {
      addLog(`❌ ping failed: ${err instanceof Error ? err.message : err}`, false);
    } finally {
      setBusy(false);
    }
  }, [getClient, addLog]);

  // -----------------------------------------------------------------------
  // Test 2 — invert round-trip
  // -----------------------------------------------------------------------
  const runInvert = useCallback(async () => {
    setBusy(true);
    try {
      const client = getClient();
      const w = 2;
      const h = 2;
      const src = new ArrayBuffer(w * h * 4);
      const view = new Uint8ClampedArray(src);
      // pixel 0: red
      view.set([255, 0, 0, 255], 0);
      // pixel 1: green
      view.set([0, 255, 0, 255], 4);
      // pixel 2: blue
      view.set([0, 0, 255, 255], 8);
      // pixel 3: white
      view.set([255, 255, 255, 128], 12);

      const t0 = performance.now();
      const result = await client.invert(w, h, src);
      const ms = (performance.now() - t0).toFixed(1);

      const out = new Uint8ClampedArray(result.pixels);
      const pixel0 = `(${out[0]},${out[1]},${out[2]},${out[3]})`;
      const pixel1 = `(${out[4]},${out[5]},${out[6]},${out[7]})`;

      // Verify: red (255,0,0) → cyan (0,255,255), green (0,255,0) → magenta (255,0,255)
      const p0ok = out[0] === 0 && out[1] === 255 && out[2] === 255 && out[3] === 255;
      const p1ok = out[4] === 255 && out[5] === 0 && out[6] === 255 && out[7] === 255;

      if (p0ok && p1ok) {
        addLog(
          `✅ invert 2×2 → pixel0=${pixel0} pixel1=${pixel1} (${ms} ms)`,
          true,
        );
      } else {
        addLog(
          `❌ invert returned unexpected pixels: p0=${pixel0} p1=${pixel1}`,
          false,
        );
      }
    } catch (err) {
      addLog(`❌ invert failed: ${err instanceof Error ? err.message : err}`, false);
    } finally {
      setBusy(false);
    }
  }, [getClient, addLog]);

  // -----------------------------------------------------------------------
  // Terminate
  // -----------------------------------------------------------------------
  const terminate = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.terminate();
      clientRef.current = null;
      addLog('⏹ worker terminated', true);
    }
  }, [addLog]);

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: '40rem', margin: '2rem auto' }}>
      <h2>Worker Lab</h2>
      <p style={{ color: '#666' }}>
        Verifies the Web Worker plumbing: message protocol, request tracking,
        and transferable ArrayBuffer pixel round-trip.
      </p>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
        <button onClick={runPing} disabled={busy}>
          Ping
        </button>
        <button onClick={runInvert} disabled={busy}>
          Invert 2×2
        </button>
        <button onClick={terminate} disabled={busy}>
          Terminate
        </button>
      </div>

      <pre
        style={{
          background: '#111',
          color: '#eee',
          padding: '1rem',
          borderRadius: '0.5rem',
          minHeight: '6rem',
          overflow: 'auto',
          fontSize: '0.85rem',
        }}
      >
        {log.length === 0
          ? 'Click a button to run a test…'
          : log.map((entry) => (
              <div key={entry.key} style={{ color: entry.ok ? '#6f6' : '#f66' }}>
                {entry.text}
              </div>
            ))}
      </pre>
    </div>
  );
}
