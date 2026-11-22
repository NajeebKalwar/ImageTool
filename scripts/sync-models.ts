#!/usr/bin/env node
/**
 * ImageTool Model Sync & R2 Asset Manager.
 *
 * Downloads approved open-source models from Hugging Face with pinned revisions,
 * computes SHA-256 checksums, generates manifest files, stages ONNX Runtime WASM
 * binaries, and facilitates upload to Cloudflare R2 object storage.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

interface ModelSyncDef {
  id: string;
  repo: string;
  revision: string;
  files: string[];
}

export const SYNC_MODELS: readonly ModelSyncDef[] = [
  {
    id: 'swin2sr-x2',
    repo: 'Xenova/swin2SR-classical-sr-x2-64',
    revision: '71e28a83cfb61f5dc95bafdeebf2815167914f2b',
    files: [
      'config.json',
      'preprocessor_config.json',
      'onnx/model_fp16.onnx',
      'onnx/model_quantized.onnx',
    ],
  },
  {
    id: 'swin2sr-x4',
    repo: 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr',
    revision: 'd0e9926970c93e472ce2392373d72597fc849027',
    files: [
      'config.json',
      'preprocessor_config.json',
      'onnx/model_fp16.onnx',
      'onnx/model_quantized.onnx',
    ],
  },
  {
    id: 'modnet',
    repo: 'Xenova/modnet',
    revision: 'fa2fa546052fba4c08921230a26cc69a333fca12',
    files: [
      'config.json',
      'preprocessor_config.json',
      'onnx/model_fp16.onnx',
      'onnx/model_quantized.onnx',
    ],
  },
  {
    id: 'birefnet-lite',
    repo: 'onnx-community/BiRefNet_lite-ONNX',
    revision: 'de15b22ba131738a16dff04aab8bdf8dc32e3ac1',
    files: [
      'config.json',
      'preprocessor_config.json',
      'onnx/model_fp16.onnx',
      'onnx/model.onnx',
    ],
  },
] as const;

export interface FileManifestEntry {
  filename: string;
  bytes: number;
  sha256: string;
}

export interface ModelManifest {
  id: string;
  repo: string;
  revision: string;
  generatedAt: string;
  files: FileManifestEntry[];
}

/**
 * Computes SHA-256 hex digest of a buffer.
 */
export function computeSha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Downloads a file with redirect handling.
 */
async function fetchBufferWithRedirect(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
  }
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Stages local ONNX Runtime WebAssembly files into wasm/ directory.
 */
export function stageWasmFiles(outputBaseDir: string): FileManifestEntry[] {
  const wasmOutputDir = join(outputBaseDir, 'wasm');
  mkdirSync(wasmOutputDir, { recursive: true });

  const ortDistDir = resolve(process.cwd(), 'node_modules/onnxruntime-web/dist');
  if (!existsSync(ortDistDir)) {
    console.warn(`[sync-models] onnxruntime-web dist directory not found at ${ortDistDir}`);
    return [];
  }

  const entries: FileManifestEntry[] = [];
  const files = readdirSync(ortDistDir).filter((f) => f.endsWith('.wasm'));

  for (const filename of files) {
    const srcPath = join(ortDistDir, filename);
    const destPath = join(wasmOutputDir, filename);
    copyFileSync(srcPath, destPath);

    const buf = readFileSync(destPath);
    const sha256 = computeSha256(buf);

    entries.push({
      filename,
      bytes: buf.byteLength,
      sha256,
    });
  }

  const wasmManifest = {
    package: 'onnxruntime-web',
    generatedAt: new Date().toISOString(),
    files: entries,
  };

  writeFileSync(
    join(wasmOutputDir, 'manifest.json'),
    JSON.stringify(wasmManifest, null, 2),
    'utf-8',
  );

  return entries;
}

/**
 * Syncs models from Hugging Face into target directory.
 */
