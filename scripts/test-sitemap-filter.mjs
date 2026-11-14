import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'cheerio';

const repositoryRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'imagetool-sitemap-filter-'));
const nodeModulesSource = join(repositoryRoot, 'node_modules');
const site = 'https://imagetool.example';
const testPath = '/__seo-noindex-test';
const testUrl = new URL(testPath, site).href;

function run(command, args, cwd, env) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(
      'Command failed: ' + [command, ...args].join(' ') + '\n' +
      (result.stdout || '') + '\n' + (result.stderr || ''),
    );
  }

  return result.stdout;
}

try {
  if (!existsSync(nodeModulesSource)) {
    throw new Error('node_modules is missing. Install dependencies before running this test.');
  }

  cpSync(repositoryRoot, temporaryRoot, {
    recursive: true,
    filter(source) {
      if (source === repositoryRoot) return true;

      const relativePath = relative(repositoryRoot, source);
      const firstSegment = relativePath.split(sep)[0];

      if (['.git', 'node_modules', 'dist', '.astro'].includes(firstSegment)) return false;
      if (firstSegment === '.env' || firstSegment.startsWith('.env.')) return false;
      return true;
    },
  });

  symlinkSync(
    nodeModulesSource,
    join(temporaryRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  const configPath = join(temporaryRoot, 'astro.config.mjs');
  const config = readFileSync(configPath, 'utf8');
  const emptyList = "const NOINDEX_PATHS = new Set([\n  // '/example-private-page',\n]);";
  const withTestPage = "const NOINDEX_PATHS = new Set([\n  '/__seo-noindex-test',\n]);";

  if (!config.includes(emptyList)) {
    throw new Error('Could not find the expected empty NOINDEX_PATHS list in astro.config.mjs.');
  }
  writeFileSync(configPath, config.replace(emptyList, withTestPage));

  const testPagePath = join(temporaryRoot, 'src', 'pages', '__seo-noindex-test.astro');
  mkdirSync(dirname(testPagePath), { recursive: true });
  writeFileSync(
    testPagePath,
    "---\n" +
      "import Layout from '../layouts/Layout.astro';\n" +
      "---\n" +
      "<Layout\n" +
      '  title="SEO Noindex Filter Test"\n' +
      '  description="Temporary test page used to verify sitemap exclusion."\n' +
      '  path="/__seo-noindex-test"\n' +
      "  noindex={true}\n" +
      ">\n" +
      "  <main><h1>SEO Noindex Filter Test</h1></main>\n" +
      "</Layout>\n",
  );

  const astroPackage = JSON.parse(
    readFileSync(join(nodeModulesSource, 'astro', 'package.json'), 'utf8'),
  );
  const astroCli = join(nodeModulesSource, 'astro', astroPackage.bin.astro);
  const buildEnv = {
    ...process.env,
    NODE_ENV: 'production',
    SITE_ENV: 'production',
  };

  run(process.execPath, [astroCli, 'build'], temporaryRoot, buildEnv);

  const dist = join(temporaryRoot, 'dist');
  const testHtml = join(dist, '__seo-noindex-test.html');
  const sitemapIndexPath = join(dist, 'sitemap-index.xml');

  if (!existsSync(testHtml)) {
    throw new Error('The temporary noindex page was not generated.');
  }
  if (!existsSync(sitemapIndexPath)) {
    throw new Error('The production sitemap index was not generated.');
  }

  const pageDocument = load(readFileSync(testHtml, 'utf8'));
  const robots = pageDocument('meta[name="robots"]').attr('content')?.trim();

  if (robots !== 'noindex, follow') {
    throw new Error('Expected the temporary page to have noindex, follow; received: ' + robots);
  }

  const indexDocument = load(readFileSync(sitemapIndexPath, 'utf8'), { xml: true });
  const sitemapLocations = indexDocument('sitemapindex > sitemap > loc')
    .map((_, element) => indexDocument(element).text().trim())
    .get();

  const listed = new Set();
  for (const location of sitemapLocations) {
    const sitemapUrl = new URL(location);
    const sitemapPath = join(dist, decodeURIComponent(sitemapUrl.pathname).replace(/^\/+/, ''));

    if (!existsSync(sitemapPath)) {
      throw new Error('Sitemap index references a missing file: ' + location);
    }

    const document = load(readFileSync(sitemapPath, 'utf8'), { xml: true });
    document('urlset > url > loc').each((_, element) => {
      listed.add(document(element).text().trim());
    });
  }

  if (listed.has(testUrl)) {
    throw new Error('The temporary noindex page appeared in the sitemap: ' + testUrl);
  }

  run(
    process.execPath,
    [
      join(repositoryRoot, 'scripts', 'verify-seo.mjs'),
      '--expect',
      'production',
      '--dist',
      dist,
      '--site',
      site,
    ],
    temporaryRoot,
    buildEnv,
  );

  console.log('PASS: temporary noindex page renders noindex, follow.');
  console.log('PASS: temporary noindex page is excluded by NOINDEX_PATHS.');
  console.log('PASS: temporary noindex page is absent from every generated sitemap.');
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
