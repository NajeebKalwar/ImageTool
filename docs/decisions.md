# ImageTool — Architecture Decision Record

This file is the source of truth for project-level decisions. Add a dated entry whenever a decision changes. Do not silently change an established decision in code.

## ADR-001: Production site origin and URL format

- **Status:** Provisional — replace the placeholder before production.
- **Problem:** Astro needs a production origin to generate absolute canonical URLs and sitemap entries. The project does not yet have a confirmed production domain.
- **Principle:** Keep one source of truth for the origin in `astro.config.mjs`; do not duplicate it in `src/site.config.ts`.
- **Decision:** Use `https://imagetool.example` as an explicitly non-production placeholder. Set `trailingSlash: 'never'` and `build.format: 'file'` so Astro emits extensionless route URLs without trailing slashes (for example, `/background-remover`) and writes page files such as `background-remover.html`.
- **Options rejected:** Guessing a real domain; maintaining the origin independently in multiple configuration files; pairing `trailingSlash: 'never'` with the default directory output format.
- **Risk:** The placeholder is unsuitable for indexing or production sharing. Replace it with the owned production origin before launch. The selected output format must be tested against the eventual static host: it must serve `/background-remover` from the generated `background-remover.html` without redirecting to a slash URL. This host behavior has not yet been tested.

## ADR-002: Global site configuration

- **Status:** Accepted.
- **Problem:** Shared site metadata should not be repeated or mixed with page-specific SEO data.
- **Principle:** A global config contains only values that remain the same across pages. Titles, descriptions, canonical paths, robots directives, and page-specific images belong to individual pages.
- **Decision:** Create `src/site.config.ts` for the site name, default language, and default social-image path. The production origin remains in `astro.config.mjs` to avoid configuration drift. The current `defaultSocialImage` value (`/images/social/default-og.png`) is a placeholder for a file that has not been created yet; before Phase 4 uses it, create the image and resolve it to an absolute URL using `Astro.site`.
- **Options rejected:** Putting per-page SEO fields in the global config; duplicating the production origin.
- **Risk:** Shared defaults may be mistaken for required page metadata. Page-level metadata must remain explicit, and the social image must exist before it is emitted.

## ADR-003: Image privacy boundary

- **Status:** Accepted as a product requirement; implementation verification is ongoing.
- **Problem:** The product's main promise is that image pixels stay on the visitor's device.
- **Principle:** Local image processing is the default. Any future feature that sends image pixels off-device must be treated as a product/privacy decision, not an incidental implementation detail.
- **Decision:** Image inputs and decoded pixel data are processed in the browser. AI inference runs locally in a Web Worker using browser-compatible runtimes where supported. Model downloads may contact a model or asset host, but user image pixels must not be included in those requests.
- **Options rejected:** A server-side image inference service as the default; uploading source images for routine processing.
- **Risk:** Third-party scripts, analytics, crash reporting, remote fonts/widgets, model-loading code, or a future sharing/cloud feature could violate the promise. See `ARCHITECTURE.md` for detection requirements. Verify actual network behavior before making privacy claims publicly.

## ADR-004: SEO framework and rendering

- **Status:** Accepted.
- **Problem:** Tool pages need crawlable HTML and individually correct metadata.
- **Principle:** Render page content and essential SEO metadata at build time wherever possible; keep interactive image tools in React islands.
- **Decision:** Use Astro for the website shell, static page generation, metadata, sitemap, and content; use React + TypeScript for interactive tools. Per-page title and description are required by the SEO layout.
- **Options rejected:** A client-only SPA as the entire public website.
- **Risk:** Client-rendered content, duplicate URL forms, missing metadata, and thin tool pages can undermine discoverability. Validate built HTML and provide useful, original content on each tool page.

## ADR-005: Repository hygiene

- **Status:** Accepted.
- **Problem:** Prevent generated files, secrets, and personal data from entering version control.
- **Principle:** Commit only intentional project source and documentation; never commit credentials or private user data.
- **Decision:** Keep `dist/`, `.astro/`, `node_modules/`, environment files, logs, and common OS/IDE artifacts ignored. No project license is selected yet.
- **Options rejected:** Committing generated build output, local environment files, API keys, or personal files.
- **Risk:** Ignore rules do not remove files already tracked. Review tracked files and repository history for accidental secrets before public release. Select a license before publishing or accepting contributions.

## ADR-006: Robots indexing policy

- **Status:** Accepted.
- **Problem:** Development and preview builds must not become indexable accidentally, while selected production pages may need to be excluded from search indexing.
- **Principle:** The deployment environment provides the mandatory safety boundary. A page-level setting may make indexing stricter, but it cannot make a non-production build indexable.
- **Decision:** The SEO layout treats a build as production only when the server-side `SITE_ENV` variable equals `production`. In development or preview builds, emit `noindex, nofollow`. In production, emit `index, follow` by default. When a production page sets `noindex: true`, emit `noindex, follow`. Production deployment must explicitly set `SITE_ENV=production`; preview deployments must not set it to `production`.
- **Options rejected:** Relying only on page authors to remember `noindex`; allowing a page prop to override a non-production build's noindex protection; using `noindex, nofollow` for every excluded production page.
- **Risk:** A deployment configured with `SITE_ENV=production` on a preview URL will be indexable. Configure the variable per deployment environment and verify the generated HTML before publishing. Check current search-engine guidance before relying on long-term link-following behavior from pages kept `noindex`.

