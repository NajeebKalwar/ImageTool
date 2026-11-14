import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://imagetool.example';
const SCRIPT = fileURLToPath(new URL('./verify-seo.mjs', import.meta.url));

function page({
  title = 'Home | ImageTool',
  description = 'A useful description.',
  canonical = SITE + '/',
  robots = 'index, follow',
  h1 = 1,
  extraTitle = false,
  includeStyles = true,
  robotsContent = true,
  canonicalHref = true,
} = {}) {
  return '<!doctype html><html lang="en"><head>' +
    '<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">' +
    (title === null ? '' : '<title>' + title + '</title>' + (extraTitle ? '<title>Second title | ImageTool</title>' : '')) +
    (description === null ? '' : '<meta name="description" content="' + description + '">') +
    (canonical === null ? '' : '<link rel="canonical" ' + (canonicalHref ? 'href="' + canonical + '"' : '') + '>') +
    '<meta name="robots" ' + (robotsContent ? 'content="' + robots + '"' : '') + '>' +
    (includeStyles ? '<style>body{}</style>' : '') +
    '</head><body>' + '<h1>Heading</h1>'.repeat(h1) + '</body></html>';
}

const sitemapIndex =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  '<sitemap><loc>' + SITE + '/sitemap-0.xml</loc></sitemap>' +
  '</sitemapindex>';

const urlset = (urls) =>
  '<?xml version="1.0" encoding="UTF-8"?>' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
  urls.map((url) => '<url><loc>' + url + '</loc></url>').join('') +
  '</urlset>';

const aboutPage = (overrides = {}) =>
  page({
    title: 'About | ImageTool',
    description: 'About this tool.',
    canonical: SITE + '/about',
    ...overrides,
  });

const goodProduction = (overrides = {}) => ({
  'index.html': page(),
  'about.html': aboutPage(),
  'robots.txt': 'User-agent: *\nAllow: /\n\nSitemap: ' + SITE + '/sitemap-index.xml\n',
  'sitemap-index.xml': sitemapIndex,
  'sitemap-0.xml': urlset([SITE + '/', SITE + '/about']),
  ...overrides,
});

const goodPreview = (overrides = {}) => ({
  'index.html': page({ robots: 'noindex, nofollow' }),
  'robots.txt': 'User-agent: *\nAllow: /\n',
  ...overrides,
});

function run(files, mode) {
  const dist = mkdtempSync(join(tmpdir(), 'seo-verify-'));

  try {
    for (const [name, content] of Object.entries(files)) {
      if (content === null) continue;
      const target = join(dist, name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content);
    }

    return spawnSync(
      process.execPath,
      [SCRIPT, '--expect', mode, '--dist', dist, '--site', SITE],
      { encoding: 'utf8' },
    );
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

const passes = (files, mode) => {
  const result = run(files, mode);
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

const fails = (files, mode) => {
  const result = run(files, mode);
  assert.equal(result.status, 1, result.stderr || result.stdout);
};

test('good production build passes', () => passes(goodProduction(), 'production'));
test('good preview build passes', () => passes(goodPreview(), 'preview'));

test('a production noindex page excluded from sitemap passes', () =>
  passes(
    goodProduction({
      'about.html': aboutPage({ robots: 'noindex, follow' }),
      'sitemap-0.xml': urlset([SITE + '/']),
    }),
    'production',
  ));

test('missing title fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ title: null }) }), 'production'));

test('empty title fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ title: '   ' }) }), 'production'));

test('two titles fail', () =>
  fails(goodProduction({ 'about.html': aboutPage({ extraTitle: true }) }), 'production'));

test('missing description fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ description: null }) }), 'production'));

test('empty description fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ description: '  ' }) }), 'production'));

test('missing canonical fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ canonical: null }) }), 'production'));

test('canonical without href fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ canonicalHref: false }) }), 'production'));

test('relative canonical fails', () =>
  fails(goodProduction({ 'about.html': aboutPage({ canonical: '/about' }) }), 'production'));

test('two h1 elements fail', () =>
  fails(goodProduction({ 'about.html': aboutPage({ h1: 2 }) }), 'production'));

test('brand repeated in title fails', () =>
  fails(
    goodProduction({ 'about.html': aboutPage({ title: 'ImageTool About | ImageTool' }) }),
    'production',
  ));

test('duplicate title across pages fails', () =>
  fails(
    goodProduction({
      'about.html': aboutPage({ title: 'Home | ImageTool', description: 'Different text.' }),
    }),
    'production',
  ));

test('duplicate description across pages fails', () =>
  fails(
    goodProduction({
      'about.html': aboutPage({ description: 'A useful description.' }),
    }),
    'production',
  ));

test('noindex page listed in sitemap fails', () =>
  fails(
    goodProduction({ 'about.html': aboutPage({ robots: 'noindex, follow' }) }),
    'production',
  ));

test('indexable page missing from sitemap fails', () =>
  fails(
    goodProduction({ 'sitemap-0.xml': urlset([SITE + '/']) }),
    'production',
  ));

test('duplicate sitemap URL fails', () =>
  fails(
    goodProduction({ 'sitemap-0.xml': urlset([SITE + '/', SITE + '/']) }),
    'production',
  ));

test('missing sitemap index fails', () =>
  fails(goodProduction({ 'sitemap-index.xml': null, 'sitemap-0.xml': null }), 'production'));

test('sitemap index pointing to a missing file fails', () =>
  fails(
    goodProduction({
      'sitemap-index.xml': sitemapIndex.replace('sitemap-0.xml', 'sitemap-1.xml'),
      'sitemap-0.xml': null,
    }),
    'production',
  ));

test('missing sitemap line in production robots.txt fails', () =>
  fails(
    goodProduction({ 'robots.txt': 'User-agent: *\nAllow: /\n' }),
    'production',
  ));

test('preview robots.txt containing a sitemap line fails', () =>
  fails(
    goodPreview({
      'robots.txt': 'User-agent: *\nAllow: /\nSitemap: ' + SITE + '/sitemap-index.xml\n',
    }),
    'preview',
  ));

test('preview build containing any sitemap file fails', () =>
  fails(
    goodPreview({ 'sitemap-0.xml': urlset([SITE + '/']) }),
    'preview',
  ));

test('preview page with an indexable robots directive fails', () =>
  fails(
    goodPreview({ 'index.html': page({ robots: 'index, follow' }) }),
    'preview',
  ));

test('missing external and inline styles fails', () =>
  fails(
    goodProduction({ 'about.html': aboutPage({ includeStyles: false }) }),
    'production',
  ));
