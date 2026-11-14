// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

// The placeholder origin is intentionally non-production.
// Replace it with the owned production domain before launch.
export default defineConfig({
  site: 'https://imagetool.example',
  trailingSlash: 'never',
  build: {
    format: 'file',
  },

  integrations: [react()],

  vite: {
    plugins: [tailwindcss()]
  }
});
