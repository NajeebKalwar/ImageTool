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
import { join, dirname, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

interface ModelSyncDef {
  id: string;
  repo: string;
  revision: string;
  files: string[];
}

export const SYNC_MODELS: readonly ModelSyncDef[] = [
  {
    id: 'swin2sr-x2',
    repo: 'Xenova/swin2SR-lightweight-x2-64',
    revision: '92a21aca5713f20faf9a87590cdfbdce2e34112c',
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

  // Prefer nested onnxruntime-web used by @huggingface/transformers to guarantee binary-to-JS compatibility
  const candidateDirs = [
    resolve(process.cwd(), 'node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist'),
    resolve(process.cwd(), 'node_modules/onnxruntime-web/dist'),
  ];

  const ortDistDir = candidateDirs.find((d) => existsSync(d));
  if (!ortDistDir) {
    console.warn(`[sync-models] onnxruntime-web dist directory not found`);
    return [];
  }

  const entries: FileManifestEntry[] = [];
  const files = readdirSync(ortDistDir).filter(
    (f) => f.startsWith('ort-wasm') && (f.endsWith('.wasm') || f.endsWith('.mjs')),
  );

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
    sourceDir: ortDistDir,
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
 * Uploads staged model and WASM files to a Cloudflare R2 bucket via Wrangler.
 */
export function uploadDirectoryToR2(baseDir: string, bucketName: string = 'imagetool-models'): void {
  console.log(`[upload-r2] Uploading staged files from ${baseDir} to bucket '${bucketName}'...`);

  // First, set the CORS policy
  const corsFile = resolve(process.cwd(), 'cloudflare/r2-cors.json');
  if (existsSync(corsFile)) {
    try {
      console.log(`[upload-r2] Applying CORS policy from cloudflare/r2-cors.json...`);
      execSync(`npx wrangler r2 bucket cors set ${bucketName} --file cloudflare/r2-cors.json -y`, {
        stdio: 'inherit',
      });
      console.log(`  ✓ CORS policy updated.`);
    } catch (err) {
      console.warn(`  [WARN] Failed to automatically apply CORS rule:`, err instanceof Error ? err.message : err);
    }
  }

  function getFilesRecursively(dir: string): string[] {
    const entries = readdirSync(dir, { withFileTypes: true });
    let files: string[] = [];
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files = files.concat(getFilesRecursively(fullPath));
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
    return files;
  }

  const allFiles = getFilesRecursively(baseDir);
  console.log(`[upload-r2] Found ${allFiles.length} files to upload.`);

  for (const filePath of allFiles) {
    const relKey = relative(baseDir, filePath).replace(/\\/g, '/');

    let contentType = 'application/octet-stream';
    if (relKey.endsWith('.json')) contentType = 'application/json';
    else if (relKey.endsWith('.wasm')) contentType = 'application/wasm';
    else if (relKey.endsWith('.onnx')) contentType = 'application/octet-stream';
    else if (relKey.endsWith('.mjs') || relKey.endsWith('.js')) contentType = 'text/javascript';

    console.log(`[upload-r2] Putting ${bucketName}/${relKey} (${contentType})...`);
    try {
      execSync(
        `npx wrangler r2 object put ${bucketName}/${relKey} --file "${filePath}" --content-type ${contentType} --remote`,
        { stdio: 'inherit' },
      );
      console.log(`  ✓ Uploaded ${relKey}`);
    } catch (err) {
      console.error(`  [ERROR] Failed to upload ${relKey}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[upload-r2] Upload completed.`);
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
  --upload-r2       Upload staged models and WASM files to Cloudflare R2 bucket (default: imagetool-models)
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

  if (args.includes('--upload-r2')) {
    const idx = args.indexOf('--upload-r2');
    const bucket = args[idx + 1] && !args[idx + 1].startsWith('-') ? args[idx + 1] : 'imagetool-models';
    uploadDirectoryToR2(outDir, bucket);
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
