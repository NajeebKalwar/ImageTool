// @ts-check

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
    plugins: [tailwindcss()],
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'credentialless',
      },
    },
  },
});