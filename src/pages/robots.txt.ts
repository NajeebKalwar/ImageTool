import type { APIRoute } from 'astro';

// Uses the same SITE_ENV as the page robots meta and Astro config.
const isProduction = import.meta.env.SITE_ENV === 'production';

export const GET: APIRoute = ({ site }) => {
  if (!site) {
    throw new Error('robots.txt needs site to be set in astro.config.mjs.');
  }

  const lines = [
    'User-agent: *',
    'Allow: /',
    ...(isProduction
      ? ['', 'Sitemap: ' + new URL('sitemap-index.xml', site).href]
      : []),
  ];

  return new Response(lines.join('\n') + '\n', {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