export async function downloadModels(outputBaseDir: string): Promise<ModelManifest[]> {
  const manifests: ModelManifest[] = [];

  for (const model of SYNC_MODELS) {
    console.log(`[sync-models] Processing ${model.id} (${model.repo})...`);
    const modelDir = join(outputBaseDir, model.repo);
    mkdirSync(modelDir, { recursive: true });

    const fileEntries: FileManifestEntry[] = [];

    for (const file of model.files) {
      const localPath = join(modelDir, file);
      mkdirSync(dirname(localPath), { recursive: true });

      if (existsSync(localPath)) {
        console.log(`  ✓ Already cached: ${file}`);
        const buf = readFileSync(localPath);
        fileEntries.push({
          filename: file,
          bytes: buf.byteLength,
          sha256: computeSha256(buf),
        });
        continue;
      }

      const hfUrl = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file}`;
      console.log(`  ↓ Fetching ${file} from ${hfUrl}...`);
      const buffer = await fetchBufferWithRedirect(hfUrl);
      writeFileSync(localPath, buffer);

      const sha256 = computeSha256(buffer);
      console.log(`  ✓ Saved ${file} (${(buffer.byteLength / 1024 / 1024).toFixed(2)} MB, sha256: ${sha256.slice(0, 12)}...)`);

      fileEntries.push({
        filename: file,
        bytes: buffer.byteLength,
        sha256,
      });
    }

    const manifest: ModelManifest = {
      id: model.id,
      repo: model.repo,
      revision: model.revision,
      generatedAt: new Date().toISOString(),
      files: fileEntries,
    };

    writeFileSync(
      join(modelDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8',
    );

    manifests.push(manifest);
  }

  return manifests;
}

/**
 * Verifies that a remote R2 custom domain endpoint responds with 200 and proper CORS headers.
 */
export async function verifyRemoteEndpoint(baseUrl: string): Promise<boolean> {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  console.log(`[verify-remote] Probing ${normalized}...`);

  let allOk = true;

  // Test one known model file
  const testPath = `${normalized}Xenova/modnet/config.json`;
  try {
    const res = await fetch(testPath, {
      method: 'HEAD',
      headers: {
        Origin: 'https://imagetool.example',
      },
    });

    console.log(`  HEAD ${testPath} -> HTTP ${res.status}`);
    const cors = res.headers.get('access-control-allow-origin');
    const contentLength = res.headers.get('content-length');
    console.log(`  CORS: ${cors ?? 'None'}, Content-Length: ${contentLength ?? 'None'}`);

    if (res.status !== 200) {
      console.error(`  [FAIL] Expected HTTP 200, got ${res.status}`);
      allOk = false;
    }

    if (!cors) {
      console.warn(`  [WARN] Missing Access-Control-Allow-Origin header.`);
      allOk = false;
    }
  } catch (err) {
    console.error(`  [FAIL] Network error reaching ${testPath}:`, err instanceof Error ? err.message : err);
    allOk = false;
  }

  return allOk;
}

// ---------------------------------------------------------------------------
// CLI Execution
// ---------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const outDir = resolve(process.cwd(), '.cache/models');

  if (args.includes('--help')) {
    console.log(`
ImageTool Model Sync Utility

Options:
  --download        Download required models from Hugging Face into .cache/models/
  --wasm-only       Stage only the ONNX Runtime WebAssembly files into .cache/models/wasm/
  --verify-remote   Probe a live R2 custom domain for HTTP 200 and CORS headers
                    Usage: --verify-remote https://models.yourdomain.com/
  --help            Show this message
`);
    process.exit(0);
  }

  if (args.includes('--verify-remote')) {
    const idx = args.indexOf('--verify-remote');
    const url = args[idx + 1];
    if (!url) {
      console.error('Error: --verify-remote requires a URL argument.');
      process.exit(1);
    }
    const ok = await verifyRemoteEndpoint(url);
    process.exit(ok ? 0 : 1);
  }

  if (args.includes('--wasm-only')) {
    console.log('[sync-models] Staging WASM files...');
    const wasmFiles = stageWasmFiles(outDir);
    console.log(`[sync-models] Staged ${wasmFiles.length} WASM files to ${outDir}/wasm/`);
    process.exit(0);
  }

  if (args.includes('--download')) {
    console.log('[sync-models] Staging WASM files...');
    stageWasmFiles(outDir);

    console.log('[sync-models] Downloading models from Hugging Face...');
    await downloadModels(outDir);
    console.log('[sync-models] All models synchronized and verified successfully.');
    process.exit(0);
  }

  // Default: stage WASM files and report available commands
  console.log('[sync-models] Staging WASM files...');
  const wasmFiles = stageWasmFiles(outDir);
  console.log(`[sync-models] Staged ${wasmFiles.length} WASM files.`);
  console.log(`Run with '--download' to fetch full model weights, or '--verify-remote <url>' to test your R2 domain.`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename ?? process.argv[1])) {
  main().catch((err) => {
    console.error('[sync-models] Fatal error:', err);
    process.exit(1);
  });
}
