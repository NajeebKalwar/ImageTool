#!/usr/bin/env node
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const distAstroDir = join(process.cwd(), 'dist', '_astro');
if (existsSync(distAstroDir)) {
  const wasmFiles = readdirSync(distAstroDir).filter((file) => file.endsWith('.wasm'));
  for (const file of wasmFiles) {
    const fullPath = join(distAstroDir, file);
    unlinkSync(fullPath);
    console.log(`[clean-dist-wasm] Removed bundled ${file} to satisfy Cloudflare 25 MiB asset limit.`);
  }
}