## ADR-007: Page title suffix

- **Status:** Accepted.
- **Problem:** Repeating the brand name in every page title creates inconsistent titles and makes page authors responsible for shared metadata.
- **Decision:** Page authors provide a page-specific title without the brand. The SEO layout trims the value and appends ` | ImageTool`. The layout rejects an empty or whitespace-only title and description.
- **Options rejected:** Requiring every page to append the brand manually; using different title separators across pages.
- **Risk:** Page titles must not include the brand suffix themselves, or the brand will appear twice.

## ADR-008: Sitemap inclusion policy

- **Status:** Accepted for Phase 1.4 implementation.
- **Problem:** The sitemap must agree with each page's canonical URL and indexing directive.
- **Decision:** Generate the sitemap only for production builds. Include only canonical, indexable production URLs. Exclude every page marked `noindex`, whether its robots directive is `noindex, follow` or `noindex, nofollow`.
- **Verification:** Check that every sitemap URL resolves to a generated page with a canonical URL and an indexable robots directive, and that no `noindex` page appears in the sitemap.
- **Risk:** Adding a page to the sitemap while excluding it from indexing creates conflicting signals. Keep the sitemap filter aligned with the layout's robots policy.


## ADR-009: Sitemap and robots.txt

- **Status:** Accepted.
- **Problem:** Crawlers need a list of indexable URLs and crawl rules, and both must agree with each page's robots directive.
- **Principle:** One SITE_ENV value decides production behavior everywhere, and the sitemap lists only canonical, indexable production URLs.
- **Decision:**
  - astro.config.mjs loads SITE_ENV with Vite's loadEnv(mode, process.cwd(), ''). The same mode is used by Astro's page environment. Shell variables take precedence over environment files. A .env or mode-specific file may define the flag, but never put SITE_ENV=production in a local file used for preview or development.
  - @astrojs/sitemap is added only when SITE_ENV=production. Pages that set noindex: true must also be listed in NOINDEX_PATHS in astro.config.mjs, because the integration filters by URL and cannot read Astro component props.
  - robots.txt is a generated route that builds the absolute sitemap URL from Astro.site. Production allows all crawlers and lists the sitemap index. Non-production allows crawling and lists no sitemap, so crawlers can read the noindex, nofollow page directive.
  - AI crawlers are not named separately; they are covered by User-agent: *. Robots rules are advisory, not access control.
  - Do not add a link rel=sitemap element to the document head for now; robots.txt is the single discovery location.
- **Options rejected:** Disallow: / on previews (a blocked page cannot show its own noindex; use host-level authentication for private previews); a static robots.txt (duplicates the site origin); a shared page registry (deferred to the future content model).
- **Risk:** NOINDEX_PATHS can drift from page props. The verifier compares actual robots metadata with sitemap membership and catches this drift. A local environment file containing SITE_ENV=production makes that local build production-indexable; keep preview/development files free of that value.

## ADR-010: SEO verifier and CI

- **Status:** Accepted.
- **Decision:** scripts/verify-seo.mjs checks the built dist/ folder. The expected mode is passed explicitly (--expect production|preview) and is never read from SITE_ENV, so the checker does not trust the flag it verifies. It parses HTML and sitemap XML with Cheerio. The site origin is read from astro.config.mjs; the brand name is read from src/site.config.ts (or may be overridden with --brand for isolated tests).
- **Tests:** scripts/verify-seo.test.mjs uses Node's test runner to prove the verifier accepts valid builds and rejects deliberate defects. scripts/test-build-integration.mjs runs real Astro builds to verify noindex/sitemap alignment and SITE_ENV loaded from a .env file.
- **CI:** GitHub Actions runs the verifier tests, real-build integration tests, preview and production builds, and repository hygiene checks on pushes and pull requests to main.
- **Risk:** The verifier checks generated structure and metadata, not the quality, usefulness, accessibility, or ranking potential of page content.

## ADR-011: Full-history secret scanning

- **Status:** Accepted.
- **Problem:** Ignore rules prevent future local environment files from being added, but they do not detect secrets that may already exist in earlier commits.
- **Decision:** A separate CI job uses Gitleaks Action and checks out the repository with fetch-depth: 0, so the scan has the full Git history available. It runs on pushes and pull requests to main. Confirmed exposed credentials must be revoked or rotated; deleting a secret from the latest file alone does not make an earlier commit safe.
- **Risk:** Automated secret scanners can produce false positives and cannot guarantee detection of every secret format. Review findings rather than silently allowlisting them.
