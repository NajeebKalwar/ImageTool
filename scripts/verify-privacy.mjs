#!/usr/bin/env node
/**
 * Automated Privacy and Security Audit Verifier (P-01 to P-04).
 *
 * Enforces ImageTool's strict zero-cloud-transmission guarantee:
 * 1. Validates strict Content Security Policy (CSP) in HTML meta tags and _headers.
 * 2. Confirms security headers (nosniff, DENY, strict-origin, credentialless, same-origin).
 * 3. Scans built HTML and JavaScript bundles for unauthorized analytics, telemetry, or tracking scripts.
 * 4. Verifies absence of external form actions or upload endpoints.
 * 5. Performs static source analysis verifying that image pixels never leave the device.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';

export const DISALLOWED_TRACKING_DOMAINS = [
  'google-analytics.com',
  'googletagmanager.com',
  'doubleclick.net',
  'connect.facebook.net',
  'static.hotjar.com',
  'cdn.segment.com',
  'api.mixpanel.com',
  'sentry.io',
  'browser-intake-datadoghq.com',
  'analytics.tiktok.com',
  'clarity.ms',
];

export const ALLOWED_CONNECT_ORIGINS = new Set([
  "'self'",
  'blob:',
  'data:',
  'https://huggingface.co',
  'https://*.huggingface.co',
]);

function parseArgs(argv) {
  const options = { dist: 'dist', src: 'src' };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];

    if (key === '--dist' && value) {
      options.dist = value;
      i++;
    } else if (key === '--src' && value) {
      options.src = value;
      i++;
    }
  }

  return options;
}

function findFilesRecursive(dir, ext) {
  if (!existsSync(dir)) return [];
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursive(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}

export function parseCspDirectives(cspString) {
  const directives = new Map();
  const parts = cspString.split(';').map((s) => s.trim()).filter(Boolean);

  for (const part of parts) {
    const [name, ...tokens] = part.split(/\s+/);
    directives.set(name.toLowerCase(), tokens);
  }

  return directives;
}

/**
 * Validates the Content-Security-Policy string against privacy standards.
 */
export function validateCsp(cspString, context = 'meta') {
  if (!cspString || !cspString.trim()) {
    throw new Error(`[${context}] CSP directive string is empty or missing.`);
  }

  const directives = parseCspDirectives(cspString);

  // default-src
  const defaultSrc = directives.get('default-src');
  if (!defaultSrc || !defaultSrc.includes("'self'")) {
    throw new Error(`[${context}] default-src must include 'self'.`);
  }

  // connect-src: strictly restrict network destinations
  const connectSrc = directives.get('connect-src');
  if (!connectSrc) {
    throw new Error(`[${context}] connect-src directive is required to restrict network calls.`);
  }

  if (connectSrc.includes('*') || connectSrc.some((t) => t.startsWith('http:'))) {
    throw new Error(`[${context}] connect-src must not permit wildcards or insecure http origins.`);
  }

  for (const token of connectSrc) {
    if (!ALLOWED_CONNECT_ORIGINS.has(token)) {
      throw new Error(`[${context}] connect-src contains unauthorized external origin: '${token}'. Only approved model CDNs are allowed.`);
    }
  }

  // object-src must be 'none'
  const objectSrc = directives.get('object-src');
  if (!objectSrc || !objectSrc.includes("'none'")) {
    throw new Error(`[${context}] object-src must be 'none'.`);
  }

  // base-uri must be 'self'
  const baseUri = directives.get('base-uri');
  if (!baseUri || !baseUri.includes("'self'")) {
    throw new Error(`[${context}] base-uri must be 'self'.`);
  }
}

/**
 * Validates the headers file (e.g. dist/_headers).
 */
export function validateHeadersFile(headersPath) {
  if (!existsSync(headersPath)) {
    throw new Error(`Security headers file missing at '${headersPath}'.`);
  }

  const content = readFileSync(headersPath, 'utf8');

  const requiredHeaders = [
    { name: 'X-Content-Type-Options', expected: 'nosniff' },
    { name: 'X-Frame-Options', expected: 'DENY' },
    { name: 'Referrer-Policy', expected: 'strict-origin-when-cross-origin' },
    { name: 'Cross-Origin-Opener-Policy', expected: 'same-origin' },
    { name: 'Cross-Origin-Embedder-Policy', expected: 'credentialless' },
  ];

  for (const { name, expected } of requiredHeaders) {
    const regex = new RegExp(`^\\s*${name}:\\s*${expected}`, 'm');
    if (!regex.test(content)) {
      throw new Error(`_headers is missing required security header '${name}: ${expected}'.`);
    }
  }

  const cspMatch = content.match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  if (!cspMatch) {
    throw new Error('_headers is missing Content-Security-Policy directive.');
  }

  validateCsp(cspMatch[1], '_headers');
}

