// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Astro evaluates this file before it loads Vite environment variables.
// Use the same mode and loadEnv rules so this file and import.meta.env in
// Astro components agree. Shell variables take precedence over environment files.
const command = process.argv.find((arg) =>
  ['dev', 'build', 'preview', 'sync'].includes(arg)
);

const mode =
  process.env.NODE_ENV ??
  (command === 'dev' || command === 'preview'
    ? 'development'
    : 'production');

const { SITE_ENV } = loadEnv(mode, process.cwd(), '');
const isProduction = SITE_ENV === 'production';

// Keep every page that sets noindex: true here as well.
 /** @type {Set<string>} */
const NOINDEX_PATHS = new Set([
  '/worker-lab',
]);

/**
 * Normalize paths so trailing slashes do not affect matching.
 * @param {string} pathname
 */
const normalizePath = (pathname) =>
  pathname === '/' ? '/' : pathname.replace(/\/+$/, '');

/**
 * Decide whether a generated page should appear in the sitemap.
 * The sitemap integration passes a full URL.
 * @type {(page: string) => boolean}
 */
const includeInSitemap = (page) =>
  !NOINDEX_PATHS.has(normalizePath(new URL(page).pathname));

// The placeholder origin is intentionally non-production.
// Replace it with your owned production domain before launch.
/**
 * Vite plugin that serves cached model files directly from local disk (.cache/models)
 * during development and preview, falling back to the remote proxy if not cached locally.
 */
function localModelServerPlugin() {
  /** @type {import('vite').Connect.NextHandleFunction} */
  const serveModelFile = (req, res, next) => {
    if (!req.url || !req.url.startsWith('/models/')) {
      return next();
    }
    const cleanPath = req.url.split('?')[0].replace(/^\/models\//, '');
    const localFile = path.resolve(process.cwd(), '.cache/models', decodeURIComponent(cleanPath));

    if (fs.existsSync(localFile) && fs.statSync(localFile).isFile()) {
      const stat = fs.statSync(localFile);
      const ext = path.extname(localFile).toLowerCase();
      let contentType = 'application/octet-stream';
      if (ext === '.json') contentType = 'application/json; charset=utf-8';
      else if (ext === '.wasm') contentType = 'application/wasm';
      else if (ext === '.mjs' || ext === '.js') contentType = 'text/javascript; charset=utf-8';
      else if (ext === '.onnx') contentType = 'application/octet-stream';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
        res.setHeader('Content-Length', end - start + 1);
        fs.createReadStream(localFile, { start, end }).pipe(res);
      } else {
        res.statusCode = 200;
        res.setHeader('Content-Length', stat.size);
        fs.createReadStream(localFile).pipe(res);
      }
      return;
    }
    next();
  };

  return {
    name: 'vite-local-models-server',
    /** @param {import('vite').ViteDevServer} server */
    configureServer(server) {
      server.middlewares.use(serveModelFile);
    },
    /** @param {import('vite').PreviewServer} server */
    configurePreviewServer(server) {
      server.middlewares.use(serveModelFile);
    },
  };
}

export default defineConfig({
  site: 'https://imagetool.example',
  trailingSlash: 'never',

  build: {
    format: 'file',
  },

  integrations: [
    react(),
    ...(isProduction
      ? [
          sitemap({
            filter: includeInSitemap,
          }),
        ]
      : []),
  ],

  vite: {
    plugins: [tailwindcss(), localModelServerPlugin()],
    build: {
      target: 'esnext',
    },
    worker: {
      format: 'es',
    },
    ssr: {
      external: ['@huggingface/transformers', 'onnxruntime-web'],
    },
    optimizeDeps: {
      exclude: ['@huggingface/transformers', 'onnxruntime-web'],
    },
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
      proxy: {
        '/models': {
          target: process.env.DEV_MODEL_TARGET || 'https://imagetool.najeebullahwahab.workers.dev',
          changeOrigin: true,
        },
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
      proxy: {
        '/models': {
          target: process.env.DEV_MODEL_TARGET || 'https://imagetool.najeebullahwahab.workers.dev',
          changeOrigin: true,
        },
      },
    },
  },
});