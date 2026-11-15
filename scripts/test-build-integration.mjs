import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { load } from 'cheerio';

const repositoryRoot = process.cwd();
const temporaryRoot = mkdtempSync(join(tmpdir(), 'imagetool-build-integration-'));
const nodeModulesSource = join(repositoryRoot, 'node_modules');
const site = 'https://imagetool.example';
const testPath = '/seo-noindex-test';
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

function runVerifier(dist, cwd, env) {
  return spawnSync(
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
    {
      cwd,
      env,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function readSitemapUrls(dist) {
  const sitemapIndexPath = join(dist, 'sitemap-index.xml');
  if (!existsSync(sitemapIndexPath)) {
    throw new Error('The production sitemap index was not generated.');
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

  return listed;
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
  const withTestPage = "const NOINDEX_PATHS = new Set([\n  '/seo-noindex-test',\n]);";

  if (!config.includes(emptyList)) {
    throw new Error('Could not find the expected empty NOINDEX_PATHS list in astro.config.mjs.');
  }

  const testPagePath = join(temporaryRoot, 'src', 'pages', 'seo-noindex-test.astro');
  mkdirSync(dirname(testPagePath), { recursive: true });
  writeFileSync(
    testPagePath,
    "---\n" +
      "import Layout from '../layouts/Layout.astro';\n" +
      "---\n" +
      "<Layout\n" +
      '  title="SEO Noindex Filter Test"\n' +
      '  description="Temporary test page used to verify sitemap exclusion."\n' +
      '  path="/seo-noindex-test"\n' +
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
  const dist = join(temporaryRoot, 'dist');
  const testHtml = join(dist, 'seo-noindex-test.html');

  // First build deliberately omits the noindex route from NOINDEX_PATHS.
  // The generated sitemap will contain it, and the verifier must reject that drift.
  writeFileSync(configPath, config.replace(emptyList, emptyList));
  run(process.execPath, [astroCli, 'build'], temporaryRoot, buildEnv);

  if (!existsSync(testHtml)) {
    throw new Error('The temporary noindex page was not generated.');
  }

  const pageDocument = load(readFileSync(testHtml, 'utf8'));
  const robots = pageDocument('meta[name="robots"]').attr('content')?.trim();

  if (robots !== 'noindex, follow') {
    throw new Error('Expected the temporary page to have noindex, follow; received: ' + robots);
  }

  const missingFilterList = readSitemapUrls(dist);
  if (!missingFilterList.has(testUrl)) {
    throw new Error('Expected the missing-filter test build to include the route in its sitemap.');
  }

  const driftResult = runVerifier(dist, temporaryRoot, buildEnv);
  const driftOutput = (driftResult.stdout || '') + (driftResult.stderr || '');

  if (driftResult.status !== 1 || !driftOutput.includes(testUrl)) {
    throw new Error(
      'Expected the verifier to reject the sitemap/filter drift with exit code 1.\n' +
      'Actual exit code: ' + driftResult.status + '\n' + driftOutput,
    );
  }

  console.log('PASS: verifier rejects a noindex page missing from NOINDEX_PATHS.');

  // Second build adds the noindex path to the explicit sitemap exclusion list.
  writeFileSync(configPath, config.replace(emptyList, withTestPage));
  rmSync(dist, { recursive: true, force: true });
  run(process.execPath, [astroCli, 'build'], temporaryRoot, buildEnv);

  const filteredDocument = load(readFileSync(testHtml, 'utf8'));
  const filteredRobots = filteredDocument('meta[name="robots"]').attr('content')?.trim();

  if (filteredRobots !== 'noindex, follow') {
    throw new Error('Expected the filtered page to retain noindex, follow; received: ' + filteredRobots);
  }

  const filteredUrls = readSitemapUrls(dist);
  if (filteredUrls.has(testUrl)) {
    throw new Error('The temporary noindex page remained in the sitemap: ' + testUrl);
  }

  const verified = runVerifier(dist, temporaryRoot, buildEnv);
  if (verified.status !== 0) {
    throw new Error(
      'Expected the verifier to accept the correctly filtered build.\n' +
      (verified.stdout || '') + '\n' + (verified.stderr || ''),
    );
  }

  console.log('PASS: temporary noindex page renders noindex, follow.');
  console.log('PASS: adding the path to NOINDEX_PATHS removes it from all sitemap files.');
  console.log('PASS: verifier accepts the correctly filtered production build.');

  // Confirm SITE_ENV is also read from .env when the shell variable is absent.
  writeFileSync(join(temporaryRoot, '.env'), 'SITE_ENV=production\\n');
  const envFileBuildEnv = { ...process.env, NODE_ENV: 'production' };
  delete envFileBuildEnv.SITE_ENV;
  rmSync(dist, { recursive: true, force: true });
  run(process.execPath, [astroCli, 'build'], temporaryRoot, envFileBuildEnv);

  const envFileResult = runVerifier(dist, temporaryRoot, envFileBuildEnv);
  if (envFileResult.status !== 0) {
    throw new Error(
      'Expected SITE_ENV from .env to produce a valid production build.\\n' +
      (envFileResult.stdout || '') + '\\n' + (envFileResult.stderr || ''),
    );
  }

  const envHome = load(readFileSync(join(dist, 'index.html'), 'utf8'));
  const envRobots = envHome('meta[name="robots"]').attr('content')?.trim();
  if (envRobots !== 'index, follow') {
    throw new Error('Expected .env production mode to emit index, follow; received: ' + envRobots);
  }
  if (!existsSync(join(dist, 'sitemap-index.xml'))) {
    throw new Error('Expected .env production mode to generate sitemap-index.xml.');
  }
  console.log('PASS: SITE_ENV from .env produces production robots metadata and a sitemap.');

} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
