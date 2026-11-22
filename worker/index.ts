/**
 * Cloudflare Worker entry point for ImageTool.
 *
 * Routes:
 * - /models/* : Fetches and streams AI model weights, configs, and WASM binaries
 *   directly from the bound Cloudflare R2 bucket ('MODELS'), with caching, CORS,
 *   and HTTP Range request (206) support.
 * - *         : Proxies to Cloudflare Workers Static Assets binding ('ASSETS').
 */

interface R2GetOptions {
  range?: Headers | unknown;
  onlyIf?: Headers | unknown;
}

interface R2ObjectBody {
  body: ReadableStream;
  httpEtag: string;
  writeHttpMetadata: (headers: Headers) => void;
  range?: unknown;
}

interface R2Bucket {
  get: (key: string, options?: R2GetOptions) => Promise<R2ObjectBody | null>;
}

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> };
  MODELS: R2Bucket;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/models/')) {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
          },
        });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method Not Allowed', { status: 405 });
      }

      // Extract object key inside the bucket
      const key = decodeURIComponent(url.pathname.replace(/^\/models\//, ''));
      if (!key) {
        return new Response('Model key required', { status: 400 });
      }

      // Query R2 bucket
      const object = await env.MODELS.get(key, {
        range: request.headers,
        onlyIf: request.headers,
      });

      if (!object) {
        return new Response(`Model asset not found: ${key}`, {
          status: 404,
          headers: {
            'Access-Control-Allow-Origin': '*',
          },
        });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set('etag', object.httpEtag);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');

      // Explicitly set correct Content-Type for all AI model assets and WASM/JS loaders
      if (key.endsWith('.mjs') || key.endsWith('.js')) {
        headers.set('content-type', 'text/javascript; charset=utf-8');
      } else if (key.endsWith('.wasm')) {
        headers.set('content-type', 'application/wasm');
      } else if (key.endsWith('.json')) {
        headers.set('content-type', 'application/json; charset=utf-8');
      } else if (key.endsWith('.onnx')) {
        headers.set('content-type', 'application/octet-stream');
      }

      const isRange = request.headers.has('range') && 'range' in object;
      const status = object.body ? (isRange ? 206 : 200) : 304;

      return new Response(request.method === 'HEAD' ? null : object.body, {
        headers,
        status,
      });
    }

    // Default: proxy to static site assets
    return env.ASSETS.fetch(request);
  },
};
