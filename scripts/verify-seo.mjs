#!/usr/bin/env node
// Verify generated SEO output. Pass the intended mode explicitly:
// node scripts/verify-seo.mjs --expect production|preview
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'cheerio';

const BRAND = 'ImageTool';

function parseArgs(argv) {
  const options = { dist: 'dist' };

  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];

    if (!value || value.startsWith('--')) {
      throw new Error('Missing value for ' + key);
    }

    if (key === '--expect') options.expect = value;
    else if (key === '--dist') options.dist = value;
    else if (key === '--site') options.site = value;
    else throw new Error('Unknown argument: ' + key);

    index += 1;
  }

  if (!['production', 'preview'].includes(options.expect)) {
    throw new Error('--expect must be "production" or "preview"');
  }

  return options;
}

async function resolveSite(cliSite) {
  if (cliSite) return new URL(cliSite).href;

  const configUrl = pathToFileURL(resolve('astro.config.mjs')).href;
  const configModule = await import(configUrl);
  const site = configModule.default?.site;

  if (typeof site !== 'string' || !site.trim()) {
    throw new Error('astro.config.mjs must export a non-empty site value');
  }

  return new URL(site).href;
}

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

// With build.format='file': index.html is "/", about.html is "/about",
// and section/index.html is "/section".
function expectedPath(file, dist) {
  const relativePath = relative(dist, file).split(sep).join('/');
  const withoutExtension = relativePath.replace(/\.html$/i, '');

  if (withoutExtension === 'index') return '/';
  if (withoutExtension.endsWith('/index')) {
    return '/' + withoutExtension.slice(0, -'/index'.length);
  }

  return '/' + withoutExtension;
}

function single($, selector, where, label, fail) {
  const elements = $(selector);

  if (elements.length !== 1) {
    fail(where, 'expected exactly one ' + label + ', found ' + elements.length);
    return null;
  }

  return elements.first();
}

function addToMap(map, value, page) {
  map.set(value, [...(map.get(value) ?? []), page]);
}

function isAbsoluteUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const dist = resolve(options.dist);
  const site = await resolveSite(options.site);
  const siteUrl = new URL(site);
  const errors = [];
  const fail = (where, message) => errors.push(where + ': ' + message);

  if (!existsSync(dist)) throw new Error('dist folder not found: ' + dist);

  const files = listFiles(dist);
  const htmlFiles = files.filter((file) => file.toLowerCase().endsWith('.html')).sort();

  if (htmlFiles.length === 0) fail('dist', 'no HTML pages found');

  const titles = new Map();
  const descriptions = new Map();
  const canonicals = new Map();
  const indexable = new Set();

  for (const file of htmlFiles) {
    const pagePath = expectedPath(file, dist);
    const where = pagePath;
    const $ = load(readFileSync(file, 'utf8'));

    const titleElement = single($, 'title', where, '<title>', fail);
    if (titleElement) {
      const title = titleElement.text().trim();

      if (!title) {
        fail(where, 'title is empty');
      } else {
        const brandCount = title.split(BRAND).length - 1;

        if (!title.endsWith(' | ' + BRAND)) {
          fail(where, 'title must end with " | ' + BRAND + '"');
        }
        if (brandCount !== 1) {
          fail(where, 'brand "' + BRAND + '" must appear exactly once in the title; found ' + brandCount);
        }

        addToMap(titles, title, where);
      }
    }

    const descriptionElement = single(
      $,
      'meta[name="description"]',
      where,
      'meta description',
      fail,
    );
    if (descriptionElement) {
      const description = descriptionElement.attr('content')?.trim();

      if (!description) fail(where, 'meta description content is missing or empty');
      else addToMap(descriptions, description, where);
    }

    const canonicalElement = single(
      $,
      'link[rel="canonical"]',
      where,
      'canonical link',
      fail,
    );
    if (canonicalElement) {
      const canonical = canonicalElement.attr('href')?.trim();
      const expectedCanonical = new URL(pagePath, siteUrl).href;

      if (!canonical) {
        fail(where, 'canonical href is missing or empty');
      } else {
        if (!isAbsoluteUrl(canonical)) {
          fail(where, 'canonical must be an absolute HTTP(S) URL; received "' + canonical + '"');
        }
        if (canonical !== expectedCanonical) {
          fail(where, 'canonical is "' + canonical + '", expected "' + expectedCanonical + '"');
        }
        addToMap(canonicals, canonical, where);
      }
    }

    const robotsElement = single(
      $,
      'meta[name="robots"]',
      where,
      'robots meta',
      fail,
    );
    if (robotsElement) {
      const robots = robotsElement.attr('content')?.trim();

      if (!robots) {
        fail(where, 'robots content is missing or empty');
      } else {
        const allowed =
          options.expect === 'preview'
            ? ['noindex, nofollow']
            : ['index, follow', 'noindex, follow'];

        if (!allowed.includes(robots)) {
          fail(where, 'robots is "' + robots + '", allowed in ' + options.expect + ' mode: ' + allowed.join(' | '));
        }

        if (options.expect === 'production' && robots === 'index, follow') {
          indexable.add(new URL(pagePath, siteUrl).href);
        }
      }
    }

    single($, 'h1', where, '<h1>', fail);

    const htmlElement = single($, 'html', where, '<html>', fail);
    if (htmlElement && !htmlElement.attr('lang')?.trim()) {
      fail(where, 'missing or empty <html lang>');
    }

    const viewport = single($, 'meta[name="viewport"]', where, 'viewport meta', fail);
    if (viewport && !viewport.attr('content')?.trim()) {
      fail(where, 'viewport content is missing or empty');
    }

    // Astro may emit an external stylesheet link or inline a small stylesheet.
    if ($('link[rel="stylesheet"]').length === 0 && $('style').length === 0) {
      fail(where, 'no external stylesheet link or inline style element found');
    }
  }

  for (const [title, pages] of titles) {
    if (pages.length > 1) fail('duplicate title', '"' + title + '" is used by ' + pages.join(', '));
  }

  for (const [description, pages] of descriptions) {
    if (pages.length > 1) {
      fail('duplicate description', '"' + description + '" is used by ' + pages.join(', '));
    }
  }

  for (const [canonical, pages] of canonicals) {
    if (pages.length > 1) {
      fail('duplicate canonical', '"' + canonical + '" is used by ' + pages.join(', '));
    }
  }

  const robotsTxtPath = join(dist, 'robots.txt');
  const sitemapIndexPath = join(dist, 'sitemap-index.xml');
  const expectedSitemapLine = 'Sitemap: ' + new URL('sitemap-index.xml', siteUrl).href;

  if (!existsSync(robotsTxtPath)) {
    fail('robots.txt', 'file is missing');
  } else {
    const lines = readFileSync(robotsTxtPath, 'utf8')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/)
      .map((line) => line.trim());
    const normalizedLines = lines.map((line) => line.toLowerCase());
    const sitemapLines = lines.filter((line) => /^sitemap:/i.test(line));

    if (!normalizedLines.includes('user-agent: *')) {
      fail('robots.txt', 'missing "User-agent: *"');
    }
    if (!normalizedLines.includes('allow: /')) {
      fail('robots.txt', 'missing "Allow: /"');
    }

    if (options.expect === 'production') {
      if (sitemapLines.length !== 1 || sitemapLines[0] !== expectedSitemapLine) {
        fail('robots.txt', 'expected exactly one line: "' + expectedSitemapLine + '"');
      }
    } else if (sitemapLines.length > 0) {
      fail('robots.txt', 'a preview build must not list a sitemap');
    }
  }

  const sitemapFilesPresent = files.filter((file) =>
    /^sitemap(?:-index|-\d+)\.xml$/i.test(file.split(sep).at(-1) ?? ''),
  );

  if (options.expect === 'preview') {
    if (sitemapFilesPresent.length > 0) {
      fail(
        'sitemap',
        'preview build must not produce sitemap files: ' +
          sitemapFilesPresent.map((file) => relative(dist, file)).join(', '),
      );
    }
  } else if (!existsSync(sitemapIndexPath)) {
    fail('sitemap', 'sitemap-index.xml is missing');
  } else {
    const index = load(readFileSync(sitemapIndexPath, 'utf8'), { xml: true });
    const sitemapLocations = index('sitemapindex > sitemap > loc')
      .map((_, element) => index(element).text().trim())
      .get();

    if (sitemapLocations.length === 0) {
      fail('sitemap', 'sitemap-index.xml lists no sitemap files');
    }

    const uniqueSitemapLocations = new Set(sitemapLocations);
    if (uniqueSitemapLocations.size !== sitemapLocations.length) {
      fail('sitemap', 'sitemap-index.xml contains duplicate sitemap locations');
    }

    const listed = new Set();

    for (const location of sitemapLocations) {
      if (!isAbsoluteUrl(location)) {
        fail('sitemap', 'sitemap location must be an absolute HTTP(S) URL: "' + location + '"');
        continue;
      }

      const sitemapUrl = new URL(location);
      if (sitemapUrl.origin !== siteUrl.origin) {
        fail('sitemap', 'sitemap location is on a different origin: "' + location + '"');
        continue;
      }

      const sitemapPath = resolve(dist, '.' + decodeURIComponent(sitemapUrl.pathname));
      if (sitemapPath !== dist && !sitemapPath.startsWith(dist + sep)) {
        fail('sitemap', 'sitemap location escapes the dist directory: "' + location + '"');
        continue;
      }

      if (!existsSync(sitemapPath)) {
        fail('sitemap', location + ' is listed in the index but missing from dist');
        continue;
      }

      const document = load(readFileSync(sitemapPath, 'utf8'), { xml: true });
      const urlElements = document('urlset > url');

      if (urlElements.length === 0) {
        fail(relative(dist, sitemapPath), 'sitemap contains no URL entries');
      }

      urlElements.each((_, element) => {
        const locations = document(element).children('loc');
        if (locations.length !== 1) {
          fail(relative(dist, sitemapPath), 'each <url> must contain exactly one <loc>');
          return;
        }

        const url = locations.first().text().trim();
        if (!url) {
          fail(relative(dist, sitemapPath), 'sitemap contains an empty <loc>');
          return;
        }
        if (listed.has(url)) fail('sitemap', 'duplicate URL entry: "' + url + '"');
        listed.add(url);
      });
    }

    for (const url of listed) {
      if (!indexable.has(url)) {
        fail('sitemap', '"' + url + '" is listed but is not an indexable page canonical');
      }
    }

    for (const url of indexable) {
      if (!listed.has(url)) {
        fail('sitemap', '"' + url + '" is indexable but missing from the sitemap');
      }
    }
  }

  if (errors.length > 0) {
    console.error('FAILED (' + errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ') in ' + options.expect + ' mode:');
    for (const error of errors) console.error(' - ' + error);
    process.exit(1);
  }

  console.log('OK: ' + htmlFiles.length + ' page(s) verified in ' + options.expect + ' mode.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(2);
});
