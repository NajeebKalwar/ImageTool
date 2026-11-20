import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateCsp,
  validateHeadersFile,
  validateDistAssets,
  validateClientSourceCode,
  verifyPrivacy,
} from './verify-privacy.mjs';

const VALID_CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://imagetool.example; connect-src 'self' blob: data: https://huggingface.co https://*.huggingface.co; worker-src 'self' blob:; child-src 'self' blob:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'none';";

const VALID_HEADERS = `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), browsing-topics=()
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: credentialless
  Content-Security-Policy: ${VALID_CSP}
`;

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-test-'));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('validateCsp', () => {
  it('accepts valid production CSP', () => {
    assert.doesNotThrow(() => validateCsp(VALID_CSP));
  });

  it('rejects empty or missing CSP', () => {
    assert.throws(() => validateCsp(''), /empty or missing/);
  });

  it('rejects connect-src with wildcards', () => {
    const invalid = VALID_CSP.replace("https://huggingface.co", "*");
    assert.throws(() => validateCsp(invalid), /wildcards/);
  });

  it('rejects connect-src with unapproved external domain', () => {
    const invalid = VALID_CSP.replace("https://huggingface.co", "https://evil-server.com");
    assert.throws(() => validateCsp(invalid), /unauthorized external origin/);
  });

  it('rejects object-src other than none', () => {
    const invalid = VALID_CSP.replace("object-src 'none'", "object-src 'self'");
    assert.throws(() => validateCsp(invalid), /object-src must be 'none'/);
  });
});

describe('validateHeadersFile', () => {
  it('accepts valid _headers file', () => {
    const { dir, cleanup } = createFixture();
    try {
      const headersPath = join(dir, '_headers');
      writeFileSync(headersPath, VALID_HEADERS);
      assert.doesNotThrow(() => validateHeadersFile(headersPath));
    } finally {
      cleanup();
    }
  });

  it('fails when _headers is missing required security headers', () => {
    const { dir, cleanup } = createFixture();
    try {
      const headersPath = join(dir, '_headers');
      writeFileSync(headersPath, '/*\n  X-Frame-Options: DENY\n');
      assert.throws(() => validateHeadersFile(headersPath), /missing required security header/);
    } finally {
      cleanup();
    }
  });
});

describe('validateDistAssets', () => {
  it('accepts valid clean HTML and JS files', () => {
    const { dir, cleanup } = createFixture();
    try {
      const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VALID_CSP}"></head><body><h1>Hello</h1></body></html>`;
      writeFileSync(join(dir, 'index.html'), html);
      writeFileSync(join(dir, 'app.js'), 'console.log("hello");');

      const res = validateDistAssets(dir);
      assert.equal(res.htmlCount, 1);
      assert.equal(res.jsCount, 1);
    } finally {
      cleanup();
    }
  });

  it('rejects HTML missing CSP meta tag', () => {
    const { dir, cleanup } = createFixture();
    try {
      const html = `<!doctype html><html><head></head><body><h1>No CSP</h1></body></html>`;
      writeFileSync(join(dir, 'index.html'), html);
      assert.throws(() => validateDistAssets(dir), /missing <meta http-equiv="Content-Security-Policy">/);
    } finally {
      cleanup();
    }
  });

  it('rejects HTML containing tracking or analytics domains', () => {
    const { dir, cleanup } = createFixture();
    try {
      const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VALID_CSP}"><script src="https://google-analytics.com/ga.js"></script></head><body></body></html>`;
      writeFileSync(join(dir, 'index.html'), html);
      assert.throws(() => validateDistAssets(dir), /disallowed telemetry or tracking domain/);
    } finally {
      cleanup();
    }
  });

  it('rejects HTML with external form action', () => {
    const { dir, cleanup } = createFixture();
    try {
      const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VALID_CSP}"></head><body><form action="https://upload.example.com/api"></form></body></html>`;
      writeFileSync(join(dir, 'index.html'), html);
      assert.throws(() => validateDistAssets(dir), /external form submission action/);
    } finally {
      cleanup();
    }
  });
});

describe('validateClientSourceCode', () => {
  it('rejects client source code calling navigator.sendBeacon', () => {
    const { dir, cleanup } = createFixture();
    try {
      const libDir = join(dir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, 'telemetry.ts'), 'navigator.sendBeacon("/log", data);');
      assert.throws(() => validateClientSourceCode(dir), /sendBeacon/);
    } finally {
      cleanup();
    }
  });

  it('rejects client source code with unauthorized fetch', () => {
    const { dir, cleanup } = createFixture();
    try {
      const libDir = join(dir, 'lib');
      mkdirSync(libDir, { recursive: true });
      writeFileSync(join(libDir, 'api.ts'), 'fetch("https://upload.example.com", { method: "POST", body: pixels });');
      assert.throws(() => validateClientSourceCode(dir), /Unauthorized fetch call/);
    } finally {
      cleanup();
    }
  });
});

describe('verifyPrivacy integration', () => {
  it('passes on a complete mock dist directory', () => {
    const { dir, cleanup } = createFixture();
    try {
      writeFileSync(join(dir, '_headers'), VALID_HEADERS);
      const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${VALID_CSP}"></head><body><h1>Privacy Verified</h1></body></html>`;
      writeFileSync(join(dir, 'index.html'), html);

      const res = verifyPrivacy({ dist: dir, src: join(dir, 'non-existent-src') });
      assert.equal(res.htmlCount, 1);
    } finally {
      cleanup();
    }
  });
});