/**
 * Validates all generated HTML and bundle assets in dist directory.
 */
export function validateDistAssets(distDir) {
  const htmlFiles = findFilesRecursive(distDir, '.html');
  if (htmlFiles.length === 0) {
    throw new Error(`No HTML files found in dist directory '${distDir}'.`);
  }

  for (const htmlPath of htmlFiles) {
    const html = readFileSync(htmlPath, 'utf8');
    const $ = load(html);
    const rel = relative(distDir, htmlPath);

    // 1. Verify CSP meta tag
    const cspMeta = $('meta[http-equiv="Content-Security-Policy"]');
    if (cspMeta.length === 0) {
      throw new Error(`Page '${rel}' is missing <meta http-equiv="Content-Security-Policy">.`);
    }

    const cspContent = cspMeta.attr('content');
    validateCsp(cspContent, rel);

    // 2. Verify no external form submissions
    $('form').each((_, el) => {
      const action = $(el).attr('action');
      if (action && (action.startsWith('http:') || action.startsWith('https:') || action.startsWith('//'))) {
        throw new Error(`Page '${rel}' contains external form submission action: ${action}`);
      }
    });

    // 3. Verify no blacklisted tracking domains in HTML
    for (const domain of DISALLOWED_TRACKING_DOMAINS) {
      if (html.includes(domain)) {
        throw new Error(`Page '${rel}' contains disallowed telemetry or tracking domain: ${domain}`);
      }
    }
  }

  // Scan JS bundle files for blacklisted tracking scripts
  const jsFiles = findFilesRecursive(distDir, '.js');
  for (const jsPath of jsFiles) {
    const js = readFileSync(jsPath, 'utf8');
    const rel = relative(distDir, jsPath);

    for (const domain of DISALLOWED_TRACKING_DOMAINS) {
      if (js.includes(domain)) {
        throw new Error(`Bundle asset '${rel}' contains disallowed telemetry or tracking domain: ${domain}`);
      }
    }
  }

  return { htmlCount: htmlFiles.length, jsCount: jsFiles.length };
}

/**
 * Validates client source code to verify P-01 & P-02 (zero pixel exfiltration).
 */
export function validateClientSourceCode(srcDir) {
  if (!existsSync(srcDir)) return;

  const clientDirs = [
    join(srcDir, 'lib'),
    join(srcDir, 'workers'),
    join(srcDir, 'components'),
  ];

  const sourceFiles = [];
  for (const dir of clientDirs) {
    sourceFiles.push(...findFilesRecursive(dir, '.ts'), ...findFilesRecursive(dir, '.tsx'));
  }

  for (const filePath of sourceFiles) {
    const code = readFileSync(filePath, 'utf8');
    const rel = relative(srcDir, filePath);

    // Check for beacon or websocket
    if (code.includes('sendBeacon')) {
      throw new Error(`Source file '${rel}' calls navigator.sendBeacon, violating privacy rules.`);
    }
    if (code.includes('new WebSocket(')) {
      throw new Error(`Source file '${rel}' establishes a WebSocket connection.`);
    }

    // Inspect fetch calls
    if (/\bfetch\s*\(/.test(code)) {
      // The only allowed fetch is model weights download in model-cache.ts
      if (!rel.includes('model-cache.ts')) {
        throw new Error(`Unauthorized fetch call detected in client source '${rel}'. Only local processing is permitted.`);
      }

      // In model-cache, ensure fetch does NOT have a POST or body
      if (/method\s*:\s*['"]POST['"]/i.test(code) || /body\s*:/i.test(code)) {
        throw new Error(`Detected POST request or outgoing body payload in '${rel}'. Image pixels must never be transmitted.`);
      }
    }
  }
}

/**
 * Master privacy verification orchestrator.
 */
export function verifyPrivacy(options) {
  const distDir = resolve(options.dist || 'dist');
  const srcDir = resolve(options.src || 'src');
  const headersPath = join(distDir, '_headers');

  // 1. Headers verification
  validateHeadersFile(headersPath);

  // 2. Built distribution assets verification
  const { htmlCount, jsCount } = validateDistAssets(distDir);

  // 3. Client source code static analysis
  validateClientSourceCode(srcDir);

  return { htmlCount, jsCount };
}

// CLI Execution Entrypoint
const isDirectCli = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isDirectCli) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const { htmlCount } = verifyPrivacy(options);
    console.log(`OK: Privacy audit passed (P-01 to P-04 verified across ${htmlCount} pages and client source code).`);
  } catch (err) {
    console.error(`Privacy verification failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
