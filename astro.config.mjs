// @ts-check
import { defineConfig } from 'astro/config';
import { loadEnv } from 'vite';

import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

// Astro evaluates this file before it loads Vite environment variables.
// Use the same mode and loadEnv rules so this file and import.meta.env in
// Astro components agree. Shell variables take precedence over environment files.
const command = process.argv.find((arg) => ['dev', 'build', 'preview', 'sync'].includes(arg));
const mode =
  process.env.NODE_ENV ??
  (command === 'dev' || command === 'preview' ? 'development' : 'production');

const { SITE_ENV } = loadEnv(mode, process.cwd(), '');
const isProduction = SITE_ENV === 'production';

// Keep every page that sets noindex: true here as well.
// The sitemap integration only sees page URLs, not Astro component props.
// The SEO verifier catches drift between robots metadata and sitemap output.
const NOINDEX_PATHS = new Set([
  // '/example-private-page',
]);

const normalizePath = (pathname) =>
  pathname === '/' ? '/' : pathname.replace(/\/+$/, '');

// The placeholder origin is intentionally non-production.
// Replace it with the owned production domain before launch.
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
            filter: (page) => !NOINDEX_PATHS.has(normalizePath(new URL(page).pathname)),
          }),
        ]
      : []),
  ],

  vite: {
    plugins: [tailwindcss()],
  },
});
